import {
  TRANSLATE_PORT,
  type BackgroundToContent,
  type ContentCommand,
  type ContentToBackground,
  type Message,
  type PageState,
  type RequestGroup,
  type TabState,
  type TestConnectionResult,
} from "../shared/messages";
import { getSettings } from "../shared/storage";
import { cacheStats, clearCache } from "./cache";
import { errorMessage, isKeyError, NO_API_KEY_MESSAGE } from "./errors";
import { AnthropicProvider } from "./providers/anthropic";
import { translateGroups } from "./translator";

// 서비스 워커는 언제든 종료될 수 있으므로 상태는 chrome.storage와 각 탭의 콘텐츠 스크립트에 두고
// 메모리에 의존하지 않는다 (SPEC 5.1).

const provider = new AnthropicProvider();
const MENU_ID = "translate-page";
/** manifest.json의 commands 이름 */
const TOGGLE_COMMAND = "toggle-translation";
const IDLE_STATE: PageState = { status: "idle", progress: { done: 0, total: 0 }, partial: false };

chrome.runtime.onInstalled.addListener((details) => {
  void createContextMenu();
  // 시나리오 1: 설치하면 옵션 페이지를 연다.
  if (details.reason === "install") void chrome.runtime.openOptionsPage();
});

async function createContextMenu(): Promise<void> {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: MENU_ID, title: "이 페이지 한국어로 번역", contexts: ["page"] });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ID && tab?.id !== undefined) void translateTab(tab.id);
});

// 단축키 (SPEC 4.8): 번역 ↔ 원문 전환
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === TOGGLE_COMMAND && tab?.id !== undefined) void toggleTab(tab.id);
});

chrome.runtime.onMessage.addListener((message: Message, sender, sendResponse) => {
  const respond = (task: Promise<unknown>) => {
    void task.then(sendResponse);
    return true; // 비동기로 응답한다
  };
  // 콘텐츠 스크립트의 알림에서 "설정 열기"를 눌렀을 때
  if (message?.type === "open-options") {
    void chrome.runtime.openOptionsPage();
    return false;
  }
  // 아래 메시지는 키를 담거나 다른 탭을 조작하므로 확장 프로그램 페이지(옵션·팝업)에서 온 것만 받는다.
  if (!isExtensionPage(sender)) return false;
  switch (message?.type) {
    case "test-connection":
      return respond(testConnection(message.apiKey, message.model));
    case "get-tab-state":
      return respond(tabState(message.tabId));
    case "tab-action":
      return respond(message.action === "translate" ? translateTab(message.tabId) : showOriginal(message.tabId));
    case "get-shortcut":
      return respond(shortcut());
    case "get-cache-stats":
      return respond(cacheStats());
    case "clear-cache":
      return respond(clearCache());
  }
  return false;
});

/** 우클릭 메뉴·팝업의 "번역": 키가 없으면 옵션 페이지를 열고, 있으면 번역을 시작한다 (SPEC 13장). */
async function translateTab(tabId: number): Promise<TabState> {
  const { apiKeys } = await getSettings();
  if (!apiKeys.anthropic) {
    await chrome.runtime.openOptionsPage();
    return tabState(tabId);
  }
  // 이미 넣은 콘텐츠 스크립트가 있으면 그쪽에 맡기고, 없으면 넣는다. 넣으면 바로 번역을 시작한다.
  const state = await sendToTab(tabId, { type: "translate" });
  if (state) return state;
  try {
    // 메뉴·팝업·단축키를 쓴 탭에는 activeTab 권한이 생긴다.
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  } catch (err) {
    console.warn("[AITranslator] 이 페이지에는 번역 스크립트를 넣을 수 없습니다.", err);
    return { status: "unsupported" };
  }
  return tabState(tabId);
}

/** 단축키: 번역 중이거나 번역됐으면 원문 보기, 아니면 번역 */
async function toggleTab(tabId: number): Promise<void> {
  const state = await sendToTab(tabId, { type: "get-state" });
  if (state?.status === "translating" || state?.status === "translated") {
    await sendToTab(tabId, { type: "show-original" });
  } else {
    await translateTab(tabId);
  }
}

async function showOriginal(tabId: number): Promise<TabState> {
  return (await sendToTab(tabId, { type: "show-original" })) ?? tabState(tabId);
}

/** 팝업이 볼 탭 상태 */
async function tabState(tabId: number): Promise<TabState> {
  const state = await sendToTab(tabId, { type: "get-state" });
  if (state) return state;
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  return tab && !canInject(tab.url) ? { status: "unsupported" } : IDLE_STATE;
}

/** 콘텐츠 스크립트에 명령을 보낸다. 아직 넣지 않았으면(받는 쪽이 없으면) undefined */
async function sendToTab(tabId: number, command: ContentCommand): Promise<PageState | undefined> {
  try {
    return await chrome.tabs.sendMessage<ContentCommand, PageState>(tabId, command, { frameId: 0 });
  } catch {
    return undefined;
  }
}

/** 콘텐츠 스크립트를 넣을 수 있는 주소인지. 주소를 모르면(권한 없음) 일단 넣어 보고 판단한다. */
function canInject(url: string | undefined): boolean {
  if (url === undefined) return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!["http:", "https:", "file:"].includes(parsed.protocol)) return false;
  // Chrome 웹 스토어에는 확장 프로그램이 스크립트를 넣을 수 없다.
  const webStore =
    parsed.hostname === "chromewebstore.google.com" ||
    (parsed.hostname === "chrome.google.com" && parsed.pathname.startsWith("/webstore"));
  return !webStore;
}

/** 실제로 할당된 단축키 (SPEC 4.8.1). 다른 확장과 겹쳐 Chrome이 할당하지 않았으면 빈 문자열 */
async function shortcut(): Promise<string> {
  const commands = await chrome.commands.getAll();
  return commands.find((command) => command.name === TOGGLE_COMMAND)?.shortcut ?? "";
}

async function testConnection(apiKey: string, model: string): Promise<TestConnectionResult> {
  return provider.testConnection({ apiKey, model: model || (await getSettings()).model });
}

function isExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL("")) === true;
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== TRANSLATE_PORT) return;
  // 번역 포트는 탭의 콘텐츠 스크립트만 연다.
  if (port.sender?.tab === undefined) {
    port.disconnect();
    return;
  }
  const controller = new AbortController();
  // 탭이 닫히거나 페이지를 옮기면 진행 중인 요청을 취소한다 (SPEC 5.4).
  port.onDisconnect.addListener(() => controller.abort());
  port.onMessage.addListener((message: ContentToBackground) => {
    if (message?.type === "translate" && Array.isArray(message.groups)) {
      void handleTranslate(port, message.groups, controller.signal);
    }
  });
});

async function handleTranslate(port: chrome.runtime.Port, groups: RequestGroup[], signal: AbortSignal): Promise<void> {
  const post = (message: BackgroundToContent) => {
    if (!signal.aborted) port.postMessage(message);
  };
  const settings = await getSettings();
  const apiKey = settings.apiKeys.anthropic;
  if (!apiKey) {
    post({ type: "error", message: NO_API_KEY_MESSAGE, needsSettings: true });
    return;
  }
  try {
    const summary = await translateGroups({
      provider,
      apiKey,
      settings,
      groups,
      signal,
      onResults: (results) => post({ type: "results", groups: results }),
    });
    post({
      type: "done",
      failed: summary.failed,
      error:
        summary.lastError === undefined ? undefined : errorMessage(summary.lastError, settings.model, "translation"),
    });
  } catch (err) {
    if (signal.aborted) return;
    console.error("[AITranslator] 번역을 멈췄습니다.", err instanceof Error ? err.message : err);
    post({
      type: "error",
      message: errorMessage(err, settings.model, "translation"),
      needsSettings: isKeyError(err),
    });
  }
}
