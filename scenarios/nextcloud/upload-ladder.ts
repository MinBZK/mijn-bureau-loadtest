// One VU uploads files of increasing size, producing a per-size latency baseline.
import { check, sleep } from "k6";
import crypto from "k6/crypto";
import exec from "k6/execution";
import { validateEnv } from "./_auth.ts";
import { del, mkcol, put } from "./_webdav.ts";

const FOLDER = "/loadtest-upload-ladder";

const SIZES: number[] = [
  64 * 1024,
  256 * 1024,
  1 * 1024 * 1024,
  4 * 1024 * 1024,
  16 * 1024 * 1024,
  64 * 1024 * 1024,
  128 * 1024 * 1024,
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

export function setup(): void {
  validateEnv();
  // SIZES is indexed by per-VU __ITER; parallelism > 1 segments the VU away and skips sizes.
  // The operator passes segments as CLI flags only when parallelism > 1, never as an env var.
  const segment = exec.test.options.executionSegment;
  if (segment && segment !== "0:1") {
    throw new Error("upload-ladder requires PARALLELISM=1");
  }
  const res = mkcol(FOLDER);
  if (res.status !== 201 && res.status !== 405) {
    throw new Error(`MKCOL ${FOLDER} failed: ${res.status}`);
  }
}

export default function (): void {
  const size = SIZES[__ITER];
  const filename = `ul-${size}-${Date.now()}.bin`;
  const res = put(`${FOLDER}/${filename}`, crypto.randomBytes(size), {
    size_bytes: size.toString(),
  });
  check(res, {
    [`PUT ${size}B → 2xx`]: (r) => r.status >= 200 && r.status < 300,
  });
  sleep(2);
}

export function teardown(): void {
  // Removes the collection and every uploaded file; they land in the trashbin
  // until Nextcloud purges it.
  del(FOLDER);
}
