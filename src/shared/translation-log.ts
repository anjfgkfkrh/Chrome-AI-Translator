import { serialQueue } from "./serial";
import type { TokenUsage } from "./usage";

// 최근 번역 기록 (SPEC 4.10, 6, 13장 "최근 번역 기록"): 페이지 번역 한 번이 한 건. 최근 것이 앞, 20건까지.
// 백그라운드가 쓰고 옵션 페이지가 읽는다. 이 브라우저의 chrome.storage.local에만 두고 밖으로 보내지 않는다.

export const TRANSLATION_LOG_KEY = "translationLog";
export const MAX_LOG_ENTRIES = 20;

export type LogStatus = "translating" | "done" | "partial" | "error" | "aborted";

export interface TranslationLogEntry {
  /** 번역 한 건의 ID (번역 스크립트가 정한다) */
  id: string;
  startedAt: number;
  /** 마지막 요청이 끝난 시각 */
  finishedAt?: number;
  /** 요청이 진행된 시간의 합. 화면이 바뀌어 더 번역한 것도 더한다. */
  durationMs: number;
  /** url은 origin + pathname (쿼리·해시는 뺀다) */
  page: { title: string; url: string };
  provider: string;
  model: string;
  /** 번역 품질 단계 이름. 단계에 없는 설정이면 없음 ("직접 설정") */
  tier?: string;
  translationMode: "accurate" | "fast";
  /** 사이트별 자동 번역으로 시작했는지 */
  automatic: boolean;
  status: LogStatus;
  /** 일부 실패·오류의 원인 문구 */
  cause?: string;
  /** 전체 = 캐시 + 새로 번역 + 원문으로 남김 (중단된 건은 나머지가 남는다) */
  groups: { total: number; cached: number; translated: number; failed: number };
  usage: TokenUsage;
  /** API 요청 횟수 (다시 보낸 것 포함) */
  requests: number;
  /** 진행 중인 요청 수. 0이 되었을 때 결과를 정하고 남길지 판단한다 (이전 기록에는 없음) */
  active?: number;
}

export async function getTranslationLog(): Promise<TranslationLogEntry[]> {
  const { [TRANSLATION_LOG_KEY]: stored } = await chrome.storage.local.get<Record<string, unknown>>(TRANSLATION_LOG_KEY);
  return Array.isArray(stored) ? (stored as TranslationLogEntry[]) : [];
}

// 배치·탭 여러 개가 동시에 끝나도 기록을 잃지 않게 하나씩 쓴다.
const oneAtATime = serialQueue();

/**
 * 그 ID의 기록을 update로 고친다. 없으면(새 번역이거나 20건에서 밀려났으면) create로 새로 넣는다.
 * 고친 기록은 맨 앞으로 오고, 20건을 넘으면 가장 오래된 것부터 지운다.
 */
export function upsertLogEntry(
  id: string,
  create: () => TranslationLogEntry,
  update: (entry: TranslationLogEntry) => TranslationLogEntry,
): Promise<void> {
  return oneAtATime(async () => {
    const log = await getTranslationLog();
    const existing = log.find((entry) => entry.id === id);
    const entry = existing ? update(existing) : create();
    const next = [entry, ...log.filter((item) => item.id !== id)].slice(0, MAX_LOG_ENTRIES);
    await chrome.storage.local.set({ [TRANSLATION_LOG_KEY]: next });
  });
}

/**
 * 그 ID의 기록이 있을 때만 고친다 (번역 중에 "기록 지우기"를 눌렀으면 되살리지 않는다).
 * update가 undefined를 돌려주면 그 기록을 지운다 (새로 번역한 것이 없는 건, SPEC 13장).
 */
export function updateLogEntry(
  id: string,
  update: (entry: TranslationLogEntry) => TranslationLogEntry | undefined,
): Promise<void> {
  return oneAtATime(async () => {
    const log = await getTranslationLog();
    const existing = log.find((entry) => entry.id === id);
    if (!existing) return;
    const updated = update(existing);
    const rest = log.filter((item) => item !== existing);
    await chrome.storage.local.set({ [TRANSLATION_LOG_KEY]: updated ? [updated, ...rest] : rest });
  });
}

export function clearTranslationLog(): Promise<void> {
  return oneAtATime(() => chrome.storage.local.remove(TRANSLATION_LOG_KEY));
}

const STATUS_TEXT: Record<LogStatus, string> = {
  translating: "번역 중",
  done: "완료",
  partial: "일부 실패",
  error: "오류",
  aborted: "중단",
};

/** 요약 한 줄: "10월 16일 15:30 · LangSmith 튜토리얼 · Haiku5.5-medium(기본) · 완료 · 149개 (캐시 120) · 12.3초" */
export function logSummary(entry: TranslationLogEntry): string {
  return [
    formatTime(entry.startedAt),
    entry.page.title || entry.page.url,
    entry.tier ?? "직접 설정",
    STATUS_TEXT[entry.status],
    `${count(entry.groups.total)}개 (캐시 ${count(entry.groups.cached)})`,
    formatDuration(entry.durationMs),
  ].join(" · ");
}

/** 펼쳤을 때의 자세한 항목 [이름, 값] (SPEC 13장 "기록 항목") */
export function logDetails(entry: TranslationLogEntry): [string, string][] {
  const { groups, usage } = entry;
  const result = entry.cause ? `${STATUS_TEXT[entry.status]}: ${entry.cause}` : STATUS_TEXT[entry.status];
  return [
    ["페이지", entry.page.title ? `${entry.page.title} (${entry.page.url})` : entry.page.url],
    ["제공업체", entry.provider],
    ["모델", entry.model],
    ["번역 품질", entry.tier ?? `직접 설정 (${entry.translationMode === "fast" ? "빠르게" : "정확하게"})`],
    ["시작 방법", entry.automatic ? "자동" : "직접"],
    ["결과", result],
    [
      "문자열",
      `전체 ${count(groups.total)} · 캐시 ${count(groups.cached)} · 새로 번역 ${count(groups.translated)} · ` +
        `원문으로 남김 ${count(groups.failed)}`,
    ],
    [
      "토큰",
      `입력 ${count(usage.inputTokens)} · 캐시 쓰기 ${count(usage.cacheWriteTokens)} · ` +
        `캐시 읽기 ${count(usage.cacheReadTokens)} · 출력 ${count(usage.outputTokens)}`,
    ],
    ["API 요청", `${count(entry.requests)}회`],
    ["걸린 시간", formatDuration(entry.durationMs)],
  ];
}

/** 컴퓨터의 현지 시각 "10월 16일 15:30" */
export function formatTime(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getMonth() + 1}월 ${date.getDate()}일 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** "12.3초" */
export function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}초`;
}

function count(value: number): string {
  return value.toLocaleString("ko-KR");
}
