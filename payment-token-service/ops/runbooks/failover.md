# Runbook: failover and availability

Covers the replica-level failover this stack actually demonstrates, and states plainly where the
dual-datacentre story is design rather than demonstration (S10.4).

---

## What is demonstrated, and what is not

| Scenario | Status |
|---|---|
| A detokenization replica dies under load | Demonstrated (compose stack) |
| A Hazelcast member dies | Demonstrated (backup count 1) |
| The cache tier is entirely unreachable | Handled by design — falls back to direct reads |
| The token-controls-service is unreachable | Handled — inline mode removes the dependency |
| A whole datacentre is lost | **Design discussion only.** Do not claim otherwise. |

---

## Drill 1 — kill a detokenization replica under load

```bash
docker compose -f docker-compose.yml up -d --wait
ops/seed-tokens.py --count 500 --url http://localhost:8081
# start sustained load against the load balancer
java -jar loadtest/target/loadtest-1.0.0-SNAPSHOT-exec.jar \
     --load.url=http://localhost:8082 --load.profile="constant:400/120s" --load.label=failover &

docker kill payment-token-service-detokenization-service-1-1
```

**Expected:** a brief error blip, then the error rate returns to zero while throughput continues
on the surviving replica.

Two settings make that true, and neither is a default — `ops/nginx/detok-lb.conf`:
- `max_fails=1 fail_timeout=2s` ejects the dead replica in about two seconds. Left at the
  defaults it would keep receiving traffic well beyond the length of the drill, and "throughput
  continues" would simply look false.
- `proxy_next_upstream error timeout` retries the *other* replica for a request that was in flight
  when the process died, converting errors into a few slow requests.

**Then watch the survivor's latency.** It rises briefly and recovers: its near-cache is cold for
the partitions it has just taken over, so the first reads for those tokens fall through to the
member and, on a miss, to the vault. Correctness is never affected — only latency, and only until
it warms. That is the read-through `MapLoader` doing exactly what it exists for.

Restart it and confirm it rejoins:

```bash
docker compose -f docker-compose.yml up -d detokenization-service-1
```

## Drill 2 — kill a Hazelcast member

```bash
curl -s localhost:8090/cluster/status     # two members, note the map sizes
docker kill payment-token-service-hazelcast-member-2-1
curl -s localhost:8090/cluster/status     # one member, map still populated
```

**Expected:** the `vault-records` map survives on the remaining member (backup count 1) and reads
continue. Authorizations keep succeeding throughout.

**What to check afterwards, and why it matters:** the `token-atc` map has write-behind enabled, so
a member dying can lose ATC advances that had not yet flushed. The replay window is exactly the
write-behind lag. This is the one place the design trades durability for latency, and it is worth
saying out loud rather than discovering under questioning. Mitigations already in place
(`AtcMapStore`): a short interval, the database value re-anchoring a cold entry rather than zero,
writes that refuse to move the stored counter backwards, and the cryptogram binding ATC, UN and
amount so a replay inside the window still has to pass verification.

## Drill 3 — lose the cache tier entirely

```bash
docker kill payment-token-service-hazelcast-member-1-1 \
            payment-token-service-hazelcast-member-2-1
```

**Expected:** authorizations continue, slower. The Hazelcast client's cluster-connect timeout is
bounded on purpose (`VaultClusterConfig`, 15 s) — a client that retries forever turns "the cache
is down" into "the service hangs", which is a far worse failure on the authorization path.

The design decision worth naming here: the cache is a read *accelerator*, never the record of
truth. Oracle remains authoritative, so losing the cache costs latency and nothing else. A
cache-only design would have lost durability and audit along with it.

## Drill 4 — the controls service is unreachable

With `detok.controls.inline=false` this is a hard dependency on the hot path. Kill it and
authorizations fail with `DEPENDENCY_UNAVAILABLE`.

That is the argument for the optimization stated as an availability property rather than a
latency one: `detok.controls.inline=true` removes the dependency altogether, and the integration
suite proves both modes reach identical decisions. Fewer synchronous dependencies on the
authorization path is worth as much as the milliseconds.

---

## True active-active across datacentres — design only

Being explicit: this repository demonstrates replica-level HA. Real active-active means both
datacentres serving authorizations simultaneously, and it raises four problems this stack does not
solve.

1. **The vault must be readable in both DCs.** Data Guard or GoldenGate, with a stated RPO. That
   RPO is the window in which a token provisioned in DC-A is unknown in DC-B, and provisioning
   therefore needs either a primary region or a conflict-resolution model.
2. **ATC monotonicity across DCs is the hard part.** A per-token counter with a single owner does
   not survive being written in two places. Realistic options: partition affinity so a token's
   authorizations always land in one DC, or per-DC ATC windows (odd/even, or a range split) so the
   two can never collide. Both constrain routing, which makes this a network design question
   rather than a database one — and that is the honest answer.
3. **Cache coherence spans DCs.** Hazelcast WAN replication, with its own lag, which reopens the
   suspended-token question at a larger timescale. `pts.cache.drift_repaired` becomes more
   important, not less.
4. **Drills, not documents.** Quarterly DR exercises that actually fail over. A runbook nobody has
   executed is a hypothesis.
