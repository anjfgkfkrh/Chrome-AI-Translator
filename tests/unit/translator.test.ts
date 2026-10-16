// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestGroup, SegmentGroup } from "../../src/shared/messages";
import { defaultSettings, type Settings } from "../../src/shared/storage";
import type { TokenUsage } from "../../src/shared/usage";
import {
  echoUppercase,
  errorResponse,
  requestBody,
  messageResponse,
  requestedGroups,
  translationResponse,
} from "../helpers/anthropic-mock";
import { uppercase } from "../helpers/mock-translator";
import { installChromeMock } from "./chrome-mock";

// 동시 요청 제한은 모듈 전역이므로 테스트마다 모듈을 새로 불러온다.
let translateGroups: typeof import("../../src/background/translator").translateGroups;
let AnthropicProvider: typeof import("../../src/background/providers/anthropic").AnthropicProvider;
let chromeMock: ReturnType<typeof installChromeMock>;

beforeEach(async () => {
  chromeMock = installChromeMock(); // 캐시 저장소 (chrome.storage.local)
  vi.resetModules();
  ({ translateGroups } = await import("../../src/background/translator"));
  ({ AnthropicProvider } = await import("../../src/background/providers/anthropic"));
  vi.spyOn(Math, "random").mockReturnValue(0.5); // 백오프 편차 없음 (×1.0)
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

function group(id: string, ...segments: string[]): RequestGroup {
  return { id, segments };
}

function words(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `word${i}`);
}

function stubFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  const fetchMock = vi.fn<typeof fetch>(impl);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** fetch 응답을 차례로 돌려준다. 마지막 응답은 계속 쓴다. */
function stubFetchSequence(...responses: (() => Response | Promise<Response>)[]) {
  let call = 0;
  return stubFetch(async () => responses[Math.min(call++, responses.length - 1)]!());
}

function run(
  groups: RequestGroup[],
  options: {
    settings?: Partial<Settings>;
    signal?: AbortSignal;
    turn?: number;
    onUsage?: (usage: TokenUsage) => void;
  } = {},
) {
  const delivered: SegmentGroup[] = [];
  const promise = translateGroups({
    provider: new AnthropicProvider(),
    apiKey: "sk-ant-test",
    settings: { ...defaultSettings(), ...options.settings },
    groups,
    turn: options.turn ?? 1,
    signal: options.signal ?? new AbortController().signal,
    onResults: (results) => delivered.push(...results),
    onUsage: options.onUsage,
  });
  return { delivered, promise };
}

/**
 * fetch가 n번 불릴 때까지 기다린다. 캐시 키 계산(Web Crypto)은 가짜 타이머와 상관없이 실제로 비동기라서,
 * 시계를 돌리기 전에 첫 요청이 나갔는지 확인해야 한다. setImmediate는 가짜로 바꾸지 않았다.
 */
async function untilCalls(fetchMock: ReturnType<typeof stubFetch>, n: number): Promise<void> {
  while (fetchMock.mock.calls.length < n) await new Promise((resolve) => setImmediate(resolve));
}

function requestedIds(fetchMock: ReturnType<typeof stubFetch>): string[][] {
  return fetchMock.mock.calls.map(([, init]) => requestedGroups(init).map((g) => g.id));
}

describe("배치 (SPEC 4.2, 13장)", () => {
  it("세그먼트 100개가 넘으면 새 배치를 열고, 그룹은 쪼개지 않는다", async () => {
    const fetchMock = stubFetch(echoUppercase);
    const groups = [group("g1", ...words(40)), group("g2", ...words(40)), group("g3", ...words(40))];

    const { delivered, promise } = run(groups);
    await promise;

    expect(requestedIds(fetchMock)).toEqual([["g1", "g2"], ["g3"]]);
    expect(delivered).toEqual(expect.arrayContaining(uppercase(groups)));
  });

  it("약 9,000자(≈3,000토큰)가 넘으면 새 배치를 연다", async () => {
    const fetchMock = stubFetch(echoUppercase);
    const long = "x".repeat(4_000);

    await run([group("g1", long), group("g2", long), group("g3", long)]).promise;

    expect(requestedIds(fetchMock)).toEqual([["g1", "g2"], ["g3"]]);
  });

  it("그룹 하나가 한도를 넘으면 조각으로 나눠 보내고, 결과를 합쳐 원래 ID로 넘긴다", async () => {
    const fetchMock = stubFetch(echoUppercase);
    const big = group("g1", ...words(150));

    const { delivered, promise } = run([big]);
    await promise;

    expect(requestedIds(fetchMock)).toEqual([["g1#1"], ["g1#2"]]);
    expect(delivered).toEqual(uppercase([big]));
  });

  it("문맥을 빼면 한도에 드는 그룹은 문맥만 빼고 보낸다", async () => {
    const fetchMock = stubFetch(echoUppercase);

    await run([{ id: "g1", segments: ["short"], context: "c".repeat(9_000) }]).promise;

    expect(requestedGroups(fetchMock.mock.calls[0]![1])).toEqual([{ id: "g1", segments: ["short"] }]);
  });

  it("동시 요청은 탭(작업)이 여러 개여도 합쳐서 3개까지만 보낸다", async () => {
    const waiting: (() => void)[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    stubFetch(
      (_input, init) =>
        new Promise((resolve) => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          waiting.push(() => {
            inFlight--;
            resolve(translationResponse(uppercase(requestedGroups(init))));
          });
        }),
    );
    const threeBatches = (prefix: string) => [1, 2, 3].map((n) => group(`${prefix}${n}`, ...words(100)));

    const first = run(threeBatches("a"));
    const second = run(threeBatches("b"));
    await vi.waitFor(() => expect(waiting.length).toBe(3));
    while (inFlight > 0) {
      waiting.shift()!();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await Promise.all([first.promise, second.promise]);

    expect(maxInFlight).toBe(3);
    expect(first.delivered).toHaveLength(3);
    expect(second.delivered).toHaveLength(3);
  });
});

describe("재시도 (SPEC 5.4, 13장)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    return () => vi.useRealTimers();
  });

  it("429는 retry-after만큼 기다렸다가 다시 보낸다", async () => {
    const fetchMock = stubFetchSequence(
      () => errorResponse(429, "rate_limit_error", "Too many requests", { "retry-after": "2" }),
      () => translationResponse([{ id: "g1", segments: ["안녕"] }]),
    );

    const { delivered, promise } = run([group("g1", "Hello")]);
    await untilCalls(fetchMock, 1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(delivered).toEqual([{ id: "g1", segments: ["안녕"] }]);
  });

  it("429에 retry-after가 없으면 1초 → 2초 → 4초 뒤 다시 보내고, 3번 모두 실패하면 원문으로 둔다", async () => {
    const fetchMock = stubFetchSequence(() => errorResponse(429, "rate_limit_error", "Too many requests"));

    const { delivered, promise } = run([group("g1", "Hello")]);
    await untilCalls(fetchMock, 1);
    const callsAt = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
      return fetchMock.mock.calls.length;
    };

    expect(await callsAt(999)).toBe(1);
    expect(await callsAt(1)).toBe(2); // 1초
    expect(await callsAt(1_999)).toBe(2);
    expect(await callsAt(1)).toBe(3); // +2초
    expect(await callsAt(3_999)).toBe(3);
    expect(await callsAt(1)).toBe(4); // +4초
    const summary = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(delivered).toEqual([]);
    expect(summary.failed).toBe(1);
    expect(summary.lastError).toMatchObject({ kind: "rate_limit" });
  });

  it("retry-after는 최대 60초까지만 기다린다", async () => {
    const fetchMock = stubFetchSequence(
      () => errorResponse(429, "rate_limit_error", "slow down", { "retry-after": "600" }),
      () => translationResponse([{ id: "g1", segments: ["안녕"] }]),
    );

    const { promise } = run([group("g1", "Hello")]);
    await untilCalls(fetchMock, 1);
    await vi.advanceTimersByTimeAsync(60_000);
    await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("529(과부하)는 같은 간격으로 다시 보내 성공하면 결과를 넘긴다", async () => {
    const overloaded = () => errorResponse(529, "overloaded_error", "Overloaded");
    const fetchMock = stubFetchSequence(overloaded, overloaded, () =>
      translationResponse([{ id: "g1", segments: ["안녕"] }]),
    );

    const { delivered, promise } = run([group("g1", "Hello")]);
    await untilCalls(fetchMock, 1);
    await vi.advanceTimersByTimeAsync(3_000);
    await promise;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(delivered).toEqual([{ id: "g1", segments: ["안녕"] }]);
  });

  it("네트워크 오류는 1초 뒤 한 번만 다시 보낸다", async () => {
    const fetchMock = stubFetch(async () => {
      throw new TypeError("Failed to fetch");
    });

    const { promise } = run([group("g1", "Hello")]);
    await untilCalls(fetchMock, 1);
    await vi.advanceTimersByTimeAsync(1_000);
    const summary = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(summary).toMatchObject({ failed: 1, lastError: { kind: "network" } });
  });

  it("401이면 다시 보내지 않고 번역 전체를 멈춘다 (진행 중인 다른 배치도 취소)", async () => {
    let otherAborted = false;
    let call = 0;
    const fetchMock = stubFetch((_input, init) => {
      if (call++ === 0) return Promise.resolve(errorResponse(401, "authentication_error", "invalid x-api-key"));
      return new Promise((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => {
          otherAborted = true;
          reject(init.signal!.reason);
        }),
      );
    });

    const { promise } = run([group("g1", ...words(100)), group("g2", ...words(100))]);

    await expect(promise).rejects.toMatchObject({ kind: "auth" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(otherAborted).toBe(true);
  });
});

describe("응답 검증과 재요청 (SPEC 4.3, 13장)", () => {
  it("JSON이 아닌 응답은 그 배치를 한 번 더 보낸다", async () => {
    const fetchMock = stubFetchSequence(
      () => messageResponse("Sorry, here is the translation: ..."),
      () => translationResponse([{ id: "g1", segments: ["시작하기"] }]),
    );

    const { delivered, promise } = run([group("g1", "Get started")]);
    await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(delivered).toEqual([{ id: "g1", segments: ["시작하기"] }]);
  });

  it("두 번 다 JSON이 아니면 원문으로 두고 세 번째는 보내지 않는다", async () => {
    const fetchMock = stubFetchSequence(() => messageResponse("not json"));

    const { delivered, promise } = run([group("g1", "a"), group("g2", "b")]);
    const summary = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(delivered).toEqual([]);
    expect(summary).toMatchObject({ failed: 2, lastError: { kind: "format" } });
  });

  it("세그먼트 개수가 다른 그룹만 다시 보낸다", async () => {
    const fetchMock = stubFetchSequence(
      () =>
        translationResponse([
          { id: "g1", segments: ["하나"] },
          { id: "g2", segments: ["둘", "셋"] }, // 개수 불일치
        ]),
      () => translationResponse([{ id: "g2", segments: ["둘"] }]),
    );

    const { delivered, promise } = run([group("g1", "one"), group("g2", "two")]);
    await promise;

    expect(requestedIds(fetchMock)).toEqual([["g1", "g2"], ["g2"]]);
    expect(delivered).toEqual([
      { id: "g1", segments: ["하나"] },
      { id: "g2", segments: ["둘"] },
    ]);
  });

  it("빈 세그먼트도 형식 오류로 보고 다시 보낸다", async () => {
    const fetchMock = stubFetchSequence(
      () => translationResponse([{ id: "g1", segments: ["  "] }]),
      () => translationResponse([{ id: "g1", segments: ["그리고"] }]),
    );

    const { delivered, promise } = run([group("g1", "and")]);
    await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(delivered).toEqual([{ id: "g1", segments: ["그리고"] }]);
  });

  it("응답에서 빠진 그룹은 다시 보내고, 재요청도 실패하면 원문으로 둔다", async () => {
    const fetchMock = stubFetchSequence(
      () => translationResponse([{ id: "g1", segments: ["하나"] }]),
      () => translationResponse([]),
    );

    const { delivered, promise } = run([group("g1", "one"), group("g2", "two")]);
    const summary = await promise;

    expect(requestedIds(fetchMock)).toEqual([["g1", "g2"], ["g2"]]);
    expect(delivered).toEqual([{ id: "g1", segments: ["하나"] }]);
    expect(summary.failed).toBe(1);
  });

  it("max_tokens에서 잘리면 같은 배치를 다시 보내지 않고 반으로 나눠 보낸다 (SPEC 13장 \"잘린 응답\")", async () => {
    let call = 0;
    const fetchMock = stubFetch(async (input, init) =>
      call++ === 0 ? messageResponse('{"groups":[', { stop_reason: "max_tokens" }) : echoUppercase(input, init),
    );
    const groups = [group("g1", "One two"), group("g2", "Three"), group("g3", "Four five"), group("g4", "Six")];

    const { delivered, promise } = run(groups);
    const summary = await promise;

    expect(requestedIds(fetchMock)).toEqual([["g1", "g2", "g3", "g4"], ["g1", "g2"], ["g3", "g4"]]);
    expect(delivered.map((result) => result.id)).toEqual(["g1", "g2", "g3", "g4"]);
    expect(summary.failed).toBe(0);
  });

  it("나눈 반도 잘리면 더 나누고, 그룹 하나만 남았는데도 잘리면 그 그룹만 원문으로 둔다", async () => {
    const fetchMock = stubFetch(async (input, init) =>
      requestedGroups(init).some((g) => g.id === "g1")
        ? messageResponse('{"groups":[', { stop_reason: "max_tokens" })
        : echoUppercase(input, init),
    );

    const { delivered, promise } = run([group("g1", "Long"), group("g2", "Short"), group("g3", "Also short")]);
    const summary = await promise;

    // 글자 수로 반을 나눈다: [g1 g2 | g3] → [g1 | g2] → g1 하나도 잘려 원문으로 둔다.
    expect(requestedIds(fetchMock)).toEqual([["g1", "g2", "g3"], ["g1", "g2"], ["g1"], ["g2"], ["g3"]]);
    expect(delivered.map((result) => result.id)).toEqual(["g2", "g3"]);
    expect(summary).toMatchObject({ failed: 1 });
    expect(String(summary.lastError)).toContain("max_tokens");
  });

  it("최대 출력 토큰과 번역 방식은 설정을 따른다", async () => {
    const fetchMock = stubFetch(echoUppercase);

    await run([group("g1", "Hello")], { settings: { maxOutputTokens: 8_000, translationMode: "fast" } }).promise;

    expect(requestBody(fetchMock.mock.calls[0]![1])).toMatchObject({ max_tokens: 8_000, thinking: { type: "disabled" } });
  });

  it("refusal은 다시 보내지 않고 원문으로 둔다", async () => {
    const fetchMock = stubFetchSequence(() => messageResponse("", { stop_reason: "refusal" }));

    const summary = await run([group("g1", "Hello")]).promise;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ failed: 1, lastError: { kind: "refusal" } });
  });
});

describe("취소 (SPEC 5.4)", () => {
  it("탭이 닫히면 진행 중인 요청을 취소하고 남은 배치는 보내지 않는다", async () => {
    const controller = new AbortController();
    const fetchMock = stubFetch(
      (_input, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason))),
    );

    const groups = [1, 2, 3, 4].map((n) => group(`g${n}`, ...words(100)));
    const { promise } = run(groups, { signal: controller.signal });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    controller.abort();

    await expect(promise).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("캐시 (SPEC 4.7, 13장)", () => {
  it("캐시에 있는 그룹은 요청하지 않고 바로 넘긴다 (재방문 시 API 호출 없음)", async () => {
    const fetchMock = stubFetch(echoUppercase);
    const groups = [group("g1", "Get started"), group("g2", "Read", "the docs")];

    await run(groups).promise;
    const again = run([group("g8", "Get started"), group("g9", "Read", "the docs")]);
    await again.promise;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(again.delivered).toEqual([
      { id: "g8", segments: ["GET STARTED"] },
      { id: "g9", segments: ["READ", "THE DOCS"] },
    ]);
  });

  it("다른 페이지라도 같은 문자열은 재사용하고, 없는 그룹만 요청한다", async () => {
    const fetchMock = stubFetch(echoUppercase);

    await run([group("g1", "Docs"), group("g2", "Pricing")]).promise;
    const next = run([group("h1", "Pricing"), group("h2", "New page text")]);
    await next.promise;

    expect(requestedGroups(fetchMock.mock.calls[1]![1])).toEqual([group("h2", "New page text")]);
    expect(next.delivered).toEqual([
      { id: "h1", segments: ["PRICING"] },
      { id: "h2", segments: ["NEW PAGE TEXT"] },
    ]);
  });

  it("모델이나 context가 다르면 따로 저장한다", async () => {
    const fetchMock = stubFetch(echoUppercase);

    await run([{ id: "g1", segments: ["Run", "now"], context: "Run build now" }]).promise;
    await run([{ id: "g1", segments: ["Run", "now"], context: "Run npm test now" }]).promise;
    await run([{ id: "g1", segments: ["Run", "now"], context: "Run build now" }], {
      settings: { model: "claude-sonnet-5-5" },
    }).promise;

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("캐시에서 꺼내 쓴 번역문과 새로 넣은 번역문은 그 번역의 턴에 쓴 것으로 적는다 (SPEC 13장 \"캐시 정리\")", async () => {
    stubFetch(echoUppercase);

    await run([group("g1", "Docs")], { turn: 3 }).promise;
    const key = Object.keys(chromeMock.storage).find((name) => name.startsWith("t:"))!;
    expect(chromeMock.storage[key]).toEqual({ s: ["DOCS"], u: 3 });

    await run([group("g1", "Docs")], { turn: 7 }).promise;
    expect(chromeMock.storage[key]).toEqual({ s: ["DOCS"], u: 7 });
  });

  it("번역하지 못해 원문으로 둔 그룹은 캐시하지 않는다", async () => {
    const fetchMock = stubFetchSequence(
      () => messageResponse("not json"),
      () => messageResponse("not json"),
      () => translationResponse([{ id: "g1", segments: ["안녕"] }]),
    );

    await run([group("g1", "Hello")]).promise;
    const retry = run([group("g1", "Hello")]);
    await retry.promise;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(retry.delivered).toEqual([{ id: "g1", segments: ["안녕"] }]);
  });
});

describe("사용량 (SPEC 4.10, 13장)", () => {
  it("응답마다 사용량을 넘긴다. 형식 오류로 다시 보낸 응답도 센다", async () => {
    stubFetchSequence(
      () =>
        messageResponse("not json", {
          usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 0, output_tokens: 3 },
        }),
      () =>
        translationResponse([{ id: "g1", segments: ["안녕"] }]),
    );
    const usages: TokenUsage[] = [];

    await run([group("g1", "Hello")], { onUsage: (usage) => usages.push(usage) }).promise;

    expect(usages).toEqual([
      { inputTokens: 10, cacheWriteTokens: 5, cacheReadTokens: 0, outputTokens: 3 },
      { inputTokens: 100, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 50 },
    ]);
  });
});

describe("번역 방식과 캐시 (SPEC 13장)", () => {
  const fast = { translationMode: "fast" } as const;

  it("정확하게 번역할 때 캐시에 있는 것이 빠르게 번역한 것이면 다시 번역해 바꿔 넣는다", async () => {
    const fetchMock = stubFetch(echoUppercase);

    await run([group("g1", "Docs")], { settings: fast }).promise;
    const accurate = run([group("g1", "Docs")]);
    await accurate.promise;
    await run([group("g1", "Docs")]).promise;

    // 빠르게 1번, 정확하게 1번 요청하고, 그다음 정확하게는 바꿔 넣은 캐시를 쓴다.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestBody(fetchMock.mock.calls[1]![1])).not.toHaveProperty("thinking");
    expect(accurate.delivered).toEqual([{ id: "g1", segments: ["DOCS"] }]);
    const entry = Object.entries(chromeMock.storage).find(([key]) => key.startsWith("t:"))![1];
    expect(entry).not.toHaveProperty("f");
  });

  it("빠르게 번역할 때는 정확하게 번역한 캐시도 그대로 쓴다", async () => {
    const fetchMock = stubFetch(echoUppercase);

    await run([group("g1", "Docs")]).promise;
    await run([group("g1", "Docs")], { settings: fast }).promise;

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("사고를 끌 수 없는 모델(Opus)은 빠르게여도 정확하게 번역한 것으로 저장한다", async () => {
    stubFetch(echoUppercase);

    await run([group("g1", "Docs")], { settings: { ...fast, model: "claude-opus-5-5" } }).promise;

    const entry = Object.entries(chromeMock.storage).find(([key]) => key.startsWith("t:"))![1];
    expect(entry).not.toHaveProperty("f");
  });
});

describe("빠르게의 형식 오류 재요청 (SPEC 13장)", () => {
  it("형식이 틀린 그룹만, 사고를 켜고 다시 보낸다. 다시 번역한 그룹은 캐시에 정확하게로 저장한다", async () => {
    let call = 0;
    const fetchMock = stubFetch(async (_input, init) => {
      const groups = requestedGroups(init);
      // 첫 응답은 g1에 칸을 하나 더 붙여 틀리게 돌려준다.
      const results = uppercase(groups).map((g) => (call === 0 && g.id === "g1" ? { ...g, segments: [...g.segments, "X"] } : g));
      call++;
      return translationResponse(results);
    });

    const { delivered, promise } = run([group("g1", "Hello"), group("g2", "World")], {
      settings: { translationMode: "fast" },
    });
    await promise;

    expect(requestedIds(fetchMock)).toEqual([["g1", "g2"], ["g1"]]);
    expect(requestBody(fetchMock.mock.calls[0]![1]).thinking).toEqual({ type: "disabled" });
    expect(requestBody(fetchMock.mock.calls[1]![1])).not.toHaveProperty("thinking");
    expect(delivered.map((g) => g.id).sort()).toEqual(["g1", "g2"]);
    const entries = Object.entries(chromeMock.storage).filter(([key]) => key.startsWith("t:"));
    const bySegments = Object.fromEntries(entries.map(([, entry]) => [(entry as { s: string[] }).s[0], entry]));
    expect(bySegments.HELLO).not.toHaveProperty("f");
    expect(bySegments.WORLD).toMatchObject({ f: 1 });
  });
});
