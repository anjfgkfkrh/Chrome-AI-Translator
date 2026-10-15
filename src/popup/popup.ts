import { sendMessage, type TabAction, type TabState } from "../shared/messages";
import { renderShortcut } from "../shared/shortcut";
import { getSettings } from "../shared/storage";

// 팝업 (SPEC 4.9, 13장 "M4 화면 문구"). 상태는 대상 탭의 콘텐츠 스크립트가 들고 있고, 백그라운드를 거쳐 읽는다.

/** 팝업이 열려 있는 동안 상태를 다시 읽는 간격 */
const POLL_MS = 500;

const statusText = element<HTMLParagraphElement>("#status");
const detailText = element<HTMLParagraphElement>("#detail");
const actionButton = element<HTMLButtonElement>("#action");
const openSettingsButton = element<HTMLButtonElement>("#open-settings");
const settingsLink = element<HTMLAnchorElement>("#settings-link");

let action: TabAction = "translate";
const tabId = await targetTabId();

settingsLink.addEventListener("click", (event) => {
  event.preventDefault();
  void chrome.runtime.openOptionsPage();
});
openSettingsButton.addEventListener("click", () => void chrome.runtime.openOptionsPage());
actionButton.addEventListener("click", async () => {
  if (tabId === undefined) return;
  actionButton.disabled = true;
  try {
    render(await sendMessage({ type: "tab-action", tabId, action }));
  } finally {
    actionButton.disabled = false;
  }
});

void renderShortcut(element("#shortcut"));
void poll();

/** 대상 탭: 지금 보고 있는 탭. E2E 테스트는 팝업을 탭으로 열기 때문에 ?tabId=로 정한다. */
async function targetTabId(): Promise<number | undefined> {
  const fromQuery = Number(new URLSearchParams(location.search).get("tabId"));
  if (Number.isInteger(fromQuery) && fromQuery > 0) return fromQuery;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

async function poll(): Promise<void> {
  for (;;) {
    await refresh();
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

async function refresh(): Promise<void> {
  const { apiKeys } = await getSettings();
  if (!apiKeys.anthropic) return renderNoKey();
  if (tabId === undefined) return render({ status: "unsupported" });
  render(await sendMessage({ type: "get-tab-state", tabId }));
}

function renderNoKey(): void {
  show("API 키를 먼저 설정하세요", "muted", undefined);
  openSettingsButton.hidden = false;
}

function render(state: TabState): void {
  openSettingsButton.hidden = true;
  detailText.hidden = true;
  switch (state.status) {
    case "unsupported":
      return show("이 페이지는 번역할 수 없습니다.", "muted", undefined);
    case "idle":
      return show("", "muted", "translate");
    case "translating":
      return show(`번역 중… ${state.progress.done}/${state.progress.total}`, "muted", "show-original");
    case "translated":
      if (state.partial) {
        detailText.textContent = "일부는 번역하지 못해 원문으로 두었습니다.";
        detailText.hidden = false;
      }
      return show("번역 완료", "success", "show-original");
    case "original":
      return show("원문 표시 중", "muted", "translate");
    case "error":
      return show(state.error ?? "", "error", "translate");
  }
}

/** 상태 문구와 버튼을 바꾼다. next가 없으면 버튼을 숨긴다. */
function show(text: string, kind: "muted" | "success" | "error", next: TabAction | undefined): void {
  statusText.textContent = text;
  statusText.dataset.kind = kind;
  statusText.hidden = text === "";
  actionButton.hidden = next === undefined;
  if (next !== undefined) {
    action = next;
    actionButton.textContent = next === "translate" ? "번역" : "원문 보기";
  }
}

function element<T extends Element>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`${selector} 요소가 없습니다.`);
  return found;
}
