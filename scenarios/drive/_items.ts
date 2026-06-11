// Container discovery for test items: the user's main workspace when the deployment provisions
// one, else a root folder "loadtest-root" (created on first use). Drive never auto-creates a
// main workspace — no backend code path sets main_workspace=True (verified v0.14.0–v0.18.0).
import http from "k6/http";

const BASE_URL: string = (__ENV.TARGET_URL || "").replace(/\/$/, "");
const API = `${BASE_URL}/api/v1.0`;
const ROOT_TITLE = "loadtest-root";

export function getWorkspaceId(token: string): string {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const res = http.get(`${API}/items/`, { headers });
  if (res.status !== 200) {
    throw new Error(`items list failed: ${res.status}`);
  }
  const items =
    (res.json("results") as { id: string; title?: string; main_workspace?: boolean }[]) || [];
  const existing = items.find((i) => i.main_workspace) || items.find((i) => i.title === ROOT_TITLE);
  if (existing) {
    return existing.id;
  }
  const create = http.post(
    `${API}/items/`,
    JSON.stringify({ type: "folder", title: ROOT_TITLE }),
    { headers },
  );
  const id = create.json("id");
  if (create.status !== 201 || typeof id !== "string") {
    throw new Error(`root folder create failed: ${create.status}`);
  }
  return id;
}
