import { beforeEach, describe, expect, it } from "vitest";
import {
  activeApiKey,
  defaultSettings,
  getSettings,
  setApiKey,
  setAutoTranslateOrigins,
  setCacheCleanup,
  setGlossary,
  setModel,
  setProvider,
  setTranslationOptions,
} from "../../src/shared/storage";
import { installChromeMock } from "./chrome-mock";

let chromeMock: ReturnType<typeof installChromeMock>;

beforeEach(() => {
  chromeMock = installChromeMock();
});

describe("설정 저장소", () => {
  it("저장된 값이 없으면 SPEC 6장의 기본값을 돌려준다", async () => {
    expect(await getSettings()).toEqual({
      provider: "anthropic",
      apiKeys: {},
      targetLanguage: "ko",
      glossary: {
        keep: ["LangChain", "LangGraph", "LangSmith", "Deep Agents", "GitHub", "Google", "Discord", "API", "CLI", "SDK"],
        map: {},
        version: 1,
      },
      autoTranslateOrigins: [],
      model: "claude-haiku-5-5",
      models: { anthropic: "claude-haiku-5-5", openrouter: "anthropic/claude-haiku-5.5" },
      translationMode: "accurate",
      maxOutputTokens: 32_000,
      cacheMaxMB: 8,
      cacheCleanupPercent: 80,
      cacheIdleTurns: 10,
      maxConcurrentRequests: 3,
      batchMaxNodes: 100,
    });
  });

  it("API 키는 settings.apiKeys.anthropic에 저장하고, 기본값은 저장소에 복사하지 않는다", async () => {
    await setApiKey("sk-ant-test");

    expect(chromeMock.storage).toEqual({ settings: { apiKeys: { anthropic: "sk-ant-test" } } });
    expect((await getSettings()).apiKeys).toEqual({ anthropic: "sk-ant-test" });
  });

  it("빈 값으로 저장하면 저장된 키를 지운다", async () => {
    await setApiKey("sk-ant-test");
    await setApiKey("");

    expect((await getSettings()).apiKeys).toEqual({});
  });

  it("돌려받은 설정을 고쳐도 기본값은 바뀌지 않는다", async () => {
    (await getSettings()).glossary.keep.push("Changed");

    expect((await getSettings()).glossary.keep).not.toContain("Changed");
  });

  it("번역 방식과 최대 출력 토큰을 저장하고, 기본값(정확하게, 32,000)이면 저장값을 지운다", async () => {
    await setTranslationOptions({ translationMode: "fast", maxOutputTokens: 64_000 });
    expect(chromeMock.storage).toEqual({ settings: { translationMode: "fast", maxOutputTokens: 64_000 } });

    await setTranslationOptions({ translationMode: "accurate", maxOutputTokens: 32_000 });
    expect(chromeMock.storage).toEqual({ settings: {} });
  });

  it("캐시 상한과 정리 기준을 저장하고, 기본값(8MB, 80%, 10턴)인 항목은 저장값을 지운다", async () => {
    await setCacheCleanup({ cacheMaxMB: 4, cacheCleanupPercent: 60, cacheIdleTurns: 25 });
    expect(chromeMock.storage).toEqual({ settings: { cacheMaxMB: 4, cacheCleanupPercent: 60, cacheIdleTurns: 25 } });

    await setCacheCleanup({ cacheMaxMB: 8, cacheCleanupPercent: 60, cacheIdleTurns: 10 });
    expect(chromeMock.storage).toEqual({ settings: { cacheCleanupPercent: 60 } });
  });

  it("자동 번역 사이트 목록을 저장하고, 비우면 저장값을 지운다", async () => {
    await setAutoTranslateOrigins(["https://docs.example.com"]);
    expect((await getSettings()).autoTranslateOrigins).toEqual(["https://docs.example.com"]);

    await setAutoTranslateOrigins([]);
    expect(chromeMock.storage).toEqual({ settings: {} });
  });
});

describe("용어집 저장 (SPEC 4.7, 13장 \"용어집 적용\")", () => {
  const defaults = defaultSettings().glossary;

  it("단어나 번역어가 바뀌면 버전을 올린다 (바뀌기 전의 캐시 번역을 다시 쓰지 않도록)", async () => {
    await setGlossary({ keep: [...defaults.keep, "Mintlify"], map: { agent: "에이전트" } });

    expect((await getSettings()).glossary).toEqual({
      keep: [...defaults.keep, "Mintlify"],
      map: { agent: "에이전트" },
      version: 2,
    });

    await setGlossary({ keep: defaults.keep, map: { agent: "에이전트" } });
    expect((await getSettings()).glossary.version).toBe(3);
  });

  it("순서만 바뀌면 버전은 그대로 두고 순서만 저장한다", async () => {
    await setGlossary({ keep: ["B", "A"], map: {} });
    await setGlossary({ keep: ["A", "B"], map: {} });

    expect((await getSettings()).glossary).toEqual({ keep: ["A", "B"], map: {}, version: 2 });
  });

  it("기본 용어집을 그대로 저장하면 저장값을 남기지 않는다", async () => {
    await setGlossary({ keep: defaults.keep, map: {} });

    expect(chromeMock.storage).toEqual({ settings: {} });
  });
});

describe("제공업체 (SPEC 13장 \"OpenRouter 추가\")", () => {
  it("키와 모델을 제공업체마다 따로 저장하고, 고른 제공업체의 것을 쓴다", async () => {
    await setApiKey("sk-ant-a", "anthropic");
    await setApiKey("sk-or-b", "openrouter");
    await setModel("claude-sonnet-5-5", "anthropic");
    await setModel("google/gemini-3.5-flash", "openrouter");

    let settings = await getSettings();
    expect(settings).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5-5" });
    expect(activeApiKey(settings)).toBe("sk-ant-a");

    await setProvider("openrouter");
    settings = await getSettings();
    expect(settings).toMatchObject({ provider: "openrouter", model: "google/gemini-3.5-flash" });
    expect(activeApiKey(settings)).toBe("sk-or-b");
    expect(chromeMock.storage).toEqual({
      settings: {
        provider: "openrouter",
        apiKeys: { anthropic: "sk-ant-a", openrouter: "sk-or-b" },
        models: { anthropic: "claude-sonnet-5-5", openrouter: "google/gemini-3.5-flash" },
      },
    });
  });

  it("제공업체가 하나였을 때 저장한 모델은 Anthropic 모델로 읽고, 다음에 저장할 때 옮긴다", async () => {
    chromeMock.storage.settings = { model: "claude-opus-5-5" };

    expect((await getSettings()).models).toEqual({ anthropic: "claude-opus-5-5", openrouter: "anthropic/claude-haiku-5.5" });

    await setModel("anthropic/claude-sonnet-5.5", "openrouter");
    expect(chromeMock.storage).toEqual({
      settings: { models: { anthropic: "claude-opus-5-5", openrouter: "anthropic/claude-sonnet-5.5" } },
    });
  });

  it("기본값(Anthropic, 각 제공업체의 비용 우선 모델)은 저장값을 남기지 않는다", async () => {
    await setProvider("openrouter");
    await setModel("google/gemini-3.5-flash", "openrouter");

    await setProvider("anthropic");
    await setModel("anthropic/claude-haiku-5.5", "openrouter");

    expect(chromeMock.storage).toEqual({ settings: {} });
  });

  it("고른 제공업체의 키가 없으면 다른 제공업체의 키가 있어도 키가 없는 것으로 본다", async () => {
    await setApiKey("sk-ant-a", "anthropic");
    await setProvider("openrouter");

    expect(activeApiKey(await getSettings())).toBeUndefined();
  });
});
