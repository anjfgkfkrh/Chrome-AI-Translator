import type { RequestGroup, SegmentGroup } from "../../src/shared/messages";
import { uppercase } from "./mock-translator";

// Messages API 응답을 흉내 내는 도우미 (단위 테스트용)

export function messageResponse(text: string, extra: Record<string, unknown> = {}): Response {
  return jsonResponse(200, {
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 100, output_tokens: 50 },
    ...extra,
  });
}

export function translationResponse(groups: SegmentGroup[]): Response {
  return messageResponse(JSON.stringify({ groups }));
}

export function errorResponse(status: number, type: string, message: string, headers: Record<string, string> = {}) {
  return jsonResponse(status, { type: "error", error: { type, message } }, headers);
}

/** fetch에 넘긴 요청 본문 */
export function requestBody(init?: RequestInit): Record<string, any> {
  return JSON.parse(String(init?.body));
}

/** fetch 요청 본문에서 번역 요청 그룹을 꺼낸다. */
export function requestedGroups(init?: RequestInit): RequestGroup[] {
  return JSON.parse(requestBody(init).messages[0].content).groups;
}

/** 받은 그룹을 대문자로 돌려주는 목 API */
export async function echoUppercase(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return translationResponse(uppercase(requestedGroups(init)));
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
