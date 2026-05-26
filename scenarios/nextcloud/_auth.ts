import encoding from "k6/encoding";

const BASE_URL_RAW = __ENV.TARGET_URL || "";
const USERNAME = __ENV.NEXTCLOUD_USERNAME || "";
const APP_PASSWORD = __ENV.NEXTCLOUD_APP_PASSWORD || "";

export const BASE_URL: string = BASE_URL_RAW.replace(/\/$/, "");
export const NEXTCLOUD_USER: string = USERNAME;
export const AUTH_HEADER: string = USERNAME
  ? `Basic ${encoding.b64encode(`${USERNAME}:${APP_PASSWORD}`)}`
  : "";
export const DAV_BASE: string = `${BASE_URL}/remote.php/dav/files/${NEXTCLOUD_USER}`;

// Call from setup(), not at module load: k6-operator's archive step has empty __ENV.
export function validateEnv(): void {
  if (!BASE_URL_RAW || !USERNAME || !APP_PASSWORD) {
    throw new Error(
      "TARGET_URL, NEXTCLOUD_USERNAME, NEXTCLOUD_APP_PASSWORD must be set on the TestRun runner",
    );
  }
}
