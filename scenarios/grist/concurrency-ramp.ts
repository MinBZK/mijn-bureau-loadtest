// Ramps concurrent VUs listing orgs via the Grist REST API (Bearer API key). /api/orgs is a light
// home-server read: its knee is Grist's front door (Node app CPU + event loop), not the
// per-document SQLite engine — point at /api/docs/<docId>/tables/<tableId>/records for that once a
// load-test document exists. The sleep(1) closed loop caps offered load at ~TARGET_VUS req/s, so
// this endpoint may need sweep levels above 100 to reach the knee.
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
