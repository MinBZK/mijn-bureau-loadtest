SHELL       := bash
.SHELLFLAGS := -eu -o pipefail -c

NS ?= loadtest

.PHONY: help setup install-scenarios run logs clean

help:
	@echo "Required shell vars: BASE_URL, PROMETHEUS_RW_URL"
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
	@echo "  make run    app=<app> scenario=<scenario>        # apply the TestRun"
	@echo "  make logs   app=<app> scenario=<scenario>        # tail runner logs"
	@echo "  make clean  app=<app> scenario=<scenario>        # delete the TestRun"

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
	  for v in BASE_URL PROMETHEUS_RW_URL LOAD_TEST_NAME PARALLELISM \
	           SCRIPTS_CONFIGMAP SCRIPT_FILE CREDENTIALS_SECRET; do \
	    : "$${!v:?$$v must be set (check runs/$(app)/$(scenario).env and .env.local)}"; \
	  done && \
	  envsubst < testrun.yaml | kubectl apply -n $(NS) -f -

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
