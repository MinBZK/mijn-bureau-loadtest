// Ramps concurrent VUs listing recent items via the la-suite Drive REST API (OIDC Bearer access
// token, fetched in setup()). recents/ is owner-scoped, so setup() seeds folders for the load-test
// user; an empty page would only measure the auth middleware. Drive is a Django/DRF app over
// Postgres; this read path is CPU + DB-bound. The breaking point shows up as a jump in
// http_req_failed or a cliff in http_req_duration_p95 once the app (after the CPU HPA reaches max
// replicas) or the Postgres connection pool saturates.
import { check, sleep } from "k6";
import http from "k6/http";
import { getTokens, refreshVuToken, type Tokens, validateEnv, vuToken } from "./_auth.ts";
import { getWorkspaceId } from "./_items.ts";
import { iterationOk, iterationStart } from "./_safety.ts";

const BASE_URL: string = (__ENV.TARGET_URL || "").replace(/\/$/, "");
const API = `${BASE_URL}/api/v1.0`;
const LIST_URL = `${API}/items/recents/`;

const SEED_ITEMS = 25;

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

export function setup(): { tokens: Tokens } {
  validateEnv();
  const tokens = getTokens();
  const headers = { Authorization: `Bearer ${tokens.access}`, "Content-Type": "application/json" };
  const recents = http.get(`${API}/items/recents/`, { headers });
  if (recents.status !== 200) {
    throw new Error(`recents list failed: ${recents.status}`);
  }
  const existing = (recents.json("count") as number) || 0;
  if (existing < SEED_ITEMS) {
    const rootId = getWorkspaceId(tokens.access);
    for (let i = existing; i < SEED_ITEMS; i++) {
      const create = http.post(
        `${API}/items/${rootId}/children/`,
        JSON.stringify({ type: "folder", title: `loadtest-seed-${i}` }),
        { headers },
      );
      if (create.status !== 201) {
        throw new Error(`item seed failed at ${i}: ${create.status}`);
      }
    }
  }
  return { tokens };
}

export default function (data: { tokens: Tokens }): void {
  iterationStart();
  let res = http.get(LIST_URL, {
    headers: { Authorization: `Bearer ${vuToken(data.tokens)}` },
    tags: { verb: "ITEMS" },
  });
  if (res.status === 401) {
    res = http.get(LIST_URL, {
      headers: { Authorization: `Bearer ${refreshVuToken()}` },
      tags: { verb: "ITEMS" },
    });
  }
  const ok = check(res, {
    "items 200": (r) => r.status === 200,
  });
  if (ok) iterationOk();
  sleep(1);
}
