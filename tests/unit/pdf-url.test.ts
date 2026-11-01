import { beforeEach, describe, expect, it, vi } from "vitest";
import { isLocalPdfUrl, isViewerUrl, viewerUrl } from "../../src/shared/pdf";

beforeEach(() => {
  vi.stubGlobal("chrome", { runtime: { getURL: (path: string) => `chrome-extension://id/${path}` } });
});

describe("viewerUrl", () => {
  it("원본 주소의 쿼리·해시·한글을 잃지 않게 인코딩한다", () => {
    const source = "https://example.com/논문.pdf?token=a&b=1#page=3";
    const url = new URL(viewerUrl(source));

    expect(url.href.split("?")[0]).toBe("chrome-extension://id/pdf/viewer.html");
    expect(url.searchParams.get("file")).toBe(source);
    expect(url.hash).toBe("");
  });
});

describe("isViewerUrl", () => {
  it("뷰어 주소만 true", () => {
    expect(isViewerUrl("chrome-extension://id/pdf/viewer.html?file=x")).toBe(true);
    expect(isViewerUrl("chrome-extension://id/popup/popup.html")).toBe(false);
    expect(isViewerUrl("https://example.com/pdf/viewer.html")).toBe(false);
    expect(isViewerUrl(undefined)).toBe(false);
  });
});

describe("isLocalPdfUrl", () => {
  it("file:// 주소의 .pdf만 true (대소문자 무시, 쿼리·해시 제외)", () => {
    expect(isLocalPdfUrl("file:///Users/me/a.pdf")).toBe(true);
    expect(isLocalPdfUrl("file:///Users/me/a.PDF#page=2")).toBe(true);
    expect(isLocalPdfUrl("file:///Users/me/a.txt")).toBe(false);
    expect(isLocalPdfUrl("https://example.com/a.pdf")).toBe(false);
    expect(isLocalPdfUrl("not a url")).toBe(false);
    expect(isLocalPdfUrl(undefined)).toBe(false);
  });
});
