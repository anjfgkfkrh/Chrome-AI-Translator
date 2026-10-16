import { glossaryText, parseGlossary, type GlossaryTerms } from "../shared/glossary";
import { sendMessage } from "../shared/messages";
import { DEFAULT_MODEL_ID, isListedModel, MODELS } from "../shared/models";
import { renderShortcut } from "../shared/shortcut";
import {
  CACHE_CLEANUP_PERCENT_RANGE,
  CACHE_IDLE_TURNS_RANGE,
  getSettings,
  setApiKey,
  setCacheCleanup,
  setGlossary,
  setModel,
} from "../shared/storage";
import { getUsage, isEmptyUsage, USAGE_KEY } from "../shared/usage";

const CUSTOM_MODEL = "custom";

const keyInput = element<HTMLInputElement>("#api-key");
const toggleButton = element<HTMLButtonElement>("#toggle-key");
const modelSelect = element<HTMLSelectElement>("#model");
const customModelInput = element<HTMLInputElement>("#custom-model");
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
const cleanupPercentInput = element<HTMLInputElement>("#cleanup-percent");
const idleTurnsInput = element<HTMLInputElement>("#idle-turns");
const usageText = element<HTMLParagraphElement>("#usage");

// 모델 목록은 src/shared/models.ts 한 곳에서 가져온다 (SPEC 7.2).
for (const model of MODELS) {
  const suffix = model.id === DEFAULT_MODEL_ID ? " (기본)" : "";
  modelSelect.add(new Option(`${model.name} — ${model.description}${suffix}`, model.id));
}
modelSelect.add(new Option("직접 입력", CUSTOM_MODEL));

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

modelSelect.addEventListener("change", () => {
  customModelInput.hidden = modelSelect.value !== CUSTOM_MODEL;
  if (!customModelInput.hidden) customModelInput.focus();
});

// 테스트와 저장은 서로 독립: 테스트는 저장 전 입력값과 고른 모델로 한다 (SPEC 13장).
testButton.addEventListener("click", async () => {
  const apiKey = keyInput.value.trim();
  const model = selectedModel();
  if (!apiKey) return showStatus("API 키를 입력하세요.", "error");
  if (!model) return showStatus("모델 ID를 입력하세요.", "error");

  testButton.disabled = true;
  showStatus("연결 확인 중…", "pending");
  try {
    const result = await sendMessage({ type: "test-connection", apiKey, model });
    showStatus(result.message ?? "", result.ok ? "success" : "error");
  } catch (err) {
    showStatus(`연결 실패: ${err instanceof Error ? err.message : String(err)}`, "error");
  } finally {
    testButton.disabled = false;
  }
});

// "저장"은 키와 모델을 함께 저장한다. 키가 빈 칸이면 저장된 키를 지운다 (SPEC 13장).
saveButton.addEventListener("click", async () => {
  const apiKey = keyInput.value.trim();
  const model = selectedModel();
  if (!model) return showStatus("모델 ID를 입력하세요.", "error");

  keyInput.value = apiKey;
  await setApiKey(apiKey);
  await setModel(model);
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

// 캐시 정리 기준 (SPEC 13장 "캐시 정리 기준 조정"): 바꾸면 바로 저장하고, 범위를 벗어나면 가까운 값으로 맞춘다.
for (const input of [cleanupPercentInput, idleTurnsInput]) {
  input.addEventListener("change", async () => {
    const saved = await getSettings();
    const percent = clampInteger(cleanupPercentInput.value, CACHE_CLEANUP_PERCENT_RANGE, saved.cacheCleanupPercent);
    const idleTurns = clampInteger(idleTurnsInput.value, CACHE_IDLE_TURNS_RANGE, saved.cacheIdleTurns);
    cleanupPercentInput.value = String(percent);
    idleTurnsInput.value = String(idleTurns);
    await setCacheCleanup(percent, idleTurns);
    cacheStatus.textContent = "정리 기준을 저장했습니다.";
  });
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
  const { apiKeys, model, glossary, cacheCleanupPercent, cacheIdleTurns } = await getSettings();
  showGlossary(glossary);
  cleanupPercentInput.value = String(cacheCleanupPercent);
  idleTurnsInput.value = String(cacheIdleTurns);
  // 불러오는 사이에 사용자가 입력을 시작했으면 덮어쓰지 않는다.
  if (!keyInput.value) keyInput.value = apiKeys.anthropic ?? "";
  if (isListedModel(model)) {
    modelSelect.value = model;
  } else {
    modelSelect.value = CUSTOM_MODEL;
    customModelInput.value = model;
    customModelInput.hidden = false;
  }
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
