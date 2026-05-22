// Fetches an OIDC access token via password grant, used as a Bearer for the la-suite API.
// Any direct-access-grants client works (e.g. admin-cli) + the load-test user; these apps accept
// any valid realm token (they do not enforce the aud claim). Call getToken() from setup() and pass
// the token to the default function — one token is shared across VUs for the run.
import http from "k6/http";

export function getToken(): string {
  const body: { [key: string]: string } = {
    grant_type: "password",
    client_id: __ENV.KEYCLOAK_CLIENT_ID || "",
    username: __ENV.KEYCLOAK_USERNAME || "",
    password: __ENV.KEYCLOAK_PASSWORD || "",
    scope: "openid",
  };
  if (__ENV.KEYCLOAK_CLIENT_SECRET) {
    body.client_secret = __ENV.KEYCLOAK_CLIENT_SECRET;
  }
  const res = http.post(__ENV.KEYCLOAK_TOKEN_URL || "", body, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  if (res.status !== 200) {
    throw new Error(`Keycloak token request failed: ${res.status}`);
  }
  const token = res.json("access_token");
  if (typeof token !== "string") {
    throw new Error("Keycloak token response missing access_token");
  }
  return token;
}

export function validateEnv(): void {
  for (const v of [
    "TARGET_URL",
    "KEYCLOAK_TOKEN_URL",
    "KEYCLOAK_CLIENT_ID",
    "KEYCLOAK_USERNAME",
    "KEYCLOAK_PASSWORD",
  ]) {
    if (!__ENV[v]) {
      throw new Error(`${v} must be set on the TestRun runner`);
    }
  }
}
