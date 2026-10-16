import type { RequestGroup, SegmentGroup } from "../../shared/messages";
import type { TokenUsage } from "../../shared/usage";

// 번역 제공업체 인터페이스 (SPEC 5.2). MVP는 AnthropicProvider만 구현한다.

export interface TranslationProvider {
  id: "anthropic" | "openrouter" | "openai" | "gemini" | "openai-compatible";
  translate(req: TranslateRequest, opts: TranslateOptions): Promise<TranslateResponse>;
  /** "빠르게"에서 이 모델의 사고를 실제로 끌 수 있는지. 끌 수 없으면 정확하게로 번역한다 (SPEC 13장). */
  canDisableThinking(model: string): Promise<boolean>;
  testConnection(opts: RequestOptions): Promise<{ ok: boolean; message?: string }>;
}

export interface TranslateOptions extends RequestOptions {
  signal?: AbortSignal;
  /** 응답 한 번의 최대 토큰 (사고 포함) */
  maxTokens: number;
  /** 빠르게: 끌 수 있는 모델이면 사고를 끈다 (SPEC 13장 "번역 방식") */
  fast: boolean;
}

export interface RequestOptions {
  apiKey: string;
  model: string;
  /**
   * 응답이 올 때마다 그 사용량을 알린다. 쓸 수 없는 응답(거절, 잘림, 형식 오류)도 요금이 나가므로 알린다
   * (SPEC 13장 "사용량에 넣는 응답").
   */
  onUsage?(usage: TokenUsage): void;
}

export interface TranslateRequest {
  targetLanguage: "ko";
  glossary: { keep: string[]; map: Record<string, string> };
  groups: RequestGroup[];
}

export interface TranslateResponse {
  groups: SegmentGroup[];
  usage?: TokenUsage;
}

/** 제공업체와 무관한 오류 분류. 안내 문구와 재시도 정책(SPEC 5.4)이 이 값으로 갈린다. */
export type ProviderErrorKind =
  | "auth" // 401 (Anthropic은 403도)
  | "credits" // OpenRouter 402: 크레딧 부족
  | "not_found" // 404: 모델이 없거나 쓸 수 없음
  | "rate_limit" // 429
  | "server" // 500, 529 등 5xx
  | "network" // 서버에 닿지 못함
  | "timeout" // 제한 시간 초과
  | "format" // 응답을 읽을 수 없음
  | "truncated" // max_tokens에서 잘림
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
