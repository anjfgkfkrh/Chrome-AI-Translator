import { serialQueue } from "./serial";

// 사용량 (SPEC 4.10, 6, 13장 "사용량 표시"): 이번 달 API 응답의 usage를 입력·캐시 쓰기·캐시 읽기·출력으로 나눠 더한다.
// 백그라운드가 더하고 옵션 페이지가 읽는다.

/** 응답 하나의 토큰 수. 입력은 캐시를 쓰지 않은 부분만이다. */
export interface TokenUsage {
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
}

export interface UsageStats extends TokenUsage {
  /** "2026-10" (컴퓨터의 현지 시각) */
  month: string;
}

export const USAGE_KEY = "usage";

const NO_USAGE: TokenUsage = { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 };

/** 현지 시각 기준 "YYYY-MM" */
export function monthOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/** 이번 달 사용량. 저장된 값이 지난달 것이면 0부터 센다. */
export async function getUsage(now = new Date()): Promise<UsageStats> {
  const month = monthOf(now);
  const { [USAGE_KEY]: stored } = await chrome.storage.local.get<Record<string, unknown>>(USAGE_KEY);
  return isUsageStats(stored) && stored.month === month ? stored : { month, ...NO_USAGE };
}

export function isEmptyUsage(usage: TokenUsage): boolean {
  return usage.inputTokens + usage.cacheWriteTokens + usage.cacheReadTokens + usage.outputTokens === 0;
}

// 배치 여러 개가 동시에 끝나도 더한 값을 잃지 않게 하나씩 쓴다.
const oneAtATime = serialQueue();

/** 응답 하나의 사용량을 더한다. 달이 바뀌었으면 새로 센다 (한 달치만 저장, SPEC 13장). */
export function recordUsage(usage: TokenUsage, now = new Date()): Promise<void> {
  return oneAtATime(async () => {
    const total = await getUsage(now);
    const stats: UsageStats = {
      month: total.month,
      inputTokens: total.inputTokens + usage.inputTokens,
      cacheWriteTokens: total.cacheWriteTokens + usage.cacheWriteTokens,
      cacheReadTokens: total.cacheReadTokens + usage.cacheReadTokens,
      outputTokens: total.outputTokens + usage.outputTokens,
    };
    await chrome.storage.local.set({ [USAGE_KEY]: stats });
  });
}

function isUsageStats(value: unknown): value is UsageStats {
  const stats = value as Partial<UsageStats> | null;
  return (
    typeof stats?.month === "string" &&
    Object.keys(NO_USAGE).every((key) => typeof stats[key as keyof TokenUsage] === "number")
  );
}
