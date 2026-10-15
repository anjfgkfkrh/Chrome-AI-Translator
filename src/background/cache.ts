import type { RequestGroup } from "../shared/messages";
import type { Settings } from "../shared/storage";

// 번역 캐시 (SPEC 4.7, 13장 "캐시 용량"·"캐시 저장 방식"·"캐시 키").
// 문자열(그룹)마다 chrome.storage.local에 항목 하나를 두고, 페이지가 달라도 같은 문자열이면 재사용한다.

const KEY_PREFIX = "t:";
/** 전체 상한. 넘으면 오래 쓰지 않은 항목부터 TARGET_BYTES가 될 때까지 지운다. */
const MAX_BYTES = 8 * 1024 * 1024;
const TARGET_BYTES = 7 * 1024 * 1024;

/** 저장 형식. 항목이 많으므로 이름을 짧게 쓴다: s = 번역된 세그먼트, t = 마지막으로 쓴 시각(ms) */
interface Entry {
  s: string[];
  t: number;
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

/** 캐시에서 찾는다. 찾은 항목은 마지막 사용 시각을 새로 적는다 (오래 쓰지 않은 것부터 지우기 위해). */
export async function lookupCache(keys: readonly string[]): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>();
  if (keys.length === 0) return found;
  const items = await chrome.storage.local.get<Record<string, unknown>>([...keys]);
  const now = Date.now();
  const touched: Record<string, Entry> = {};
  for (const [key, entry] of Object.entries(items)) {
    if (!isEntry(entry)) continue;
    found.set(key, entry.s);
    touched[key] = { s: entry.s, t: now };
  }
  if (found.size > 0) await chrome.storage.local.set(touched);
  return found;
}

/** 번역 결과를 넣는다. 저장소 전체가 상한을 넘으면 오래 쓰지 않은 항목부터 지운다. */
export async function storeCache(
  translations: ReadonlyMap<string, string[]>,
  limits = { maxBytes: MAX_BYTES, targetBytes: TARGET_BYTES },
): Promise<void> {
  if (translations.size === 0) return;
  const now = Date.now();
  await chrome.storage.local.set(Object.fromEntries([...translations].map(([key, s]) => [key, { s, t: now }])));
  if ((await chrome.storage.local.getBytesInUse(null)) > limits.maxBytes) await evict(limits.targetBytes);
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

async function evict(targetBytes: number): Promise<void> {
  const all = await chrome.storage.local.get<Record<string, unknown>>(null);
  const entries = Object.entries(all)
    .filter((item): item is [string, Entry] => item[0].startsWith(KEY_PREFIX) && isEntry(item[1]))
    .sort((a, b) => a[1].t - b[1].t);
  let bytes = await chrome.storage.local.getBytesInUse(null);
  const remove: string[] = [];
  for (const [key, entry] of entries) {
    if (bytes <= targetBytes) break;
    remove.push(key);
    bytes -= new TextEncoder().encode(key + JSON.stringify(entry)).length;
  }
  if (remove.length > 0) await chrome.storage.local.remove(remove);
}

function isEntry(value: unknown): value is Entry {
  const entry = value as Partial<Entry> | null;
  return (
    Array.isArray(entry?.s) && entry.s.every((segment) => typeof segment === "string") && typeof entry.t === "number"
  );
}
