import { beforeEach, describe, expect, it } from "vitest";
import {
  defaultSettings,
  getSettings,
  setApiKey,
  setAutoTranslateOrigins,
  setCacheCleanup,
  setGlossary,
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

  it("캐시 정리 기준을 저장하고, 기본값(80%, 10턴)이면 저장값을 지운다", async () => {
    await setCacheCleanup(60, 25);
    expect(chromeMock.storage).toEqual({ settings: { cacheCleanupPercent: 60, cacheIdleTurns: 25 } });

    await setCacheCleanup(80, 10);
    expect(chromeMock.storage).toEqual({ settings: {} });
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
