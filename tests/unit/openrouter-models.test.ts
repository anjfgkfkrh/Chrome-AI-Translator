// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { forgetOpenRouterModels, openRouterModelIds, openRouterModels } from "../../src/shared/openrouter-models";
import { jsonResponse, MODELS_URL, SAMPLE_MODELS, stubOpenRouter } from "../helpers/openrouter-mock";
import { installChromeMock } from "./chrome-mock";

let chromeMock: ReturnType<typeof installChromeMock>;

beforeEach(() => {
  chromeMock = installChromeMock();
  forgetOpenRouterModels();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

const DAY = 24 * 60 * 60 * 1000;

describe("OpenRouter 모델 정보 (SPEC 5.3.1)", () => {
  it("모델마다 최대 출력, 구조화된 출력, 사고 effort, 사고 필수 여부만 남긴다", async () => {
    stubOpenRouter({});

    const models = await openRouterModels();

    expect(models.get("anthropic/claude-haiku-5.5")).toEqual({
      id: "anthropic/claude-haiku-5.5",
      maxOutput: 128_000,
      structured: true,
      efforts: ["max", "xhigh", "high", "medium", "low", "none"],
      reasoningMandatory: false,
    });
    expect(models.get("anthropic/claude-sonnet-5.5")).toMatchObject({ reasoningMandatory: true });
    expect(models.get("plain/model")).toEqual({ id: "plain/model", structured: false, efforts: [], reasoningMandatory: false });
  });

  it("하루 동안은 다시 받지 않는다. 서비스 워커가 다시 떠도 저장해 둔 목록을 쓴다", async () => {
    const fetchMock = stubOpenRouter({});
    const now = Date.now();

    await openRouterModels(now);
    forgetOpenRouterModels(); // 서비스 워커가 멈췄다 다시 뜬 것처럼
    await openRouterModels(now + DAY - 1);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(chromeMock.storage.openrouterModels).toMatchObject({ at: now });
  });

  it("하루가 지나면 다시 받는다", async () => {
    const fetchMock = stubOpenRouter({});
    const now = Date.now();

    await openRouterModels(now);
    await openRouterModels(now + DAY + 1);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("받지 못하면 지난 목록을 쓰고, 그것도 없으면 빈 목록", async () => {
    stubOpenRouter({ models: () => jsonResponse(503, {}) });
    expect((await openRouterModels()).size).toBe(0);

    chromeMock.storage.openrouterModels = {
      at: 0,
      models: [{ id: "old/model", structured: false, efforts: [], reasoningMandatory: false }],
    };
    forgetOpenRouterModels();
    expect([...(await openRouterModels()).keys()]).toEqual(["old/model"]);
  });

  it("자동 완성 목록은 일괄 처리용(:batch)을 빼고 정렬한다 (SPEC 13장)", async () => {
    stubOpenRouter({});

    expect(await openRouterModelIds()).toEqual([
      "anthropic/claude-haiku-5.5",
      "anthropic/claude-sonnet-5.5",
      "deepseek/deepseek-chat",
      "plain/model",
    ]);
    expect(SAMPLE_MODELS.data.some((model) => model.id.endsWith(":batch"))).toBe(true);
  });

  it("목록은 키 없이 받는다", async () => {
    const fetchMock = stubOpenRouter({});

    await openRouterModels();

    expect(fetchMock.mock.calls[0]?.[0]).toBe(MODELS_URL);
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty("headers");
  });
});
