// Ramps concurrent VUs through the Conversations LLM path: each iteration creates a chat, POSTs
// one user message to /conversation/ and reads the full streamed completion, then deletes the
// chat. The completion (op:completion) dominates; its http_req_duration is the time to stream the
// whole answer. The limit is the model backend (Ollama tokens/s, OLLAMA_NUM_PARALLEL) plus the
// app's concurrently held streaming responses — sweep small levels (e.g. 1 2 4 8 16).
import { check, sleep } from "k6";
import http from "k6/http";
import { getToken, validateEnv } from "./_auth.ts";
import { iterationOk, iterationStart } from "./_safety.ts";

const BASE_URL: string = (__ENV.TARGET_URL || "").replace(/\/$/, "");
const API = `${BASE_URL}/api/v1.0`;

const PROMPT = "Answer in about 100 words: what is a load test?";

const TARGET_VUS: number = parseInt(__ENV.TARGET_VUS || "4", 10);

export const options = {
  scenarios: {
    conversation_ramp: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: __ENV.RAMP_UP || "30s", target: TARGET_VUS },
        { duration: __ENV.HOLD || "2m", target: TARGET_VUS },
      ],
      // Outlast the completion timeout so in-flight iterations still delete their chat.
      gracefulStop: "185s",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.9"],
  },
  tags: { target_vus: String(TARGET_VUS) },
};

export function setup(): { token: string } {
  validateEnv();
  return { token: getToken() };
}

export default function (data: { token: string }): void {
  iterationStart();
  const headers = { Authorization: `Bearer ${data.token}`, "Content-Type": "application/json" };

  const create = http.post(
    `${API}/chats/`,
    JSON.stringify({ title: `loadtest-conv-${__VU}-${__ITER}` }),
    { headers, tags: { op: "create" } },
  );
  if (!check(create, { "create 201": (r) => r.status === 201 })) {
    sleep(1);
    return;
  }
  const chatId = create.json("id");
  if (typeof chatId !== "string") {
    sleep(1);
    return;
  }

  // protocol=text streams the plain completion; the message shape is the Vercel AI SDK UIMessage.
  const completion = http.post(
    `${API}/chats/${chatId}/conversation/?protocol=text`,
    JSON.stringify({
      messages: [{ id: "1", role: "user", content: PROMPT, parts: [{ type: "text", text: PROMPT }] }],
    }),
    { headers, tags: { op: "completion" }, timeout: "180s" },
  );
  // The 200 is committed before generation starts; a non-empty body proves the stream produced.
  const ok = check(completion, {
    "completion streamed": (r) => r.status === 200 && typeof r.body === "string" && r.body.length > 0,
  });

  http.del(`${API}/chats/${chatId}/`, null, { headers, tags: { op: "delete" } });

  if (ok) iterationOk();
  sleep(1);
}
