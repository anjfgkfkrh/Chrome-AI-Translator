import { glossaryText, parseGlossary, type GlossaryTerms } from "../shared/glossary";
import { sendMessage } from "../shared/messages";
import {
  DEFAULT_MODELS,
  isListedModel,
  MODELS,
  PROVIDERS,
  providerInfo,
  QUALITY_TIERS,
  qualityTierOf,
  qualityTierText,
  type ProviderId,
} from "../shared/models";
import { renderShortcut } from "../shared/shortcut";
import {
  CACHE_CLEANUP_PERCENT_RANGE,
  CACHE_IDLE_TURNS_RANGE,
  CACHE_MAX_MB_RANGE,
  getSettings,
  MAX_OUTPUT_TOKENS_RANGE,
  setApiKey,
  setCacheCleanup,
  setGlossary,
  setModel,
  setProvider,
  setQualityTier,
  setTranslationOptions,
} from "../shared/storage";
import { getUsage, isEmptyUsage, USAGE_KEY } from "../shared/usage";

const CUSTOM_MODEL = "custom";

const providerSelect = element<HTMLSelectElement>("#provider");
const keyLabel = element<HTMLLabelElement>("#api-key-label");
const keyInput = element<HTMLInputElement>("#api-key");
const toggleButton = element<HTMLButtonElement>("#toggle-key");
const qualitySelect = element<HTMLSelectElement>("#quality");
const advanced = element<HTMLDetailsElement>("#advanced");
const modelSelect = element<HTMLSelectElement>("#model");
const customModelInput = element<HTMLInputElement>("#custom-model");
const customModelList = element<HTMLDataListElement>("#custom-model-list");
const modeSelect = element<HTMLSelectElement>("#mode");
const maxTokensInput = element<HTMLInputElement>("#max-tokens");
const testButton = element<HTMLButtonElement>("#test");
const saveButton = element<HTMLButtonElement>("#save");
const status = element<HTMLParagraphElement>("#status");
const cacheSummary = element<HTMLParagraphElement>("#cache-summary");
const clearCacheButton = element<HTMLButtonElement>("#clear-cache");
const cacheStatus = element<HTMLParagraphElement>("#cache-status");
const autoSites = element<HTMLUListElement>("#auto-sites");
const autoSitesEmpty = element<HTMLParagraphElement>("#auto-sites-empty");
const glossaryKeep = element<HTMLTextAreaElement>("#glossary-keep");
const glossaryMap = element<HTMLTextAreaElement>("#glossary-map");
const saveGlossaryButton = element<HTMLButtonElement>("#save-glossary");
const glossaryStatus = element<HTMLParagraphElement>("#glossary-status");
const cacheMaxInput = element<HTMLInputElement>("#cache-max");
const cleanupPercentInput = element<HTMLInputElement>("#cleanup-percent");
const idleTurnsInput = element<HTMLInputElement>("#idle-turns");
const usageText = element<HTMLParagraphElement>("#usage");

for (const provider of PROVIDERS) providerSelect.add(new Option(provider.name, provider.id));
for (const tier of QUALITY_TIERS) qualitySelect.add(new Option(qualityTierText(tier), tier.id));
/** 고급 설정이 어느 번역 품질 단계와도 같지 않을 때 보이는 항목. 고를 수는 없다. */
const customQuality = new Option("직접 설정", "custom");
customQuality.disabled = true;

/**
 * 제공업체마다 화면에 입력한 (저장 전) 키와 모델. 제공업체를 바꿔도 입력한 것을 잃지 않고,
 * "저장"하면 모두 저장한다 (SPEC 13장 "OpenRouter 세부": 제공업체마다 따로 기억).
 */
const drafts = new Map<ProviderId, { key: string; model: string }>();
let shownProvider: ProviderId = "anthropic";

void loadSettings();
void renderAutoSites();
void renderCacheSummary();
void renderUsage();
void renderShortcut(element("#shortcut"));

// 열어 둔 동안 번역해도 사용량이 바로 바뀐다 (SPEC 13장 "사용량 갱신").
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && USAGE_KEY in changes) void renderUsage();
});

toggleButton.addEventListener("click", () => {
  const show = keyInput.type === "password";
  keyInput.type = show ? "text" : "password";
  toggleButton.textContent = show ? "숨기기" : "보기";
});

providerSelect.addEventListener("change", () => {
  rememberDraft();
  showProvider(providerSelect.value as ProviderId);
});

modelSelect.addEventListener("change", () => {
  customModelInput.hidden = modelSelect.value !== CUSTOM_MODEL;
  if (!customModelInput.hidden) customModelInput.focus();
  showQuality();
});
customModelInput.addEventListener("input", () => showQuality());
modeSelect.addEventListener("change", () => showQuality());

// 번역 품질 (SPEC 13장 "번역 품질을 고르는 곳"): 고르면 고급 설정을 그 단계로 바꾸고 바로 저장한다.
// 저장하는 것은 화면에 보이는 제공업체의 모델과 번역 방식이다. 키와 제공업체는 "저장"을 눌러야 저장된다.
qualitySelect.addEventListener("change", async () => {
  const tier = QUALITY_TIERS.find((item) => item.id === qualitySelect.value);
  if (!tier) return;
  const model = tier.models[shownProvider];
  modelSelect.value = model;
  customModelInput.value = "";
  customModelInput.hidden = true;
  modeSelect.value = tier.translationMode;
  drafts.set(shownProvider, { key: keyInput.value.trim(), model });
  showQuality();
  await setQualityTier(tier, shownProvider);
  showStatus("저장했습니다.", "success");
});

// 테스트와 저장은 서로 독립: 테스트는 저장 전 입력값과 고른 모델로 한다 (SPEC 13장).
testButton.addEventListener("click", async () => {
  const provider = shownProvider;
  const apiKey = keyInput.value.trim();
  const model = selectedModel();
  if (!apiKey) return showStatus("API 키를 입력하세요.", "error");
  if (!model) return showStatus("모델 ID를 입력하세요.", "error");

  testButton.disabled = true;
  showStatus("연결 확인 중…", "pending");
  try {
    const result = await sendMessage({ type: "test-connection", provider, apiKey, model });
    showStatus(result.message ?? "", result.ok ? "success" : "error");
  } catch (err) {
    showStatus(`연결 실패: ${err instanceof Error ? err.message : String(err)}`, "error");
  } finally {
    testButton.disabled = false;
  }
});

// "저장"은 제공업체와 키·모델을 함께 저장한다. 키가 빈 칸이면 그 제공업체의 저장된 키를 지운다 (SPEC 13장).
saveButton.addEventListener("click", async () => {
  const model = selectedModel();
  if (!model) return showStatus("모델 ID를 입력하세요.", "error");

  keyInput.value = keyInput.value.trim();
  rememberDraft();
  // 번역 방식과 최대 출력 토큰도 함께 저장한다. 범위를 벗어나면 가까운 값으로 맞춘다 (SPEC 13장).
  const saved = await getSettings();
  const maxOutputTokens = clampInteger(maxTokensInput.value, MAX_OUTPUT_TOKENS_RANGE, saved.maxOutputTokens);
  maxTokensInput.value = String(maxOutputTokens);
  await setProvider(shownProvider);
  for (const [provider, draft] of drafts) {
    await setApiKey(draft.key, provider);
    // 다른 제공업체에서 "직접 입력"을 비워 둔 채 바꿨으면 그 모델은 그대로 둔다.
    if (draft.model) await setModel(draft.model, provider);
  }
  await setTranslationOptions({ translationMode: modeSelect.value === "fast" ? "fast" : "accurate", maxOutputTokens });
  showStatus("저장했습니다.", "success");
});

// 용어집 (SPEC 4.10, 13장 "용어집 편집"): 형식이 틀리면 저장하지 않고 안내한다.
saveGlossaryButton.addEventListener("click", async () => {
  const parsed = parseGlossary(glossaryKeep.value, glossaryMap.value);
  if (!parsed.ok) return showGlossaryStatus(parsed.error, "error");
  await setGlossary(parsed.terms);
  showGlossary(parsed.terms); // 정리한 모습(빈 줄·공백·중복 제거)으로 다시 보여 준다
  showGlossaryStatus("용어집을 저장했습니다.", "success");
});

function showGlossary(terms: GlossaryTerms): void {
  const text = glossaryText(terms);
  glossaryKeep.value = text.keep;
  glossaryMap.value = text.map;
}

function showGlossaryStatus(text: string, kind: "success" | "error"): void {
  glossaryStatus.textContent = text;
  glossaryStatus.dataset.kind = kind;
}

// 캐시 상한과 정리 기준 (SPEC 13장 "캐시 상한 설정"·"캐시 정리 기준 조정"): 바꾸면 바로 저장하고,
// 범위를 벗어나면 가까운 값으로 맞춘다. 저장한 뒤 새 기준으로 바로 정리한다.
for (const input of [cacheMaxInput, cleanupPercentInput, idleTurnsInput]) {
  input.addEventListener("change", async () => {
    const saved = await getSettings();
    const values = {
      cacheMaxMB: clampInteger(cacheMaxInput.value, CACHE_MAX_MB_RANGE, saved.cacheMaxMB),
      cacheCleanupPercent: clampInteger(cleanupPercentInput.value, CACHE_CLEANUP_PERCENT_RANGE, saved.cacheCleanupPercent),
      cacheIdleTurns: clampInteger(idleTurnsInput.value, CACHE_IDLE_TURNS_RANGE, saved.cacheIdleTurns),
    };
    showCacheSettings(values);
    await setCacheCleanup(values);
    cacheStatus.textContent = "정리 기준을 저장했습니다.";
    await sendMessage({ type: "clean-cache" });
    await renderCacheSummary();
  });
}

function showCacheSettings(values: { cacheMaxMB: number; cacheCleanupPercent: number; cacheIdleTurns: number }): void {
  cacheMaxInput.value = String(values.cacheMaxMB);
  cleanupPercentInput.value = String(values.cacheCleanupPercent);
  idleTurnsInput.value = String(values.cacheIdleTurns);
}

/** 정수로 읽어 범위 안으로 맞춘다. 숫자가 아니면(빈 칸 등) fallback */
function clampInteger(text: string, range: { min: number; max: number }, fallback: number): number {
  const value = Math.round(Number(text));
  if (text.trim() === "" || !Number.isFinite(value)) return fallback;
  return Math.min(range.max, Math.max(range.min, value));
}

// 사용량 (SPEC 4.10, 13장 "M7 화면 문구")
async function renderUsage(): Promise<void> {
  const usage = await getUsage();
  const count = (tokens: number) => tokens.toLocaleString("ko-KR");
  usageText.textContent = isEmptyUsage(usage)
    ? "이번 달 사용량이 없습니다."
    : `이번 달: 입력 ${count(usage.inputTokens)} · 캐시 쓰기 ${count(usage.cacheWriteTokens)} · ` +
      `캐시 읽기 ${count(usage.cacheReadTokens)} · 출력 ${count(usage.outputTokens)} 토큰`;
}

// 자동 번역 사이트 (SPEC 4.10, 13장 "M6 화면 문구"): 삭제하면 등록을 풀고 권한도 돌려준다.
async function renderAutoSites(): Promise<void> {
  const { autoTranslateOrigins } = await getSettings();
  autoSitesEmpty.hidden = autoTranslateOrigins.length > 0;
  autoSites.replaceChildren(
    ...autoTranslateOrigins.map((origin) => {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "삭제";
      remove.setAttribute("aria-label", `${origin} 삭제`);
      remove.addEventListener("click", async () => {
        await sendMessage({ type: "set-auto-translate", origin, enabled: false });
        await renderAutoSites();
      });
      const item = document.createElement("li");
      item.append(`${origin} `, remove);
      return item;
    }),
  );
}

// 저장된 번역 (SPEC 4.7, 4.10, 13장 "M5 화면 문구")
clearCacheButton.addEventListener("click", async () => {
  await sendMessage({ type: "clear-cache" });
  cacheStatus.textContent = "캐시를 비웠습니다.";
  await renderCacheSummary();
});

async function renderCacheSummary(): Promise<void> {
  const { count, bytes } = await sendMessage({ type: "get-cache-stats" });
  // 아주 작아도 0.0이 아니라 0.1 MB로 보여 준다.
  const megabytes = Math.max(0.1, bytes / 1024 / 1024).toFixed(1);
  cacheSummary.textContent = count === 0 ? "저장된 번역이 없습니다." : `${count}개 · 약 ${megabytes} MB`;
}

async function loadSettings(): Promise<void> {
  const settings = await getSettings();
  showGlossary(settings.glossary);
  modeSelect.value = settings.translationMode;
  maxTokensInput.value = String(settings.maxOutputTokens);
  showCacheSettings(settings);
  // 불러오는 사이에 사용자가 키를 입력하기 시작했으면 덮어쓰지 않는다.
  const typed = keyInput.value;
  for (const provider of PROVIDERS) {
    drafts.set(provider.id, { key: settings.apiKeys[provider.id] ?? "", model: settings.models[provider.id] });
  }
  if (typed) drafts.get(settings.provider)!.key = typed;
  providerSelect.value = settings.provider;
  showProvider(settings.provider);
  // 단계에 없는 설정이면 고급 설정을 펼쳐 둔다.
  advanced.open = qualityTierOf(settings) === undefined;
}

/** 고급 설정(모델·번역 방식)과 같은 번역 품질 단계를 보여 준다. 없으면 "직접 설정" */
function showQuality(): void {
  const model = modelSelect.value === CUSTOM_MODEL ? customModelInput.value.trim() : modelSelect.value;
  const translationMode = modeSelect.value === "fast" ? "fast" : "accurate";
  const tier = qualityTierOf({ provider: shownProvider, model, translationMode });
  if (tier) customQuality.remove();
  else if (!customQuality.isConnected) qualitySelect.add(customQuality);
  qualitySelect.value = tier?.id ?? customQuality.value;
}

/** 고른 제공업체의 키 라벨·자리표시자·모델 목록을 보여 주고, 그 제공업체에 입력해 둔 값을 채운다. */
function showProvider(provider: ProviderId): void {
  shownProvider = provider;
  const info = providerInfo(provider);
  keyLabel.textContent = `${info.name} API 키`;
  keyInput.placeholder = info.keyPlaceholder;
  customModelInput.placeholder = `모델 ID (예: ${info.customModelExample})`;

  // 모델 목록은 src/shared/models.ts 한 곳에서 가져온다 (SPEC 7.2).
  modelSelect.replaceChildren();
  for (const model of MODELS[provider]) {
    const suffix = model.id === DEFAULT_MODELS[provider] ? " (기본)" : "";
    modelSelect.add(new Option(`${model.name} — ${model.description}${suffix}`, model.id));
  }
  modelSelect.add(new Option("직접 입력", CUSTOM_MODEL));

  const draft = drafts.get(provider) ?? { key: "", model: DEFAULT_MODELS[provider] };
  keyInput.value = draft.key;
  const listed = isListedModel(draft.model, provider);
  modelSelect.value = listed ? draft.model : CUSTOM_MODEL;
  customModelInput.value = listed ? "" : draft.model;
  customModelInput.hidden = listed;
  void showModelSuggestions(provider);
  showQuality();
}

function rememberDraft(): void {
  drafts.set(shownProvider, {
    key: keyInput.value.trim(),
    model: modelSelect.value === CUSTOM_MODEL ? customModelInput.value.trim() : modelSelect.value,
  });
}

/** "직접 입력"의 자동 완성: OpenRouter는 실제 모델 목록 (SPEC 13장 "OpenRouter 모델 고르기") */
let openRouterModelIds: Promise<string[]> | undefined;
async function showModelSuggestions(provider: ProviderId): Promise<void> {
  if (provider !== "openrouter") return customModelList.replaceChildren();
  openRouterModelIds ??= sendMessage({ type: "get-openrouter-models" });
  const ids = await openRouterModelIds;
  if (shownProvider === provider) customModelList.replaceChildren(...ids.map((id) => new Option(id, id)));
}

function selectedModel(): string {
  if (modelSelect.value !== CUSTOM_MODEL) return modelSelect.value;
  customModelInput.value = customModelInput.value.trim();
  return customModelInput.value;
}

function showStatus(text: string, kind: "pending" | "success" | "error"): void {
  status.textContent = text;
  status.dataset.kind = kind;
}

function element<T extends Element>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`${selector} 요소가 없습니다.`);
  return found;
}
