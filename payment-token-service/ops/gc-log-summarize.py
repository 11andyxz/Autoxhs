#!/usr/bin/env python3
"""
Summarise G1 pauses from a -Xlog:gc* log (S9.3).

The claim under test is about the TAIL: "p99.9 pause outliers reduced". A mean pause time is the
wrong statistic for that -- it barely moves when 1 in 1000 collections stalls for 200 ms, and that
one collection is the entire story. So this reports the pause distribution and, separately, counts
the two events that actually produce those outliers:

  * to-space exhausted / evacuation failure -- G1 ran out of space to copy survivors into and had
    to fall back. This is the classic "everything was fine and then a 200 ms pause" cause, and it is
    what -XX:G1ReservePercent and an earlier -XX:InitiatingHeapOccupancyPercent are there to prevent.
  * Full GC -- with G1 a full collection is a failure mode, not a normal event.

Usage:
  ops/gc-log-summarize.py target/gc-baseline.log [target/gc-tuned.log ...]
"""

import re
import sys
from pathlib import Path

# Unified logging (JDK 9+): "[12.345s][info][gc] GC(42) Pause Young (Normal) ... 13.456ms"
#
# The kind is matched against G1's known pause names rather than a generic word pattern: a lazy
# [A-Za-z ]+? happily matches a single letter, which silently produced a per-kind breakdown of
# "Y", "R" and "C" that looked plausible enough to miss.
PAUSE = re.compile(
    r"Pause\s+(?P<kind>Young(?:\s+\((?:Normal|Concurrent Start|Prepare Mixed|Mixed"
    r"|Allocation Failure)\))?|Full|Remark|Cleanup|Initial Mark)"
    r"[^\n]*?(?P<ms>\d+[.,]\d+)ms")
TO_SPACE = re.compile(r"to-space exhausted|Evacuation Failure", re.IGNORECASE)
FULL_GC = re.compile(r"Pause Full")


def percentile(values, p):
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, int(round(p / 100.0 * len(ordered) + 0.5)) - 1))
    return ordered[index]


def summarise(path: Path):
    if not path.exists():
        print(f"!! {path} not found")
        return None

    pauses, by_kind = [], {}
    to_space, full_gc = 0, 0

    for line in path.read_text(errors="replace").splitlines():
        if TO_SPACE.search(line):
            to_space += 1
        if FULL_GC.search(line):
            full_gc += 1
        match = PAUSE.search(line)
        if match:
            ms = float(match.group("ms").replace(",", "."))
            kind = re.sub(r"\s+", " ", match.group("kind")).strip()
            pauses.append(ms)
            by_kind.setdefault(kind, []).append(ms)

    if not pauses:
        print(f"!! no GC pauses parsed from {path}. Was the JVM started with "
              f"-Xlog:gc*,safepoint:file=...?")
        return None

    print(f"\n=== {path.name} ===")
    print(f"collections     : {len(pauses)}")
    print(f"total pause     : {sum(pauses):.1f} ms")
    print(f"pause p50       : {percentile(pauses, 50):.2f} ms")
    print(f"pause p95       : {percentile(pauses, 95):.2f} ms")
    print(f"pause p99       : {percentile(pauses, 99):.2f} ms")
    print(f"pause p99.9     : {percentile(pauses, 99.9):.2f} ms   <-- the claim lives here")
    print(f"pause max       : {max(pauses):.2f} ms")
    print(f"to-space exhaust: {to_space}   (each one is a tail outlier waiting to happen)")
    print(f"full GCs        : {full_gc}   (with G1, any number above 0 deserves attention)")
    for kind, values in sorted(by_kind.items(), key=lambda kv: -len(kv[1])):
        print(f"  {kind:<24} n={len(values):<6} max={max(values):8.2f} ms  "
              f"p99.9={percentile(values, 99.9):8.2f} ms")

    return {
        "name": path.name,
        "count": len(pauses),
        "p999": percentile(pauses, 99.9),
        "max": max(pauses),
        "to_space": to_space,
        "full_gc": full_gc,
    }


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2

    results = [r for r in (summarise(Path(arg)) for arg in sys.argv[1:]) if r]

    if len(results) >= 2:
        baseline, tuned = results[0], results[1]
        print("\n=== comparison ===")
        for field, label in (("p999", "p99.9 pause"), ("max", "max pause")):
            b, t = baseline[field], tuned[field]
            if b == 0:
                change = "no data"
            else:
                delta = (b - t) / b * 100
                change = f"{delta:.0f}% lower" if delta >= 0 else f"{-delta:.0f}% HIGHER"
            print(f"{label:<14} {b:8.2f} ms -> {t:8.2f} ms   ({change})")
        print(f"{'to-space':<14} {baseline['to_space']:8d}    -> {tuned['to_space']:8d}")
        print(f"{'full GCs':<14} {baseline['full_gc']:8d}    -> {tuned['full_gc']:8d}")
        if min(baseline["count"], tuned["count"]) < 100:
            print(f"\nSAMPLE SIZE: {baseline['count']} and {tuned['count']} collections. A true p99.9 "
                  f"needs far more;\nat these counts p99.9 and max are the same observation. Run a "
                  f"longer profile before\nquoting a percentile rather than a maximum.")
        print("\nHonest caveat: absolute pause times depend on the host, the heap size and the")
        print("allocation rate of the workload. The transferable claim is the DIRECTION and the")
        print("mechanism -- fewer evacuation failures because marking starts earlier and space is")
        print("reserved -- not the specific millisecond values.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
