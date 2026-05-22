// Realistic Docs user journey: a weighted mix of read/create/favorite operations with think-time,
// over a seeded dataset (run `make seed app=docs` first). Ramps to TARGET_VUS concurrent users and
// holds; sweep TARGET_VUS to find the breaking point. 429s are tagged separately. Auth is an OIDC
// Bearer token fetched in setup() (edits/search need session/collab auth — out of scope here).
import { check, sleep } from "k6";
import { Counter } from "k6/metrics";
import http from "k6/http";
import { getToken, validateEnv } from "./_auth.ts";
import { iterationOk, iterationStart } from "./_safety.ts";

const BASE_URL: string = (__ENV.TARGET_URL || "").replace(/\/$/, "");
const API = `${BASE_URL}/api/v1.0`;

const TARGET_VUS: number = parseInt(__ENV.TARGET_VUS || "25", 10);

const throttled = new Counter("throttled");

interface Ctx {
  token: string;
  docIds: string[];
}

interface Operation {
  name: string;
  weight: number;
  thinkTime: [number, number]; // seconds [min, max]
  run: (ctx: Ctx) => number; // performs the request, returns the HTTP status
}

function authHeaders(token: string): { [k: string]: string } {
  return { Authorization: `Bearer ${token}` };
}

function randItem<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

const operations: Operation[] = [
  {
    name: "list",
    weight: 25,
    thinkTime: [2, 5],
    run: (c) =>
      http.get(`${API}/documents/?page=1&ordering=-updated_at`, { headers: authHeaders(c.token), tags: { op: "list" } }).status,
  },
  {
    name: "open",
    weight: 25,
    thinkTime: [3, 8],
    run: (c) =>
      http.get(`${API}/documents/${randItem(c.docIds)}/`, { headers: authHeaders(c.token), tags: { op: "open" } }).status,
  },
  {
    name: "children",
    weight: 10,
    thinkTime: [1, 3],
    run: (c) =>
      http.get(`${API}/documents/${randItem(c.docIds)}/children/`, { headers: authHeaders(c.token), tags: { op: "children" } }).status,
  },
  {
    name: "favorite_list",
    weight: 5,
    thinkTime: [1, 3],
    run: (c) =>
      http.get(`${API}/documents/favorite_list/`, { headers: authHeaders(c.token), tags: { op: "favorite_list" } }).status,
  },
  {
    name: "create",
    weight: 5,
    thinkTime: [5, 10],
    run: (c) =>
      http.post(
        `${API}/documents/`,
        JSON.stringify({ title: `loadtest-journey-${__VU}-${Date.now()}` }),
        { headers: { ...authHeaders(c.token), "Content-Type": "application/json" }, tags: { op: "create" } },
      ).status,
  },
  {
    name: "favorite",
    weight: 3,
    thinkTime: [1, 3],
    run: (c) =>
      http.post(`${API}/documents/${randItem(c.docIds)}/favorite/`, null, { headers: authHeaders(c.token), tags: { op: "favorite" } }).status,
  },
];

export const options = {
  scenarios: {
    journey: {
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

// Weighted pick over `operations`; r is a uniform sample in [0, 1).
function pickOperation(r: number): Operation {
  const total = operations.reduce((sum, o) => sum + o.weight, 0);
  let threshold = r * total;
  for (const op of operations) {
    threshold -= op.weight;
    if (threshold < 0) return op;
  }
  return operations[operations.length - 1];
}

export function setup(): Ctx {
  validateEnv();
  const token = getToken();
  const res = http.get(`${API}/documents/?page=1`, { headers: authHeaders(token) });
  if (res.status !== 200) {
    throw new Error(`Docs list for setup failed: ${res.status}`);
  }
  const results = (res.json("results") as { id: string }[]) || [];
  const docIds = results.map((d) => d.id);
  if (docIds.length === 0) {
    throw new Error("no documents for the load-test user — run `make seed app=docs` first");
  }
  return { token, docIds };
}

export default function (ctx: Ctx): void {
  iterationStart();
  const op = pickOperation(Math.random());
  const status = op.run(ctx);
  if (status === 429) {
    throttled.add(1, { op: op.name });
  }
  const ok = check(status, { [`${op.name} ok`]: () => status >= 200 && status < 400 });
  if (ok) iterationOk();
  const [min, max] = op.thinkTime;
  sleep(min + Math.random() * (max - min));
}
