// Thin WebDAV verb wrappers. Every request tags `verb` so dashboards can
// break out latency-by-verb. Callers add scenario-specific tags via the
// optional `extraTags` argument.
import http, { RefinedResponse, ResponseType } from "k6/http";
import { AUTH_HEADER, DAV_BASE } from "./_auth.ts";

type Tags = Record<string, string>;

function headers(extra?: Record<string, string>): Record<string, string> {
  return { Authorization: AUTH_HEADER, ...(extra || {}) };
}

export function mkcol(
  path: string,
  extraTags: Tags = {},
): RefinedResponse<ResponseType | undefined> {
  return http.request("MKCOL", `${DAV_BASE}${path}`, null, {
    headers: headers(),
    tags: { verb: "MKCOL", ...extraTags },
  });
}

export function put(
  path: string,
  body: ArrayBuffer | string,
  extraTags: Tags = {},
  timeout = "300s",
): RefinedResponse<ResponseType | undefined> {
  return http.put(`${DAV_BASE}${path}`, body, {
    headers: headers({ "Content-Type": "application/octet-stream" }),
    tags: { verb: "PUT", ...extraTags },
    timeout,
  });
}

export function propfind(
  path: string = "",
  depth: "0" | "1" | "infinity" = "0",
  extraTags: Tags = {},
): RefinedResponse<ResponseType | undefined> {
  return http.request("PROPFIND", `${DAV_BASE}${path}`, null, {
    headers: headers({ Depth: depth }),
    tags: { verb: "PROPFIND", ...extraTags },
  });
}
