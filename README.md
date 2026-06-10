# mijn-bureau-loadtest

[k6](https://k6.io/) load-test scenarios for the
[MijnBureau](https://github.com/MinBZK/mijn-bureau-infra) platform. Scenarios run in-cluster
as `TestRun` CRs scheduled by the [k6-operator](https://github.com/grafana/k6-operator).

## Layout

```
scenarios/<app>/                 # k6 scripts (helpers prefixed `_`), shipped as a ConfigMap
runs/<app>/<scenario>.env        # per-scenario env vars (sourced before envsubst)
docs/scaling.md                  # results: per-app saturating resource + measured points
testrun.yaml                     # single TestRun template
networkpolicy.yaml               # per-namespace egress allow rules
Makefile                         # setup / install / run / sweep / seed / unseed / logs / clean
tsconfig.json + package.json     # TypeScript type-check (editor + pre-commit)
```

Adding a scenario: one `.ts` under `scenarios/<app>/`, one `.env` under `runs/<app>/`.

## Prerequisites

- Kubernetes cluster with the [k6-operator](https://github.com/grafana/k6-operator) installed
- [Helm](https://helm.sh/), `envsubst`, GNU `make`
- `npm install` for the TypeScript type-check (editor + CI; not used at runtime)

## Setup

### Per cluster

```bash
helm repo add grafana https://grafana.github.io/helm-charts
helm install k6-operator grafana/k6-operator \
  --version 3.13.0 \
  --namespace k6-operator-system \
  --create-namespace
```

### Per namespace (defaults to `loadtest`)

```bash
make setup
```

### Per app

```bash
make install-scenarios app=nextcloud

# Credentials Secret — keys vary per app, documented in scenarios/<app>/_auth.ts.
# Nextcloud needs a user + OCS app-password (Settings → Security → Devices & sessions):
kubectl create secret generic loadtest-nextcloud-credentials -n loadtest \
  --from-literal NEXTCLOUD_USERNAME='<user>' \
  --from-literal NEXTCLOUD_APP_PASSWORD='<app-password>'
```

Re-run `install-scenarios` after editing a scenario script.

## Daily workflow

```bash
cp .env.example .env.local       # once per environment
source .env.local                 # once per shell

make run    app=nextcloud scenario=concurrency-ramp
make sweep  app=nextcloud scenario=concurrency-ramp levels="5 25 50 75 100"
make logs   app=nextcloud scenario=concurrency-ramp
make clean  app=nextcloud scenario=concurrency-ramp
```

`make help` lists targets.

## Reading results

- **`concurrency-ramp`** holds a fixed number of VUs steady (env-driven ramp→plateau:
  `TARGET_VUS`, `RAMP_UP`, `HOLD`) so each run is one clean steady-state point. Sweep it
  across levels — `make sweep app=<app> scenario=concurrency-ramp levels="5 25 50 75 100"` —
  for several points; each is tagged `target_vus` as a Prometheus label. The breaking
  point is the level where `http_req_duration` p95 cliffs or `http_req_failed` climbs. The
  failure threshold is deliberately permissive — it hunts the knee, it is not an SLO gate.
- **`upload-ladder`** uploads one file per size (single VU) as a per-size latency baseline
  for the bandwidth path; run it in-cluster so the runner's uplink isn't the limit. The
  size range varies per app (see the scenario's `SIZES`).
- **`journey`** drives a realistic mix of operations with think-time over a seeded dataset, instead
  of one endpoint in a loop. It ramps to `TARGET_VUS` concurrent users (`ramping-vus`); sweep
  `TARGET_VUS` to find the breaking point. Requests are tagged `op`, and HTTP 429s increment a
  `throttled` counter so rate-limiting is visible. **Seed first:** `make seed app=docs` provisions the
  dataset (idempotent), `make unseed app=docs` removes it. For meaningful single-user load on
  throttled apps (Docs), raise the backend throttle (`API_DOCUMENT_THROTTLE_RATE`) for the run.

## Keycloak token source

The la-suite scenarios (Docs, Drive, Conversations) authenticate via the OAuth **password grant**.
The platform's *app* clients have direct grants (`directAccessGrantsEnabled`) disabled, but the
built-in **`admin-cli`** client — present in every realm, public, direct grants enabled — works, so
**no dedicated client is needed**. You only need a single **`loadtest` user** (with a password) in
realm `mijnbureau`; the apps accept any valid realm token (they don't enforce `aud`), so the same user
authenticates to all of them.

Per-app credentials Secret (keys consumed by `scenarios/<app>/_auth.ts`; `admin-cli` is public, so no
client secret), e.g. for Docs:

```bash
kubectl create secret generic loadtest-docs-credentials -n loadtest \
  --from-literal KEYCLOAK_TOKEN_URL='https://<keycloak-host>/realms/mijnbureau/protocol/openid-connect/token' \
  --from-literal KEYCLOAK_CLIENT_ID='admin-cli' \
  --from-literal KEYCLOAK_USERNAME='loadtest' \
  --from-literal KEYCLOAK_PASSWORD='<password>'
```

## Visualising

Metrics ship to Prometheus via remote-write. Import the
[official k6 dashboard](https://grafana.com/grafana/dashboards/19665) (ID `19665`).

`PROMETHEUS_RW_URL` must accept remote-write. OpenShift's bundled `prometheus-k8s` does not
(no `--web.enable-remote-write-receiver`); use Mimir/Thanos/Grafana Cloud or a sidecar
Prometheus with the receiver flag enabled.

## OpenShift notes

The TestRun's `runner.securityContext` only sets `seccompProfile: RuntimeDefault`; the
`restricted-v2` SCC mutator handles the rest (`runAsUser`/`runAsNonRoot`/capabilities) at
admission. Do not add `runAsNonRoot: true` here — kubelet rejects the grafana/k6 image's
non-numeric `USER` on clusters without that mutator (e.g. kind).

`networkpolicy.yaml` allows egress for DNS, intra-namespace 6565 (k6-operator
starter↔runner), HTTPS (target apps + remote-write), and 9090 (sidecar Prometheus). Add a
rule if your remote-write endpoint listens elsewhere.
