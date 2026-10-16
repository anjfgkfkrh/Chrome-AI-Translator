import type { LogInfo } from "../shared/messages";
import { providerInfo, qualityTierOf } from "../shared/models";
import type { Settings } from "../shared/storage";
import { updateLogEntry, upsertLogEntry, type LogStatus } from "../shared/translation-log";
import type { TokenUsage } from "../shared/usage";

// 최근 번역 기록을 쓴다 (SPEC 13장 "최근 번역 기록"·"기록의 한 건"). 번역 요청 하나마다
// 시작할 때 한 건을 열거나(화면 변화로 더 번역하면 그 건에 더하고), 끝날 때 모은 숫자를 더한다.

/** 요청 하나 동안 모은 숫자 */
export class RequestStats {
  cached = 0;
  /** 넘긴 그룹 수 (캐시에서 꺼낸 것 포함) */
  delivered = 0;
  requests = 0;
  readonly usage: TokenUsage = { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 };

  addUsage(usage: TokenUsage): void {
    this.usage.inputTokens += usage.inputTokens;
    this.usage.cacheWriteTokens += usage.cacheWriteTokens;
    this.usage.cacheReadTokens += usage.cacheReadTokens;
    this.usage.outputTokens += usage.outputTokens;
  }
}

/** 요청이 어떻게 끝났는지. failed는 원문으로 남은 그룹 수 */
export type RequestEnd =
  | { kind: "done"; failed: number; cause?: string }
  | { kind: "error"; failed: number; cause: string }
  | { kind: "aborted" };

/** 기록을 연다. 같은 페이지 번역의 다음 요청이면 그 건의 전체 수에 더한다. */
export function beginLog(log: LogInfo, settings: Settings, groups: number): Promise<void> {
  return upsertLogEntry(
    log.id,
    () => ({
      id: log.id,
      startedAt: Date.now(),
      durationMs: 0,
      page: { title: log.title, url: log.url },
      provider: providerInfo(settings.provider).name,
      model: settings.model,
      tier: qualityTierOf(settings)?.label,
      translationMode: settings.translationMode,
      automatic: log.automatic,
      status: "translating",
      groups: { total: groups, cached: 0, translated: 0, failed: 0 },
      usage: { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 },
      requests: 0,
    }),
    (entry) => ({ ...entry, status: "translating", groups: { ...entry.groups, total: entry.groups.total + groups } }),
  );
}

/** 요청이 끝나면 모은 숫자를 더하고 결과를 정한다. 사용자가 기록을 지웠으면 되살리지 않는다. */
export function finishLog(id: string, stats: RequestStats, end: RequestEnd, elapsedMs: number): Promise<void> {
  return updateLogEntry(id, (entry) => {
    const groups = {
      total: entry.groups.total,
      cached: entry.groups.cached + stats.cached,
      translated: entry.groups.translated + (stats.delivered - stats.cached),
      failed: entry.groups.failed + (end.kind === "aborted" ? 0 : end.failed),
    };
    return {
      ...entry,
      finishedAt: Date.now(),
      durationMs: entry.durationMs + elapsedMs,
      groups,
      usage: {
        inputTokens: entry.usage.inputTokens + stats.usage.inputTokens,
        cacheWriteTokens: entry.usage.cacheWriteTokens + stats.usage.cacheWriteTokens,
        cacheReadTokens: entry.usage.cacheReadTokens + stats.usage.cacheReadTokens,
        outputTokens: entry.usage.outputTokens + stats.usage.outputTokens,
      },
      requests: entry.requests + stats.requests,
      status: statusOf(end, groups),
      cause: end.kind === "aborted" ? entry.cause : (end.cause ?? entry.cause),
    };
  });
}

/** 화면에 보인 결과와 같게 정한다: 하나도 번역하지 못했으면 오류, 일부만 못 했으면 일부 실패 (SPEC 13장 "실패 원인 표시") */
function statusOf(end: RequestEnd, groups: { cached: number; translated: number; failed: number }): LogStatus {
  if (end.kind === "aborted") return "aborted";
  if (end.kind === "error") return "error";
  if (groups.failed === 0) return "done";
  return groups.cached + groups.translated > 0 ? "partial" : "error";
}

/** 번역 스크립트가 보낸 기록 정보를 확인한다. 없거나 모양이 틀리면 기록하지 않는다. */
export function logInfoOf(value: unknown): LogInfo | undefined {
  const log = value as Partial<LogInfo> | null;
  if (typeof log?.id !== "string" || log.id === "") return undefined;
  return {
    id: log.id.slice(0, 64),
    title: typeof log.title === "string" ? log.title.slice(0, 200) : "",
    url: typeof log.url === "string" ? log.url.slice(0, 500) : "",
    automatic: log.automatic === true,
  };
}
