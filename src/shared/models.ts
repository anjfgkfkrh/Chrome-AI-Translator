// 제공업체와 모델 목록은 이 파일 한 곳에 둔다 (SPEC 7.2).
// Anthropic ID는 2026-10-15, OpenRouter ID는 2026-10-16 공식 문서·모델 목록으로 확인했다.

export type ProviderId = "anthropic" | "openrouter";

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  /** 키 입력란의 자리표시자 */
  keyPlaceholder: string;
  /** "직접 입력" 자리표시자에 보여 줄 모델 ID 예 */
  customModelExample: string;
}

export const PROVIDERS: readonly ProviderInfo[] = [
  { id: "anthropic", name: "Anthropic", keyPlaceholder: "sk-ant-...", customModelExample: "claude-haiku-5-5" },
  { id: "openrouter", name: "OpenRouter", keyPlaceholder: "sk-or-...", customModelExample: "google/gemini-3.5-flash" },
];

export const DEFAULT_PROVIDER: ProviderId = "anthropic";

export interface ModelInfo {
  id: string;
  name: string;
  /** 비용 우선 / 균형 / 품질 우선 */
  description: string;
  /** Anthropic 직접 연결의 "빠르게"에서 사고를 끄는 값. 없으면 끌 수 없는 모델이다 (SPEC 13장 "번역 방식"). */
  thinkingOff?: { type: "disabled" | "between_tools" };
}

export const MODELS: Readonly<Record<ProviderId, readonly ModelInfo[]>> = {
  anthropic: [
    { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", description: "비용 우선", thinkingOff: { type: "disabled" } },
    { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", description: "균형", thinkingOff: { type: "between_tools" } },
    { id: "claude-opus-5-5", name: "Claude Opus 5.5", description: "품질 우선" },
  ],
  // 사고를 끌 수 있는지는 OpenRouter 모델 정보로 판단한다 (SPEC 13장 "OpenRouter 번역 방식").
  openrouter: [
    { id: "anthropic/claude-haiku-5.5", name: "Claude Haiku 5.5", description: "비용 우선" },
    { id: "anthropic/claude-sonnet-5.5", name: "Claude Sonnet 5.5", description: "균형" },
    { id: "anthropic/claude-opus-5.5", name: "Claude Opus 5.5", description: "품질 우선" },
  ],
};

/** 제공업체마다 기본 모델: 비용 우선 */
export const DEFAULT_MODELS: Readonly<Record<ProviderId, string>> = {
  anthropic: "claude-haiku-5-5",
  openrouter: "anthropic/claude-haiku-5.5",
};

export function isProviderId(value: unknown): value is ProviderId {
  return PROVIDERS.some((provider) => provider.id === value);
}

export function providerInfo(id: ProviderId): ProviderInfo {
  return PROVIDERS.find((provider) => provider.id === id)!;
}

/** 목록에 있는 모델인지. Anthropic에서 직접 입력한 모델에는 effort·구조화된 출력을 보내지 않는다 (SPEC 13장). */
export function isListedModel(id: string, provider: ProviderId = "anthropic"): boolean {
  return MODELS[provider].some((model) => model.id === id);
}

export function listedModel(id: string, provider: ProviderId = "anthropic"): ModelInfo | undefined {
  return MODELS[provider].find((model) => model.id === id);
}
