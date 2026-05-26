// Opt-in: abort if FAIL_SAFE_THRESHOLD consecutive iterations don't reach iterationOk().
// Counter is per-VU.
import exec from "k6/execution";

const THRESHOLD: number = parseInt(__ENV.FAIL_SAFE_THRESHOLD || "10", 10);

let consecutiveUnfinished = 0;

export function iterationStart(): void {
  if (consecutiveUnfinished >= THRESHOLD) {
    exec.test.abort(
      `Aborting: ${consecutiveUnfinished} consecutive iterations did not reach iterationOk() (threshold ${THRESHOLD})`,
    );
  }
  consecutiveUnfinished += 1;
}

export function iterationOk(): void {
  consecutiveUnfinished = 0;
}
