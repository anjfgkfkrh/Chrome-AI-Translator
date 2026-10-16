import { beforeEach, describe, expect, it, vi } from "vitest";
import { monthOf } from "../../src/shared/usage";
import { echoUppercase, messageResponse, requestBody } from "../helpers/anthropic-mock";
import { createPort, EXTENSION_ID, installChromeMock } from "./chrome-mock";

let chromeMock: ReturnType<typeof installChromeMock>;

beforeEach(async () => {
  chromeMock = installChromeMock();
  vi.resetModules();
  await import("../../src/background/index");
});

const optionsPage: chrome.runtime.MessageSender = {
  id: EXTENSION_ID,
  url: `chrome-extension://${EXTENSION_ID}/options/options.html`,
};

const contentScript: chrome.runtime.MessageSender = {
  id: EXTENSION_ID,
  url: "https://example.com/docs",
  tab: { id: 7 } as chrome.tabs.Tab,
};

const popup: chrome.runtime.MessageSender = { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/popup/popup.html` };

function sendToBackground(message: unknown, sender: chrome.runtime.MessageSender) {
  const sendResponse = vi.fn();
  const keepOpen = chromeMock.onMessage[0]!(message, sender, sendResponse);
  return { keepOpen, sendResponse };
}

/** 메시지를 보내고 응답을 기다린다. */
async function ask(message: unknown, sender = popup) {
  const { keepOpen, sendResponse } = sendToBackground(message, sender);
  if (keepOpen) await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
  return sendResponse.mock.calls[0]?.[0];
}

function stubFetchOk() {
  const fetchMock = vi.fn<typeof fetch>(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function saveKey() {
  chromeMock.storage.settings = { apiKeys: { anthropic: "sk-ant-saved" } };
}

describe("설치", () => {
  it("설치하면 우클릭 메뉴를 만들고 옵션 페이지를 연다 (시나리오 1)", async () => {
    chromeMock.onInstalled[0]!({ reason: "install" });

    expect(chromeMock.openOptionsPage).toHaveBeenCalledOnce();
    await vi.waitFor(() =>
      expect(chromeMock.createMenu).toHaveBeenCalledWith({
        id: "translate-page",
        title: "이 페이지 한국어로 번역",
        contexts: ["page"],
      }),
    );
    expect(chromeMock.removeAllMenus).toHaveBeenCalledBefore(chromeMock.createMenu);
  });

  it("업데이트 때는 메뉴만 다시 만들고 옵션 페이지는 열지 않는다", async () => {
    chromeMock.onInstalled[0]!({ reason: "update", previousVersion: "0.0.1" });

    await vi.waitFor(() => expect(chromeMock.createMenu).toHaveBeenCalledOnce());
    expect(chromeMock.openOptionsPage).not.toHaveBeenCalled();
  });
});

describe("우클릭 메뉴 (SPEC 4.8, 13장)", () => {
  it("키가 없으면 옵션 페이지를 열고 스크립트는 넣지 않는다", async () => {
    chromeMock.onMenuClicked[0]!({ menuItemId: "translate-page" }, { id: 7 });

    await vi.waitFor(() => expect(chromeMock.openOptionsPage).toHaveBeenCalledOnce());
    expect(chromeMock.executeScript).not.toHaveBeenCalled();
  });

  it("키가 있으면 그 탭에 콘텐츠 스크립트를 넣는다", async () => {
    saveKey();

    chromeMock.onMenuClicked[0]!({ menuItemId: "translate-page" }, { id: 7 });

    await vi.waitFor(() =>
      expect(chromeMock.executeScript).toHaveBeenCalledWith({ target: { tabId: 7 }, files: ["content.js"] }),
    );
  });
});

describe("연결 테스트", () => {
  it("옵션 페이지가 보낸 (저장 전) 키와 고른 모델로 테스트한다", async () => {
    const fetchMock = stubFetchOk();

    const { keepOpen, sendResponse } = sendToBackground(
      { type: "test-connection", apiKey: "sk-ant-typed", model: "claude-sonnet-5-5" },
      optionsPage,
    );

    expect(keepOpen).toBe(true);
    await vi.waitFor(() =>
      expect(sendResponse).toHaveBeenCalledWith({ ok: true, message: "연결 성공 (claude-sonnet-5-5)" }),
    );
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ "x-api-key": "sk-ant-typed" });
    expect(requestBody(fetchMock.mock.calls[0]?.[1]).model).toBe("claude-sonnet-5-5");
  });

  it("모델이 비어 있으면 저장된 모델로 테스트한다", async () => {
    chromeMock.storage.settings = { model: "claude-test-model" };
    const fetchMock = stubFetchOk();

    sendToBackground({ type: "test-connection", apiKey: "sk-ant-typed", model: "" }, optionsPage);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(requestBody(fetchMock.mock.calls[0]?.[1]).model).toBe("claude-test-model");
  });

  it("웹 페이지(콘텐츠 스크립트)에서 온 연결 테스트 요청은 무시한다", () => {
    const fetchMock = stubFetchOk();

    const { keepOpen, sendResponse } = sendToBackground(
      { type: "test-connection", apiKey: "sk-ant-x", model: "claude-haiku-5-5" },
      contentScript,
    );

    expect(keepOpen).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sendResponse).not.toHaveBeenCalled();
  });
});

describe("번역 포트", () => {
  it("탭이 아닌 곳에서 연 포트는 끊는다", () => {
    const { port } = createPort(optionsPage);

    chromeMock.onConnect[0]!(port);

    expect(port.disconnect).toHaveBeenCalled();
  });

  it("받은 그룹을 번역해 results를 보내고 done으로 끝낸다. 키는 메시지에 넣지 않는다", async () => {
    saveKey();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(echoUppercase));
    const { port, posted, receive } = createPort(contentScript);
    chromeMock.onConnect[0]!(port);

    receive({ type: "translate", groups: [{ id: "g1", segments: ["Get started"] }] });

    await vi.waitFor(() =>
      expect(posted).toEqual([
        { type: "results", groups: [{ id: "g1", segments: ["GET STARTED"] }] },
        { type: "done", failed: 0, error: undefined },
      ]),
    );
    expect(JSON.stringify(posted)).not.toContain("sk-ant-saved");
  });

  it("키가 없으면 '설정 열기'를 붙일 error를 보낸다", async () => {
    const { port, posted, receive } = createPort(contentScript);
    chromeMock.onConnect[0]!(port);

    receive({ type: "translate", groups: [{ id: "g1", segments: ["Hello"] }] });

    await vi.waitFor(() =>
      expect(posted).toEqual([
        { type: "error", message: "API 키를 먼저 설정하세요", needsSettings: true, missingKey: true },
      ]),
    );
  });

  it("키 오류(401)면 번역을 멈추고 error를 보낸다", async () => {
    saveKey();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response('{"error":{"message":"invalid x-api-key"}}', { status: 401 })),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { port, posted, receive } = createPort(contentScript);
    chromeMock.onConnect[0]!(port);

    receive({ type: "translate", groups: [{ id: "g1", segments: ["Hello"] }] });

    await vi.waitFor(() =>
      expect(posted).toEqual([
        { type: "error", message: "API 키를 확인하세요.", needsSettings: true, missingKey: false },
      ]),
    );
  });

  it("그 밖의 오류는 '번역 실패:'로 알리고 '설정 열기'는 붙이지 않는다", async () => {
    saveKey();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        async () => new Response('{"error":{"message":"Your credit balance is too low."}}', { status: 400 }),
      ),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { port, posted, receive } = createPort(contentScript);
    chromeMock.onConnect[0]!(port);

    receive({ type: "translate", groups: [{ id: "g1", segments: ["Hello"] }] });

    await vi.waitFor(() =>
      expect(posted).toEqual([
        {
          type: "error",
          message: "번역 실패: Your credit balance is too low.",
          needsSettings: false,
          missingKey: false,
        },
      ]),
    );
  });

  it("포트가 끊기면(탭 닫힘) 진행 중인 요청을 취소하고 아무것도 보내지 않는다", async () => {
    saveKey();
    let aborted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        (_input, init) =>
          new Promise((_resolve, reject) =>
            init?.signal?.addEventListener("abort", () => {
              aborted = true;
              reject(init.signal!.reason);
            }),
          ),
      ),
    );
    const { port, posted, receive, close } = createPort(contentScript);
    chromeMock.onConnect[0]!(port);

    receive({ type: "translate", groups: [{ id: "g1", segments: ["Hello"] }] });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    close();

    await vi.waitFor(() => expect(aborted).toBe(true));
    expect(posted).toEqual([]);
  });
});

const translatedState = { status: "translated", progress: { done: 3, total: 3 }, partial: false };

describe("단축키 (SPEC 4.8, 13장)", () => {
  it("번역된 탭에서 누르면 원문 보기", async () => {
    chromeMock.tabsSendMessage.mockResolvedValue(translatedState);

    chromeMock.onCommand[0]!("toggle-translation", { id: 7 });

    await vi.waitFor(() =>
      expect(chromeMock.tabsSendMessage).toHaveBeenCalledWith(7, { type: "show-original" }, { frameId: 0 }),
    );
    expect(chromeMock.executeScript).not.toHaveBeenCalled();
  });

  it("원문 표시 중인 탭에서 누르면 다시 번역", async () => {
    saveKey();
    chromeMock.tabsSendMessage.mockResolvedValue({ ...translatedState, status: "original" });

    chromeMock.onCommand[0]!("toggle-translation", { id: 7 });

    await vi.waitFor(() =>
      expect(chromeMock.tabsSendMessage).toHaveBeenCalledWith(7, { type: "translate" }, { frameId: 0 }),
    );
  });

  it("아직 번역하지 않은 탭이면 콘텐츠 스크립트를 넣어 번역을 시작한다", async () => {
    saveKey();

    chromeMock.onCommand[0]!("toggle-translation", { id: 7 });

    await vi.waitFor(() =>
      expect(chromeMock.executeScript).toHaveBeenCalledWith({ target: { tabId: 7 }, files: ["content.js"] }),
    );
  });

  it("키가 없으면 옵션 페이지를 연다", async () => {
    chromeMock.onCommand[0]!("toggle-translation", { id: 7 });

    await vi.waitFor(() => expect(chromeMock.openOptionsPage).toHaveBeenCalledOnce());
    expect(chromeMock.executeScript).not.toHaveBeenCalled();
  });
});

describe("팝업 메시지", () => {
  it("탭 상태: 콘텐츠 스크립트가 있으면 그 상태를 돌려준다", async () => {
    chromeMock.tabsSendMessage.mockResolvedValue(translatedState);

    expect(await ask({ type: "get-tab-state", tabId: 7 })).toEqual(translatedState);
  });

  it("탭 상태: 콘텐츠 스크립트가 없으면 웹 페이지는 대기, chrome:// 같은 페이지는 번역할 수 없음", async () => {
    expect(await ask({ type: "get-tab-state", tabId: 7 })).toMatchObject({ status: "idle" });

    for (const url of ["chrome://extensions/", "https://chromewebstore.google.com/detail/x", "about:blank"]) {
      chromeMock.getTab.mockResolvedValueOnce({ id: 7, url } as chrome.tabs.Tab);
      expect(await ask({ type: "get-tab-state", tabId: 7 })).toEqual({ status: "unsupported" });
    }
  });

  it("번역: 스크립트를 넣을 수 없으면 번역할 수 없음을 돌려준다", async () => {
    saveKey();
    chromeMock.executeScript.mockRejectedValueOnce(new Error("Cannot access contents of the page"));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await ask({ type: "tab-action", tabId: 7, action: "translate" })).toEqual({ status: "unsupported" });
  });

  it("원문 보기: 콘텐츠 스크립트에 전달한다", async () => {
    chromeMock.tabsSendMessage.mockResolvedValue({ ...translatedState, status: "original" });

    expect(await ask({ type: "tab-action", tabId: 7, action: "show-original" })).toMatchObject({ status: "original" });
    expect(chromeMock.tabsSendMessage).toHaveBeenCalledWith(7, { type: "show-original" }, { frameId: 0 });
  });

  it("단축키: 실제로 할당된 단축키를 돌려주고, 할당되지 않았으면 빈 문자열 (SPEC 4.8.1)", async () => {
    expect(await ask({ type: "get-shortcut" })).toBe("⌥T");

    chromeMock.getCommands.mockResolvedValueOnce([{ name: "toggle-translation", shortcut: "" }]);
    expect(await ask({ type: "get-shortcut" })).toBe("");
  });

  it("콘텐츠 스크립트가 보낸 탭 조작 요청은 무시한다", async () => {
    const { keepOpen } = sendToBackground({ type: "tab-action", tabId: 3, action: "translate" }, contentScript);

    expect(keepOpen).toBe(false);
    expect(chromeMock.executeScript).not.toHaveBeenCalled();
  });

  it("캐시 통계와 비우기 (옵션 페이지)", async () => {
    chromeMock.storage["t:abc"] = { s: ["가"], t: 1 };

    expect(await ask({ type: "get-cache-stats" })).toEqual({ count: 1, bytes: expect.any(Number) });
    await ask({ type: "clear-cache" });

    expect(chromeMock.storage).toEqual({});
  });

  it("알림의 '설정 열기'(콘텐츠 스크립트)는 옵션 페이지를 연다", () => {
    sendToBackground({ type: "open-options" }, contentScript);

    expect(chromeMock.openOptionsPage).toHaveBeenCalledOnce();
  });
});

describe("사이트별 자동 번역 (SPEC 4.8, 13장)", () => {
  const origin = "https://docs.example.com";
  const registeredScript = {
    id: `auto:${origin}`,
    matches: [`${origin}/*`],
    js: ["auto.js", "content.js"],
    runAt: "document_idle",
    persistAcrossSessions: true,
  };

  it("켜면 목록에 넣고 그 출처에만 콘텐츠 스크립트를 등록하고, 지금 페이지도 바로 번역한다", async () => {
    saveKey();

    expect(await ask({ type: "set-auto-translate", origin, enabled: true, tabId: 7 })).toBe(true);

    expect(chromeMock.storage.settings).toMatchObject({ autoTranslateOrigins: [origin] });
    expect(chromeMock.registered).toEqual([registeredScript]);
    expect(chromeMock.executeScript).toHaveBeenCalledWith({ target: { tabId: 7 }, files: ["content.js"] });
  });

  it("이미 켜져 있으면 같은 출처를 다시 넣거나 다시 등록하지 않는다", async () => {
    await ask({ type: "set-auto-translate", origin, enabled: true });

    expect(await ask({ type: "set-auto-translate", origin, enabled: true })).toBe(true);

    expect(chromeMock.storage.settings).toEqual({ autoTranslateOrigins: [origin] });
    expect(chromeMock.registerContentScripts).toHaveBeenCalledOnce();
    expect(chromeMock.registered).toEqual([registeredScript]);
  });

  it("그 출처의 권한이 없으면 켜지 않는다", async () => {
    saveKey();
    chromeMock.containsPermissions.mockResolvedValue(false);

    expect(await ask({ type: "set-auto-translate", origin, enabled: true, tabId: 7 })).toBe(false);

    expect(chromeMock.storage.settings).not.toHaveProperty("autoTranslateOrigins");
    expect(chromeMock.registered).toEqual([]);
    expect(chromeMock.executeScript).not.toHaveBeenCalled();
  });

  it("끄면 목록에서 빼고 등록을 풀고 권한도 돌려준다", async () => {
    await ask({ type: "set-auto-translate", origin, enabled: true });

    expect(await ask({ type: "set-auto-translate", origin, enabled: false })).toBe(false);

    expect(chromeMock.storage.settings).not.toHaveProperty("autoTranslateOrigins");
    expect(chromeMock.registered).toEqual([]);
    expect(chromeMock.removePermissions).toHaveBeenCalledWith({ origins: [`${origin}/*`] });
  });

  it("권한을 돌려줄 수 없어도(필수 권한) 끄기는 끝난다", async () => {
    await ask({ type: "set-auto-translate", origin, enabled: true });
    chromeMock.removePermissions.mockRejectedValueOnce(new Error("You cannot remove required permissions."));

    expect(await ask({ type: "set-auto-translate", origin, enabled: false })).toBe(false);

    expect(chromeMock.registered).toEqual([]);
  });

  it("팝업이 권한 창 때문에 닫혀도, 권한이 추가되면 남겨 둔 요청대로 켜고 그 탭을 번역한다", async () => {
    saveKey();
    await ask({ type: "auto-translate-pending", origin, tabId: 9 });

    chromeMock.onPermissionsAdded[0]!({ origins: [`${origin}/*`] });

    await vi.waitFor(() =>
      expect(chromeMock.executeScript).toHaveBeenCalledWith({ target: { tabId: 9 }, files: ["content.js"] }),
    );
    expect(chromeMock.registered).toEqual([registeredScript]);
    expect(chromeMock.session).toEqual({});
  });

  it("권한 창에서 허용한 뒤 팝업과 권한 이벤트가 함께 켜도 한 번만 등록한다", async () => {
    saveKey();
    await ask({ type: "auto-translate-pending", origin, tabId: 9 });

    chromeMock.onPermissionsAdded[0]!({ origins: [`${origin}/*`] });
    expect(await ask({ type: "set-auto-translate", origin, enabled: true, tabId: 9 })).toBe(true);

    await vi.waitFor(() => expect(chromeMock.registerContentScripts).toHaveBeenCalledOnce());
    expect(chromeMock.registered).toEqual([registeredScript]);
    expect(chromeMock.storage.settings).toMatchObject({ autoTranslateOrigins: [origin] });
  });

  it("브라우저 시작 때 설치·시작 이벤트가 함께 와도 한 번만 등록한다", async () => {
    chromeMock.storage.settings = { autoTranslateOrigins: [origin] };

    chromeMock.onInstalled[0]!({ reason: "update", previousVersion: "0.0.1" });
    chromeMock.onStartup[0]!();

    await vi.waitFor(() => expect(chromeMock.registered).toEqual([registeredScript]));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(chromeMock.registerContentScripts).toHaveBeenCalledOnce();
  });

  it("남겨 둔 요청과 다른 권한이 추가되면 아무것도 켜지 않는다", async () => {
    await ask({ type: "auto-translate-pending", origin, tabId: 9 });

    chromeMock.onPermissionsAdded[0]!({ origins: ["https://other.example.com/*"] });

    await vi.waitFor(() => expect(chromeMock.session).toEqual({}));
    expect(chromeMock.registered).toEqual([]);
  });

  it("팝업이 결과를 직접 알려 오면 남겨 둔 요청은 지운다 (두 번 켜지 않도록)", async () => {
    await ask({ type: "auto-translate-pending", origin, tabId: 9 });

    await ask({ type: "set-auto-translate", origin, enabled: false });

    expect(chromeMock.session).toEqual({});
  });

  it("Chrome 설정에서 사이트 권한을 빼면 자동 번역도 끈다", async () => {
    await ask({ type: "set-auto-translate", origin, enabled: true });

    chromeMock.onPermissionsRemoved[0]!({ origins: [`${origin}/*`] });

    await vi.waitFor(() => expect(chromeMock.registered).toEqual([]));
    expect(chromeMock.storage.settings).not.toHaveProperty("autoTranslateOrigins");
  });

  it("브라우저를 시작하면 목록을 실제 권한에 맞추고, 등록도 목록에 맞춘다", async () => {
    chromeMock.storage.settings = { autoTranslateOrigins: [origin, "https://revoked.example.com"] };
    chromeMock.containsPermissions.mockImplementation(async ({ origins }) => origins?.[0] === `${origin}/*`);
    chromeMock.registered.push({
      id: "auto:https://stale.example.com",
      matches: ["https://stale.example.com/*"],
      js: ["auto.js", "content.js"],
    });

    chromeMock.onStartup[0]!();

    await vi.waitFor(() => expect(chromeMock.registered).toEqual([registeredScript]));
    expect(chromeMock.storage.settings).toEqual({ autoTranslateOrigins: [origin] });
  });

  it("확장을 업데이트하면 남아 있던 등록을 지금 버전의 설정으로 고친다", async () => {
    chromeMock.storage.settings = { autoTranslateOrigins: [origin] };
    chromeMock.registered.push({ id: `auto:${origin}`, matches: [`${origin}/*`], js: ["old.js"] });

    chromeMock.onInstalled[0]!({ reason: "update", previousVersion: "0.0.1" });

    await vi.waitFor(() => expect(chromeMock.registered).toEqual([registeredScript]));
    expect(chromeMock.registerContentScripts).not.toHaveBeenCalled();
  });

  it("팝업 체크박스 상태: 목록에 있고 권한도 있을 때만 켜짐", async () => {
    expect(await ask({ type: "get-auto-translate", origin })).toBe(false);

    await ask({ type: "set-auto-translate", origin, enabled: true });
    expect(await ask({ type: "get-auto-translate", origin })).toBe(true);

    chromeMock.containsPermissions.mockResolvedValue(false);
    expect(await ask({ type: "get-auto-translate", origin })).toBe(false);
  });

  it("웹 페이지(콘텐츠 스크립트)는 자동 번역을 켤 수 없다", () => {
    const { keepOpen } = sendToBackground({ type: "set-auto-translate", origin, enabled: true }, contentScript);

    expect(keepOpen).toBe(false);
    expect(chromeMock.registerContentScripts).not.toHaveBeenCalled();
  });
});

describe("캐시 정리의 턴과 사용량 (SPEC 13장)", () => {
  async function translateOnce(newTurn: boolean) {
    const { port, posted, receive } = createPort(contentScript);
    chromeMock.onConnect[0]!(port);
    receive({ type: "translate", groups: [{ id: "g1", segments: ["Docs"] }], newTurn });
    await vi.waitFor(() => expect(posted.at(-1)).toMatchObject({ type: "done" }));
  }

  function cacheEntry() {
    return Object.entries(chromeMock.storage).find(([key]) => key.startsWith("t:"))?.[1];
  }

  it("페이지 번역을 시작하는 요청이면 새 턴을 열고, 화면 변화로 더 번역하는 요청이면 지금 턴을 쓴다", async () => {
    saveKey();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(echoUppercase));

    await translateOnce(true);
    expect(chromeMock.storage.cacheTurn).toBe(1);
    expect(cacheEntry()).toEqual({ s: ["DOCS"], u: 1 });

    await translateOnce(false);
    expect(chromeMock.storage.cacheTurn).toBe(1);

    await translateOnce(true);
    expect(chromeMock.storage.cacheTurn).toBe(2);
    expect(cacheEntry()).toEqual({ s: ["DOCS"], u: 2 });
  });

  it("번역 응답과 연결 테스트의 사용량을 이번 달 사용량에 더한다", async () => {
    saveKey();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(echoUppercase));
    await translateOnce(true);

    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => messageResponse("pong")));
    await ask({ type: "test-connection", apiKey: "sk-ant-typed", model: "claude-haiku-5-5" }, optionsPage);

    await vi.waitFor(() =>
      expect(chromeMock.storage.usage).toEqual({
        month: monthOf(new Date()),
        inputTokens: 200,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 100,
      }),
    );
  });
});
