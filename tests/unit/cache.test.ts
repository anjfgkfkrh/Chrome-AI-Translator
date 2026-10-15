// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cacheKey, cacheStats, clearCache, lookupCache, storeCache } from "../../src/background/cache";
import { defaultSettings } from "../../src/shared/storage";
import { installChromeMock } from "./chrome-mock";

let chromeMock: ReturnType<typeof installChromeMock>;

beforeEach(() => {
  chromeMock = installChromeMock();
});

const settings = defaultSettings();

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

describe("lookupCache / storeCache", () => {
  it("넣은 번역을 찾고, 찾을 때마다 마지막 사용 시각을 새로 적는다", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    await storeCache(new Map([["t:a", ["시작하기"]]]));

    vi.spyOn(Date, "now").mockReturnValue(5_000);
    const found = await lookupCache(["t:a", "t:missing"]);

    expect(found).toEqual(new Map([["t:a", ["시작하기"]]]));
    expect(chromeMock.storage["t:a"]).toEqual({ s: ["시작하기"], t: 5_000 });
  });

  it("저장소가 상한을 넘으면 오래 쓰지 않은 것부터 목표 크기가 될 때까지 지운다. 설정은 지우지 않는다", async () => {
    chromeMock.storage.settings = { apiKeys: { anthropic: "sk-ant-x" } };
    // 항목 하나는 약 38바이트, 설정은 44바이트: 넷째 항목을 넣으면 200바이트가 되어 상한을 넘는다.
    const limits = { maxBytes: 190, targetBytes: 130 };
    for (const [i, key] of ["t:old", "t:mid", "t:new"].entries()) {
      vi.spyOn(Date, "now").mockReturnValue(i);
      await storeCache(new Map([[key, ["번역문입니다"]]]), limits);
    }

    vi.spyOn(Date, "now").mockReturnValue(10);
    await storeCache(new Map([["t:latest", ["번역문입니다"]]]), limits);

    expect(Object.keys(chromeMock.storage).sort()).toEqual(["settings", "t:latest", "t:new"]);
    expect(await chrome.storage.local.getBytesInUse(null)).toBeLessThanOrEqual(limits.targetBytes);
  });
});

describe("cacheStats / clearCache (옵션 페이지)", () => {
  it("캐시 항목 수와 바이트 수를 세고, 비우면 캐시만 지운다", async () => {
    chromeMock.storage.settings = { model: "claude-sonnet-5-5" };
    await storeCache(new Map([["t:a", ["가"]], ["t:b", ["나"]]]));

    const stats = await cacheStats();
    expect(stats.count).toBe(2);
    expect(stats.bytes).toBeGreaterThan(0);

    await clearCache();
    expect(await cacheStats()).toEqual({ count: 0, bytes: 0 });
    expect(chromeMock.storage).toEqual({ settings: { model: "claude-sonnet-5-5" } });
  });
});
