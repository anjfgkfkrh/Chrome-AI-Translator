import type { RequestGroup, SegmentGroup } from "../../shared/messages";

// 번역 제공업체 인터페이스 (SPEC 5.2). MVP는 AnthropicProvider만 구현한다.

export interface TranslationProvider {
  id: "anthropic" | "openai" | "gemini" | "openai-compatible";
  translate(
    req: TranslateRequest,
    opts: { apiKey: string; model: string; signal?: AbortSignal },
  ): Promise<TranslateResponse>;
  testConnection(opts: { apiKey: string; model: string }): Promise<{ ok: boolean; message?: string }>;
}

export interface TranslateRequest {
  targetLanguage: "ko";
  glossary: { keep: string[]; map: Record<string, string> };
  groups: RequestGroup[];
}

export interface TranslateResponse {
  groups: SegmentGroup[];
  usage?: { inputTokens: number; outputTokens: number };
}

/** 제공업체와 무관한 오류 분류. 안내 문구와 재시도 정책(SPEC 5.4)이 이 값으로 갈린다. */
export type ProviderErrorKind =
  | "auth" // 401, 403
  | "not_found" // 404: 모델이 없거나 쓸 수 없음
  | "rate_limit" // 429
  | "server" // 500, 529 등 5xx
  | "network" // 서버에 닿지 못함
  | "timeout" // 제한 시간 초과
  | "format" // 응답을 읽을 수 없거나 max_tokens에서 잘림
  | "refusal" // 모델이 응답을 거절함
  | "other";

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status?: number;
  /** 429 응답의 retry-after (밀리초) */
  readonly retryAfterMs?: number;

  constructor(kind: ProviderErrorKind, message: string, options: { status?: number; retryAfterMs?: number } = {}) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}
