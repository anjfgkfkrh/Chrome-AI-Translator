// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import {
  cacheKey,
  cacheLimits,
  cacheStats,
  clearCache,
  currentTurn,
  lookupCache,
  startTurn,
  storeCache,
  type CacheLimits,
} from "../../src/background/cache";
import { defaultSettings } from "../../src/shared/storage";
import { installChromeMock } from "./chrome-mock";

let chromeMock: ReturnType<typeof installChromeMock>;

beforeEach(() => {
  chromeMock = installChromeMock();
});

const settings = defaultSettings();
/** 정리하지 않는 한도 (준비용) */
const roomy: CacheLimits = { maxBytes: 1_000_000, targetBytes: 900_000, cleanupPercent: 100, idleTurns: 10 };

function cacheEntries(): string[] {
  return Object.keys(chromeMock.storage)
    .filter((key) => key.startsWith("t:"))
    .sort();
}

function usedBytes(): Promise<number> {
  return chrome.storage.local.getBytesInUse(null);
}

/** Chrome처럼 "키 + 값의 JSON" 바이트 수 */
function bytesOf(key: string, value: unknown): number {
  return new TextEncoder().encode(key + JSON.stringify(value)).length;
}

/** 새 항목을 넣은 뒤의 크기가 정확히 상한의 80%가 되는 상한 (정리는 시작하지만 상한은 넘지 않는다) */
function limitsAtEightyPercent(bytesAfterStore: number, idleTurns = 10): CacheLimits {
  return { maxBytes: Math.floor(bytesAfterStore / 0.8), targetBytes: 0, cleanupPercent: 80, idleTurns };
}

describe("cacheKey (SPEC 13장 \"캐시 키\")", () => {
  it("같은 입력이면 같은 키다. SHA-256 앞 128비트(16진수 32자리)", async () => {
    const key = await cacheKey(settings, { id: "g1", segments: ["Get started"] });

    expect(key).toMatch(/^t:[0-9a-f]{32}$/);
    expect(await cacheKey(settings, { id: "다른 ID", segments: ["Get started"] })).toBe(key);
  });

  it("세그먼트·context·모델·용어집 버전 중 하나라도 다르면 다른 키다", async () => {
    const base = await cacheKey(settings, { id: "g1", segments: ["Run", "now"], context: "Run build now" });
    const variants = await Promise.all([
      cacheKey(settings, { id: "g1", segments: ["Run", "later"], context: "Run build now" }),
      cacheKey(settings, { id: "g1", segments: ["Run", "now"], context: "Run npm test now" }),
      cacheKey({ ...settings, model: "claude-sonnet-5-5" }, { id: "g1", segments: ["Run", "now"], context: "Run build now" }),
      cacheKey(
        { ...settings, glossary: { ...settings.glossary, version: 2 } },
        { id: "g1", segments: ["Run", "now"], context: "Run build now" },
      ),
    ]);

    expect(new Set([base, ...variants]).size).toBe(5);
  });
});

describe("턴 (SPEC 13장 \"캐시 정리: 턴\")", () => {
  it("새 턴을 열 때마다 1씩 늘고, 지금 턴은 늘리지 않고 읽기만 한다", async () => {
    expect(await currentTurn()).toBe(0);

    expect(await startTurn()).toBe(1);
    expect(await startTurn()).toBe(2);

    expect(await currentTurn()).toBe(2);
    expect(await currentTurn()).toBe(2);
  });

  it("탭 여러 개가 동시에 번역을 시작해도 턴을 잃지 않는다", async () => {
    const turns = await Promise.all([startTurn(), startTurn(), startTurn()]);

    expect(turns.sort()).toEqual([1, 2, 3]);
    expect(await currentTurn()).toBe(3);
  });
});

describe("lookupCache / storeCache", () => {
  it("넣은 번역을 찾고, 찾을 때마다 그 턴에 쓴 것으로 적는다", async () => {
    await storeCache(new Map([["t:a", ["시작하기"]]]), 1, roomy);
    expect(chromeMock.storage["t:a"]).toEqual({ s: ["시작하기"], u: 1 });

    const found = await lookupCache(["t:a", "t:missing"], 5);

    expect(found).toEqual(new Map([["t:a", ["시작하기"]]]));
    expect(chromeMock.storage["t:a"]).toEqual({ s: ["시작하기"], u: 5 });
  });

  it("시각으로 기록된 이전 항목(M5 형식)도 찾는다", async () => {
    chromeMock.storage["t:old"] = { s: ["옛 번역"], t: 1_700_000_000_000 };

    expect(await lookupCache(["t:old"], 4)).toEqual(new Map([["t:old", ["옛 번역"]]]));
    expect(chromeMock.storage["t:old"]).toEqual({ s: ["옛 번역"], u: 4 });
  });
});

describe("캐시 정리 (SPEC 13장 \"캐시 정리\")", () => {
  /** 턴 1, 2, 11, 12에 쓴 번역문 넷과 설정·사용량·턴을 넣는다. */
  async function fillCache(): Promise<void> {
    chromeMock.storage.settings = { apiKeys: { anthropic: "sk-ant-x" } };
    chromeMock.storage.usage = { month: "2026-10", inputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 1 };
    chromeMock.storage.cacheTurn = 12;
    for (const turn of [1, 2, 11, 12]) await storeCache(new Map([[`t:${turn}`, ["번역문입니다"]]]), turn, roomy);
  }

  it("저장소가 정리 시작 용량(상한의 80%)보다 작으면 지우지 않는다", async () => {
    await fillCache();
    const after = (await usedBytes()) + bytesOf("t:new", { s: ["새"], u: 12 });
    const limits = { ...limitsAtEightyPercent(after), maxBytes: Math.floor(after / 0.8) + 10 };

    await storeCache(new Map([["t:new", ["새"]]]), 12, limits);

    expect(cacheEntries()).toEqual(["t:1", "t:11", "t:12", "t:2", "t:new"]);
  });

  it("80% 이상이면 최근 10턴 동안 쓰이지 않은 번역문을 모두 지운다. 설정·사용량·턴은 지우지 않는다", async () => {
    await fillCache();
    const limits = limitsAtEightyPercent((await usedBytes()) + bytesOf("t:new", { s: ["새"], u: 12 }));

    await storeCache(new Map([["t:new", ["새"]]]), 12, limits);

    // 턴 12 기준: 턴 1(11턴 전)·턴 2(10턴 전)는 지우고, 턴 11·12는 남긴다.
    expect(cacheEntries()).toEqual(["t:11", "t:12", "t:new"]);
    expect(chromeMock.storage).toHaveProperty("settings");
    expect(chromeMock.storage).toHaveProperty("usage");
    expect(chromeMock.storage.cacheTurn).toBe(12);
  });

  it("정리 기준(용량 %·턴 수)은 설정을 따른다", async () => {
    await fillCache();
    const bytes = await usedBytes();
    const limits: CacheLimits = {
      ...cacheLimits({ ...settings, cacheCleanupPercent: 50, cacheIdleTurns: 2 }),
      maxBytes: bytes * 1.5,
    };

    await storeCache(new Map([["t:new", ["새"]]]), 12, limits);

    // 50%를 넘었고, 2턴 이상 쓰이지 않은 턴 1·2는 지운다. 턴 11은 1턴 전이라 남긴다.
    expect(cacheEntries()).toEqual(["t:11", "t:12", "t:new"]);
  });

  it("정리한 뒤에도 상한을 넘으면 오래 쓰지 않은 것(턴 기준)부터 목표 크기가 될 때까지 지운다", async () => {
    await fillCache();
    const bytes = await usedBytes();
    const oldest = ["t:1", "t:2", "t:11"].reduce((sum, key) => sum + bytesOf(key, chromeMock.storage[key]), 0);
    const added = bytesOf("t:new", { s: ["번역문입니다"], u: 12 });
    // 모두 최근 20턴 안에 쓰였으므로 정리 대상이 없다. 그런데 새 항목을 넣으면 상한을 넘는다.
    // 목표 크기는 가장 오래된 셋을 지워야 닿는 크기다.
    const limits: CacheLimits = {
      maxBytes: bytes,
      targetBytes: bytes + added - oldest,
      cleanupPercent: 80,
      idleTurns: 20,
    };

    await storeCache(new Map([["t:new", ["번역문입니다"]]]), 12, limits);

    expect(cacheEntries()).toEqual(["t:12", "t:new"]);
    expect(await usedBytes()).toBeLessThanOrEqual(limits.targetBytes);
  });

  it("시각으로 기록된 이전 항목(M5 형식)은 턴 0으로 본다", async () => {
    chromeMock.storage["t:legacy"] = { s: ["옛 번역"], t: 1_700_000_000_000 };
    await storeCache(new Map([["t:9", ["번역문입니다"]]]), 9, roomy);
    const limits = limitsAtEightyPercent((await usedBytes()) + bytesOf("t:10", { s: ["번역문입니다"], u: 10 }));

    await storeCache(new Map([["t:10", ["번역문입니다"]]]), 10, limits);

    expect(cacheEntries()).toEqual(["t:10", "t:9"]);
  });

  it("기본 정리 기준은 상한 8MB의 80%, 최근 10턴", () => {
    expect(cacheLimits(settings)).toEqual({
      maxBytes: 8 * 1024 * 1024,
      targetBytes: 7 * 1024 * 1024,
      cleanupPercent: 80,
      idleTurns: 10,
    });
  });
});

describe("cacheStats / clearCache (옵션 페이지)", () => {
  it("캐시 항목 수와 바이트 수를 세고, 비우면 캐시만 지운다", async () => {
    chromeMock.storage.settings = { model: "claude-sonnet-5-5" };
    await storeCache(
      new Map([
        ["t:a", ["가"]],
        ["t:b", ["나"]],
      ]),
      1,
      roomy,
    );

    const stats = await cacheStats();
    expect(stats.count).toBe(2);
    expect(stats.bytes).toBeGreaterThan(0);

    await clearCache();
    expect(await cacheStats()).toEqual({ count: 0, bytes: 0 });
    expect(chromeMock.storage).toEqual({ settings: { model: "claude-sonnet-5-5" } });
  });
});
