import type { RequestGroup, SegmentGroup } from "../shared/messages";
import type { Settings } from "../shared/storage";
import { cacheKey, lookupCache, storeCache } from "./cache";
import { validateGroups } from "./prompt";
import { ProviderError, type TranslationProvider } from "./providers/types";

// 배치, 동시성, 재시도, 캐시 (SPEC 4.2, 4.5, 4.7, 5.4)

/** 토큰 수 어림: 글자 수 ÷ 3 (SPEC 13장 "배치 한도") */
const CHARS_PER_TOKEN = 3;
const BATCH_MAX_TOKENS = 3_000;
const BATCH_MAX_CHARS = BATCH_MAX_TOKENS * CHARS_PER_TOKEN;

// SPEC 13장 "재시도 대기"
const MAX_RETRIES = 3; // 429, 500, 529
const NETWORK_RETRIES = 1;
const BASE_DELAY_MS = 1_000;
const MAX_RETRY_AFTER_MS = 60_000;

export interface TranslationJob {
  provider: TranslationProvider;
  apiKey: string;
  settings: Settings;
  groups: RequestGroup[];
  /** 탭이 닫히거나 페이지를 옮기면 취소된다 (SPEC 5.4). */
  signal: AbortSignal;
  /** 배치가 끝날 때마다 검증을 통과한 그룹을 넘긴다. */
  onResults(groups: SegmentGroup[]): void;
}

export interface TranslationSummary {
  /** 번역하지 못해 원문으로 남은 그룹 수 */
  failed: number;
  /** 그 원인 중 마지막 오류 */
  lastError?: unknown;
}

/**
 * 캐시에 있는 그룹은 바로 넘기고, 없는 그룹만 배치로 묶어 번역한다 (SPEC 4.7, 13장).
 * 키 오류처럼 다른 배치도 실패할 오류가 나면 나머지 배치를 멈추고 그 오류를 던진다.
 * 그 밖의 실패(재시도까지 실패, 형식 오류, refusal)는 해당 그룹만 원문으로 두고 계속한다.
 */
export async function translateGroups(job: TranslationJob): Promise<TranslationSummary> {
  const { misses, keyById } = await useCache(job);
  const stopAll = new AbortController();
  const signal = AbortSignal.any([job.signal, stopAll.signal]);
  limiter.max = job.settings.maxConcurrentRequests;

  const assembler = new Assembler(misses, job.settings.batchMaxNodes);
  const saving: Promise<void>[] = [];
  let fatal: { error: unknown } | undefined;
  let lastError: unknown;

  await Promise.all(
    pack(assembler.pieces, job.settings.batchMaxNodes).map(async (batch) => {
      try {
        const outcome = await limiter.run(() => translateBatch(job, batch, signal), signal);
        const done = assembler.complete(outcome.valid, outcome.failed);
        if (done.length > 0) {
          saving.push(saveToCache(done, keyById));
          job.onResults(done);
        }
        if (outcome.error !== undefined) lastError = outcome.error;
      } catch (err) {
        if (signal.aborted) return; // 탭이 닫혔거나, 다른 배치의 치명적인 오류로 이미 멈췄다
        fatal = { error: err };
        stopAll.abort(err);
      }
    }),
  );
  await Promise.all(saving);
  if (fatal) throw fatal.error;
  job.signal.throwIfAborted();
  return { failed: assembler.failedCount, lastError };
}

/** 캐시에 있는 그룹은 바로 넘기고, 없는 그룹과 그 캐시 키를 돌려준다. 저장소를 못 읽으면 캐시 없이 진행한다. */
async function useCache(job: TranslationJob): Promise<{ misses: RequestGroup[]; keyById: Map<string, string> }> {
  const keys = await Promise.all(job.groups.map((group) => cacheKey(job.settings, group)));
  const cached = await lookupCache(keys).catch((err: unknown) => {
    console.warn("[AITranslator] 캐시를 읽지 못했습니다.", err);
    return new Map<string, string[]>();
  });
  const hits: SegmentGroup[] = [];
  const misses: RequestGroup[] = [];
  const keyById = new Map<string, string>();
  job.groups.forEach((group, i) => {
    const segments = cached.get(keys[i]!);
    if (segments?.length === group.segments.length) {
      hits.push({ id: group.id, segments });
    } else {
      misses.push(group);
      keyById.set(group.id, keys[i]!);
    }
  });
  if (hits.length > 0) job.onResults(hits);
  return { misses, keyById };
}

async function saveToCache(groups: readonly SegmentGroup[], keyById: ReadonlyMap<string, string>): Promise<void> {
  const translations = new Map<string, string[]>();
  for (const group of groups) {
    const key = keyById.get(group.id);
    if (key) translations.set(key, group.segments);
  }
  await storeCache(translations).catch((err: unknown) => {
    console.warn("[AITranslator] 번역을 캐시에 저장하지 못했습니다.", err);
  });
}

interface BatchOutcome {
  valid: SegmentGroup[];
  failed: RequestGroup[];
  error?: unknown;
}

/** 배치 하나: 형식 오류(파싱 실패, ID 누락, 개수 불일치, 빈 세그먼트)는 해당 그룹만 1회 재요청한다 (SPEC 4.3, 13장). */
async function translateBatch(job: TranslationJob, groups: RequestGroup[], signal: AbortSignal): Promise<BatchOutcome> {
  const valid: SegmentGroup[] = [];
  let pending = groups;
  let error: unknown;
  for (let round = 0; round < 2 && pending.length > 0; round++) {
    try {
      const response = await requestWithRetry(job, pending, signal);
      const checked = validateGroups(pending, response.groups);
      valid.push(...checked.valid);
      pending = checked.invalid;
      if (pending.length > 0) error = new ProviderError("format", "응답 형식이 맞지 않는 그룹이 있습니다.");
    } catch (err) {
      if (signal.aborted || !(err instanceof ProviderError) || isFatal(err)) throw err;
      error = err;
      // 파싱 실패·잘린 응답만 배치를 다시 보낸다. 재시도까지 실패한 오류와 refusal은 원문으로 둔다.
      if (err.kind !== "format") break;
    }
  }
  if (pending.length > 0) {
    console.warn(
      `[AITranslator] 번역하지 못해 원문으로 둔 그룹: ${pending.map((group) => group.id).join(", ")}`,
      error instanceof Error ? error.message : error,
    );
  }
  return { valid, failed: pending, error: pending.length > 0 ? error : undefined };
}

/** HTTP 단계 재시도 (SPEC 5.4) */
async function requestWithRetry(job: TranslationJob, groups: RequestGroup[], signal: AbortSignal) {
  let retries = 0;
  let networkRetries = 0;
  for (;;) {
    try {
      return await job.provider.translate(
        { targetLanguage: "ko", glossary: job.settings.glossary, groups },
        { apiKey: job.apiKey, model: job.settings.model, signal },
      );
    } catch (err) {
      if (!(err instanceof ProviderError) || signal.aborted) throw err;
      let delay: number | undefined;
      if (err.kind === "rate_limit" && retries < MAX_RETRIES) {
        delay = err.retryAfterMs !== undefined ? Math.min(err.retryAfterMs, MAX_RETRY_AFTER_MS) : backoff(retries);
        retries++;
      } else if (err.kind === "server" && retries < MAX_RETRIES) {
        delay = backoff(retries);
        retries++;
      } else if ((err.kind === "network" || err.kind === "timeout") && networkRetries < NETWORK_RETRIES) {
        delay = BASE_DELAY_MS;
        networkRetries++;
      }
      if (delay === undefined) throw err;
      await sleep(delay, signal);
    }
  }
}

/** 이 오류는 다른 배치도 같은 이유로 실패하므로 번역 전체를 멈춘다 (키 오류, 없는 모델, 잔액 부족 같은 요청 오류). */
function isFatal(err: ProviderError): boolean {
  return err.kind === "auth" || err.kind === "not_found" || err.kind === "other";
}

/** 1초 → 2초 → 4초, ±20% */
function backoff(retry: number): number {
  return BASE_DELAY_MS * 2 ** retry * (0.8 + Math.random() * 0.4);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

interface Size {
  nodes: number;
  chars: number;
}

function sizeOf(group: RequestGroup): Size {
  const chars = group.segments.reduce((sum, segment) => sum + segment.length, 0) + (group.context?.length ?? 0);
  return { nodes: group.segments.length, chars };
}

function fits(size: Size, maxNodes: number): boolean {
  return size.nodes <= maxNodes && size.chars <= BATCH_MAX_CHARS;
}

/** 그룹을 쪼개지 않고 배치에 담는다. 한도에 닿으면 새 배치를 연다. */
function pack(groups: readonly RequestGroup[], maxNodes: number): RequestGroup[][] {
  const batches: RequestGroup[][] = [];
  let batch: RequestGroup[] = [];
  let used: Size = { nodes: 0, chars: 0 };
  for (const group of groups) {
    const size = sizeOf(group);
    if (batch.length > 0 && !fits({ nodes: used.nodes + size.nodes, chars: used.chars + size.chars }, maxNodes)) {
      batches.push(batch);
      batch = [];
      used = { nodes: 0, chars: 0 };
    }
    batch.push(group);
    used = { nodes: used.nodes + size.nodes, chars: used.chars + size.chars };
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

/**
 * 그룹 하나가 한도를 넘을 때만 나눈다 (SPEC 13장). 문맥을 빼서 들어가면 문맥만 빼고,
 * 그래도 넘으면 한도 크기 조각("g12#1", "g12#2" …)으로 나눈다. 조각에는 문맥을 붙이지 않는다.
 */
function fitGroup(group: RequestGroup, maxNodes: number): RequestGroup[] {
  if (fits(sizeOf(group), maxNodes)) return [group];
  const bare: RequestGroup = { id: group.id, segments: group.segments };
  if (fits(sizeOf(bare), maxNodes)) return [bare];

  const pieces: string[][] = [];
  let current: string[] = [];
  let chars = 0;
  for (const segment of group.segments) {
    if (current.length > 0 && (current.length >= maxNodes || chars + segment.length > BATCH_MAX_CHARS)) {
      pieces.push(current);
      current = [];
      chars = 0;
    }
    current.push(segment);
    chars += segment.length;
  }
  pieces.push(current);
  return pieces.map((segments, i) => ({ id: `${group.id}#${i + 1}`, segments }));
}

/** 나눠 보낸 조각의 결과를 모아, 조각이 모두 온 그룹만 원래 ID로 돌려준다. */
class Assembler {
  readonly pieces: RequestGroup[] = [];
  private readonly owners = new Map<string, { id: string; index: number }>();
  private readonly parts = new Map<string, (string[] | undefined)[]>();
  private readonly failed = new Set<string>();

  constructor(groups: readonly RequestGroup[], maxNodes: number) {
    for (const group of groups) {
      const pieces = fitGroup(group, maxNodes);
      this.parts.set(group.id, pieces.map(() => undefined));
      pieces.forEach((piece, index) => {
        this.owners.set(piece.id, { id: group.id, index });
        this.pieces.push(piece);
      });
    }
  }

  get failedCount(): number {
    return this.failed.size;
  }

  complete(valid: readonly SegmentGroup[], failed: readonly RequestGroup[]): SegmentGroup[] {
    for (const piece of failed) {
      const owner = this.owners.get(piece.id);
      if (owner) this.failed.add(owner.id);
    }
    const done: SegmentGroup[] = [];
    for (const piece of valid) {
      const owner = this.owners.get(piece.id);
      const parts = owner && this.parts.get(owner.id);
      if (!owner || !parts) continue;
      parts[owner.index] = piece.segments;
      if (!this.failed.has(owner.id) && parts.every((part) => part !== undefined)) {
        done.push({ id: owner.id, segments: parts.flatMap((part) => part ?? []) });
      }
    }
    return done;
  }
}

/** 백그라운드 전체에서 동시에 보내는 요청 수를 제한한다 (탭이 여러 개여도 합쳐서, SPEC 13장). */
class Limiter {
  max = 3;
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  async run<T>(task: () => Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    if (this.active < this.max) this.active++;
    else await this.wait(signal); // 깨어날 때 끝난 작업의 자리를 그대로 넘겨받는다
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }

  private wait(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const wake = () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        this.waiting.splice(this.waiting.indexOf(wake), 1);
        reject(signal.reason);
      };
      this.waiting.push(wake);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

const limiter = new Limiter();
