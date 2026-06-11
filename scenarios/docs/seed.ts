// One-time dataset provisioner for the Docs journey, and its teardown.
// SEED_MODE=create (default): create up to SEED_DOC_COUNT documents — idempotent (tops up to target).
// SEED_MODE=delete: delete every document the load test created (title prefix "loadtest-").
// Run via `make seed app=docs` / `make unseed app=docs`.
import { check, sleep } from "k6";
import http, { type RefinedResponse, type ResponseType } from "k6/http";
import { getToken, validateEnv } from "./_auth.ts";

declare const console: { log: (...args: unknown[]) => void };

const BASE_URL: string = (__ENV.TARGET_URL || "").replace(/\/$/, "");
const API = `${BASE_URL}/api/v1.0`;

const MODE: string = __ENV.SEED_MODE || "create";
const COUNT: number = parseInt(__ENV.SEED_DOC_COUNT || "300", 10);
const PREFIX = "loadtest-seed-"; // created/counted docs
const CLEANUP_PREFIX = "loadtest-"; // unseed also clears journey-created docs

export const options = {
  scenarios: {
    seed: { executor: "shared-iterations", vus: 1, iterations: 1, maxDuration: "40m" },
  },
};

function authHeaders(token: string): { [k: string]: string } {
  return { Authorization: `Bearer ${token}` };
}

// Docs throttles document ops per user (default 80/min); wait out 429s instead of failing.
function retry429(
  fn: () => RefinedResponse<ResponseType | undefined>,
): RefinedResponse<ResponseType | undefined> {
  for (;;) {
    const res = fn();
    if (res.status !== 429) {
      return res;
    }
    const wait = parseFloat(res.headers["Retry-After"]);
    sleep(wait > 0 ? wait : 5);
  }
}

function listAll(token: string): { id: string; title: string }[] {
  const out: { id: string; title: string }[] = [];
  let url: string | null = `${API}/documents/all/?page_size=100`;
  while (url) {
    const res = retry429(() => http.get(url as string, { headers: authHeaders(token) }));
    if (res.status !== 200) {
      throw new Error(`list failed: ${res.status}`);
    }
    const page = (res.json("results") as { id: string; title: string }[]) || [];
    out.push(...page);
    url = (res.json("next") as string) || null;
  }
  return out;
}

export function setup(): { token: string } {
  validateEnv();
  return { token: getToken() };
}

export default function (data: { token: string }): void {
  const token = data.token;
  const auth = authHeaders(token);

  if (MODE === "delete") {
    const docs = listAll(token).filter((d) => (d.title || "").startsWith(CLEANUP_PREFIX));
    let deleted = 0;
    for (const d of docs) {
      const res = retry429(() => http.del(`${API}/documents/${d.id}/`, null, { headers: auth }));
      const ok = check(res, {
        "delete ok": (r) => r.status === 204 || r.status === 200 || r.status === 404,
      });
      if (ok) deleted++;
    }
    console.log(`unseed: deleted ${deleted}/${docs.length} documents with prefix "${CLEANUP_PREFIX}"`);
    if (deleted < docs.length) {
      throw new Error(`unseed: ${docs.length - deleted} documents could not be deleted`);
    }
    return;
  }

  const existing = listAll(token).filter((d) => (d.title || "").startsWith(PREFIX)).length;
  const toCreate = Math.max(0, COUNT - existing);
  console.log(`seed: ${existing} existing, creating ${toCreate} to reach ${COUNT}`);
  for (let i = 0; i < toCreate; i++) {
    const idx = existing + i;
    const create = retry429(() =>
      http.post(`${API}/documents/`, JSON.stringify({ title: `${PREFIX}${idx}` }), {
        headers: { ...auth, "Content-Type": "application/json" },
      }),
    );
    if (!check(create, { "create 201": (r) => r.status === 201 })) {
      throw new Error(`seed create failed at ${idx}: ${create.status} ${create.body}`);
    }
  }
  console.log(`seed: done (target ${COUNT})`);
}
