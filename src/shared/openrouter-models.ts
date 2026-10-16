// OpenRouter 모델 정보 (SPEC 5.3.1, 13장 "OpenRouter 번역 방식"): 키 없이 받는 모델 목록을 하루에 한 번 받아 둔다.
// 모델마다 사고를 끌 수 있는지, 구조화된 출력을 받는지, 최대 출력이 얼마인지를 이 정보로 판단한다.

const MODELS_URL = "https://openrouter.ai/api/v1/models";
const STORAGE_KEY = "openrouterModels";
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

export interface OpenRouterModel {
  id: string;
  /** 최대 출력 토큰. 모르면 없음 */
  maxOutput?: number;
  /** 구조화된 출력(response_format의 JSON 스키마)을 받는지 */
  structured: boolean;
  /** 고를 수 있는 사고 effort. 사고를 고를 수 없는 모델이면 빈 배열 */
  efforts: string[];
  /** 사고를 끌 수 없는 모델인지 */
  reasoningMandatory: boolean;
}

interface Stored {
  at: number;
  models: OpenRouterModel[];
}

let memory: { at: number; models: Map<string, OpenRouterModel> } | undefined;

/** 모델 정보. 하루가 지났으면 다시 받는다. 받지 못하면 지난 목록, 그것도 없으면 빈 목록 */
export async function openRouterModels(now = Date.now()): Promise<Map<string, OpenRouterModel>> {
  if (memory && now - memory.at < MAX_AGE_MS) return memory.models;
  const { [STORAGE_KEY]: stored } = await chrome.storage.local.get<Record<string, unknown>>(STORAGE_KEY);
  if (isStored(stored) && now - stored.at < MAX_AGE_MS) return remember(stored);
  try {
    const res = await fetch(MODELS_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const fresh: Stored = { at: now, models: compact(await res.json()) };
    await chrome.storage.local.set({ [STORAGE_KEY]: fresh });
    return remember(fresh);
  } catch (err) {
    console.warn("[AITranslator] OpenRouter 모델 목록을 받지 못했습니다.", err instanceof Error ? err.message : err);
    return isStored(stored) ? new Map(stored.models.map((model) => [model.id, model])) : new Map();
  }
}

/** 직접 입력칸의 자동 완성: 모델 ID 목록. 일괄 처리용(`:batch`)은 바로 응답하지 않으므로 뺀다 (SPEC 13장). */
export async function openRouterModelIds(): Promise<string[]> {
  return [...(await openRouterModels()).keys()].filter((id) => !id.endsWith(":batch")).sort();
}

/** 테스트용: 메모리에 둔 목록을 지운다. */
export function forgetOpenRouterModels(): void {
  memory = undefined;
}

function remember(stored: Stored): Map<string, OpenRouterModel> {
  memory = { at: stored.at, models: new Map(stored.models.map((model) => [model.id, model])) };
  return memory.models;
}

/** API 응답에서 필요한 것만 남긴다 (465개 × 수 KB → 약 50KB). */
function compact(data: unknown): OpenRouterModel[] {
  const list = (data as { data?: unknown } | null)?.data;
  if (!Array.isArray(list)) throw new Error("모델 목록 형식이 다릅니다.");
  return list.flatMap((item): OpenRouterModel[] => {
    const model = item as {
      id?: unknown;
      supported_parameters?: unknown;
      top_provider?: { max_completion_tokens?: unknown } | null;
      reasoning?: { supported_efforts?: unknown; mandatory?: unknown } | null;
    };
    if (typeof model.id !== "string") return [];
    const parameters = Array.isArray(model.supported_parameters) ? model.supported_parameters : [];
    const efforts = model.reasoning?.supported_efforts;
    const maxOutput = model.top_provider?.max_completion_tokens;
    return [
      {
        id: model.id,
        ...(typeof maxOutput === "number" && maxOutput > 0 ? { maxOutput } : {}),
        structured: parameters.includes("structured_outputs"),
        efforts: Array.isArray(efforts) ? efforts.filter((effort): effort is string => typeof effort === "string") : [],
        reasoningMandatory: model.reasoning?.mandatory === true,
      },
    ];
  });
}

function isStored(value: unknown): value is Stored {
  const stored = value as Partial<Stored> | null;
  return typeof stored?.at === "number" && Array.isArray(stored.models);
}
