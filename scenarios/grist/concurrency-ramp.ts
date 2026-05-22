// Ramps concurrent VUs listing orgs via the Grist REST API (Bearer API key). Grist is a Node app
// fronting a SQLite DB per document; this read path is CPU-bound (app + event loop). The breaking
// point shows up as a jump in http_req_failed or a cliff in http_req_duration_p95 once the app
// (after the CPU HPA reaches max replicas) saturates.
import { check, sleep } from "k6";
import http from "k6/http";
import { API_BASE, AUTH_HEADER, validateEnv } from "./_auth.ts";
import { iterationOk, iterationStart } from "./_safety.ts";

const TARGET_VUS: number = parseInt(__ENV.TARGET_VUS || "25", 10);

export const options = {
  scenarios: {
    concurrency_ramp: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: __ENV.RAMP_UP || "30s", target: TARGET_VUS },
        { duration: __ENV.HOLD || "2m", target: TARGET_VUS },
      ],
      gracefulRampDown: __ENV.RAMP_DOWN || "30s",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.9"],
  },
  tags: { target_vus: String(TARGET_VUS) },
};

export function setup(): void {
  validateEnv();
}

export default function (): void {
  iterationStart();
  const res = http.get(`${API_BASE}/orgs`, {
    headers: { Authorization: AUTH_HEADER },
    tags: { verb: "ORGS" },
  });
  const ok = check(res, {
    "orgs 200": (r) => r.status === 200,
  });
  if (ok) iterationOk();
  sleep(1);
}
