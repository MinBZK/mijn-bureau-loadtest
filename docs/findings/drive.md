# Drive — load test findings

*2026-06-11 · details & raw numbers: [`../scaling.md`](../scaling.md)*

## TL;DR

- Drive runs out of **CPU** first — memory, bandwidth and Redis/MinIO are not a factor.
- Out of the box it served **~150 active users**; after two config changes it serves
  **~300+** (47 → 70 req/s). The path to more is known and cheap.
- When overloaded, Drive used to **crash instead of slowing down** — the health checks killed
  busy pods. **Fixed and verified**: with a lenient liveness probe, a 300-user overload run
  finished with 1 failed request out of 57,000 — slow (p95 ~7 s), but nothing broke.
- The namespace **CPU quota remains the final wall**: currently 10.95 of 11 cores used — 50m of
  headroom. The requested +5 cores is **not yet processed**; until it lands, one pod replacement
  is enough to hit `FailedCreate` again.

## What happened

1. **Baseline:** fine up to ~100 concurrent users on 3 pods, sub-second responses.
2. **Scaling had two separate problems.** First: sudden load arrives faster than the
   autoscaler reacts — from the scaled-down single pod, even 75 users meant minutes of
   errors while it caught up. Second: at saturation the **liveness health check (2 s
   timeout) kills pods that are merely busy**, which spirals: kill → slow restart → quota
   blocks the replacement → remaining pods drown → total collapse. *Fixed: liveness relaxed to
   5 s timeout / 6 failures — verified under full overload, zero kills, zero errors. (A
   startupProbe for slow cold starts is recommended on top, but untested.)*
3. **We raised the autoscaler** (max 3 → 6 replicas, scale at 50% instead of 80% CPU).
   Gradual load now scales out cleanly; capacity +34%.
4. **That exposed Postgres** — a single instance at 92% of its small CPU limit, throttled.
   Giving it one full CPU bought another +15–20%. Adding backend pods beyond ~6 is
   pointless until PG grows further.
5. **Now the namespace CPU quota is the wall.** Not cluster hardware — our tenant's budget.

## What to do

| action | owner | status |
|---|---|---|
| Keep HPA 6 @ 50%, set minReplicas 2 (kills the cold-start cliff) | namespace | partly done |
| Fix the **liveness** probe (lenient: 5 s/×6); keep readiness strict | chart | **verified — codify in the chart** (add a startupProbe there too: recommended, untested) |
| Keep Postgres at 1 CPU; raise further when scaling past ~6 pods | namespace | done |
| Raise the tenant `limits.cpu` quota (+5 requested) | platform | **not processed** — hard is 11 cores, 10.95 used (50m headroom: one pod replacement away from FailedCreate) |
| Sync deployed image v0.14.0 → pinned v0.18.0 | platform | ask |

Not yet tested: the upload/file-transfer path, and realistic multi-user load (all tests use
one user → caches flatter the numbers; treat them as an upper bound).
