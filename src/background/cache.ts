import type { RequestGroup } from "../shared/messages";
import { CACHE_MODEL_RANKS, listedModel, type CacheModelName } from "../shared/models";
import { serialQueue } from "../shared/serial";
import type { Settings } from "../shared/storage";

// 번역 캐시 (SPEC 4.7, 13장 "캐시 용량"·"캐시 저장 방식"·"캐시 키"·"캐시 정리"·"캐시를 모델끼리 나눠 씀").
// 문자열(그룹)마다 chrome.storage.local에 항목 하나를 두고, 페이지가 달라도 같은 문자열이면 재사용한다.
// 목록에 있는 모델은 모델·제공업체가 달라도 항목을 함께 쓰고, 같거나 높은 품질로 번역한 것만 그대로 쓴다.
// 페이지 번역 한 번을 한 턴으로 세어, 용량이 차면 오래 쓰이지 않은 번역문부터 지운다.

const KEY_PREFIX = "c:";
/** 모델끼리 캐시를 나누기 전의 키. 새 규칙으로는 찾을 수 없어 업데이트할 때 지운다 (SPEC 13장 "캐시: 이전 형식"). */
const OLD_KEY_PREFIX = "t:";
/** 지금까지 연 턴 수 */
const TURN_KEY = "cacheTurn";
const MEGABYTE = 1024 * 1024;
/** 정리한 뒤에도 상한을 넘으면 상한의 이 비율이 될 때까지 지운다 (8MB → 7MB, SPEC 13장). */
const TARGET_RATIO = 7 / 8;

/**
 * 저장 형식. 항목이 많으므로 이름을 짧게 쓴다: s = 번역된 세그먼트, u = 마지막으로 쓴 턴,
 * m = 번역한 모델(목록에 있는 모델의 캐시 이름), f = 빠르게(사고 끔) 번역
 */
interface Entry {
  s: string[];
  u: number;
  /** 직접 입력한 모델이 번역한 것에는 없다. 그 모델의 키에만 넣고 그 모델만 본다 (SPEC 13장 "캐시: 직접 입력한 모델"). */
  m?: string;
  /** 사고를 끄고 번역했으면 1 (SPEC 13장 "번역 방식과 캐시") */
  f?: 1;
}

/** 번역문의 품질: 어느 모델이 사고를 끄고 번역했는지 (SPEC 13장 "캐시: 품질 비교") */
export interface CacheQuality {
  /** 목록에 있는 모델의 캐시 이름. 직접 입력한 모델이면 없다 (가장 낮은 등급) */
  model?: CacheModelName;
  fast: boolean;
}

/** 그룹 하나를 캐시에서 찾을 곳과 새 번역을 넣을 곳 */
export interface CacheSlot {
  /** 앞의 것부터 보고, 쓸 수 있는 번역문이 처음 나오는 것을 쓴다. */
  read: string[];
  write: string;
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

/** 이 설정으로 번역한 것의 품질. fast는 실제로 사고를 끄고 번역하는지다. */
export function cacheQuality(settings: Settings, fast: boolean): CacheQuality {
  return { model: listedModel(settings.model, settings.provider)?.cacheName, fast };
}

/**
 * 그룹의 캐시 자리 (SPEC 13장 "캐시 키"). 키는 SHA-256 앞 128비트다.
 * 목록에 있는 모델은 hash(대상 언어 + 용어집 버전 + 세그먼트 원문 + context) 하나를 함께 쓴다.
 * 직접 입력한 모델은 앞에 제공업체 + 모델을 더한 자기 키에 넣고, 찾을 때는 자기 키 다음에 함께 쓰는 키도 본다.
 * ownOnly("이 품질로 다시 번역")면 자기 키만 본다 (SPEC 13장 "직접 입력한 모델의 다시 번역").
 */
export async function cacheSlot(settings: Settings, group: RequestGroup, ownOnly = false): Promise<CacheSlot> {
  const source = [settings.targetLanguage, settings.glossary.version, group.segments, group.context ?? ""];
  if (listedModel(settings.model, settings.provider)) {
    const shared = await keyOf(source);
    return { read: [shared], write: shared };
  }
  const own = await keyOf([settings.provider, settings.model, ...source]);
  return { read: ownOnly ? [own] : [own, await keyOf(source)], write: own };
}

async function keyOf(source: readonly unknown[]): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(source))));
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
 * 그룹마다 캐시에서 찾는다. 찾은 번역문은 이번 턴에 쓴 것으로 적는다.
 * 이번 번역과 같거나 높은 품질의 번역문만 쓴다. 낮으면 없는 것으로 보므로 다시 번역해 바꿔 넣게 된다.
 */
export async function lookupCache(
  slots: readonly CacheSlot[],
  turn: number,
  quality: CacheQuality,
): Promise<(string[] | undefined)[]> {
  const keys = [...new Set(slots.flatMap((slot) => slot.read))];
  if (keys.length === 0) return slots.map(() => undefined);
  const items = await chrome.storage.local.get<Record<string, unknown>>(keys);
  const touched: Record<string, Entry> = {};
  const found = slots.map((slot) => {
    for (const key of slot.read) {
      const entry = items[key];
      if (!isEntry(entry) || !atLeast(entry, quality)) continue;
      touched[key] = entryOf(entry.s, turn, entry.m, entry.f === 1);
      return entry.s;
    }
    return undefined;
  });
  if (Object.keys(touched).length > 0) await chrome.storage.local.set(touched);
  return found;
}

/**
 * 새 번역을 이번 턴에 쓴 것으로 넣고, 저장소가 정리를 시작할 만큼 찼으면 정리한다.
 * 그사이 다른 탭이 더 높은 품질로 번역해 넣었으면 그것을 남긴다 (SPEC 13장 "캐시: 동시에 저장").
 */
export async function storeCache(
  translations: ReadonlyMap<string, string[]>,
  turn: number,
  limits: CacheLimits,
  quality: CacheQuality,
): Promise<void> {
  if (translations.size === 0) return;
  const stored = await chrome.storage.local.get<Record<string, unknown>>([...translations.keys()]);
  const entries: Record<string, Entry> = {};
  for (const [key, s] of translations) {
    const old = stored[key];
    entries[key] =
      isEntry(old) && old.s.length === s.length && higher(old, quality)
        ? entryOf(old.s, turn, old.m, old.f === 1)
        : entryOf(s, turn, quality.model, quality.fast);
  }
  await chrome.storage.local.set(entries);
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

/** 모델끼리 캐시를 나누기 전 형식의 번역문을 모두 지운다. 확장 프로그램을 업데이트할 때 부른다 (SPEC 13장 "캐시: 이전 형식"). */
export async function removeOldCache(): Promise<void> {
  const keys = (await chrome.storage.local.getKeys()).filter((key) => key.startsWith(OLD_KEY_PREFIX));
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
    .map(([key, entry]) => ({ key, used: entry.u, bytes: sizeOf(key, entry) }))
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

/** 캐시의 번역문이 이번 번역과 같거나 높은 품질인지: 모델 등급과 사고가 둘 다 같거나 높아야 한다 (SPEC 13장 "캐시: 품질 비교") */
function atLeast(entry: Entry, quality: CacheQuality): boolean {
  if (entry.f === 1 && !quality.fast) return false;
  // 모델이 적히지 않은 것은 직접 입력한 모델의 자기 키에만 있고, 그 키는 그 모델만 본다.
  if (entry.m === undefined) return quality.model === undefined;
  // 목록에서 빠진 모델이 번역한 것은 쓰지 않는다. 직접 입력한 모델은 가장 낮은 등급(0)이다.
  if (!Object.hasOwn(CACHE_MODEL_RANKS, entry.m)) return false;
  const required = quality.model === undefined ? 0 : CACHE_MODEL_RANKS[quality.model];
  return CACHE_MODEL_RANKS[entry.m as CacheModelName] >= required;
}

/** 넣으려는 번역보다 확실히 높은 품질인지: 같거나 높고, 똑같은 품질은 아니다. */
function higher(entry: Entry, quality: CacheQuality): boolean {
  return atLeast(entry, quality) && (entry.m !== quality.model || (entry.f === 1) !== quality.fast);
}

function entryOf(s: string[], turn: number, model: string | undefined, fast: boolean): Entry {
  const entry: Entry = { s, u: turn };
  if (model !== undefined) entry.m = model;
  if (fast) entry.f = 1;
  return entry;
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
    typeof entry.u === "number" &&
    (entry.m === undefined || typeof entry.m === "string") &&
    (entry.f === undefined || entry.f === 1)
  );
}
