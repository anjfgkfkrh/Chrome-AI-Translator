import { sendMessage, type TabAction, type TabState } from "../shared/messages";
import { isListedModel, QUALITY_TIERS, qualityTierOf, qualityTierText } from "../shared/models";
import { renderShortcut } from "../shared/shortcut";
import { originPattern, pageOrigin } from "../shared/sites";
import { activeApiKey, getSettings, setQualityTier, type Settings } from "../shared/storage";

// 팝업 (SPEC 4.9, 13장 "M4 화면 문구"). 상태는 대상 탭의 콘텐츠 스크립트가 들고 있고, 백그라운드를 거쳐 읽는다.

/** 팝업이 열려 있는 동안 상태를 다시 읽는 간격 */
const POLL_MS = 500;

const statusText = element<HTMLParagraphElement>("#status");
const detailText = element<HTMLParagraphElement>("#detail");
const actionButton = element<HTMLButtonElement>("#action");
const openSettingsButton = element<HTMLButtonElement>("#open-settings");
const settingsLink = element<HTMLAnchorElement>("#settings-link");
const autoRow = element<HTMLLabelElement>("#auto-row");
const autoCheckbox = element<HTMLInputElement>("#auto");
const autoMessage = element<HTMLParagraphElement>("#auto-message");
const cacheUsage = element<HTMLParagraphElement>("#cache-usage");
const qualityRow = element<HTMLLabelElement>("#quality-row");
const qualitySelect = element<HTMLSelectElement>("#quality");
const retranslateButton = element<HTMLButtonElement>("#retranslate");
/** 저장된 설정이 어느 번역 품질 단계와도 같지 않을 때 보이는 항목. 고를 수는 없다. */
const customQuality = new Option("직접 설정", "custom");
customQuality.disabled = true;
const DENIED_MESSAGE = "권한을 허용해야 이 사이트를 자동으로 번역할 수 있습니다.";
const MEGABYTE = 1024 * 1024;

let action: TabAction = "translate";
/** 이 팝업에서 번역 품질을 바꿨는지. 바꿨으면 번역된 페이지에 "이 품질로 다시 번역"을 보여 준다 (SPEC 13장). */
let qualityChanged = false;
/**
 * 설정이 직접 입력한 모델인지. 그 모델은 목록에 있는 모델의 캐시도 쓰므로, 번역된 페이지에서는 그 모델로만
 * 다시 번역할 수 있게 "이 품질로 다시 번역"을 늘 보여 준다 (SPEC 13장 "직접 입력한 모델의 다시 번역").
 */
let customModel = false;
let lastState: TabState | undefined;
for (const tier of QUALITY_TIERS) qualitySelect.add(new Option(qualityTierText(tier), tier.id));
const tabId = await targetTabId();
/** 대상 탭의 출처. http·https 페이지가 아니면 자동 번역 체크박스를 보여 주지 않는다 (SPEC 13장). */
const origin = tabId === undefined ? undefined : pageOrigin((await chrome.tabs.get(tabId).catch(() => undefined))?.url);
if (origin !== undefined) {
  autoCheckbox.checked = await sendMessage({ type: "get-auto-translate", origin });
  // 권한 창이 뜨면 팝업이 닫혀 거부 문구를 보여 줄 수 없었다. 다시 열 때 한 번 보여 준다 (SPEC 13장 "권한 거부 안내").
  if (await sendMessage({ type: "take-auto-translate-denied", origin })) showDenied();
}

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

// 번역 품질 (SPEC 13장 "번역 품질을 고르는 곳"): 고르면 바로 저장한다.
qualitySelect.addEventListener("change", async () => {
  const tier = QUALITY_TIERS.find((item) => item.id === qualitySelect.value);
  if (!tier) return;
  await setQualityTier(tier, (await getSettings()).provider);
  qualityChanged = true;
  renderRetranslate();
});

// 이 품질로 다시 번역: 기억한 번역문을 버리고 새 품질로 다시 요청한다 (SPEC 13장).
retranslateButton.addEventListener("click", async () => {
  if (tabId === undefined) return;
  qualityChanged = false;
  retranslateButton.hidden = true;
  render(await sendMessage({ type: "tab-action", tabId, action: "retranslate" }));
});

// 이 사이트는 항상 번역 (SPEC 4.8, 시나리오 4)
autoCheckbox.addEventListener("change", () => {
  if (origin === undefined || tabId === undefined) return;
  autoMessage.hidden = true;
  if (!autoCheckbox.checked) {
    void sendMessage({ type: "set-auto-translate", origin, enabled: false });
    return;
  }
  // 권한 창이 뜰 때 팝업이 닫힐 수 있으므로 먼저 백그라운드에 알려 둔다. 결과는 백그라운드도 받아 처리한다.
  void sendMessage({ type: "auto-translate-pending", origin, tabId });
  // 권한 요청은 사용자 동작 안에서 바로 불러야 한다 (await보다 먼저).
  void chrome.permissions.request({ origins: [originPattern(origin)] }).then(async (granted) => {
    if (granted) {
      autoCheckbox.checked = await sendMessage({ type: "set-auto-translate", origin, enabled: true, tabId });
      return;
    }
    autoCheckbox.checked = false;
    showDenied();
    void sendMessage({ type: "set-auto-translate", origin, enabled: false });
  });
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

function showDenied(): void {
  autoMessage.textContent = DENIED_MESSAGE;
  autoMessage.hidden = false;
}

async function refresh(): Promise<void> {
  const settings = await getSettings();
  customModel = !isListedModel(settings.model, settings.provider);
  await renderCacheUsage(settings.cacheMaxMB);
  // 고른 제공업체의 키가 있는지로 본다 (SPEC 13장 "OpenRouter 추가").
  const hasKey = activeApiKey(settings) !== undefined;
  autoRow.hidden = !hasKey || origin === undefined;
  qualityRow.hidden = !hasKey;
  renderQuality(settings);
  if (!hasKey) return renderNoKey();
  if (tabId === undefined) return render({ status: "unsupported" });
  render(await sendMessage({ type: "get-tab-state", tabId }));
}

/** 캐시 사용량: "캐시 1.2 MB / 8 MB (15%)" (SPEC 13장 "팝업의 캐시 사용량") */
async function renderCacheUsage(maxMB: number): Promise<void> {
  const { bytes } = await sendMessage({ type: "get-cache-stats" });
  // 옵션 페이지처럼 아주 작아도 0.0이 아니라 0.1로 보여 준다.
  const used = bytes === 0 ? "0" : Math.max(0.1, bytes / MEGABYTE).toFixed(1);
  const percent = Math.round((bytes / (maxMB * MEGABYTE)) * 100);
  cacheUsage.textContent = `캐시 ${used} MB / ${maxMB} MB (${percent}%)`;
}

/** 저장된 설정의 번역 품질. 고르는 중에 덮어쓰지 않도록 다를 때만 바꾼다. */
function renderQuality(settings: Settings): void {
  const tier = qualityTierOf(settings);
  if (tier) customQuality.remove();
  else if (!customQuality.isConnected) qualitySelect.add(customQuality);
  const value = tier?.id ?? customQuality.value;
  if (qualitySelect.value !== value) qualitySelect.value = value;
}

/** 번역된 페이지(번역 완료·원문 표시 중)에서 품질을 바꿨을 때나, 직접 입력한 모델일 때만 보인다. */
function renderRetranslate(): void {
  const translated = lastState?.status === "translated" || lastState?.status === "original";
  retranslateButton.hidden = !((qualityChanged || customModel) && translated);
}

function renderNoKey(): void {
  show("API 키를 먼저 설정하세요", "muted", undefined);
  openSettingsButton.hidden = false;
}

function render(state: TabState): void {
  lastState = state;
  renderRetranslate();
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
        // 원인 문구를 다음 줄에 붙인다 (SPEC 13장 "실패 원인 표시").
        detailText.textContent = ["일부는 번역하지 못해 원문으로 두었습니다.", state.cause].filter(Boolean).join("\n");
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
