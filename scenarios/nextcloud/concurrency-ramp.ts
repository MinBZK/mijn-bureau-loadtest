// Ramps concurrent VUs uploading a fixed-size file. The breaking point shows up
// as a jump in http_req_failed or a cliff in http_req_duration_p95 at the VU
// count where Nextcloud (PHP-FPM workers, DB connections, MinIO write contention)
// starts shedding work.
import { check, sleep } from "k6";
import crypto from "k6/crypto";
import { validateEnv } from "./_auth.ts";
import { iterationOk, iterationStart } from "./_safety.ts";
import { mkcol, put } from "./_webdav.ts";

const FOLDER = "/loadtest-concurrency-ramp";
const SIZE_BYTES = 1024 * 1024; // 1 MB

export const options = {
  scenarios: {
    concurrency_ramp: {
      executor: "ramping-vus",
      startVUs: 1,
      stages: [
        { duration: "30s", target: 5 },
        { duration: "2m", target: 50 },
        { duration: "1m", target: 100 },
        { duration: "30s", target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.9"],
  },
};

export function setup(): void {
  validateEnv();
  mkcol(FOLDER);
}

export default function (): void {
  iterationStart();
  const filename = `cr-vu${__VU}-${__ITER}-${Date.now()}.bin`;
  const res = put(`${FOLDER}/${filename}`, crypto.randomBytes(SIZE_BYTES));
  const ok = check(res, {
    "PUT 2xx": (r) => r.status >= 200 && r.status < 300,
  });
  if (ok) iterationOk();
  sleep(1);
}
