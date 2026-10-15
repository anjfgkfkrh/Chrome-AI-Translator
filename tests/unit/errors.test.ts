import { describe, expect, it } from "vitest";
import { errorMessage, isKeyError } from "../../src/background/errors";
import { ProviderError } from "../../src/background/providers/types";

describe("errorMessage (SPEC 13장 M1·M4 화면 문구)", () => {
  it("그 밖의 오류는 연결 테스트에서 '연결 실패:', 번역에서 '번역 실패:'를 붙인다", () => {
    const error = new ProviderError("other", "Your credit balance is too low.");

    expect(errorMessage(error, "claude-haiku-5-5")).toBe("연결 실패: Your credit balance is too low.");
    expect(errorMessage(error, "claude-haiku-5-5", "translation")).toBe("번역 실패: Your credit balance is too low.");
  });

  it("상태 코드별 안내는 연결 테스트와 번역이 같다", () => {
    const error = new ProviderError("rate_limit", "Too many requests");

    expect(errorMessage(error, "m", "translation")).toBe("요청 한도를 초과했습니다. 잠시 후 다시 시도하세요.");
    expect(errorMessage(error, "m", "connection")).toBe("요청 한도를 초과했습니다. 잠시 후 다시 시도하세요.");
  });
});

describe("isKeyError", () => {
  it("401·403(auth)만 키 오류로 본다", () => {
    expect(isKeyError(new ProviderError("auth", "invalid x-api-key"))).toBe(true);
    expect(isKeyError(new ProviderError("not_found", "model"))).toBe(false);
    expect(isKeyError(new Error("x"))).toBe(false);
  });
});
