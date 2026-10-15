import { beforeEach, describe, expect, it, vi } from "vitest";
import { echoUppercase, requestBody } from "../helpers/anthropic-mock";
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

function sendToBackground(message: unknown, sender: chrome.runtime.MessageSender) {
  const sendResponse = vi.fn();
  const keepOpen = chromeMock.onMessage[0]!(message, sender, sendResponse);
  return { keepOpen, sendResponse };
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
      expect(posted).toEqual([{ type: "error", message: "API 키를 먼저 설정하세요", needsSettings: true }]),
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
      expect(posted).toEqual([{ type: "error", message: "API 키를 확인하세요.", needsSettings: true }]),
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
        { type: "error", message: "번역 실패: Your credit balance is too low.", needsSettings: false },
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
  const popup: chrome.runtime.MessageSender = { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/popup/popup.html` };

  async function ask(message: unknown, sender = popup) {
    const { keepOpen, sendResponse } = sendToBackground(message, sender);
    if (keepOpen) await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
    return sendResponse.mock.calls[0]?.[0];
  }

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
