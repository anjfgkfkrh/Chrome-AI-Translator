import { sameTerms, type GlossaryTerms } from "./glossary";
import { DEFAULT_MODEL_ID } from "./models";

// chrome.storage.local만 쓴다. sync는 API 키가 다른 기기로 동기화되므로 쓰지 않는다 (SPEC 6).

export interface Settings {
  provider: "anthropic";
  apiKeys: { anthropic?: string };
  targetLanguage: "ko";
  glossary: { keep: string[]; map: Record<string, string>; version: number };
  autoTranslateOrigins: string[]; // 예: ["https://docs.langchain.com"]
  model: string;
  /** 캐시 상한의 몇 %부터 정리할지 (SPEC 13장 "캐시 정리") */
  cacheCleanupPercent: number;
  /** 최근 몇 턴(번역 횟수) 동안 쓰이지 않은 번역문을 지울지 */
  cacheIdleTurns: number;
  maxConcurrentRequests: number;
  batchMaxNodes: number;
}

/** 옵션 페이지에서 고를 수 있는 캐시 정리 기준의 범위 (SPEC 13장). 벗어나면 가까운 값으로 맞춘다. */
export const CACHE_CLEANUP_PERCENT_RANGE = { min: 10, max: 100 } as const;
export const CACHE_IDLE_TURNS_RANGE = { min: 1, max: 1000 } as const;

export function defaultSettings(): Settings {
  return {
    provider: "anthropic",
    apiKeys: {},
    targetLanguage: "ko",
    glossary: {
      keep: ["LangChain", "LangGraph", "LangSmith", "Deep Agents", "GitHub", "Google", "Discord", "API", "CLI", "SDK"],
      map: {},
      version: 1,
    },
    autoTranslateOrigins: [],
    model: DEFAULT_MODEL_ID,
    cacheCleanupPercent: 80,
    cacheIdleTurns: 10,
    maxConcurrentRequests: 3,
    batchMaxNodes: 100,
  };
}

const SETTINGS_KEY = "settings";

/** 저장소에는 사용자가 바꾼 값만 둔다. 기본값은 읽을 때 채우므로 나중에 기본값을 바꿔도 그대로 반영된다. */
type StoredSettings = Partial<Settings>;

async function readStored(): Promise<StoredSettings> {
  const items = await chrome.storage.local.get<{ settings?: StoredSettings }>(SETTINGS_KEY);
  return items.settings ?? {};
}

export async function getSettings(): Promise<Settings> {
  const defaults = defaultSettings();
  const stored = await readStored();
  return {
    ...defaults,
    ...stored,
    apiKeys: { ...defaults.apiKeys, ...stored.apiKeys },
    glossary: { ...defaults.glossary, ...stored.glossary },
  };
}

/** Anthropic API 키를 저장한다. 빈 문자열이면 저장된 키를 지운다. */
export async function setApiKey(apiKey: string): Promise<void> {
  const stored = await readStored();
  const apiKeys = { ...stored.apiKeys };
  if (apiKey) apiKeys.anthropic = apiKey;
  else delete apiKeys.anthropic;
  await writeStored({ ...stored, apiKeys });
}

/** 모델을 저장한다. 기본 모델이면 저장값을 지워, 나중에 기본 모델이 바뀌어도 그대로 따르게 한다. */
export async function setModel(model: string): Promise<void> {
  const stored = await readStored();
  if (model === DEFAULT_MODEL_ID) delete stored.model;
  else stored.model = model;
  await writeStored(stored);
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

/** 캐시 정리 기준을 저장한다. 기본값이면 저장값을 지운다. */
export async function setCacheCleanup(percent: number, idleTurns: number): Promise<void> {
  const defaults = defaultSettings();
  const stored = await readStored();
  if (percent === defaults.cacheCleanupPercent) delete stored.cacheCleanupPercent;
  else stored.cacheCleanupPercent = percent;
  if (idleTurns === defaults.cacheIdleTurns) delete stored.cacheIdleTurns;
  else stored.cacheIdleTurns = idleTurns;
  await writeStored(stored);
}

async function writeStored(stored: StoredSettings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: stored });
}
