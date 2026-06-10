SHELL       := bash
.SHELLFLAGS := -eu -o pipefail -c

NS ?= loadtest

.PHONY: help setup install-scenarios run sweep seed unseed logs clean

help:
	@echo "Required shell vars: TARGET_URL, PROMETHEUS_RW_URL"
	@echo ""
	@echo "One-time per cluster (manual): install the k6-operator. See README."
	@echo ""
	@echo "Per-namespace setup (idempotent):"
	@echo "  make setup                                       # create namespace + apply networkpolicy"
	@echo ""
	@echo "Per-app setup (re-run when scripts change):"
	@echo "  make install-scenarios app=<app>                 # ship the app's scripts as a ConfigMap"
	@echo "  (credentials Secret: see README; it varies per app)"
	@echo ""
	@echo "Per run:"
	@echo "  make run    app=<app> scenario=<scenario>                            # one TestRun at the env's TARGET_VUS"
	@echo "  make sweep  app=<app> scenario=<scenario> levels=\"5 25 50 75 100\"    # plateau at each level → 3-5 points"
	@echo "  make seed   app=<app>                                                 # create the journey dataset (one-time)"
	@echo "  make unseed app=<app>                                                 # delete the journey dataset"
	@echo "  make logs   app=<app> scenario=<scenario>                            # tail runner logs"
	@echo "  make clean  app=<app> scenario=<scenario>                            # delete the TestRun"

setup:
	kubectl create namespace $(NS) --dry-run=client -o yaml | kubectl apply -f -
	kubectl apply -n $(NS) -f networkpolicy.yaml

install-scenarios:
	@: $${app:?app=<name> required — run 'make help' for usage}
	kubectl create configmap $(app)-scenarios -n $(NS) \
	  --from-file scenarios/$(app)/ \
	  --dry-run=client -o yaml | kubectl apply -f -

run:
	@: $${app:?app=<name> required — run 'make help' for usage}
	@: $${scenario:?scenario=<name> required — run 'make help' for usage}
	@source runs/$(app)/$(scenario).env && \
	  export SCENARIO=$(scenario) && \
	  export RUN_ID=$$(date +%Y%m%d-%H%M%S) && \
	  for v in TARGET_URL PROMETHEUS_RW_URL LOAD_TEST_NAME PARALLELISM \
	           SCRIPTS_CONFIGMAP SCRIPT_FILE CREDENTIALS_SECRET \
	           RUNNER_CPU_REQUEST RUNNER_CPU_LIMIT \
	           RUNNER_MEMORY_REQUEST RUNNER_MEMORY_LIMIT; do \
	    : "$${!v:?$$v must be set (check runs/$(app)/$(scenario).env and .env.local)}"; \
	  done && \
	  envsubst < testrun.yaml | kubectl apply -n $(NS) -f -

# Sweep the same scenario across discrete load levels (one TestRun per level, awaited in
# turn) to produce the 3-5 steady-state points the scaling doc extrapolates from.
# Each level overrides TARGET_VUS and gets a unique <name>-<vus>v TestRun; metrics are in
# Prometheus (tagged target_vus) so the CRs are deleted after each level finishes.
# A level that never reaches stage=finished (e.g. stage=error) still gets its CR deleted,
# then the sweep aborts.
sweep:
	@: $${app:?app=<name> required — run 'make help' for usage}
	@: $${scenario:?scenario=<name> required — run 'make help' for usage}
	@: $${levels:?levels="5 25 50 75 100" required}
	@source runs/$(app)/$(scenario).env && \
	  export SCENARIO=$(scenario) && \
	  for v in TARGET_URL PROMETHEUS_RW_URL LOAD_TEST_NAME PARALLELISM \
	           SCRIPTS_CONFIGMAP SCRIPT_FILE CREDENTIALS_SECRET \
	           RUNNER_CPU_REQUEST RUNNER_CPU_LIMIT \
	           RUNNER_MEMORY_REQUEST RUNNER_MEMORY_LIMIT; do \
	    : "$${!v:?$$v must be set (check runs/$(app)/$(scenario).env and .env.local)}"; \
	  done && \
	  base="$$LOAD_TEST_NAME" && \
	  for vus in $(levels); do \
	    export TARGET_VUS="$$vus" && \
	    export RUN_ID="$$(date +%Y%m%d-%H%M%S)" && \
	    export LOAD_TEST_NAME="$${base}-$${vus}v" && \
	    echo "=== sweep $(app)/$(scenario) @ $${vus} VUs ($${LOAD_TEST_NAME}) ===" && \
	    envsubst < testrun.yaml | kubectl apply -n $(NS) -f - && \
	    rc=0 && \
	    kubectl wait --for="jsonpath={.status.stage}=finished" \
	      "testrun.k6.io/$${LOAD_TEST_NAME}" -n $(NS) --timeout=30m || rc=$$?; \
	    if [ "$$rc" -ne 0 ]; then \
	      kubectl logs -n $(NS) -l "k6_cr=$${LOAD_TEST_NAME}" --tail=20 || true; \
	    fi; \
	    kubectl delete testrun -n $(NS) "$${LOAD_TEST_NAME}" --ignore-not-found || rc=$$?; \
	    if [ "$$rc" -ne 0 ]; then echo "sweep aborted: level $${vus} did not finish"; exit 1; fi; \
	    sleep 20; \
	  done

# One-time dataset provisioning for an app's journey scenario. `seed` creates up to
# SEED_DOC_COUNT docs; `unseed` deletes everything titled with CLEANUP_PREFIX. Both run a
# single TestRun (seed.ts) and wait for it to finish before deleting the CR.
seed:
	@: $${app:?app=<name> required — run 'make help' for usage}
	@source runs/$(app)/seed.env && \
	  export SCENARIO=seed && \
	  export RUN_ID=$$(date +%Y%m%d-%H%M%S) && \
	  for v in TARGET_URL PROMETHEUS_RW_URL LOAD_TEST_NAME PARALLELISM \
	           SCRIPTS_CONFIGMAP SCRIPT_FILE CREDENTIALS_SECRET \
	           RUNNER_CPU_REQUEST RUNNER_CPU_LIMIT \
	           RUNNER_MEMORY_REQUEST RUNNER_MEMORY_LIMIT; do \
	    : "$${!v:?$$v must be set (check runs/$(app)/seed.env and .env.local)}"; \
	  done && \
	  envsubst < testrun.yaml | kubectl apply -n $(NS) -f - && \
	  kubectl wait --for="jsonpath={.status.stage}=finished" \
	    "testrun.k6.io/$$LOAD_TEST_NAME" -n $(NS) --timeout=40m && \
	  kubectl logs -n $(NS) -l "k6_cr=$$LOAD_TEST_NAME" --tail=20 && \
	  kubectl delete testrun -n $(NS) "$$LOAD_TEST_NAME" --ignore-not-found

unseed:
	@: $${app:?app=<name> required — run 'make help' for usage}
	@source runs/$(app)/seed.env && \
	  export SEED_MODE=delete && \
	  export SCENARIO=seed && \
	  export RUN_ID=$$(date +%Y%m%d-%H%M%S) && \
	  for v in TARGET_URL PROMETHEUS_RW_URL LOAD_TEST_NAME PARALLELISM \
	           SCRIPTS_CONFIGMAP SCRIPT_FILE CREDENTIALS_SECRET \
	           RUNNER_CPU_REQUEST RUNNER_CPU_LIMIT \
	           RUNNER_MEMORY_REQUEST RUNNER_MEMORY_LIMIT; do \
	    : "$${!v:?$$v must be set (check runs/$(app)/seed.env and .env.local)}"; \
	  done && \
	  envsubst < testrun.yaml | kubectl apply -n $(NS) -f - && \
	  kubectl wait --for="jsonpath={.status.stage}=finished" \
	    "testrun.k6.io/$$LOAD_TEST_NAME" -n $(NS) --timeout=40m && \
	  kubectl logs -n $(NS) -l "k6_cr=$$LOAD_TEST_NAME" --tail=20 && \
	  kubectl delete testrun -n $(NS) "$$LOAD_TEST_NAME" --ignore-not-found

logs:
	@: $${app:?app=<name> required — run 'make help' for usage}
	@: $${scenario:?scenario=<name> required — run 'make help' for usage}
	@source runs/$(app)/$(scenario).env && \
	  kubectl logs -n $(NS) -l "k6_cr=$$LOAD_TEST_NAME" -f --tail=200

clean:
	@: $${app:?app=<name> required — run 'make help' for usage}
	@: $${scenario:?scenario=<name> required — run 'make help' for usage}
	@source runs/$(app)/$(scenario).env && \
	  kubectl delete testrun -n $(NS) "$$LOAD_TEST_NAME" --ignore-not-found
