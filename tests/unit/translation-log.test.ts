// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearTranslationLog,
  getTranslationLog,
  logDetails,
  logSummary,
  updateLogEntry,
  upsertLogEntry,
  type TranslationLogEntry,
} from "../../src/shared/translation-log";
import { installChromeMock } from "./chrome-mock";

let chromeMock: ReturnType<typeof installChromeMock>;

beforeEach(() => {
  chromeMock = installChromeMock();
});

function entry(id: string, extra: Partial<TranslationLogEntry> = {}): TranslationLogEntry {
  return {
    id,
    startedAt: new Date(2026, 9, 16, 15, 30).getTime(),
    durationMs: 12_345,
    page: { title: "LangSmith 튜토리얼", url: "https://docs.langchain.com/langsmith/observability-llm-tutorial" },
    provider: "Anthropic",
    model: "claude-haiku-5-5",
    tier: "Haiku5.5-medium(기본)",
    translationMode: "accurate",
    automatic: false,
    status: "done",
    groups: { total: 149, cached: 120, translated: 27, failed: 2 },
    usage: { inputTokens: 1200, cacheWriteTokens: 0, cacheReadTokens: 800, outputTokens: 400 },
    requests: 3,
    ...extra,
  };
}

const keepAsIs = (item: TranslationLogEntry) => item;

describe("최근 번역 기록 저장 (SPEC 13장 \"최근 번역 기록\")", () => {
  it("최근 것이 앞이고, 20건을 넘으면 가장 오래된 것부터 지운다", async () => {
    for (let i = 1; i <= 21; i++) await upsertLogEntry(`e${i}`, () => entry(`e${i}`), keepAsIs);

    const log = await getTranslationLog();
    expect(log).toHaveLength(20);
    expect(log[0]!.id).toBe("e21");
    expect(log.at(-1)!.id).toBe("e2");
  });

  it("같은 ID면 새로 넣지 않고 고친 뒤 맨 앞으로 옮긴다", async () => {
    await upsertLogEntry("a", () => entry("a"), keepAsIs);
    await upsertLogEntry("b", () => entry("b"), keepAsIs);

    await upsertLogEntry("a", () => entry("새로 만들면 안 됨"), (item) => ({ ...item, requests: item.requests + 1 }));

    expect((await getTranslationLog()).map((item) => [item.id, item.requests])).toEqual([
      ["a", 4],
      ["b", 3],
    ]);
  });

  it("고치기만 할 때는 지운 기록을 되살리지 않는다 (번역 중에 \"기록 지우기\")", async () => {
    await upsertLogEntry("a", () => entry("a"), keepAsIs);
    await clearTranslationLog();

    await updateLogEntry("a", (item) => ({ ...item, status: "done" }));

    expect(await getTranslationLog()).toEqual([]);
    expect(chromeMock.storage).not.toHaveProperty("translationLog");
  });

  it("동시에 여러 요청이 고쳐도 잃지 않는다", async () => {
    await upsertLogEntry("a", () => entry("a", { requests: 0 }), keepAsIs);

    await Promise.all(
      Array.from({ length: 5 }, () => updateLogEntry("a", (item) => ({ ...item, requests: item.requests + 1 }))),
    );

    expect((await getTranslationLog())[0]!.requests).toBe(5);
  });
});

describe("기록 보여 주기 (SPEC 13장 \"M7 화면 문구\"의 최근 번역)", () => {
  it("요약 한 줄: 시각 · 페이지 제목 · 번역 품질 · 결과 · 전체 (캐시) · 걸린 시간", () => {
    expect(logSummary(entry("a"))).toBe(
      "10월 16일 15:30 · LangSmith 튜토리얼 · Haiku5.5-medium(기본) · 완료 · 149개 (캐시 120) · 12.3초",
    );
  });

  it("단계에 없는 설정은 \"직접 설정\", 제목이 없으면 주소, 결과는 번역 중·일부 실패·오류·중단", () => {
    expect(logSummary(entry("a", { tier: undefined, page: { title: "", url: "https://example.com/a" }, status: "aborted" }))).toBe(
      "10월 16일 15:30 · https://example.com/a · 직접 설정 · 중단 · 149개 (캐시 120) · 12.3초",
    );
    expect(logSummary(entry("a", { status: "translating" }))).toContain(" · 번역 중 · ");
    expect(logSummary(entry("a", { status: "partial" }))).toContain(" · 일부 실패 · ");
    expect(logSummary(entry("a", { status: "error" }))).toContain(" · 오류 · ");
  });

  it("펼치면 페이지·제공업체·모델·번역 품질·시작 방법·결과(원인)·문자열·토큰·API 요청·걸린 시간", () => {
    const details = logDetails(
      entry("a", { status: "partial", cause: "요청 한도를 초과했습니다. 잠시 후 다시 시도하세요.", automatic: true }),
    );

    expect(details).toEqual([
      ["페이지", "LangSmith 튜토리얼 (https://docs.langchain.com/langsmith/observability-llm-tutorial)"],
      ["제공업체", "Anthropic"],
      ["모델", "claude-haiku-5-5"],
      ["번역 품질", "Haiku5.5-medium(기본)"],
      ["시작 방법", "자동"],
      ["결과", "일부 실패: 요청 한도를 초과했습니다. 잠시 후 다시 시도하세요."],
      ["문자열", "전체 149 · 캐시 120 · 새로 번역 27 · 원문으로 남김 2"],
      ["토큰", "입력 1,200 · 캐시 쓰기 0 · 캐시 읽기 800 · 출력 400"],
      ["API 요청", "3회"],
      ["걸린 시간", "12.3초"],
    ]);
  });

  it("단계에 없는 설정은 번역 방식도 함께 보여 준다", () => {
    const details = logDetails(entry("a", { tier: undefined, translationMode: "fast" }));

    expect(details).toContainEqual(["번역 품질", "직접 설정 (빠르게)"]);
  });
});
