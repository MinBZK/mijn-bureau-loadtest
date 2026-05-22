# mijn-bureau-loadtest

[k6](https://k6.io/) load-test scenarios for the
[MijnBureau](https://github.com/MinBZK/mijn-bureau-infra) platform. Scenarios run in-cluster
as `TestRun` CRs scheduled by the [k6-operator](https://github.com/grafana/k6-operator).

## Layout

```
scenarios/<app>/                 # k6 scripts (helpers prefixed `_`), shipped as a ConfigMap
runs/<app>/<scenario>.env        # per-scenario env vars (sourced before envsubst)
testrun.yaml                     # single TestRun template
networkpolicy.yaml               # per-namespace egress allow rules
Makefile                         # install / run / logs / clean
tsconfig.json + package.json     # TypeScript type-check (editor + pre-commit)
```

Adding a scenario: one `.ts` under `scenarios/<app>/`, one `.env` under `runs/<app>/`.

## Prerequisites

- Kubernetes cluster with the [k6-operator](https://github.com/grafana/k6-operator) installed
- [Helm](https://helm.sh/), `envsubst`, GNU `make`
- `npm install` for the TypeScript type-check (editor + pre-commit; not used at runtime)

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

make run    app=nextcloud scenario=breaking-point
make logs   app=nextcloud scenario=breaking-point
make clean  app=nextcloud scenario=breaking-point
```

`make help` lists targets.

## Reading results

- **`upload-ladder`** uploads files of increasing size (64 KB → 128 MB) once each,
  producing a per-size latency baseline. The cliff for a typical Nextcloud is well
  above this range; expect 100% success and roughly linear scaling.
- **`concurrency-ramp`** ramps from 1 to 100 concurrent VUs against a fixed 1 MB
  upload, looking for where Nextcloud (PHP-FPM workers, Postgres connection pool,
  MinIO write concurrency) starts shedding requests. The breaking point is the
  VU count at which `http_req_failed` climbs above 0 or `http_req_duration_p95` jumps.

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

## Without make

```bash
source .env.local
source runs/<app>/<scenario>.env
envsubst < testrun.yaml | kubectl apply -n loadtest -f -
kubectl logs -n loadtest -l "k6_cr=$LOAD_TEST_NAME" -f --tail=200
kubectl delete testrun -n loadtest "$LOAD_TEST_NAME" --ignore-not-found
```

The Makefile is a thin wrapper that validates required env vars.
