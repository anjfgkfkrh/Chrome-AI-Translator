import { serialQueue } from "../shared/serial";
import { originPattern } from "../shared/sites";
import { getSettings, setAutoTranslateOrigins } from "../shared/storage";

// 사이트별 자동 번역 (SPEC 4.8, 13장): 권한을 받은 출처에만 콘텐츠 스크립트를 등록해,
// 그 사이트의 페이지가 열릴 때마다 번역한다.

const SCRIPT_PREFIX = "auto:";
const PENDING_KEY = "pendingAutoTranslate";

interface Pending {
  origin: string;
  tabId: number;
}

/**
 * 목록과 등록을 바꾸는 작업은 하나씩 한다. 권한 창에서 허용하면 팝업과 permissions.onAdded가,
 * 브라우저를 시작하면 onInstalled와 onStartup이 거의 동시에 같은 일을 하기 때문이다.
 */
const oneAtATime = serialQueue();

/** 자동 번역을 켠다. 그 출처의 권한이 없으면 켜지 않고 false */
export function enableAutoTranslate(origin: string): Promise<boolean> {
  return oneAtATime(async () => {
    if (!(await hasPermission(origin))) return false;
    const { autoTranslateOrigins } = await getSettings();
    if (!autoTranslateOrigins.includes(origin)) await setAutoTranslateOrigins([...autoTranslateOrigins, origin]);
    await register(origin);
    return true;
  });
}

/** 자동 번역을 끄고 권한도 돌려준다 (SPEC 4.8). */
export function disableAutoTranslate(origin: string): Promise<void> {
  return oneAtATime(async () => {
    await removeSite(origin);
    // 필수 권한(테스트용 빌드의 픽스처 주소 등)은 돌려줄 수 없으므로 실패해도 넘어간다.
    await chrome.permissions.remove({ origins: [originPattern(origin)] }).catch(() => false);
  });
}

/** 목록에서 빼고 등록을 푼다. 권한은 건드리지 않는다 (이미 빠진 경우). */
export function forgetSite(origin: string): Promise<void> {
  return oneAtATime(() => removeSite(origin));
}

export async function isAutoTranslated(origin: string): Promise<boolean> {
  const { autoTranslateOrigins } = await getSettings();
  return autoTranslateOrigins.includes(origin) && (await hasPermission(origin));
}

/** 브라우저 시작·확장 설치·업데이트 때: 저장된 목록을 실제 권한에 맞추고, 등록도 목록에 맞춘다 (SPEC 13장). */
export function syncAutoTranslate(): Promise<void> {
  return oneAtATime(async () => {
    const { autoTranslateOrigins } = await getSettings();
    const granted: string[] = [];
    for (const origin of autoTranslateOrigins) if (await hasPermission(origin)) granted.push(origin);
    if (granted.length !== autoTranslateOrigins.length) await setAutoTranslateOrigins(granted);

    const wanted = new Set(granted.map(scriptId));
    const registered = (await chrome.scripting.getRegisteredContentScripts()).map((script) => script.id);
    await unregister(registered.filter((id) => id.startsWith(SCRIPT_PREFIX) && !wanted.has(id)));
    for (const origin of granted) await register(origin);
  });
}

/** 권한 창이 뜨면 팝업이 닫힐 수 있다. 팝업이 요청 직전에 남긴 표시로 백그라운드가 이어서 켠다 (SPEC 13장). */
export async function rememberPending(origin: string, tabId: number): Promise<void> {
  await chrome.storage.session.set({ [PENDING_KEY]: { origin, tabId } satisfies Pending });
}

/** 남긴 표시를 꺼내고 지운다. */
export async function takePending(): Promise<Pending | undefined> {
  const { [PENDING_KEY]: pending } = await chrome.storage.session.get<Record<string, unknown>>(PENDING_KEY);
  await chrome.storage.session.remove(PENDING_KEY);
  const value = pending as Partial<Pending> | undefined;
  return typeof value?.origin === "string" && typeof value.tabId === "number"
    ? { origin: value.origin, tabId: value.tabId }
    : undefined;
}

async function removeSite(origin: string): Promise<void> {
  const { autoTranslateOrigins } = await getSettings();
  if (autoTranslateOrigins.includes(origin)) {
    await setAutoTranslateOrigins(autoTranslateOrigins.filter((item) => item !== origin));
  }
  await unregister([scriptId(origin)]);
}

function hasPermission(origin: string): Promise<boolean> {
  return chrome.permissions.contains({ origins: [originPattern(origin)] });
}

async function register(origin: string): Promise<void> {
  const script: chrome.scripting.RegisteredContentScript = {
    id: scriptId(origin),
    matches: [originPattern(origin)],
    // auto.js가 먼저 돌아 "자동 번역으로 열림"을 표시한다. 키가 없으면 알림 없이 건너뛰기 위해서다.
    js: ["auto.js", "content.js"],
    runAt: "document_idle",
    persistAcrossSessions: true,
  };
  const exists = (await chrome.scripting.getRegisteredContentScripts({ ids: [script.id] })).length > 0;
  // 이미 있으면(지난 세션·이전 버전의 등록) 지금 버전의 설정으로 고친다.
  if (exists) await chrome.scripting.updateContentScripts([script]);
  else await chrome.scripting.registerContentScripts([script]);
}

async function unregister(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const present = (await chrome.scripting.getRegisteredContentScripts({ ids })).map((script) => script.id);
  if (present.length > 0) await chrome.scripting.unregisterContentScripts({ ids: present });
}

function scriptId(origin: string): string {
  return SCRIPT_PREFIX + origin;
}
