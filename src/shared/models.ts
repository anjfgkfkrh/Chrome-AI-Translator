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

/**
 * 번역문 캐시를 함께 쓰는 모델과 등급. 제공업체가 달라도 같은 모델이면 같은 이름이고,
 * 등급이 같거나 높은 모델이 번역해 둔 것은 그대로 쓴다 (SPEC 13장 "캐시를 모델끼리 나눠 씀"·"캐시: 품질 비교").
 */
export const CACHE_MODEL_RANKS = { "haiku-5.5": 1, "sonnet-5.5": 2, "opus-5.5": 3 } as const;

export type CacheModelName = keyof typeof CACHE_MODEL_RANKS;

export interface ModelInfo {
  id: string;
  name: string;
  /** 비용 우선 / 균형 / 품질 우선 */
  description: string;
  /** 캐시에 적는 이름 */
  cacheName: CacheModelName;
  /** Anthropic 직접 연결의 "빠르게"에서 사고를 끄는 값. 없으면 끌 수 없는 모델이다 (SPEC 13장 "번역 방식"). */
  thinkingOff?: { type: "disabled" | "between_tools" };
}

export const MODELS: Readonly<Record<ProviderId, readonly ModelInfo[]>> = {
  anthropic: [
    {
      id: "claude-haiku-5-5",
      name: "Claude Haiku 5.5",
      description: "비용 우선",
      cacheName: "haiku-5.5",
      thinkingOff: { type: "disabled" },
    },
    {
      id: "claude-sonnet-5-5",
      name: "Claude Sonnet 5.5",
      description: "균형",
      cacheName: "sonnet-5.5",
      thinkingOff: { type: "between_tools" },
    },
    { id: "claude-opus-5-5", name: "Claude Opus 5.5", description: "품질 우선", cacheName: "opus-5.5" },
  ],
  // 사고를 끌 수 있는지는 OpenRouter 모델 정보로 판단한다 (SPEC 13장 "OpenRouter 번역 방식").
  openrouter: [
    { id: "anthropic/claude-haiku-5.5", name: "Claude Haiku 5.5", description: "비용 우선", cacheName: "haiku-5.5" },
    { id: "anthropic/claude-sonnet-5.5", name: "Claude Sonnet 5.5", description: "균형", cacheName: "sonnet-5.5" },
    { id: "anthropic/claude-opus-5.5", name: "Claude Opus 5.5", description: "품질 우선", cacheName: "opus-5.5" },
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

/** 번역 품질 단계: 모델과 번역 방식을 함께 고른다 (SPEC 13장 "번역 품질 단계"). */
export interface QualityTier {
  id: "haiku-no-thinking" | "haiku-medium" | "sonnet-medium" | "opus-medium";
  /** 모델-사고 설정(쉬운 말) */
  label: string;
  description: string;
  /** 제공업체마다 이 단계의 모델 */
  models: Readonly<Record<ProviderId, string>>;
  translationMode: "accurate" | "fast";
}

export const QUALITY_TIERS: readonly QualityTier[] = [
  {
    id: "haiku-no-thinking",
    label: "Haiku5.5-no-thinking(빠르게)",
    description: "가장 빠름, 가끔 어색함",
    models: { anthropic: "claude-haiku-5-5", openrouter: "anthropic/claude-haiku-5.5" },
    translationMode: "fast",
  },
  {
    id: "haiku-medium",
    label: "Haiku5.5-medium(기본)",
    description: "빠르고 저렴함",
    models: { anthropic: "claude-haiku-5-5", openrouter: "anthropic/claude-haiku-5.5" },
    translationMode: "accurate",
  },
  {
    id: "sonnet-medium",
    label: "Sonnet5.5-medium(정확하게)",
    description: "더 자연스러움, 비용 약 20배",
    models: { anthropic: "claude-sonnet-5-5", openrouter: "anthropic/claude-sonnet-5.5" },
    translationMode: "accurate",
  },
  {
    id: "opus-medium",
    label: "Opus5.5-medium(최고 품질)",
    description: "가장 정확함, 비용 약 40배",
    models: { anthropic: "claude-opus-5-5", openrouter: "anthropic/claude-opus-5.5" },
    translationMode: "accurate",
  },
];

/** 선택 상자에 보일 글: "이름 — 설명" */
export function qualityTierText(tier: QualityTier): string {
  return `${tier.label} — ${tier.description}`;
}

/** 이 설정과 같은 단계. 어느 단계와도 같지 않으면 undefined ("직접 설정") */
export function qualityTierOf(settings: {
  provider: ProviderId;
  model: string;
  translationMode: "accurate" | "fast";
}): QualityTier | undefined {
  return QUALITY_TIERS.find(
    (tier) => tier.models[settings.provider] === settings.model && tier.translationMode === settings.translationMode,
  );
}
