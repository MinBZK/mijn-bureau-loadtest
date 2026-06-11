// Grist REST API auth: a per-user API key (generated in Grist after OIDC login), sent as Bearer.
// Call validateEnv() from setup(), not at module load: the k6-operator archive step sees empty __ENV.
const BASE_URL: string = (__ENV.TARGET_URL || "").replace(/\/$/, "");

export const API_BASE: string = `${BASE_URL}/api`;
export const AUTH_HEADER: string = __ENV.GRIST_API_KEY ? `Bearer ${__ENV.GRIST_API_KEY}` : "";

export function validateEnv(): void {
  for (const v of ["TARGET_URL", "GRIST_API_KEY"]) {
    if (!__ENV[v]) {
      throw new Error(`${v} must be set on the TestRun runner`);
    }
  }
}
