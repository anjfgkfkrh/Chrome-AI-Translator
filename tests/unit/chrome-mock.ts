import { vi } from "vitest";

// 단위 테스트용 chrome API 최소 구현. 실제 브라우저 동작은 tests/e2e에서 확인한다.

export const EXTENSION_ID = "aitranslatortestid";

type Listener = (...args: any[]) => unknown;

export function installChromeMock() {
  const storage: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  /** chrome.scripting.registerContentScripts로 등록된 스크립트 */
  const registered: chrome.scripting.RegisteredContentScript[] = [];
  const onInstalled: Listener[] = [];
  const onStartup: Listener[] = [];
  const onPermissionsAdded: Listener[] = [];
  const onPermissionsRemoved: Listener[] = [];
  const onMessage: Listener[] = [];
  const onConnect: Listener[] = [];
  const onMenuClicked: Listener[] = [];
  const onCommand: Listener[] = [];
  const openOptionsPage = vi.fn(async () => {});
  const createMenu = vi.fn();
  const removeAllMenus = vi.fn(async () => {});
  const executeScript = vi.fn(async () => []);
  // 기본은 "콘텐츠 스크립트가 아직 없음" (받는 쪽이 없어 실패)
  const tabsSendMessage = vi.fn(async (): Promise<unknown> => {
    throw new Error("Could not establish connection. Receiving end does not exist.");
  });
  const getTab = vi.fn(async (tabId: number) => ({ id: tabId, url: "https://example.com/docs" }) as chrome.tabs.Tab);
  /** 지금 보고 있는 탭 (팝업의 대상) */
  const queryTabs = vi.fn(async (_query: chrome.tabs.QueryInfo) => [{ id: 7 } as chrome.tabs.Tab]);
  const createTab = vi.fn(async () => ({}));
  const getCommands = vi.fn(async () => [{ name: "toggle-translation", shortcut: "⌥T" }]);
  const runtimeSendMessage = vi.fn(async (_message: any): Promise<unknown> => undefined);
  const connect = vi.fn();
  const requestPermissions = vi.fn(async (_permissions: chrome.permissions.Permissions) => true);
  const containsPermissions = vi.fn(async (_permissions: chrome.permissions.Permissions) => true);
  const removePermissions = vi.fn(async (_permissions: chrome.permissions.Permissions) => true);
  const registerContentScripts = vi.fn(async (scripts: chrome.scripting.RegisteredContentScript[]) => {
    for (const script of scripts) {
      if (registered.some((item) => item.id === script.id)) throw new Error(`Duplicate script ID '${script.id}'`);
      registered.push(structuredClone(script));
    }
  });
  const updateContentScripts = vi.fn(async (scripts: chrome.scripting.RegisteredContentScript[]) => {
    for (const script of scripts) {
      const index = registered.findIndex((item) => item.id === script.id);
      if (index < 0) throw new Error(`Script with ID '${script.id}' does not exist`);
      registered[index] = { ...registered[index]!, ...structuredClone(script) };
    }
  });
  const unregisterContentScripts = vi.fn(async (filter?: { ids?: string[] }) => {
    for (let i = registered.length - 1; i >= 0; i--) {
      if (!filter?.ids || filter.ids.includes(registered[i]!.id)) registered.splice(i, 1);
    }
  });
  const getRegisteredContentScripts = vi.fn(async (filter?: { ids?: string[] }) =>
    structuredClone(registered.filter((script) => !filter?.ids || filter.ids.includes(script.id))),
  );

  vi.stubGlobal("chrome", {
    storage: {
      local: {
        async get(keys?: string | string[] | null) {
          const list = keys == null ? Object.keys(storage) : [keys].flat();
          return Object.fromEntries(
            list.filter((key) => key in storage).map((key) => [key, structuredClone(storage[key])]),
          );
        },
        async set(items: Record<string, unknown>) {
          for (const [key, value] of Object.entries(items)) storage[key] = structuredClone(value);
        },
        async remove(keys: string | string[]) {
          for (const key of [keys].flat()) delete storage[key];
        },
        async getKeys() {
          return Object.keys(storage);
        },
        // Chrome처럼 "키 + 값의 JSON" 바이트 수로 센다.
        async getBytesInUse(keys?: string | string[] | null) {
          const list = keys == null ? Object.keys(storage) : [keys].flat();
          const encoder = new TextEncoder();
          return list
            .filter((key) => key in storage)
            .reduce((sum, key) => sum + encoder.encode(key + JSON.stringify(storage[key])).length, 0);
        },
      },
      session: {
        async get(keys?: string | string[] | null) {
          const list = keys == null ? Object.keys(session) : [keys].flat();
          return Object.fromEntries(
            list.filter((key) => key in session).map((key) => [key, structuredClone(session[key])]),
          );
        },
        async set(items: Record<string, unknown>) {
          for (const [key, value] of Object.entries(items)) session[key] = structuredClone(value);
        },
        async remove(keys: string | string[]) {
          for (const key of [keys].flat()) delete session[key];
        },
      },
    },
    runtime: {
      id: EXTENSION_ID,
      getURL: (path: string) => `chrome-extension://${EXTENSION_ID}/${path}`,
      openOptionsPage,
      sendMessage: runtimeSendMessage,
      connect,
      onInstalled: { addListener: (fn: Listener) => onInstalled.push(fn) },
      onMessage: { addListener: (fn: Listener) => onMessage.push(fn) },
      onConnect: { addListener: (fn: Listener) => onConnect.push(fn) },
      onStartup: { addListener: (fn: Listener) => onStartup.push(fn) },
    },
    permissions: {
      request: requestPermissions,
      contains: containsPermissions,
      remove: removePermissions,
      onAdded: { addListener: (fn: Listener) => onPermissionsAdded.push(fn) },
      onRemoved: { addListener: (fn: Listener) => onPermissionsRemoved.push(fn) },
    },
    contextMenus: {
      create: createMenu,
      removeAll: removeAllMenus,
      onClicked: { addListener: (fn: Listener) => onMenuClicked.push(fn) },
    },
    commands: {
      getAll: getCommands,
      onCommand: { addListener: (fn: Listener) => onCommand.push(fn) },
    },
    tabs: { sendMessage: tabsSendMessage, get: getTab, create: createTab, query: queryTabs },
    scripting: {
      executeScript,
      registerContentScripts,
      updateContentScripts,
      unregisterContentScripts,
      getRegisteredContentScripts,
    },
  });

  return {
    storage,
    session,
    registered,
    onInstalled,
    onStartup,
    onPermissionsAdded,
    onPermissionsRemoved,
    onMessage,
    onConnect,
    onMenuClicked,
    onCommand,
    openOptionsPage,
    createMenu,
    removeAllMenus,
    executeScript,
    tabsSendMessage,
    getTab,
    queryTabs,
    createTab,
    getCommands,
    runtimeSendMessage,
    connect,
    requestPermissions,
    containsPermissions,
    removePermissions,
    registerContentScripts,
    updateContentScripts,
    unregisterContentScripts,
  };
}

/** chrome.runtime.Port 흉내. receive()는 상대가 보낸 메시지, close()는 상대 쪽 연결 끊김이다. */
export function createPort(sender: chrome.runtime.MessageSender, name = "translate") {
  const messageListeners: Listener[] = [];
  const disconnectListeners: Listener[] = [];
  const posted: any[] = [];
  const port = {
    name,
    sender,
    postMessage: vi.fn((message: unknown) => {
      posted.push(message);
    }),
    disconnect: vi.fn(),
    onMessage: { addListener: (fn: Listener) => messageListeners.push(fn) },
    onDisconnect: { addListener: (fn: Listener) => disconnectListeners.push(fn) },
  };
  return {
    port,
    posted,
    receive: (message: unknown) => messageListeners.forEach((fn) => fn(message, port)),
    close: () => disconnectListeners.forEach((fn) => fn(port)),
  };
}
