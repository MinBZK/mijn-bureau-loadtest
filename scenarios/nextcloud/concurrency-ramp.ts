// Ramps concurrent VUs uploading a fixed-size file. The breaking point shows up
// as a jump in http_req_failed or a cliff in http_req_duration_p95 at the VU
// count where Nextcloud (PHP-FPM workers, DB connections, MinIO write contention)
// starts shedding work.
import { check, sleep } from "k6";
import crypto from "k6/crypto";
import { validateEnv } from "./_auth.ts";
import { iterationOk, iterationStart } from "./_safety.ts";
import { del, mkcol, put } from "./_webdav.ts";

const FOLDER = "/loadtest-concurrency-ramp";
const SIZE_BYTES = 1024 * 1024; // 1 MB
const PAYLOAD = crypto.randomBytes(SIZE_BYTES); // one buffer per VU; fresh bytes per PUT would tax the runner

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
  const res = mkcol(FOLDER);
  if (res.status !== 201 && res.status !== 405) {
    throw new Error(`MKCOL ${FOLDER} failed: ${res.status}`);
  }
}

export default function (): void {
  iterationStart();
  const filename = `cr-vu${__VU}-${__ITER}-${Date.now()}.bin`;
  const res = put(`${FOLDER}/${filename}`, PAYLOAD);
  const ok = check(res, {
    "PUT 2xx": (r) => r.status >= 200 && r.status < 300,
  });
  if (ok) iterationOk();
  sleep(1);
}

export function teardown(): void {
  // Removes the collection and every uploaded file; they land in the trashbin
  // until Nextcloud purges it.
  del(FOLDER);
}
