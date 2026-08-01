# Runbook: detokenization latency regression

**Page:** `pts.detok.stage{stage="total"}` p99 above 25 ms for 5 minutes.

The point of this runbook is that it is short. Every stage of the pipeline is separately timed
(S8.1, S13), so the first question — *which stage got slower* — is answered by one dashboard panel
rather than by reasoning about the architecture. The budget is a diagnostic tool, not a design
document.

---

## 0. Establish the blast radius (30 seconds)

```
sum(rate(pts_detok_stage_seconds_count{stage="total"}[1m])) by (instance)
```

- **One replica slow, the other fine** → it is the replica, not the system. Check whether it
  restarted recently: a cold near-cache raises latency until it warms, which is expected and
  self-correcting. If it did not restart, take it out of the load balancer and move to §4.
- **Both replicas slow** → shared dependency. Continue.
- **Request rate collapsed at the same time** → this may be an upstream problem presenting as
  latency. Check the switch's `pts.switch.response` codes before going further.

## 1. Which stage? (1 minute)

Dashboard: **Per-stage p99**. Or:

```
histogram_quantile(0.99, sum(rate(pts_detok_stage_seconds_bucket{stage!="total"}[1m])) by (le, stage))
```

Read it against the expected budget:

| Stage | Expected | If it is the one that moved |
|---|---|---|
| `resolve` | sub-ms on a near-cache hit; ~7-9 ms on a direct read | §2 |
| `controls` | ~0 inline; ~7-9 ms remote | §3 |
| `cryptogram` | 1-2 ms, in-process | §5 |
| `atc` | sub-ms in the cluster; ~7 ms in the database | §2 or §4 |
| `decrypt` | sub-ms | §5 |
| *none of them* | total moved but no stage did | §6 |

That last row is the important one and the reason `total` is timed separately from the sum of its
parts: if `total` rose and no stage did, the time is being spent *outside* the pipeline — in
request queueing, thread scheduling or GC — and §6 is where to go.

## 2. `resolve` or `atc` got slower — the cache tier or the vault

```bash
curl -s localhost:8082/v1/detokenize/config     # which mode is this replica actually in?
curl -s localhost:8090/cluster/status           # member list and map sizes
```

- **Mode is `DIRECT` when it should be `NEAR_CACHE`** → a config regression. This is the single
  most likely cause of a large, sudden, uniform latency increase, and the config endpoint answers
  it in one call.
- **Mode is `NEAR_CACHE` but the source counter says `DATABASE`:**
  `sum(rate(pts_detok_vault_read_total[1m])) by (source)` — the client cannot reach the cluster
  and has fallen back. Check the member list; a member that left will have redistributed
  partitions and invalidated near-caches.
- **Cluster is healthy and reads are served from it** → the database is slow. Go to §4.

## 3. `controls` got slower — the remote hop

`detok.controls.inline=false` means every authorization makes a synchronous call to
token-controls-service. Check that service's own `pts.controls.check` timer: if it is slow, the
cause is one level down (its database, its connection pool) rather than in detokenization.

The permanent fix is the one the design argues for: `detok.controls.inline=true` deletes this hop
entirely. If the incident is ongoing and the flag is off, turning it on is a legitimate mitigation
— the integration suite proves both modes produce identical decisions.

## 4. The database is slow

```
sum(hikaricp_connections_pending) by (instance)
sum(hikaricp_connections_active) by (instance)
```

**Pending acquires above zero is the finding, not a detail.** It means requests are queueing for a
connection, and that wait lands in the p99 exactly as a slow query does. Distinguish two cases:

- **Active at maximum and pending rising** → the pool is too small for the offered load, *or*
  queries got slower and are holding connections longer. Look at query time before enlarging the
  pool; a bigger pool against a slow database moves the queue rather than removing it.
- **Active well below maximum but latency high** → the database itself. On Oracle, check whether
  partition pruning is still happening (`db/oracle/03_explain_plan.sql`): a plan regression on the
  hot path turns a single-partition probe into something much worse, and it is invisible from the
  application side.

## 5. `cryptogram` or `decrypt` got slower — the key service

These are in-process and should be flat. If they move:

- Check `pts.hsm.mode`. Under `PKCS11` every MAC and unwrap is a call across the PKCS#11 boundary,
  so a slow or contended HSM shows up here directly.
- A `decrypt` regression with no `cryptogram` regression suggests DEK unwrapping is happening more
  often than it should — the registry caches unwrapped keys per version, and a rotation loop or a
  cleared cache would defeat that.

## 6. No stage moved, but `total` did — it is not the pipeline

```
sum(rate(jvm_gc_pause_seconds_sum[1m])) by (cause)
max(jvm_gc_pause_seconds_max) by (action)
```

- **GC pause time rose** → `ops/gc-log-summarize.py` on the replica's GC log. Look at the
  to-space-exhausted count specifically: those are the outliers that produce "everything was fine
  and then 200 ms". `ops/jvm/tuned.env` explains the flags that prevent them.
- **GC is flat** → request queueing ahead of the pipeline. Check Tomcat thread saturation and,
  critically, whether the load generator or an upstream caller is the actual bottleneck. A p99
  measured from the client includes the client's own queueing, which is why the load driver
  records latency from *scheduled* arrival time — see `OpenModelDriver`.

---

## Follow one request end to end

Every service stamps the propagated trace id on every log line (`TraceFilter`,
`TraceHeaderInterceptor`), so a single authorization is greppable across the switch,
detokenization, the controls service and the issuer:

```bash
grep '<traceId>' target/local/logs/*.log
```

Card data cannot appear in those lines: `PanScrubber` masks any 12-19 digit run, and it fails
closed — it will mask an epoch timestamp rather than risk missing a PAN.

---

## What NOT to do

- **Do not disable the ATC guard to buy latency.** It is the replay protection. If ATC is the
  bottleneck, move it into the cluster (`detok.atc-mode=CLUSTER`), which keeps the guard atomic and
  removes the hop.
- **Do not raise the near-cache TTL to improve the hit ratio.** TTL is a staleness bound, not a
  performance knob. Correctness for security-relevant state comes from write-through plus
  invalidation, and lengthening TTL widens the window in which a missed invalidation matters.
- **Do not enlarge the connection pool as a first move.** See §4: without knowing whether queries
  got slower, a bigger pool relocates the queue into the database.
