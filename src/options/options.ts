import { sendMessage } from "../shared/messages";
import { DEFAULT_MODEL_ID, isListedModel, MODELS } from "../shared/models";
import { renderShortcut } from "../shared/shortcut";
import { getSettings, setApiKey, setModel } from "../shared/storage";

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

// 모델 목록은 src/shared/models.ts 한 곳에서 가져온다 (SPEC 7.2).
for (const model of MODELS) {
  const suffix = model.id === DEFAULT_MODEL_ID ? " (기본)" : "";
  modelSelect.add(new Option(`${model.name} — ${model.description}${suffix}`, model.id));
}
modelSelect.add(new Option("직접 입력", CUSTOM_MODEL));

void loadSettings();
void renderCacheSummary();
void renderShortcut(element("#shortcut"));

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
  const { apiKeys, model } = await getSettings();
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
