import { ProviderError, type ProviderErrorKind } from "./types";

// 제공업체 모듈이 함께 쓰는 HTTP 처리 (SPEC 5.4): 시간 초과·네트워크 오류를 ProviderError로 바꾸고,
// 실패 응답은 제공업체마다 다른 기준(classify)으로 분류한다. 호출한 쪽이 취소한 요청은 그대로 던진다.

export async function requestJson(
  url: string,
  init: RequestInit,
  classify: (status: number) => ProviderErrorKind,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new ProviderError("timeout", "요청 시간이 초과되었습니다.");
    }
    if (err instanceof DOMException && err.name === "AbortError") throw err; // 호출한 쪽에서 취소함
    throw new ProviderError("network", err instanceof Error ? err.message : String(err));
  }
  if (!res.ok) {
    const message = (await readErrorMessage(res)) ?? `HTTP ${res.status}`;
    throw new ProviderError(classify(res.status), message, { status: res.status, retryAfterMs: retryAfter(res) });
  }
  return res.json();
}

/** retry-after 헤더(초 또는 HTTP 날짜)를 밀리초로 바꾼다. */
function retryAfter(res: Response): number | undefined {
  const value = res.headers.get("retry-after");
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** 오류 본문의 error.message. Anthropic과 OpenRouter 모두 {"error":{"message":"..."}} 모양이다. */
async function readErrorMessage(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { error?: { message?: unknown } };
    return typeof body.error?.message === "string" ? body.error.message : undefined;
  } catch {
    return undefined;
  }
}
