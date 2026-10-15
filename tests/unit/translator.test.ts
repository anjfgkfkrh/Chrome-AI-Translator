// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestGroup, SegmentGroup } from "../../src/shared/messages";
import { defaultSettings, type Settings } from "../../src/shared/storage";
import {
  echoUppercase,
  errorResponse,
  messageResponse,
  requestedGroups,
  translationResponse,
} from "../helpers/anthropic-mock";
import { uppercase } from "../helpers/mock-translator";
import { installChromeMock } from "./chrome-mock";

// 동시 요청 제한은 모듈 전역이므로 테스트마다 모듈을 새로 불러온다.
let translateGroups: typeof import("../../src/background/translator").translateGroups;
let AnthropicProvider: typeof import("../../src/background/providers/anthropic").AnthropicProvider;

beforeEach(async () => {
  installChromeMock(); // 캐시 저장소 (chrome.storage.local)
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

function run(groups: RequestGroup[], options: { settings?: Partial<Settings>; signal?: AbortSignal } = {}) {
  const delivered: SegmentGroup[] = [];
  const promise = translateGroups({
    provider: new AnthropicProvider(),
    apiKey: "sk-ant-test",
    settings: { ...defaultSettings(), ...options.settings },
    groups,
    signal: options.signal ?? new AbortController().signal,
    onResults: (results) => delivered.push(...results),
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

  it("max_tokens에서 잘린 응답은 파싱 실패처럼 한 번 더 보낸다", async () => {
    const fetchMock = stubFetchSequence(
      () => messageResponse('{"groups":[{"id":"g1","segm', { stop_reason: "max_tokens" }),
      () => translationResponse([{ id: "g1", segments: ["안녕"] }]),
    );

    const { delivered, promise } = run([group("g1", "Hello")]);
    await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(delivered).toEqual([{ id: "g1", segments: ["안녕"] }]);
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
