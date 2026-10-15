import { beforeEach, describe, expect, it } from "vitest";
import { getSettings, setApiKey } from "../../src/shared/storage";
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
});
