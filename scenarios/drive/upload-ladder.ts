// One VU uploads files of increasing size to Drive, producing a per-size latency baseline for the
// bandwidth path: create item → PUT bytes to the presigned MinIO URL → upload-ended. The PUT
// (tagged size_bytes) is the bandwidth-relevant step; run in-cluster so the runner's uplink isn't
// the limit. Auth is the same OIDC bearer as the Drive list scenario.
import { check, sleep } from "k6";
import crypto from "k6/crypto";
import exec from "k6/execution";
import http from "k6/http";
import { getToken, validateEnv } from "./_auth.ts";
import { getWorkspaceId } from "./_items.ts";

const BASE_URL: string = (__ENV.TARGET_URL || "").replace(/\/$/, "");
const API = `${BASE_URL}/api/v1.0`;

const SIZES: number[] = [
  64 * 1024,
  256 * 1024,
  1 * 1024 * 1024,
  4 * 1024 * 1024,
  16 * 1024 * 1024,
  64 * 1024 * 1024,
];

export const options = {
  scenarios: {
    upload_ladder: {
      executor: "shared-iterations",
      vus: 1,
      iterations: SIZES.length,
      maxDuration: "15m",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.5"],
  },
};

export function setup(): { token: string; workspaceId: string } {
  validateEnv();
  // SIZES is indexed by per-VU __ITER; parallelism > 1 segments the VU away and skips sizes.
  // The operator passes segments as CLI flags only when parallelism > 1, never as an env var.
  const segment = exec.test.options.executionSegment;
  if (segment && segment !== "0:1") {
    throw new Error("upload-ladder requires PARALLELISM=1");
  }
  const token = getToken();
  return { token, workspaceId: getWorkspaceId(token) };
}

export default function (data: { token: string; workspaceId: string }): void {
  const auth = { Authorization: `Bearer ${data.token}` };
  const size = SIZES[__ITER];

  // 1. create the file item → presigned MinIO upload URL
  const create = http.post(
    `${API}/items/${data.workspaceId}/children/`,
    JSON.stringify({ type: "file", filename: `ul-${size}-${Date.now()}.bin` }),
    { headers: { ...auth, "Content-Type": "application/json" }, tags: { verb: "CREATE" } },
  );
  if (!check(create, { "create 201": (r) => r.status === 201 })) {
    return;
  }
  const itemId = create.json("id");
  const policy = create.json("policy");
  if (typeof itemId !== "string" || typeof policy !== "string") {
    return;
  }

  // 2. PUT the bytes straight to MinIO (auth is in the presigned URL) — the bandwidth step
  const upload = http.put(policy, crypto.randomBytes(size), {
    headers: { "Content-Type": "application/octet-stream", "X-Amz-Acl": "private" },
    timeout: "300s",
    tags: { size_bytes: size.toString(), verb: "UPLOAD" },
  });
  check(upload, { [`PUT ${size}B → 2xx`]: (r) => r.status >= 200 && r.status < 300 });

  // 3. finalize (best-effort; large files may exceed the server's size limit at this step)
  http.post(`${API}/items/${itemId}/upload-ended/`, null, { headers: auth, tags: { verb: "UPLOAD_ENDED" } });

  // 4. clean up — soft-deletes to the trash; MinIO storage is reclaimed when the trash purges
  http.del(`${API}/items/${itemId}/`, null, { headers: auth, tags: { verb: "DELETE" } });

  sleep(2);
}
