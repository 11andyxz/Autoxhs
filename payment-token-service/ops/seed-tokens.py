#!/usr/bin/env python3
"""
Provision a pool of ACTIVE tokens through the real provisioning API.

Used before a load run: the driver exercises the ACCEPT path of the detokenization pipeline, which
needs tokens that actually authorize. A load test that only produces rejections measures the cheapest
branch in the pipeline and proves nothing about the latency budget (S11).

Cards are generated so the issuer simulator's deterministic risk score (last4 mod 100) puts every one
of them on the green ID&V path -- see DemoCards for why that mapping exists.

Usage:
  ops/seed-tokens.py --count 500 [--url http://localhost:8081] [--concurrency 16]
"""

import argparse
import json
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

ISSA_FUNDING_BIN = "41111000"
GREEN_LAST_TWO = 25            # risk 25 -> APPROVE
WALLET_REQUESTOR = "40010030001"


def luhn_complete(prefix: str) -> str:
    """Append the ISO/IEC 7812-1 check digit."""
    total, double = 0, True
    for ch in reversed(prefix):
        d = int(ch)
        if double:
            d *= 2
            if d > 9:
                d -= 9
        total += d
        double = not double
    return prefix + str((10 - total % 10) % 10)


def green_cards(count: int):
    """Yield `count` distinct Luhn-valid ISSA cards whose last two digits put them on the green path."""
    found, suffix = 0, 0
    while found < count and suffix < 10_000_000:
        pan = luhn_complete(f"{ISSA_FUNDING_BIN}{suffix:07d}")
        suffix += 1
        if int(pan[-2:]) == GREEN_LAST_TWO:
            found += 1
            yield pan
    if found < count:
        raise SystemExit(f"could only generate {found} of the {count} requested cards")


def provision(url: str, pan: str, index: int):
    body = json.dumps({
        "fundingPan": pan,
        "expiry": "2812",
        "cardholderName": "LOAD TEST",
        "requestorId": WALLET_REQUESTOR,
        "domainType": "ECOM",
        "deviceId": f"load-device-{index}",
        "idvChannel": "SMS",
    }).encode()
    request = urllib.request.Request(
        f"{url}/v1/tokens", data=body,
        headers={"Content-Type": "application/json",
                 # Idempotent per card, so re-running the seeder does not create a second token.
                 "Idempotency-Key": f"seed-{pan}"},
        method="POST")
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.loads(response.read())
            return response.status, payload.get("decision")
    except urllib.error.HTTPError as e:
        return e.code, e.read()[:200].decode(errors="replace")
    except Exception as e:  # noqa: BLE001 - a seeding failure just needs reporting
        return 0, str(e)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--count", type=int, default=500)
    parser.add_argument("--url", default="http://localhost:8081")
    parser.add_argument("--concurrency", type=int, default=16)
    args = parser.parse_args()

    cards = list(green_cards(args.count))
    print(f"provisioning {len(cards)} tokens against {args.url} "
          f"({args.concurrency} concurrent)...", flush=True)

    approved = 0
    failures = []
    with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        results = pool.map(lambda pair: provision(args.url, pair[1], pair[0]), enumerate(cards))
        for (status, detail), pan in zip(results, cards):
            if status == 201 and detail == "APPROVE":
                approved += 1
            else:
                failures.append((pan, status, detail))

    print(f"provisioned {approved}/{len(cards)} ACTIVE tokens")
    if failures:
        print(f"{len(failures)} failed; first few:")
        for pan, status, detail in failures[:5]:
            print(f"  {pan[:6]}...{pan[-4:]}  HTTP {status}  {detail}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
