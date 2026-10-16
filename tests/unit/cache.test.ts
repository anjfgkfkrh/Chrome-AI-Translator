// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import {
  cacheLimits,
  cacheQuality,
  cacheSlot,
  cacheStats,
  cleanUpCache,
  clearCache,
  currentTurn,
  lookupCache,
  removeOldCache,
  startTurn,
  storeCache,
  type CacheLimits,
  type CacheQuality,
  type CacheSlot,
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

const HAIKU_FAST: CacheQuality = { model: "haiku-5.5", fast: true };
const HAIKU: CacheQuality = { model: "haiku-5.5", fast: false };
const SONNET_FAST: CacheQuality = { model: "sonnet-5.5", fast: true };
const SONNET: CacheQuality = { model: "sonnet-5.5", fast: false };
const OPUS: CacheQuality = { model: "opus-5.5", fast: false };
/** 직접 입력한 모델 */
const CUSTOM: CacheQuality = { fast: false };

function cacheEntries(): string[] {
  return Object.keys(chromeMock.storage)
    .filter((key) => key.startsWith("c:"))
    .sort();
}

/** 키 하나를 찾아보고 넣는 자리 (목록에 있는 모델) */
function slot(key: string): CacheSlot {
  return { read: [key], write: key };
}

function usedBytes(): Promise<number> {
  return chrome.storage.local.getBytesInUse(null);
}

/** Chrome처럼 "키 + 값의 JSON" 바이트 수 */
function bytesOf(key: string, value: unknown): number {
  return new TextEncoder().encode(key + JSON.stringify(value)).length;
}

/** Haiku 기본으로 번역해 넣은 항목 */
function haikuEntry(s: string[], u: number) {
  return { s, u, m: "haiku-5.5" };
}

/** 새 항목을 넣은 뒤의 크기가 정확히 상한의 80%가 되는 상한 (정리는 시작하지만 상한은 넘지 않는다) */
function limitsAtEightyPercent(bytesAfterStore: number, idleTurns = 10): CacheLimits {
  return { maxBytes: Math.floor(bytesAfterStore / 0.8), targetBytes: 0, cleanupPercent: 80, idleTurns };
}

describe("cacheSlot (SPEC 13장 \"캐시 키\")", () => {
  const group = { id: "g1", segments: ["Get started"] };

  it("목록에 있는 모델은 모델·제공업체가 달라도 같은 키 하나를 찾고 넣는다. SHA-256 앞 128비트(16진수 32자리)", async () => {
    const haiku = await cacheSlot(settings, group);

    expect(haiku.write).toMatch(/^c:[0-9a-f]{32}$/);
    expect(haiku.read).toEqual([haiku.write]);
    const others = await Promise.all([
      cacheSlot({ ...settings, model: "claude-opus-5-5" }, group),
      cacheSlot({ ...settings, provider: "openrouter", model: "anthropic/claude-haiku-5.5" }, group),
      cacheSlot({ ...settings, translationMode: "fast" }, group),
      cacheSlot(settings, { id: "다른 ID", segments: ["Get started"] }),
    ]);
    for (const other of others) expect(other).toEqual(haiku);
  });

  it("세그먼트·context·용어집 버전 중 하나라도 다르면 다른 키다", async () => {
    const run = { id: "g1", segments: ["Run", "now"], context: "Run build now" };
    const keys = await Promise.all([
      cacheSlot(settings, run),
      cacheSlot(settings, { ...run, segments: ["Run", "later"] }),
      cacheSlot(settings, { ...run, context: "Run npm test now" }),
      cacheSlot({ ...settings, glossary: { ...settings.glossary, version: 2 } }, run),
    ]);

    expect(new Set(keys.map((item) => item.write)).size).toBe(4);
  });

  it("직접 입력한 모델은 제공업체 + 모델을 더한 자기 키에 넣고, 자기 키 다음에 함께 쓰는 키를 본다. 다시 번역할 때는 자기 키만", async () => {
    const shared = (await cacheSlot(settings, group)).write;
    const custom = { ...settings, model: "claude-custom-1" };

    const own = await cacheSlot(custom, group);

    expect(own.write).toMatch(/^c:[0-9a-f]{32}$/);
    expect(own.write).not.toBe(shared);
    expect(own.read).toEqual([own.write, shared]);
    expect(await cacheSlot(custom, group, true)).toEqual({ read: [own.write], write: own.write });
    const others = await Promise.all([
      cacheSlot({ ...settings, model: "claude-custom-2" }, group),
      cacheSlot({ ...settings, provider: "openrouter", model: "claude-custom-1" }, group),
    ]);
    for (const other of others) expect(other.write).not.toBe(own.write);
  });

  it("번역문의 품질: 목록에 있는 모델은 캐시 이름을 적고, 직접 입력한 모델은 적지 않는다", () => {
    expect(cacheQuality(settings, false)).toEqual({ model: "haiku-5.5", fast: false });
    expect(cacheQuality({ ...settings, provider: "openrouter", model: "anthropic/claude-opus-5.5" }, false)).toEqual(OPUS);
    expect(cacheQuality({ ...settings, model: "claude-custom-1" }, true)).toEqual({ model: undefined, fast: true });
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
  it("넣은 번역을 번역한 모델과 함께 적고, 찾을 때마다 그 턴에 쓴 것으로 적는다", async () => {
    await storeCache(new Map([["c:a", ["시작하기"]]]), 1, roomy, HAIKU);
    expect(chromeMock.storage["c:a"]).toEqual({ s: ["시작하기"], u: 1, m: "haiku-5.5" });

    const found = await lookupCache([slot("c:a"), slot("c:missing")], 5, HAIKU);

    expect(found).toEqual([["시작하기"], undefined]);
    expect(chromeMock.storage["c:a"]).toEqual({ s: ["시작하기"], u: 5, m: "haiku-5.5" });
  });

  it("같거나 높은 품질만 쓴다: Haiku < Sonnet < Opus, 같은 모델에서는 빠르게 < 정확하게 (SPEC 13장 \"캐시: 품질 비교\")", async () => {
    const cases: [stored: CacheQuality, request: CacheQuality, usable: boolean][] = [
      [OPUS, HAIKU, true],
      [OPUS, SONNET, true],
      [SONNET, HAIKU_FAST, true],
      [HAIKU, HAIKU_FAST, true],
      [HAIKU, HAIKU, true],
      [HAIKU, SONNET, false],
      [SONNET, OPUS, false],
      [HAIKU_FAST, HAIKU, false],
      [SONNET_FAST, HAIKU_FAST, true],
      // 어느 쪽이 나은지 잰 적이 없는 조합은 서로 쓰지 않는다.
      [SONNET_FAST, HAIKU, false],
      [HAIKU, SONNET_FAST, false],
    ];

    for (const [i, [stored, request, usable]] of cases.entries()) {
      const key = `c:${i}`;
      await storeCache(new Map([[key, ["번역"]]]), 1, roomy, stored);
      expect(await lookupCache([slot(key)], 2, request), `${JSON.stringify(stored)} → ${JSON.stringify(request)}`).toEqual([
        usable ? ["번역"] : undefined,
      ]);
    }
  });

  it("쓰지 못한 번역문은 그 턴에 쓴 것으로 적지 않고, 다시 번역해 넣으면 바꿔 넣는다", async () => {
    await storeCache(new Map([["c:fast", ["빠른 번역"]]]), 1, roomy, HAIKU_FAST);
    expect(chromeMock.storage["c:fast"]).toEqual({ s: ["빠른 번역"], u: 1, m: "haiku-5.5", f: 1 });

    expect(await lookupCache([slot("c:fast")], 2, HAIKU)).toEqual([undefined]);
    expect(chromeMock.storage["c:fast"]).toEqual({ s: ["빠른 번역"], u: 1, m: "haiku-5.5", f: 1 });

    await storeCache(new Map([["c:fast", ["정확한 번역"]]]), 2, roomy, HAIKU);
    expect(chromeMock.storage["c:fast"]).toEqual({ s: ["정확한 번역"], u: 2, m: "haiku-5.5" });
  });

  it("직접 입력한 모델: 자기 키를 먼저 보고, 목록에 있는 모델이 번역해 둔 것도 쓴다(사고 규칙은 같음). 자기 키의 것은 그 모델만 쓴다", async () => {
    await storeCache(new Map([["c:shared", ["하이쿠 번역"]]]), 1, roomy, HAIKU);
    await storeCache(new Map([["c:shared-fast", ["빠른 번역"]]]), 1, roomy, HAIKU_FAST);
    await storeCache(new Map([["c:own", ["직접 입력 번역"]]]), 1, roomy, CUSTOM);
    expect(chromeMock.storage["c:own"]).toEqual({ s: ["직접 입력 번역"], u: 1 });

    expect(await lookupCache([{ read: ["c:own", "c:shared"], write: "c:own" }], 2, CUSTOM)).toEqual([["직접 입력 번역"]]);
    expect(await lookupCache([{ read: ["c:none", "c:shared"], write: "c:none" }], 2, CUSTOM)).toEqual([["하이쿠 번역"]]);
    expect(await lookupCache([{ read: ["c:none", "c:shared-fast"], write: "c:none" }], 2, CUSTOM)).toEqual([undefined]);
    expect(await lookupCache([{ read: ["c:none", "c:shared-fast"], write: "c:none" }], 2, { fast: true })).toEqual([
      ["빠른 번역"],
    ]);
    // 목록에 있는 모델은 모델이 적히지 않은 것(직접 입력한 모델의 번역)을 쓰지 않는다.
    expect(await lookupCache([slot("c:own")], 2, OPUS)).toEqual([undefined]);
  });

  it("목록에서 빠진 모델이 번역한 것은 쓰지 않는다", async () => {
    chromeMock.storage["c:gone"] = { s: ["옛 모델 번역"], u: 1, m: "haiku-4.5" };

    expect(await lookupCache([slot("c:gone")], 2, HAIKU_FAST)).toEqual([undefined]);
    expect(await lookupCache([{ read: ["c:none", "c:gone"], write: "c:none" }], 2, { fast: true })).toEqual([undefined]);
  });

  it("그사이 다른 탭이 더 높은 품질로 넣었으면 그것을 남긴다 (SPEC 13장 \"캐시: 동시에 저장\")", async () => {
    await storeCache(new Map([["c:a", ["오퍼스 번역"]]]), 1, roomy, OPUS);
    await storeCache(new Map([["c:a", ["하이쿠 번역"]]]), 2, roomy, HAIKU);
    expect(chromeMock.storage["c:a"]).toEqual({ s: ["오퍼스 번역"], u: 2, m: "opus-5.5" });

    // 같은 품질이거나, 어느 쪽이 나은지 모르는 품질이면 새것으로 바꾼다.
    await storeCache(new Map([["c:a", ["다른 오퍼스 번역"]]]), 3, roomy, OPUS);
    expect(chromeMock.storage["c:a"]).toEqual({ s: ["다른 오퍼스 번역"], u: 3, m: "opus-5.5" });
    await storeCache(new Map([["c:b", ["소넷 빠른 번역"]]]), 1, roomy, SONNET_FAST);
    await storeCache(new Map([["c:b", ["하이쿠 번역"]]]), 2, roomy, HAIKU);
    expect(chromeMock.storage["c:b"]).toEqual({ s: ["하이쿠 번역"], u: 2, m: "haiku-5.5" });

    // 세그먼트 수가 다른 항목은 높은 품질이어도 바꾼다.
    chromeMock.storage["c:c"] = { s: ["하나", "둘"], u: 1, m: "opus-5.5" };
    await storeCache(new Map([["c:c", ["하나"]]]), 2, roomy, HAIKU);
    expect(chromeMock.storage["c:c"]).toEqual({ s: ["하나"], u: 2, m: "haiku-5.5" });
  });
});

describe("이전 형식의 캐시 (SPEC 13장 \"캐시: 이전 형식\")", () => {
  it("모델끼리 나누기 전 형식(t:)의 번역문만 모두 지운다. 새 형식·설정·기록·턴은 그대로", async () => {
    chromeMock.storage["t:old"] = { s: ["옛 번역"], u: 3 };
    chromeMock.storage["t:older"] = { s: ["더 옛 번역"], t: 1_700_000_000_000 };
    chromeMock.storage["c:new"] = haikuEntry(["새 번역"], 4);
    chromeMock.storage.settings = { apiKeys: { anthropic: "sk-ant-x" } };
    chromeMock.storage.translationLog = [];
    chromeMock.storage.cacheTurn = 4;

    await removeOldCache();

    expect(chromeMock.storage).toEqual({
      "c:new": haikuEntry(["새 번역"], 4),
      settings: { apiKeys: { anthropic: "sk-ant-x" } },
      translationLog: [],
      cacheTurn: 4,
    });
  });
});

describe("캐시 정리 (SPEC 13장 \"캐시 정리\")", () => {
  /** 턴 1, 2, 11, 12에 쓴 번역문 넷과 설정·사용량·턴을 넣는다. */
  async function fillCache(): Promise<void> {
    chromeMock.storage.settings = { apiKeys: { anthropic: "sk-ant-x" } };
    chromeMock.storage.usage = { month: "2026-10", inputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 1 };
    chromeMock.storage.cacheTurn = 12;
    for (const turn of [1, 2, 11, 12]) await storeCache(new Map([[`c:${turn}`, ["번역문입니다"]]]), turn, roomy, HAIKU);
  }

  it("저장소가 정리 시작 용량(상한의 80%)보다 작으면 지우지 않는다", async () => {
    await fillCache();
    const after = (await usedBytes()) + bytesOf("c:new", haikuEntry(["새"], 12));
    const limits = { ...limitsAtEightyPercent(after), maxBytes: Math.floor(after / 0.8) + 10 };

    await storeCache(new Map([["c:new", ["새"]]]), 12, limits, HAIKU);

    expect(cacheEntries()).toEqual(["c:1", "c:11", "c:12", "c:2", "c:new"]);
  });

  it("80% 이상이면 최근 10턴 동안 쓰이지 않은 번역문을 모두 지운다. 설정·사용량·턴은 지우지 않는다", async () => {
    await fillCache();
    const limits = limitsAtEightyPercent((await usedBytes()) + bytesOf("c:new", haikuEntry(["새"], 12)));

    await storeCache(new Map([["c:new", ["새"]]]), 12, limits, HAIKU);

    // 턴 12 기준: 턴 1(11턴 전)·턴 2(10턴 전)는 지우고, 턴 11·12는 남긴다.
    expect(cacheEntries()).toEqual(["c:11", "c:12", "c:new"]);
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

    await storeCache(new Map([["c:new", ["새"]]]), 12, limits, HAIKU);

    // 50%를 넘었고, 2턴 이상 쓰이지 않은 턴 1·2는 지운다. 턴 11은 1턴 전이라 남긴다.
    expect(cacheEntries()).toEqual(["c:11", "c:12", "c:new"]);
  });

  it("정리한 뒤에도 상한을 넘으면 오래 쓰지 않은 것(턴 기준)부터 목표 크기가 될 때까지 지운다", async () => {
    await fillCache();
    const bytes = await usedBytes();
    const oldest = ["c:1", "c:2", "c:11"].reduce((sum, key) => sum + bytesOf(key, chromeMock.storage[key]), 0);
    const added = bytesOf("c:new", haikuEntry(["번역문입니다"], 12));
    // 모두 최근 20턴 안에 쓰였으므로 정리 대상이 없다. 그런데 새 항목을 넣으면 상한을 넘는다.
    // 목표 크기는 가장 오래된 셋을 지워야 닿는 크기다.
    const limits: CacheLimits = {
      maxBytes: bytes,
      targetBytes: bytes + added - oldest,
      cleanupPercent: 80,
      idleTurns: 20,
    };

    await storeCache(new Map([["c:new", ["번역문입니다"]]]), 12, limits, HAIKU);

    expect(cacheEntries()).toEqual(["c:12", "c:new"]);
    expect(await usedBytes()).toBeLessThanOrEqual(limits.targetBytes);
  });

  it("상한은 설정을 따르고, 넘으면 상한의 7/8까지 줄인다", () => {
    expect(cacheLimits({ ...settings, cacheMaxMB: 4 })).toMatchObject({
      maxBytes: 4 * 1024 * 1024,
      targetBytes: 3.5 * 1024 * 1024,
    });
  });

  it("새 번역을 넣지 않아도 바로 정리할 수 있다 (상한을 낮췄을 때)", async () => {
    await fillCache();
    const limits = limitsAtEightyPercent(await usedBytes());

    await cleanUpCache(12, limits);

    expect(cacheEntries()).toEqual(["c:11", "c:12"]);
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
        ["c:a", ["가"]],
        ["c:b", ["나"]],
      ]),
      1,
      roomy,
      HAIKU,
    );

    const stats = await cacheStats();
    expect(stats.count).toBe(2);
    expect(stats.bytes).toBeGreaterThan(0);

    await clearCache();
    expect(await cacheStats()).toEqual({ count: 0, bytes: 0 });
    expect(chromeMock.storage).toEqual({ settings: { model: "claude-sonnet-5-5" } });
  });
});
