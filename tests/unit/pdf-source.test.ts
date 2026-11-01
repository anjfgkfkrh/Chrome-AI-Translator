import { describe, expect, it, vi } from "vitest";
import { downloadPdf, fileNameOf, pageFromHash, PdfDownloadError, sourceUrl } from "../../src/pdf/source";

describe("sourceUrl", () => {
  it("http·https 주소만 돌려준다", () => {
    const search = (file: string) => `?file=${encodeURIComponent(file)}`;

    expect(sourceUrl(search("https://example.com/a.pdf?x=1#page=2"))).toBe("https://example.com/a.pdf?x=1#page=2");
    expect(sourceUrl(search("http://example.com/a.pdf"))).toBe("http://example.com/a.pdf");
    expect(sourceUrl(search("file:///a.pdf"))).toBeUndefined();
    expect(sourceUrl(search("javascript:alert(1)"))).toBeUndefined();
    expect(sourceUrl(search("not a url"))).toBeUndefined();
    expect(sourceUrl("")).toBeUndefined();
  });
});

describe("fileNameOf", () => {
  it("마지막 경로 조각을 디코딩하고 쿼리·해시를 뺀다", () => {
    expect(fileNameOf("https://example.com/rss19/p089.pdf?a=1#page=2")).toBe("p089.pdf");
    expect(fileNameOf("https://example.com/%EB%85%BC%EB%AC%B8.pdf")).toBe("논문.pdf");
    expect(fileNameOf("file:///Users/me/a.pdf")).toBe("a.pdf");
  });

  it("디코딩할 수 없으면 조각 그대로, 비어 있으면 PDF", () => {
    expect(fileNameOf("https://example.com/100%.pdf")).toBe("100%.pdf");
    expect(fileNameOf("https://example.com/")).toBe("PDF");
    expect(fileNameOf(null)).toBe("PDF");
  });
});

describe("pageFromHash", () => {
  it("#page=N을 읽고 범위 밖이면 undefined", () => {
    expect(pageFromHash("https://example.com/a.pdf#page=3", 11)).toBe(3);
    expect(pageFromHash("https://example.com/a.pdf#zoom=100&page=3", 11)).toBe(3);
    expect(pageFromHash("https://example.com/a.pdf#page=12", 11)).toBeUndefined();
    expect(pageFromHash("https://example.com/a.pdf#page=0", 11)).toBeUndefined();
    expect(pageFromHash("https://example.com/a.pdf?page=3", 11)).toBeUndefined();
    expect(pageFromHash(undefined, 11)).toBeUndefined();
  });
});

describe("downloadPdf", () => {
  it("쿠키를 함께 보내고 내용을 돌려준다", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
    vi.stubGlobal("fetch", fetchMock);

    expect((await downloadPdf("https://example.com/a.pdf")).byteLength).toBe(3);
    expect(fetchMock).toHaveBeenCalledWith("https://example.com/a.pdf", { credentials: "include" });
  });

  it("실패하면 화면에 보여 줄 문구로 던진다", async () => {
    vi.stubGlobal("fetch", async () => new Response("", { status: 404 }));
    await expect(downloadPdf("https://example.com/a.pdf")).rejects.toThrow(new PdfDownloadError("PDF를 받지 못했습니다. (HTTP 404)"));

    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(downloadPdf("https://example.com/a.pdf")).rejects.toThrow(
      new PdfDownloadError("PDF를 받지 못했습니다. 네트워크 연결을 확인하세요."),
    );
  });
});
