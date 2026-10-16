import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock } from "./chrome-mock";

// 팝업의 "이 사이트는 항상 번역" (SPEC 4.8, 13장). Chrome의 권한 창은 E2E에서 누를 수 없어 여기서 확인한다.

const POPUP_BODY = new DOMParser().parseFromString(
  readFileSync(path.resolve(import.meta.dirname, "../../src/popup/popup.html"), "utf8"),
  "text/html",
).body.innerHTML;

/** chrome-mock의 탭 주소(https://example.com/docs)의 출처 */
const ORIGIN = "https://example.com";

let chromeMock: ReturnType<typeof installChromeMock>;
/** 백그라운드가 기억하는 이 사이트의 자동 번역 여부 */
let autoTranslate: boolean;
/** 백그라운드가 돌려주는 탭 상태 */
let tabState: unknown;
/** 팝업이 닫힌 사이 권한을 거부했는지 */
let denied: boolean;
/** 캐시 크기 (바이트) */
let cacheBytes: number;

beforeEach(() => {
  // 팝업은 500ms마다 상태를 다시 읽는다. 가짜 타이머로 두어 테스트가 끝나면 그 반복도 멈추게 한다.
  vi.useFakeTimers();
  chromeMock = installChromeMock();
  chromeMock.storage.settings = { apiKeys: { anthropic: "sk-ant-saved" } };
  autoTranslate = false;
  tabState = { status: "idle", progress: { done: 0, total: 0 }, partial: false };
  denied = false;
  cacheBytes = 0;
  chromeMock.runtimeSendMessage.mockImplementation(async (message) => {
    switch (message.type) {
      case "get-auto-translate":
        return autoTranslate;
      case "set-auto-translate":
        return (autoTranslate = message.enabled);
      case "get-tab-state":
        return tabState;
      case "get-shortcut":
        return "⌥T";
      case "take-auto-translate-denied":
        return denied;
      case "get-cache-stats":
        return { count: cacheBytes > 0 ? 1 : 0, bytes: cacheBytes };
      case "tab-action":
        return { status: "translating", progress: { done: 0, total: 2 }, partial: false };
    }
    return undefined;
  });
  document.body.innerHTML = POPUP_BODY;
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
});

async function openPopup(): Promise<void> {
  await import("../../src/popup/popup");
}

const autoRow = () => document.querySelector<HTMLLabelElement>("#auto-row")!;
const checkbox = () => document.querySelector<HTMLInputElement>("#auto")!;
const autoMessage = () => document.querySelector<HTMLParagraphElement>("#auto-message")!;

/** 백그라운드에 보낸 메시지 가운데 이 종류 */
function sent(type: string): unknown[] {
  return chromeMock.runtimeSendMessage.mock.calls.map(([message]) => message).filter((message) => message.type === type);
}

describe("팝업: 이 사이트는 항상 번역", () => {
  it("키가 있는 웹 페이지면 체크박스를 보여 주고, 이미 켠 사이트면 체크된 채로 연다", async () => {
    autoTranslate = true;

    await openPopup();

    await vi.waitFor(() => expect(autoRow().hidden).toBe(false));
    expect(checkbox().checked).toBe(true);
    expect(sent("get-auto-translate")).toEqual([{ type: "get-auto-translate", origin: ORIGIN }]);
  });

  it("체크하면 백그라운드에 먼저 알리고 같은 클릭 안에서 그 출처의 권한을 요청한다. 허용하면 켜고 지금 탭도 번역한다", async () => {
    let pendingWhenRequested = 0;
    chromeMock.requestPermissions.mockImplementation(async () => {
      pendingWhenRequested = sent("auto-translate-pending").length;
      return true;
    });
    await openPopup();
    await vi.waitFor(() => expect(autoRow().hidden).toBe(false));

    checkbox().click();

    // 권한 요청은 사용자 동작 안에서 해야 하므로 기다리지 않고 바로 불렸어야 한다.
    expect(chromeMock.requestPermissions).toHaveBeenCalledWith({ origins: [`${ORIGIN}/*`] });
    expect(pendingWhenRequested).toBe(1);
    expect(sent("auto-translate-pending")).toEqual([{ type: "auto-translate-pending", origin: ORIGIN, tabId: 7 }]);
    await vi.waitFor(() =>
      expect(sent("set-auto-translate")).toEqual([
        { type: "set-auto-translate", origin: ORIGIN, enabled: true, tabId: 7 },
      ]),
    );
    expect(checkbox().checked).toBe(true);
    expect(autoMessage().hidden).toBe(true);
  });

  it("권한을 거부하면 체크를 풀고 \"권한을 허용해야…\"를 보여 준다", async () => {
    chromeMock.requestPermissions.mockResolvedValue(false);
    await openPopup();
    await vi.waitFor(() => expect(autoRow().hidden).toBe(false));

    checkbox().click();

    await vi.waitFor(() => expect(autoMessage().hidden).toBe(false));
    expect(autoMessage().textContent).toBe("권한을 허용해야 이 사이트를 자동으로 번역할 수 있습니다.");
    expect(checkbox().checked).toBe(false);
    expect(sent("set-auto-translate")).toEqual([{ type: "set-auto-translate", origin: ORIGIN, enabled: false }]);
  });

  it("체크를 풀면 끈다. 권한은 묻지 않는다", async () => {
    autoTranslate = true;
    await openPopup();

    checkbox().click();

    await vi.waitFor(() =>
      expect(sent("set-auto-translate")).toEqual([{ type: "set-auto-translate", origin: ORIGIN, enabled: false }]),
    );
    expect(chromeMock.requestPermissions).not.toHaveBeenCalled();
    expect(checkbox().checked).toBe(false);
  });

  it("키가 없으면 체크박스를 보여 주지 않는다", async () => {
    chromeMock.storage.settings = {};

    await openPopup();

    await vi.waitFor(() => expect(document.querySelector("#status")?.textContent).toBe("API 키를 먼저 설정하세요"));
    expect(autoRow().hidden).toBe(true);
  });

  it("http·https 페이지가 아니면(chrome:// 등) 체크박스를 보여 주지 않는다", async () => {
    chromeMock.getTab.mockResolvedValue({ id: 7, url: "chrome://extensions/" } as chrome.tabs.Tab);

    await openPopup();

    await vi.waitFor(() => expect(sent("get-tab-state")).not.toEqual([]));
    expect(autoRow().hidden).toBe(true);
    expect(sent("get-auto-translate")).toEqual([]);
  });
});

describe("팝업: 실패 원인 (SPEC 13장 \"실패 원인 표시\")", () => {
  it("일부만 실패하면 \"번역 완료\" 아래에 \"일부는…\"과 원인 문구를 두 줄로 보여 준다", async () => {
    tabState = { status: "translated", progress: { done: 2, total: 2 }, partial: true, cause: "요청 한도를 초과했습니다. 잠시 후 다시 시도하세요." };

    await openPopup();

    await vi.waitFor(() => expect(document.querySelector("#status")?.textContent).toBe("번역 완료"));
    const detail = document.querySelector<HTMLParagraphElement>("#detail")!;
    expect(detail.hidden).toBe(false);
    expect(detail.textContent).toBe("일부는 번역하지 못해 원문으로 두었습니다.\n요청 한도를 초과했습니다. 잠시 후 다시 시도하세요.");
  });

  it("하나도 번역하지 못했으면 원인 문구와 \"번역\" 버튼(다시 시도)을 보여 준다", async () => {
    tabState = { status: "error", progress: { done: 2, total: 2 }, error: "요청 한도를 초과했습니다. 잠시 후 다시 시도하세요.", partial: false };

    await openPopup();

    await vi.waitFor(() => expect(document.querySelector("#status")?.textContent).toBe("요청 한도를 초과했습니다. 잠시 후 다시 시도하세요."));
    expect(document.querySelector<HTMLButtonElement>("#action")?.textContent).toBe("번역");
    expect(document.querySelector<HTMLParagraphElement>("#detail")?.hidden).toBe(true);
  });
});

describe("팝업: 권한 창 때문에 팝업이 닫힌 뒤 (SPEC 13장 \"권한 거부 안내\")", () => {
  it("다시 열었을 때 거부했던 것이면 안내 문구를 보여 준다", async () => {
    denied = true;

    await openPopup();

    expect(autoMessage().hidden).toBe(false);
    expect(autoMessage().textContent).toBe("권한을 허용해야 이 사이트를 자동으로 번역할 수 있습니다.");
    expect(checkbox().checked).toBe(false);
    expect(sent("take-auto-translate-denied")).toEqual([{ type: "take-auto-translate-denied", origin: ORIGIN }]);
  });

  it("거부한 적이 없으면 안내하지 않는다", async () => {
    await openPopup();

    expect(autoMessage().hidden).toBe(true);
  });
});

describe("팝업: 캐시 사용량 (SPEC 13장 \"팝업의 캐시 사용량\")", () => {
  const usage = () => document.querySelector("#cache-usage")?.textContent;

  it("\"캐시 사용량 MB / 상한 MB (%)\"로 보여 준다. 상한은 설정을 따른다", async () => {
    cacheBytes = 1.25 * 1024 * 1024;
    chromeMock.storage.settings = { apiKeys: { anthropic: "sk-ant-saved" }, cacheMaxMB: 5 };

    await openPopup();

    await vi.waitFor(() => expect(usage()).toBe("캐시 1.3 MB / 5 MB (25%)"));
  });

  it("비었으면 0, 아주 작으면 0.1 MB로 보여 준다", async () => {
    await openPopup();
    await vi.waitFor(() => expect(usage()).toBe("캐시 0 MB / 8 MB (0%)"));

    cacheBytes = 2_000;
    await vi.advanceTimersByTimeAsync(500);

    await vi.waitFor(() => expect(usage()).toBe("캐시 0.1 MB / 8 MB (0%)"));
  });

  it("키가 없거나 번역할 수 없는 페이지에서도 보여 준다", async () => {
    chromeMock.storage.settings = {};
    chromeMock.getTab.mockResolvedValue({ id: 7, url: "chrome://extensions/" } as chrome.tabs.Tab);

    await openPopup();

    await vi.waitFor(() => expect(usage()).toBe("캐시 0 MB / 8 MB (0%)"));
  });
});

describe("팝업: 제공업체 (SPEC 13장 \"OpenRouter 추가\")", () => {
  it("OpenRouter를 골랐는데 그 키가 없으면, Anthropic 키가 있어도 \"API 키를 먼저 설정하세요\"", async () => {
    chromeMock.storage.settings = { provider: "openrouter", apiKeys: { anthropic: "sk-ant-saved" } };

    await openPopup();

    await vi.waitFor(() => expect(document.querySelector("#status")?.textContent).toBe("API 키를 먼저 설정하세요"));
    expect(autoRow().hidden).toBe(true);
  });

  it("OpenRouter 키가 있으면 번역할 수 있다", async () => {
    chromeMock.storage.settings = { provider: "openrouter", apiKeys: { openrouter: "sk-or-saved" } };

    await openPopup();

    await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>("#action")?.hidden).toBe(false));
    expect(document.querySelector("#action")?.textContent).toBe("번역");
  });
});

describe("팝업: 번역 품질 (SPEC 13장 \"번역 품질을 고르는 곳\")", () => {
  const quality = () => document.querySelector<HTMLSelectElement>("#quality")!;
  const retranslate = () => document.querySelector<HTMLButtonElement>("#retranslate")!;
  const translated = { status: "translated", progress: { done: 2, total: 2 }, partial: false };

  function choose(tierId: string): void {
    quality().value = tierId;
    quality().dispatchEvent(new Event("change"));
  }

  it("지금 설정의 단계를 보여 주고, 고르면 그 제공업체의 모델과 번역 방식을 바로 저장한다", async () => {
    await openPopup();
    await vi.waitFor(() => expect(document.querySelector<HTMLLabelElement>("#quality-row")!.hidden).toBe(false));
    expect(quality().value).toBe("haiku-medium");

    choose("haiku-no-thinking");

    await vi.waitFor(() =>
      expect(chromeMock.storage.settings).toMatchObject({ translationMode: "fast", apiKeys: { anthropic: "sk-ant-saved" } }),
    );
  });

  it("단계에 없는 설정이면 고를 수 없는 \"직접 설정\"으로 보인다", async () => {
    chromeMock.storage.settings = { apiKeys: { anthropic: "sk-ant-saved" }, models: { anthropic: "claude-opus-5-5" }, translationMode: "fast" };

    await openPopup();

    await vi.waitFor(() => expect(quality().value).toBe("custom"));
    const custom = quality().selectedOptions[0]!;
    expect(custom.textContent).toBe("직접 설정");
    expect(custom.disabled).toBe(true);
  });

  it("번역된 페이지에서 품질을 바꾸면 \"이 품질로 다시 번역\"이 나타나고, 누르면 다시 번역을 요청한다", async () => {
    tabState = translated;
    await openPopup();
    await vi.waitFor(() => expect(document.querySelector("#status")?.textContent).toBe("번역 완료"));
    expect(retranslate().hidden).toBe(true);

    choose("sonnet-medium");

    await vi.waitFor(() => expect(retranslate().hidden).toBe(false));
    expect(retranslate().textContent).toBe("이 품질로 다시 번역");
    retranslate().click();
    await vi.waitFor(() =>
      expect(sent("tab-action")).toEqual([{ type: "tab-action", tabId: 7, action: "retranslate" }]),
    );
    expect(retranslate().hidden).toBe(true);
  });

  it("아직 번역하지 않은 페이지에서는 바꿔도 다시 번역 버튼이 없다 (\"번역\"이 새 품질로 번역)", async () => {
    await openPopup();
    await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>("#action")?.hidden).toBe(false));

    choose("sonnet-medium");

    await vi.waitFor(() => expect(chromeMock.storage.settings).toMatchObject({ models: { anthropic: "claude-sonnet-5-5" } }));
    expect(retranslate().hidden).toBe(true);
  });

  it("직접 입력한 모델이면 품질을 바꾸지 않아도 번역된 페이지에서 \"이 품질로 다시 번역\"이 보인다 (SPEC 13장)", async () => {
    chromeMock.storage.settings = { apiKeys: { anthropic: "sk-ant-saved" }, models: { anthropic: "claude-custom-1" } };
    tabState = translated;

    await openPopup();

    await vi.waitFor(() => expect(retranslate().hidden).toBe(false));
    retranslate().click();
    await vi.waitFor(() =>
      expect(sent("tab-action")).toEqual([{ type: "tab-action", tabId: 7, action: "retranslate" }]),
    );
  });

  it("직접 입력한 모델이어도 아직 번역하지 않은 페이지에서는 보이지 않는다", async () => {
    chromeMock.storage.settings = { apiKeys: { anthropic: "sk-ant-saved" }, models: { anthropic: "claude-custom-1" } };

    await openPopup();

    await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>("#action")?.hidden).toBe(false));
    expect(retranslate().hidden).toBe(true);
  });

  it("목록에 있는 모델의 \"직접 설정\"(Opus 빠르게)은 지금처럼 품질을 바꿨을 때만 보인다", async () => {
    chromeMock.storage.settings = { apiKeys: { anthropic: "sk-ant-saved" }, models: { anthropic: "claude-opus-5-5" }, translationMode: "fast" };
    tabState = translated;

    await openPopup();

    await vi.waitFor(() => expect(document.querySelector("#status")?.textContent).toBe("번역 완료"));
    expect(quality().value).toBe("custom");
    expect(retranslate().hidden).toBe(true);
  });

  it("키가 없으면 번역 품질을 보여 주지 않는다", async () => {
    chromeMock.storage.settings = {};

    await openPopup();

    await vi.waitFor(() => expect(document.querySelector("#status")?.textContent).toBe("API 키를 먼저 설정하세요"));
    expect(document.querySelector<HTMLLabelElement>("#quality-row")!.hidden).toBe(true);
  });
});
