import { DEFAULT_MODEL_ID } from "./models";

// chrome.storage.local만 쓴다. sync는 API 키가 다른 기기로 동기화되므로 쓰지 않는다 (SPEC 6).

export interface Settings {
  provider: "anthropic";
  apiKeys: { anthropic?: string };
  targetLanguage: "ko";
  glossary: { keep: string[]; map: Record<string, string>; version: number };
  autoTranslateOrigins: string[]; // 예: ["https://docs.langchain.com"]
  model: string;
  maxConcurrentRequests: number;
  batchMaxNodes: number;
}

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

async function writeStored(stored: StoredSettings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: stored });
}
