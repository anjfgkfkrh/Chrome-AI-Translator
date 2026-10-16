import type { RequestGroup } from "../shared/messages";
import { serialQueue } from "../shared/serial";
import type { Settings } from "../shared/storage";

// 번역 캐시 (SPEC 4.7, 13장 "캐시 용량"·"캐시 저장 방식"·"캐시 키"·"캐시 정리").
// 문자열(그룹)마다 chrome.storage.local에 항목 하나를 두고, 페이지가 달라도 같은 문자열이면 재사용한다.
// 페이지 번역 한 번을 한 턴으로 세어, 용량이 차면 오래 쓰이지 않은 번역문부터 지운다.

const KEY_PREFIX = "t:";
/** 지금까지 연 턴 수 */
const TURN_KEY = "cacheTurn";
const MEGABYTE = 1024 * 1024;
/** 정리한 뒤에도 상한을 넘으면 상한의 이 비율이 될 때까지 지운다 (8MB → 7MB, SPEC 13장). */
const TARGET_RATIO = 7 / 8;

/** 저장 형식. 항목이 많으므로 이름을 짧게 쓴다: s = 번역된 세그먼트, u = 마지막으로 쓴 턴, f = 빠르게(사고 끔) 번역 */
interface Entry {
  s: string[];
  /** M5 형식(t = 시각)으로 저장된 항목에는 없다. 턴 0으로 본다 (SPEC 13장). */
  u?: number;
  /** 사고를 끄고 번역했으면 1 (SPEC 13장 "번역 방식과 캐시") */
  f?: 1;
}

export interface CacheLimits {
  maxBytes: number;
  targetBytes: number;
  /** 상한의 몇 %부터 정리할지 */
  cleanupPercent: number;
  /** 최근 몇 턴 동안 쓰이지 않은 번역문을 지울지 */
  idleTurns: number;
}

export function cacheLimits(settings: Settings): CacheLimits {
  const maxBytes = settings.cacheMaxMB * MEGABYTE;
  return {
    maxBytes,
    targetBytes: Math.floor(maxBytes * TARGET_RATIO),
    cleanupPercent: settings.cacheCleanupPercent,
    idleTurns: settings.cacheIdleTurns,
  };
}

/** hash(제공업체 + 모델 + 대상 언어 + 용어집 버전 + 세그먼트 원문 + context), SHA-256 앞 128비트 */
export async function cacheKey(settings: Settings, group: RequestGroup): Promise<string> {
  const source = JSON.stringify([
    settings.provider,
    settings.model,
    settings.targetLanguage,
    settings.glossary.version,
    group.segments,
    group.context ?? "",
  ]);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source)));
  return KEY_PREFIX + [...digest.subarray(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// 탭 여러 개가 동시에 번역을 시작해도 턴을 잃지 않게 하나씩 센다.
const counting = serialQueue();
// 배치가 동시에 끝나도 정리는 하나씩 한다.
const cleaning = serialQueue();

/** 새 턴을 열고 그 번호를 돌려준다. 페이지 번역을 시작할 때 부른다 (SPEC 13장 "캐시 정리: 턴"). */
export function startTurn(): Promise<number> {
  return counting(async () => {
    const turn = (await currentTurn()) + 1;
    await chrome.storage.local.set({ [TURN_KEY]: turn });
    return turn;
  });
}

/** 지금 턴. 번역 보기 중 화면이 바뀌어 더 번역할 때는 새 턴을 열지 않고 이 값을 쓴다. */
export async function currentTurn(): Promise<number> {
  const { [TURN_KEY]: turn } = await chrome.storage.local.get<Record<string, unknown>>(TURN_KEY);
  return typeof turn === "number" ? turn : 0;
}

/**
 * 캐시에서 찾는다. 찾은 번역문은 이번 턴에 쓴 것으로 적는다.
 * accurate면 빠르게(사고 끔) 번역한 것은 없는 것으로 본다. 다시 번역해 바꿔 넣게 된다 (SPEC 13장 "번역 방식과 캐시").
 */
export async function lookupCache(
  keys: readonly string[],
  turn: number,
  options: { accurate: boolean } = { accurate: false },
): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>();
  if (keys.length === 0) return found;
  const items = await chrome.storage.local.get<Record<string, unknown>>([...keys]);
  const touched: Record<string, Entry> = {};
  for (const [key, entry] of Object.entries(items)) {
    if (!isEntry(entry) || (options.accurate && entry.f === 1)) continue;
    found.set(key, entry.s);
    touched[key] = entry.f === 1 ? { s: entry.s, u: turn, f: 1 } : { s: entry.s, u: turn };
  }
  if (found.size > 0) await chrome.storage.local.set(touched);
  return found;
}

/** 번역 결과를 이번 턴에 쓴 것으로 넣고, 저장소가 정리를 시작할 만큼 찼으면 정리한다. fast면 빠르게로 표시한다. */
export async function storeCache(
  translations: ReadonlyMap<string, string[]>,
  turn: number,
  limits: CacheLimits,
  options: { fast: boolean } = { fast: false },
): Promise<void> {
  if (translations.size === 0) return;
  const entries = [...translations].map(([key, s]) => [key, (options.fast ? { s, u: turn, f: 1 } : { s, u: turn }) satisfies Entry]);
  await chrome.storage.local.set(Object.fromEntries(entries));
  await cleanUpCache(turn, limits);
}

/** 저장소가 정리를 시작할 만큼 찼으면 정리한다. 정리는 하나씩 한다. */
export function cleanUpCache(turn: number, limits: CacheLimits): Promise<void> {
  return cleaning(() => cleanUp(turn, limits));
}

export async function cacheStats(): Promise<{ count: number; bytes: number }> {
  const keys = await cacheKeys();
  return { count: keys.length, bytes: keys.length > 0 ? await chrome.storage.local.getBytesInUse(keys) : 0 };
}

export async function clearCache(): Promise<void> {
  const keys = await cacheKeys();
  if (keys.length > 0) await chrome.storage.local.remove(keys);
}

async function cacheKeys(): Promise<string[]> {
  return (await chrome.storage.local.getKeys()).filter((key) => key.startsWith(KEY_PREFIX));
}

/**
 * 저장소가 상한의 cleanupPercent% 이상이면 최근 idleTurns 턴 동안 쓰이지 않은 번역문을 모두 지운다.
 * 그래도 상한을 넘으면 오래 쓰지 않은 것(턴 기준)부터 targetBytes가 될 때까지 지운다 (SPEC 13장 "캐시 정리").
 */
async function cleanUp(turn: number, limits: CacheLimits): Promise<void> {
  let bytes = await chrome.storage.local.getBytesInUse(null);
  if (bytes < (limits.maxBytes * limits.cleanupPercent) / 100) return;
  const all = await chrome.storage.local.get<Record<string, unknown>>(null);
  const entries = Object.entries(all)
    .filter((item): item is [string, Entry] => item[0].startsWith(KEY_PREFIX) && isEntry(item[1]))
    .map(([key, entry]) => ({ key, used: entry.u ?? 0, bytes: sizeOf(key, entry) }))
    .sort((a, b) => a.used - b.used);

  const remove: string[] = [];
  const recent: typeof entries = [];
  for (const entry of entries) {
    if (turn - entry.used >= limits.idleTurns) {
      remove.push(entry.key);
      bytes -= entry.bytes;
    } else {
      recent.push(entry);
    }
  }
  if (bytes > limits.maxBytes) {
    for (const entry of recent) {
      if (bytes <= limits.targetBytes) break;
      remove.push(entry.key);
      bytes -= entry.bytes;
    }
  }
  if (remove.length > 0) await chrome.storage.local.remove(remove);
}

/** Chrome처럼 "키 + 값의 JSON" 바이트 수로 센다. */
function sizeOf(key: string, entry: Entry): number {
  return new TextEncoder().encode(key + JSON.stringify(entry)).length;
}

function isEntry(value: unknown): value is Entry {
  const entry = value as Partial<Entry> | null;
  return (
    Array.isArray(entry?.s) &&
    entry.s.every((segment) => typeof segment === "string") &&
    (entry.u === undefined || typeof entry.u === "number") &&
    (entry.f === undefined || entry.f === 1)
  );
}
