// Ramps concurrent VUs listing chats via the la-suite Conversations REST API (OIDC Bearer access
// token, fetched in setup()). This probes the API tier only — the LLM path is conversation-ramp.ts.
// The chat list is owner-scoped, so setup() seeds chats for the load-test user; an empty page would
// only measure the auth middleware. Conversations is a Django/DRF app over Postgres; this read path
// is CPU + DB-bound. The breaking point shows up as a jump in http_req_failed or a cliff in
// http_req_duration_p95 once the app (after the CPU HPA reaches max replicas) or the Postgres
// connection pool saturates.
import { check, sleep } from "k6";
import http from "k6/http";
import { getToken, validateEnv } from "./_auth.ts";
import { iterationOk, iterationStart } from "./_safety.ts";

const BASE_URL: string = (__ENV.TARGET_URL || "").replace(/\/$/, "");
const API = `${BASE_URL}/api/v1.0`;

const SEED_CHATS = 25;

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
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const res = http.get(`${API}/chats/?title=loadtest-seed`, { headers });
  if (res.status !== 200) {
    throw new Error(`chats list failed: ${res.status}`);
  }
  const existing = (res.json("count") as number) || 0;
  for (let i = existing; i < SEED_CHATS; i++) {
    const create = http.post(`${API}/chats/`, JSON.stringify({ title: `loadtest-seed-${i}` }), {
      headers,
    });
    if (create.status !== 201) {
      throw new Error(`chat seed failed at ${i}: ${create.status}`);
    }
  }
  return { token };
}

export default function (data: { token: string }): void {
  iterationStart();
  const res = http.get(`${API}/chats/`, {
    headers: { Authorization: `Bearer ${data.token}` },
    tags: { verb: "CHATS" },
  });
  const ok = check(res, {
    "chats 200": (r) => r.status === 200,
  });
  if (ok) iterationOk();
  sleep(1);
}
