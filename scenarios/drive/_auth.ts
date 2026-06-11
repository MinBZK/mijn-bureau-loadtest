// Fetches OIDC tokens via password grant, used as a Bearer for the la-suite API.
// Any direct-access-grants client works (e.g. admin-cli) + the load-test user; these apps accept
// any valid realm token (they do not enforce the aud claim). Call getTokens() from setup() and
// pass the result to the default function; getToken() remains for single-token scenarios.
import http from "k6/http";

export interface Tokens {
  access: string;
  refresh: string;
  expiresIn: number;
  issuedAt: number;
}

function tokenRequest(body: { [key: string]: string }): Tokens {
  if (__ENV.KEYCLOAK_CLIENT_SECRET) {
    body.client_secret = __ENV.KEYCLOAK_CLIENT_SECRET;
  }
  const res = http.post(__ENV.KEYCLOAK_TOKEN_URL || "", body, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  if (res.status !== 200) {
    throw new Error(`Keycloak token request failed: ${res.status} ${res.body}`);
  }
  const access = res.json("access_token");
  const refresh = res.json("refresh_token");
  const expiresIn = res.json("expires_in");
  if (typeof access !== "string" || typeof refresh !== "string" || typeof expiresIn !== "number") {
    throw new Error("Keycloak token response missing access_token/refresh_token/expires_in");
  }
  return { access, refresh, expiresIn, issuedAt: Date.now() };
}

export function getTokens(): Tokens {
  return tokenRequest({
    grant_type: "password",
    client_id: __ENV.KEYCLOAK_CLIENT_ID || "",
    username: __ENV.KEYCLOAK_USERNAME || "",
    password: __ENV.KEYCLOAK_PASSWORD || "",
    scope: "openid",
  });
}

export function getToken(): string {
  return getTokens().access;
}

// Per-VU token renewal so runs can outlive the access-token lifespan. The realm is
// bruteForceProtected (quickLogin 1s → 60s lockout) and revokes refresh tokens on use, so VUs
// must never authenticate in a herd and cannot share a refresh chain. Renewal is scheduled at a
// random 50–90% of the lifespan FROM TOKEN ISSUE (not VU start — a late-starting VU must renew
// before the shared setup token dies, not after). A VU's first renewal is a fresh login starting
// its own session (the shared refresh token is single-use — only logins are smeared, by schedule
// and VU-start spread); every renewal after that chains the VU's own refresh grants.
let tokens: Tokens | null = null;
let ownSession = false;
let renewAt = 0;

function scheduleRenewal(): void {
  if (!tokens) {
    return;
  }
  renewAt = tokens.issuedAt + tokens.expiresIn * 1000 * (0.5 + 0.4 * Math.random());
}

function renew(): void {
  if (!tokens) {
    throw new Error("renew() before vuToken()");
  }
  if (!ownSession) {
    tokens = getTokens();
    ownSession = true;
  } else {
    try {
      tokens = tokenRequest({
        grant_type: "refresh_token",
        client_id: __ENV.KEYCLOAK_CLIENT_ID || "",
        refresh_token: tokens.refresh,
      });
    } catch {
      tokens = getTokens(); // refresh token expired (e.g. SSO idle) — fresh login
    }
  }
  scheduleRenewal();
}

export function vuToken(initial: Tokens): string {
  if (!tokens) {
    tokens = initial;
    scheduleRenewal();
  }
  if (Date.now() > renewAt) {
    renew();
  }
  return tokens.access;
}

// Backstop for a 401 that slips through (e.g. clock skew); retry the request with this.
export function refreshVuToken(): string {
  renew();
  return tokens!.access;
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
