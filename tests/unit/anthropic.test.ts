import { describe, expect, it, vi } from "vitest";
import { RESPONSE_SCHEMA, systemPrompt } from "../../src/background/prompt";
import { AnthropicProvider } from "../../src/background/providers/anthropic";
import { ProviderError, type TranslateRequest } from "../../src/background/providers/types";
import { messageResponse, requestBody } from "../helpers/anthropic-mock";

const provider = new AnthropicProvider();
const apiKey = "sk-ant-unit-test-key";
const model = "claude-haiku-5-5";
const NETWORK_MESSAGE = "네트워크에 연결할 수 없습니다. 인터넷 연결을 확인하세요.";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function apiError(status: number, type: string, message: string): Response {
  return jsonResponse(status, { type: "error", error: { type, message } });
}

function stubFetch(impl: () => Promise<Response>) {
  const fetchMock = vi.fn<typeof fetch>(impl);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("AnthropicProvider.testConnection", () => {
  it("연결 테스트의 사용량도 알린다 (SPEC 13장 \"사용량에 넣는 응답\")", async () => {
    stubFetch(async () => messageResponse("pong", { usage: { input_tokens: 8, output_tokens: 4 } }));
    const onUsage = vi.fn();

    await provider.testConnection({ apiKey, model, onUsage });

    expect(onUsage).toHaveBeenCalledExactlyOnceWith({
      inputTokens: 8,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 4,
    });
  });

  it("SPEC 5.3 형식으로 짧은 요청을 1회 보낸다", async () => {
    const fetchMock = stubFetch(async () => jsonResponse(200, { type: "message", content: [] }));

    expect(await provider.testConnection({ apiKey, model })).toEqual({
      ok: true,
      message: "연결 성공 (claude-haiku-5-5)",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "anthropic-dangerous-direct-browser-access": "true",
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      model,
      max_tokens: 16,
      messages: [{ role: "user", content: "ping" }],
    });
  });

  it.each([
    [401, "authentication_error", "API 키를 확인하세요."],
    [403, "permission_error", "API 키를 확인하세요."],
    [404, "not_found_error", "이 모델을 사용할 수 없습니다: claude-haiku-5-5"],
    [429, "rate_limit_error", "요청 한도를 초과했습니다. 잠시 후 다시 시도하세요."],
    [500, "api_error", "Anthropic 서버가 혼잡합니다. 잠시 후 다시 시도하세요."],
    [529, "overloaded_error", "Anthropic 서버가 혼잡합니다. 잠시 후 다시 시도하세요."],
  ])("HTTP %i → 안내 문구를 보여주고 재시도하지 않는다", async (status, type, message) => {
    const fetchMock = stubFetch(async () => apiError(status, type, "detail"));

    const result = await provider.testConnection({ apiKey, model });

    expect(result).toEqual({ ok: false, message });
    expect(result.message).not.toContain(apiKey);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("그 밖의 오류는 API 오류 메시지를 그대로 보여준다", async () => {
    const detail = "Your credit balance is too low to access the Anthropic API.";
    stubFetch(async () => apiError(400, "invalid_request_error", detail));

    expect(await provider.testConnection({ apiKey, model })).toEqual({ ok: false, message: `연결 실패: ${detail}` });
  });

  it("오류 본문을 읽을 수 없으면 HTTP 상태 코드를 보여준다", async () => {
    stubFetch(async () => new Response("I'm a teapot", { status: 418 }));

    expect(await provider.testConnection({ apiKey, model })).toEqual({ ok: false, message: "연결 실패: HTTP 418" });
  });

  it("서버에 닿지 못하면 네트워크 안내를 보여준다", async () => {
    stubFetch(async () => {
      throw new TypeError("Failed to fetch");
    });

    expect(await provider.testConnection({ apiKey, model })).toEqual({ ok: false, message: NETWORK_MESSAGE });
  });

  it("30초 제한 시간을 걸고, 시간이 지나면 네트워크 안내를 보여준다", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = stubFetch(async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });

    expect(await provider.testConnection({ apiKey, model })).toEqual({ ok: false, message: NETWORK_MESSAGE });
    expect(timeout).toHaveBeenCalledWith(30_000);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(timeout.mock.results[0]?.value);
  });
});

describe("AnthropicProvider.translate", () => {
  const request: TranslateRequest = {
    targetLanguage: "ko",
    glossary: { keep: ["LangChain"], map: { agent: "에이전트" } },
    groups: [{ id: "g1", segments: ["Get started"] }],
  };

  it("목록의 모델: 시스템 프롬프트 캐시, effort medium, 구조화된 출력으로 보낸다 (SPEC 13장)", async () => {
    const fetchMock = stubFetch(async () => messageResponse('{"groups":[{"id":"g1","segments":["시작하기"]}]}'));

    await provider.translate(request, { apiKey, model });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init?.headers).toMatchObject({ "x-api-key": apiKey, "anthropic-dangerous-direct-browser-access": "true" });
    expect(requestBody(init)).toEqual({
      model,
      max_tokens: 16_000,
      system: [{ type: "text", text: systemPrompt(request.glossary), cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: JSON.stringify({ target_language: "ko", groups: request.groups }) }],
      output_config: { effort: "medium", format: { type: "json_schema", schema: RESPONSE_SCHEMA } },
    });
  });

  it("직접 입력한 모델에는 effort와 구조화된 출력을 보내지 않는다", async () => {
    const fetchMock = stubFetch(async () => messageResponse('{"groups":[]}'));

    await provider.translate(request, { apiKey, model: "claude-custom-model" });

    expect(requestBody(fetchMock.mock.calls[0]![1])).not.toHaveProperty("output_config");
  });

  it("text 블록만 읽어 그룹과 사용량(입력·캐시 쓰기·캐시 읽기·출력)을 돌려준다", async () => {
    stubFetch(async () =>
      messageResponse("", {
        content: [
          { type: "thinking", thinking: "" },
          { type: "text", text: '{"groups":[{"id":"g1",' },
          { type: "text", text: '"segments":["시작하기"]}]}' },
        ],
        usage: { input_tokens: 20, cache_creation_input_tokens: 600, cache_read_input_tokens: 0, output_tokens: 15 },
      }),
    );

    expect(await provider.translate(request, { apiKey, model })).toEqual({
      groups: [{ id: "g1", segments: ["시작하기"] }],
      usage: { inputTokens: 20, cacheWriteTokens: 600, cacheReadTokens: 0, outputTokens: 15 },
    });
  });

  it.each([
    ["거절", '{"groups":[', { stop_reason: "refusal" }],
    ["max_tokens에서 잘림", '{"groups":[', { stop_reason: "max_tokens" }],
    ["JSON 아님", "not json", {}],
  ])("쓸 수 없는 응답(%s)도 사용량을 알린다 (SPEC 13장 \"사용량에 넣는 응답\")", async (_case, text, extra) => {
    stubFetch(async () => messageResponse(text, extra));
    const onUsage = vi.fn();

    await expect(provider.translate(request, { apiKey, model, onUsage })).rejects.toBeInstanceOf(ProviderError);

    expect(onUsage).toHaveBeenCalledExactlyOnceWith({
      inputTokens: 100,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 50,
    });
  });

  it("오류 응답(HTTP 429 등)에는 사용량이 없으므로 알리지 않는다", async () => {
    stubFetch(async () => apiError(429, "rate_limit_error", "slow down"));
    const onUsage = vi.fn();

    await expect(provider.translate(request, { apiKey, model, onUsage })).rejects.toBeInstanceOf(ProviderError);

    expect(onUsage).not.toHaveBeenCalled();
  });

  it.each([
    ["refusal", "refusal"],
    ["max_tokens", "format"],
  ])("stop_reason %s → %s 오류", async (stopReason, kind) => {
    stubFetch(async () => messageResponse('{"groups":[', { stop_reason: stopReason }));

    await expect(provider.translate(request, { apiKey, model })).rejects.toMatchObject({ kind });
  });

  it("429의 retry-after(초)를 밀리초로 넘긴다", async () => {
    stubFetch(async () => new Response("{}", { status: 429, headers: { "retry-after": "2" } }));

    const error = await provider.translate(request, { apiKey, model }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ kind: "rate_limit", status: 429, retryAfterMs: 2_000 });
  });
});
