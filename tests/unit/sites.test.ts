import { describe, expect, it } from "vitest";
import { originPattern, pageOrigin } from "../../src/shared/sites";

describe("자동 번역 사이트 = 출처 (SPEC 13장)", () => {
  it("http·https 페이지는 출처를 돌려준다. 하위 도메인과 포트는 따로 본다", () => {
    expect(pageOrigin("https://docs.langchain.com/oss/python/langchain/overview?x=1#top")).toBe(
      "https://docs.langchain.com",
    );
    expect(pageOrigin("https://langchain.com/")).toBe("https://langchain.com");
    expect(pageOrigin("http://localhost:8080/docs")).toBe("http://localhost:8080");
    expect(pageOrigin("https://example.com:443/")).toBe("https://example.com");
  });

  it("그 밖의 주소는 자동 번역 대상이 아니다", () => {
    for (const url of ["chrome://extensions/", "file:///Users/me/a.html", "about:blank", "not a url", undefined]) {
      expect(pageOrigin(url)).toBeUndefined();
    }
  });

  it("권한·등록 패턴은 그 출처의 모든 페이지", () => {
    expect(originPattern("https://docs.langchain.com")).toBe("https://docs.langchain.com/*");
    expect(originPattern("http://localhost:8080")).toBe("http://localhost:8080/*");
  });
});
