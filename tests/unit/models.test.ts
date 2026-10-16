import { describe, expect, it } from "vitest";
import { QUALITY_TIERS, qualityTierOf, qualityTierText } from "../../src/shared/models";

describe("번역 품질 단계 (SPEC 13장 \"번역 품질 단계\")", () => {
  it("이름은 \"모델-사고 설정(쉬운 말) — 설명\"", () => {
    expect(QUALITY_TIERS.map(qualityTierText)).toEqual([
      "Haiku5.5-no-thinking(빠르게) — 가장 빠름, 가끔 어색함",
      "Haiku5.5-medium(기본) — 빠르고 저렴함",
      "Sonnet5.5-medium(정확하게) — 더 자연스러움, 비용 약 20배",
      "Opus5.5-medium(최고 품질) — 가장 정확함, 비용 약 40배",
    ]);
  });

  it("제공업체마다 그 제공업체의 모델 ID와 번역 방식이 같으면 그 단계다", () => {
    expect(qualityTierOf({ provider: "anthropic", model: "claude-haiku-5-5", translationMode: "fast" })?.id).toBe(
      "haiku-no-thinking",
    );
    expect(qualityTierOf({ provider: "anthropic", model: "claude-haiku-5-5", translationMode: "accurate" })?.id).toBe(
      "haiku-medium",
    );
    expect(
      qualityTierOf({ provider: "openrouter", model: "anthropic/claude-sonnet-5.5", translationMode: "accurate" })?.id,
    ).toBe("sonnet-medium");
  });

  it("어느 단계와도 같지 않으면 \"직접 설정\"이다 (다른 모델, 단계에 없는 번역 방식)", () => {
    expect(qualityTierOf({ provider: "openrouter", model: "google/gemini-3.5-flash", translationMode: "accurate" })).toBe(
      undefined,
    );
    expect(qualityTierOf({ provider: "anthropic", model: "claude-opus-5-5", translationMode: "fast" })).toBe(undefined);
    // 제공업체가 다르면 모델 ID도 다르다.
    expect(qualityTierOf({ provider: "openrouter", model: "claude-haiku-5-5", translationMode: "accurate" })).toBe(
      undefined,
    );
  });
});
