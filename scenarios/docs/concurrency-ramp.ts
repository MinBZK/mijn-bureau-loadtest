// Ramps concurrent VUs listing documents via the la-suite Docs REST API (OIDC Bearer access token,
// fetched in setup()). Targets the paginated list the UI calls — not documents/all/, whose ceiling
// proved endpoint-specific (see docs/scaling.md). Needs a seeded dataset (`make seed app=docs`):
// an empty page only measures the auth middleware. Docs is a Django/DRF app over Postgres; this
// read path is CPU + DB-bound. The breaking point shows up as a jump in http_req_failed or a cliff
// in http_req_duration_p95 once the app (after the CPU HPA reaches max replicas) or the Postgres
// connection pool saturates.
import { check, sleep } from "k6";
import http from "k6/http";
import { getToken, validateEnv } from "./_auth.ts";
import { iterationOk, iterationStart } from "./_safety.ts";

const BASE_URL: string = (__ENV.TARGET_URL || "").replace(/\/$/, "");

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
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.9"],
  },
  tags: { target_vus: String(TARGET_VUS) },
};

export function setup(): { token: string } {
  validateEnv();
  const token = getToken();
  const res = http.get(`${BASE_URL}/api/v1.0/documents/?page=1`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status !== 200) {
    throw new Error(`docs list failed: ${res.status}`);
  }
  if (((res.json("results") as unknown[]) || []).length === 0) {
    throw new Error("no documents for the load-test user — run `make seed app=docs` first");
  }
  return { token };
}

export default function (data: { token: string }): void {
  iterationStart();
  const res = http.get(`${BASE_URL}/api/v1.0/documents/?page=1`, {
    headers: { Authorization: `Bearer ${data.token}` },
    tags: { verb: "DOCUMENTS" },
  });
  const ok = check(res, {
    "documents 200": (r) => r.status === 200,
  });
  if (ok) iterationOk();
  sleep(1);
}
