import { sameTerms, type GlossaryTerms } from "./glossary";
import { DEFAULT_MODELS, DEFAULT_PROVIDER, type ProviderId } from "./models";

// chrome.storage.local만 쓴다. sync는 API 키가 다른 기기로 동기화되므로 쓰지 않는다 (SPEC 6).

export interface Settings {
  /** 번역에 쓰는 제공업체 (SPEC 13장 "OpenRouter 추가") */
  provider: ProviderId;
  /** 제공업체마다 따로 저장한 키 */
  apiKeys: Partial<Record<ProviderId, string>>;
  targetLanguage: "ko";
  glossary: { keep: string[]; map: Record<string, string>; version: number };
  autoTranslateOrigins: string[]; // 예: ["https://docs.langchain.com"]
  /** 고른 제공업체의 모델 (models[provider]) */
  model: string;
  /** 제공업체마다 따로 기억한 모델 */
  models: Record<ProviderId, string>;
  /** 정확하게(사고 켬) / 빠르게(사고 끔) (SPEC 13장 "번역 방식") */
  translationMode: "accurate" | "fast";
  /** 번역 요청의 max_tokens (사고 포함) (SPEC 13장 "최대 출력 토큰") */
  maxOutputTokens: number;
  /** 캐시 상한 (MB) (SPEC 13장 "캐시 상한 설정") */
  cacheMaxMB: number;
  /** 캐시 상한의 몇 %부터 정리할지 (SPEC 13장 "캐시 정리") */
  cacheCleanupPercent: number;
  /** 최근 몇 턴(번역 횟수) 동안 쓰이지 않은 번역문을 지울지 */
  cacheIdleTurns: number;
  maxConcurrentRequests: number;
  batchMaxNodes: number;
}

/** 옵션 페이지에서 고를 수 있는 캐시 정리 기준의 범위 (SPEC 13장). 벗어나면 가까운 값으로 맞춘다. */
export const MAX_OUTPUT_TOKENS_RANGE = { min: 1_000, max: 128_000 } as const;
export const CACHE_MAX_MB_RANGE = { min: 1, max: 9 } as const;
export const CACHE_CLEANUP_PERCENT_RANGE = { min: 10, max: 100 } as const;
export const CACHE_IDLE_TURNS_RANGE = { min: 1, max: 1000 } as const;

export function defaultSettings(): Settings {
  return {
    provider: DEFAULT_PROVIDER,
    apiKeys: {},
    targetLanguage: "ko",
    glossary: {
      keep: ["LangChain", "LangGraph", "LangSmith", "Deep Agents", "GitHub", "Google", "Discord", "API", "CLI", "SDK"],
      map: {},
      version: 1,
    },
    autoTranslateOrigins: [],
    model: DEFAULT_MODELS[DEFAULT_PROVIDER],
    models: { ...DEFAULT_MODELS },
    translationMode: "accurate",
    maxOutputTokens: 32_000,
    cacheMaxMB: 8,
    cacheCleanupPercent: 80,
    cacheIdleTurns: 10,
    maxConcurrentRequests: 3,
    batchMaxNodes: 100,
  };
}

const SETTINGS_KEY = "settings";

/**
 * 저장소에는 사용자가 바꾼 값만 둔다. 기본값은 읽을 때 채우므로 나중에 기본값을 바꿔도 그대로 반영된다.
 * model은 제공업체가 하나였을 때 저장한 Anthropic 모델이다. 읽을 때 models.anthropic으로 본다.
 */
type StoredSettings = Omit<Partial<Settings>, "models"> & { models?: Partial<Record<ProviderId, string>> };

async function readStored(): Promise<StoredSettings> {
  const items = await chrome.storage.local.get<{ settings?: StoredSettings }>(SETTINGS_KEY);
  return items.settings ?? {};
}

export async function getSettings(): Promise<Settings> {
  const defaults = defaultSettings();
  const stored = await readStored();
  const provider = stored.provider ?? defaults.provider;
  const models = { ...defaults.models, ...storedModels(stored) };
  return {
    ...defaults,
    ...stored,
    provider,
    apiKeys: { ...defaults.apiKeys, ...stored.apiKeys },
    glossary: { ...defaults.glossary, ...stored.glossary },
    models,
    model: models[provider],
  };
}

/** 고른 제공업체의 키. 없으면 undefined */
export function activeApiKey(settings: Pick<Settings, "provider" | "apiKeys">): string | undefined {
  return settings.apiKeys[settings.provider] || undefined;
}

/** 번역에 쓸 제공업체를 저장한다. 기본(Anthropic)이면 저장값을 지운다. */
export async function setProvider(provider: ProviderId): Promise<void> {
  const stored = await readStored();
  if (provider === DEFAULT_PROVIDER) delete stored.provider;
  else stored.provider = provider;
  await writeStored(stored);
}

/** 제공업체의 API 키를 저장한다. 빈 문자열이면 저장된 키를 지운다. */
export async function setApiKey(apiKey: string, provider: ProviderId = "anthropic"): Promise<void> {
  const stored = await readStored();
  const apiKeys = { ...stored.apiKeys };
  if (apiKey) apiKeys[provider] = apiKey;
  else delete apiKeys[provider];
  await writeStored({ ...stored, apiKeys });
}

/** 제공업체의 모델을 저장한다. 기본 모델이면 저장값을 지워, 나중에 기본 모델이 바뀌어도 그대로 따르게 한다. */
export async function setModel(model: string, provider: ProviderId = "anthropic"): Promise<void> {
  const stored = await readStored();
  const models = storedModels(stored);
  delete stored.model; // 제공업체가 하나였을 때의 저장값은 models로 옮긴다
  if (model === DEFAULT_MODELS[provider]) delete models[provider];
  else models[provider] = model;
  if (Object.keys(models).length === 0) delete stored.models;
  else stored.models = models;
  await writeStored(stored);
}

function storedModels(stored: StoredSettings): Partial<Record<ProviderId, string>> {
  return { ...(stored.model === undefined ? {} : { anthropic: stored.model }), ...stored.models };
}

/** 자동 번역 사이트 목록 (SPEC 6 autoTranslateOrigins). 비면 저장값을 지운다. */
export async function setAutoTranslateOrigins(origins: string[]): Promise<void> {
  const stored = await readStored();
  if (origins.length === 0) delete stored.autoTranslateOrigins;
  else stored.autoTranslateOrigins = origins;
  await writeStored(stored);
}

/**
 * 용어집을 저장한다. 단어나 번역어가 바뀌었을 때만 버전을 올려 바뀌기 전의 캐시 번역을 다시 쓰지 않게 한다 (SPEC 4.7).
 * 순서만 바뀐 것은 같은 용어집으로 본다. 기본 용어집을 그대로 저장하면 저장값을 지운다.
 */
export async function setGlossary(terms: GlossaryTerms): Promise<void> {
  const stored = await readStored();
  const defaults = defaultSettings().glossary;
  const current = { ...defaults, ...stored.glossary };
  const version = sameTerms(current, terms) ? current.version : current.version + 1;
  const glossary = { keep: [...terms.keep], map: { ...terms.map }, version };
  if (JSON.stringify(glossary) === JSON.stringify(defaults)) delete stored.glossary;
  else stored.glossary = glossary;
  await writeStored(stored);
}

type TranslationOptions = Pick<Settings, "translationMode" | "maxOutputTokens">;

/** 번역 방식과 최대 출력 토큰을 저장한다. 기본값인 항목은 저장값을 지운다. */
export async function setTranslationOptions(values: TranslationOptions): Promise<void> {
  const defaults = defaultSettings();
  const stored = await readStored();
  if (values.translationMode === defaults.translationMode) delete stored.translationMode;
  else stored.translationMode = values.translationMode;
  if (values.maxOutputTokens === defaults.maxOutputTokens) delete stored.maxOutputTokens;
  else stored.maxOutputTokens = values.maxOutputTokens;
  await writeStored(stored);
}

type CacheSettings = Pick<Settings, "cacheMaxMB" | "cacheCleanupPercent" | "cacheIdleTurns">;

/** 캐시 상한과 정리 기준을 저장한다. 기본값인 항목은 저장값을 지운다. */
export async function setCacheCleanup(values: CacheSettings): Promise<void> {
  const defaults = defaultSettings();
  const stored = await readStored();
  for (const key of ["cacheMaxMB", "cacheCleanupPercent", "cacheIdleTurns"] as const) {
    if (values[key] === defaults[key]) delete stored[key];
    else stored[key] = values[key];
  }
  await writeStored(stored);
}

async function writeStored(stored: StoredSettings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: stored });
}
