// PDF 뷰어 주소 (SPEC 13장 "PDF 번역"). 백그라운드와 뷰어가 함께 쓴다.

const VIEWER_PATH = "pdf/viewer.html";

/** 원본 PDF 주소를 뷰어 주소로 바꾼다. 해시(#page=N)도 file 값 안에 그대로 넣는다. */
export function viewerUrl(source: string): string {
  return `${chrome.runtime.getURL(VIEWER_PATH)}?file=${encodeURIComponent(source)}`;
}

/** 이 확장의 PDF 뷰어 주소인지 */
export function isViewerUrl(url: string | undefined): boolean {
  return url?.startsWith(chrome.runtime.getURL(VIEWER_PATH)) === true;
}

/** file:// 주소이면서 경로가 .pdf로 끝나는지 (대소문자 무시, 쿼리·해시 제외) */
export function isLocalPdfUrl(url: string | undefined): boolean {
  if (url === undefined) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "file:" && parsed.pathname.toLowerCase().endsWith(".pdf");
  } catch {
    return false;
  }
}
