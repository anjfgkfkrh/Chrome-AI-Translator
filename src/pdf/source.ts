// 뷰어가 열 PDF의 주소와 내려받기 (SPEC 13장 "PDF 번역"). pdf.js를 쓰지 않는다.

const FETCH_FAILED = "PDF를 받지 못했습니다. 네트워크 연결을 확인하세요.";

/** 내려받기 실패. message는 화면에 보여 줄 문구다. */
export class PdfDownloadError extends Error {}

/** 뷰어 주소의 file 값. 내려받을 수 있는 http·https 주소가 아니면 undefined */
export function sourceUrl(search: string): string | undefined {
  const file = new URLSearchParams(search).get("file");
  if (file === null) return undefined;
  try {
    return ["http:", "https:"].includes(new URL(file).protocol) ? file : undefined;
  } catch {
    return undefined;
  }
}

/** 탭 제목에 쓸 파일명: 주소의 마지막 경로 조각. 없으면 "PDF" */
export function fileNameOf(url: string | null): string {
  const piece = url?.split(/[?#]/)[0]?.split("/").pop() ?? "";
  if (piece === "") return "PDF";
  try {
    return decodeURIComponent(piece);
  } catch {
    return piece;
  }
}

/** 주소의 #page=N. 1 이상 pagesCount 이하가 아니면 undefined */
export function pageFromHash(url: string | undefined, pagesCount: number): number | undefined {
  const hash = url?.split("#")[1] ?? "";
  const page = Number(/(?:^|&)page=(\d+)/.exec(hash)?.[1]);
  return page >= 1 && page <= pagesCount ? page : undefined;
}

/** PDF를 내려받는다. 로그인이 필요한 PDF도 받도록 쿠키를 함께 보낸다. */
export async function downloadPdf(url: string): Promise<ArrayBuffer> {
  let response: Response;
  try {
    response = await fetch(url, { credentials: "include" });
  } catch {
    throw new PdfDownloadError(FETCH_FAILED);
  }
  if (!response.ok) throw new PdfDownloadError(`PDF를 받지 못했습니다. (HTTP ${response.status})`);
  try {
    return await response.arrayBuffer();
  } catch {
    throw new PdfDownloadError(FETCH_FAILED);
  }
}
