import { vi } from "vitest";
import type { SegmentGroup } from "../../src/shared/messages";
import { SAMPLE_MODELS } from "./openrouter-sample";

// OpenRouter API를 흉내 내는 도우미 (단위 테스트용).

export { SAMPLE_MODELS };

export const MODELS_URL = "https://openrouter.ai/api/v1/models";
export const CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
export const KEY_URL = "https://openrouter.ai/api/v1/key";

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** chat completions 응답 (OpenAI 형식) */
export function chatResponse(
  content: string | { type: string; text: string }[] | null,
  extra: { finish_reason?: string; usage?: unknown; choice?: Record<string, unknown>; top?: Record<string, unknown> } = {},
): Response {
  return jsonResponse(200, {
    id: "gen-test",
    object: "chat.completion",
    choices: [{ message: { role: "assistant", content }, finish_reason: extra.finish_reason ?? "stop", ...extra.choice }],
    usage: extra.usage ?? { prompt_tokens: 100, completion_tokens: 50 },
    ...extra.top,
  });
}

export function chatTranslation(groups: SegmentGroup[]): Response {
  return chatResponse(JSON.stringify({ groups }));
}

/** 요청 본문에서 번역 요청 그룹을 꺼낸다. */
export function chatRequestedGroups(init?: RequestInit): { id: string; segments: string[] }[] {
  return JSON.parse(JSON.parse(String(init?.body)).messages[1].content).groups;
}

/** 주소마다 응답을 정해 fetch를 바꾼다. 정하지 않은 주소는 404 */
export function stubOpenRouter(handlers: {
  models?: () => Response;
  key?: (init?: RequestInit) => Response;
  chat?: (init?: RequestInit) => Response | Promise<Response>;
}) {
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url === MODELS_URL) return (handlers.models ?? (() => jsonResponse(200, SAMPLE_MODELS)))();
    if (url === KEY_URL && handlers.key) return handlers.key(init);
    if (url === CHAT_URL && handlers.chat) return handlers.chat(init);
    return jsonResponse(404, { error: { code: 404, message: `unexpected ${url}` } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
