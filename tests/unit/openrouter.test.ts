// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RESPONSE_SCHEMA, systemPrompt, userMessage } from "../../src/background/prompt";
import { OpenRouterProvider } from "../../src/background/providers/openrouter";
import { ProviderError, type TranslateRequest } from "../../src/background/providers/types";
import { forgetOpenRouterModels } from "../../src/shared/openrouter-models";
import {
  CHAT_URL,
  chatResponse,
  jsonResponse,
  KEY_URL,
  stubOpenRouter,
} from "../helpers/openrouter-mock";
import { installChromeMock } from "./chrome-mock";

// OpenRouter 제공업체 (SPEC 5.3.1, 13장 "OpenRouter …" 결정)

const provider = new OpenRouterProvider();
const apiKey = "sk-or-unit-test-key";
const haiku = "anthropic/claude-haiku-5.5";
const request: TranslateRequest = {
  targetLanguage: "ko",
  glossary: { keep: ["LangChain"], map: { agent: "에이전트" } },
  groups: [{ id: "g1", segments: ["Get started"] }],
};
const options = { apiKey, maxTokens: 32_000, fast: false };
const TRANSLATED = '{"groups":[{"id":"g1","segments":["시작하기"]}]}';

beforeEach(() => {
  installChromeMock(); // 모델 정보를 저장해 둔다 (chrome.storage.local)
  forgetOpenRouterModels();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

function chatBody(fetchMock: ReturnType<typeof stubOpenRouter>): Record<string, any> {
  const call = fetchMock.mock.calls.find(([url]) => String(url) === CHAT_URL)!;
  return JSON.parse(String(call[1]?.body));
}

describe("OpenRouterProvider.translate: 요청", () => {
  it("Claude 모델: 시스템 프롬프트를 캐시 지점으로 표시하고, 구조화된 출력과 effort medium으로 보낸다", async () => {
    const fetchMock = stubOpenRouter({ chat: () => chatResponse(TRANSLATED) });

    await provider.translate(request, { ...options, model: haiku });

    const call = fetchMock.mock.calls.find(([url]) => String(url) === CHAT_URL)!;
    expect(call[1]?.method).toBe("POST");
    // 앱 표시 헤더(HTTP-Referer, X-OpenRouter-Title)는 보내지 않는다.
    expect(call[1]?.headers).toEqual({ Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" });
    expect(chatBody(fetchMock)).toEqual({
      model: haiku,
      max_tokens: 32_000,
      messages: [
        {
          role: "system",
          content: [{ type: "text", text: systemPrompt(request.glossary), cache_control: { type: "ephemeral" } }],
        },
        { role: "user", content: userMessage(request) },
      ],
      response_format: { type: "json_schema", json_schema: { name: "translation", strict: true, schema: RESPONSE_SCHEMA } },
      reasoning: { effort: "medium" },
    });
  });

  it("빠르게: 사고를 끌 수 있는 모델은 effort none, 사고가 필수인 모델은 medium 그대로", async () => {
    const fetchMock = stubOpenRouter({ chat: () => chatResponse(TRANSLATED) });

    await provider.translate(request, { ...options, model: haiku, fast: true });
    expect(chatBody(fetchMock).reasoning).toEqual({ effort: "none" });

    fetchMock.mockClear();
    await provider.translate(request, { ...options, model: "anthropic/claude-sonnet-5.5", fast: true });
    expect(chatBody(fetchMock).reasoning).toEqual({ effort: "medium" });
  });

  it("Claude가 아닌 모델은 시스템 프롬프트를 글로 보내고, 받지 않는 기능(구조화된 출력·사고)은 보내지 않는다", async () => {
    const fetchMock = stubOpenRouter({ chat: () => chatResponse(TRANSLATED) });

    await provider.translate(request, { ...options, model: "plain/model" });

    const body = chatBody(fetchMock);
    expect(body.messages[0]).toEqual({ role: "system", content: systemPrompt(request.glossary) });
    expect(body).not.toHaveProperty("response_format");
    expect(body).not.toHaveProperty("reasoning");
  });

  it("최대 출력 토큰이 모델 한도보다 크면 모델 한도로 줄인다", async () => {
    const fetchMock = stubOpenRouter({ chat: () => chatResponse(TRANSLATED) });

    await provider.translate(request, { ...options, model: "deepseek/deepseek-chat" });

    expect(chatBody(fetchMock).max_tokens).toBe(16_000);
  });

  it("모델 정보를 받지 못하면 구조화된 출력·사고를 보내지 않고, 최대 출력도 설정 그대로 보낸다", async () => {
    const fetchMock = stubOpenRouter({ models: () => jsonResponse(503, {}), chat: () => chatResponse(TRANSLATED) });

    await provider.translate(request, { ...options, model: haiku, fast: true });

    const body = chatBody(fetchMock);
    expect(body).toMatchObject({ max_tokens: 32_000 });
    expect(body).not.toHaveProperty("response_format");
    expect(body).not.toHaveProperty("reasoning");
  });
});

describe("OpenRouterProvider.translate: 응답", () => {
  it("문자열과 조각 배열 모두 읽고, 사용량은 입력·캐시 쓰기·캐시 읽기·출력으로 나눈다", async () => {
    stubOpenRouter({
      chat: () =>
        chatResponse([{ type: "text", text: '{"groups":[{"id":"g1",' }, { type: "text", text: '"segments":["시작하기"]}]}' }], {
          usage: {
            prompt_tokens: 1_000,
            completion_tokens: 50,
            prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 100 },
          },
        }),
    });
    const onUsage = vi.fn();

    expect(await provider.translate(request, { ...options, model: haiku, onUsage })).toEqual({
      groups: [{ id: "g1", segments: ["시작하기"] }],
      usage: { inputTokens: 300, cacheWriteTokens: 100, cacheReadTokens: 600, outputTokens: 50 },
    });
    expect(onUsage).toHaveBeenCalledOnce();
  });

  it.each([
    ["length", "truncated"],
    ["content_filter", "refusal"],
    ["error", "server"],
  ])("finish_reason %s → %s 오류. 쓸 수 없는 응답도 사용량은 알린다", async (finish, kind) => {
    stubOpenRouter({ chat: () => chatResponse('{"groups":[', { finish_reason: finish }) });
    const onUsage = vi.fn();

    await expect(provider.translate(request, { ...options, model: haiku, onUsage })).rejects.toMatchObject({ kind });
    expect(onUsage).toHaveBeenCalledOnce();
  });

  it("200 응답 안의 error도 상태 코드 기준으로 나눈다", async () => {
    stubOpenRouter({ chat: () => jsonResponse(200, { error: { code: 402, message: "Insufficient credits" } }) });
    await expect(provider.translate(request, { ...options, model: haiku })).rejects.toMatchObject({ kind: "credits" });

    stubOpenRouter({
      chat: () =>
        chatResponse("partial", { finish_reason: "error", choice: { error: { code: 502, message: "Provider disconnected" } } }),
    });
    await expect(provider.translate(request, { ...options, model: haiku })).rejects.toMatchObject({ kind: "server" });
  });

  it.each([
    [401, "auth"],
    [402, "credits"],
    [403, "refusal"],
    [404, "not_found"],
    [408, "timeout"],
    [429, "rate_limit"],
    [500, "server"],
    [502, "server"],
    [503, "server"],
    [400, "other"],
  ])("HTTP %i → %s (SPEC 13장 \"OpenRouter 오류\")", async (status, kind) => {
    stubOpenRouter({ chat: () => jsonResponse(status, { error: { code: status, message: "mocked" } }) });

    const error = await provider.translate(request, { ...options, model: haiku }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ kind, status, message: "mocked" });
  });

  it("429의 Retry-After를 밀리초로 넘긴다", async () => {
    stubOpenRouter({ chat: () => jsonResponse(429, { error: { code: 429, message: "slow down" } }, { "retry-after": "3" }) });

    await expect(provider.translate(request, { ...options, model: haiku })).rejects.toMatchObject({ retryAfterMs: 3_000 });
  });
});

describe("OpenRouterProvider.canDisableThinking", () => {
  it("모델 정보상 effort none을 받고 사고가 필수가 아닐 때만 끌 수 있다", async () => {
    stubOpenRouter({});

    expect(await provider.canDisableThinking(haiku)).toBe(true);
    expect(await provider.canDisableThinking("anthropic/claude-sonnet-5.5")).toBe(false);
    expect(await provider.canDisableThinking("deepseek/deepseek-chat")).toBe(false);
    expect(await provider.canDisableThinking("unknown/model")).toBe(false);
  });
});

describe("OpenRouterProvider.testConnection (SPEC 13장 \"OpenRouter 연결 테스트\")", () => {
  it("키는 키 확인 주소로, 모델 ID는 모델 목록으로 확인한다. 번역 요청(토큰)은 보내지 않는다", async () => {
    const fetchMock = stubOpenRouter({ key: () => jsonResponse(200, { data: { label: "test" } }) });

    expect(await provider.testConnection({ apiKey, model: haiku })).toEqual({
      ok: true,
      message: `연결 성공 (${haiku})`,
    });
    const keyCall = fetchMock.mock.calls.find(([url]) => String(url) === KEY_URL)!;
    expect(keyCall[1]?.headers).toEqual({ Authorization: `Bearer ${apiKey}` });
    expect(fetchMock.mock.calls.some(([url]) => String(url) === CHAT_URL)).toBe(false);
  });

  it("키가 틀리면 \"API 키를 확인하세요.\"", async () => {
    stubOpenRouter({ key: () => jsonResponse(401, { error: { code: 401, message: "User not found." } }) });

    expect(await provider.testConnection({ apiKey, model: haiku })).toEqual({ ok: false, message: "API 키를 확인하세요." });
  });

  it("목록에 없는 모델이면 쓸 수 없다고 알린다", async () => {
    stubOpenRouter({ key: () => jsonResponse(200, { data: {} }) });

    expect(await provider.testConnection({ apiKey, model: "unknown/model" })).toEqual({
      ok: false,
      message: "이 모델을 사용할 수 없습니다: unknown/model",
    });
  });

  it("모델 목록을 받지 못했으면 모델은 확인하지 않는다", async () => {
    stubOpenRouter({ models: () => jsonResponse(503, {}), key: () => jsonResponse(200, { data: {} }) });

    expect(await provider.testConnection({ apiKey, model: "unknown/model" })).toMatchObject({ ok: true });
  });

  it("서버 오류 문구에는 OpenRouter를 쓴다", async () => {
    stubOpenRouter({ key: () => jsonResponse(503, { error: { code: 503, message: "busy" } }) });

    expect(await provider.testConnection({ apiKey, model: haiku })).toEqual({
      ok: false,
      message: "OpenRouter 서버가 혼잡합니다. 잠시 후 다시 시도하세요.",
    });
  });
});
