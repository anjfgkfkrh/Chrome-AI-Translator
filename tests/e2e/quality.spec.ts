import path from "node:path";
import { expect, test, TEST_EXTENSION_PATH } from "./fixtures";
import { apiCalls, mockTranslationApi, openPopup, readStorage, storeApiKey, tabIdOf } from "./sw-helpers";

// 고도화: 번역 품질을 쉽게 고르기 (SPEC 13장 "번역 품질 …" 결정)

const FIXTURE_ORIGIN = "http://aitranslator.test";
const FIXTURES_DIR = path.resolve(import.meta.dirname, "../fixtures");
const SENTENCES = `${FIXTURE_ORIGIN}/sentences.html`;
const HAIKU = "Haiku5.5-medium(기본) — 빠르고 저렴함";
const SONNET = "Sonnet5.5-medium(정확하게) — 더 자연스러움, 비용 약 20배";

test.use({ extensionPath: TEST_EXTENSION_PATH });

test.beforeEach(async ({ context, serviceWorker }) => {
  await context.route(`${FIXTURE_ORIGIN}/**`, (route) =>
    route.fulfill({ path: path.join(FIXTURES_DIR, new URL(route.request().url()).pathname) }),
  );
  await storeApiKey(serviceWorker, "sk-ant-e2e");
});

test("옵션 페이지: 번역 품질을 고르면 바로 저장되고, 모델·번역 방식은 접힌 고급 설정에 있다", async ({
  context,
  serviceWorker,
  extensionId,
}) => {
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options/options.html`);
  const quality = options.getByLabel("번역 품질");
  await expect(quality.locator("option")).toHaveText([
    "Haiku5.5-no-thinking(빠르게) — 가장 빠름, 가끔 어색함",
    "Haiku5.5-medium(기본) — 빠르고 저렴함",
    SONNET,
    "Opus5.5-medium(최고 품질) — 가장 정확함, 비용 약 40배",
  ]);
  await expect(quality).toHaveValue("haiku-medium");
  await expect(options.getByLabel("모델", { exact: true })).toBeHidden();

  await quality.selectOption({ label: SONNET });

  // "저장"을 누르지 않아도 저장된다.
  await expect(options.getByRole("status")).toHaveText("저장했습니다.");
  await expect
    .poll(async () => (await readStorage(serviceWorker)).settings)
    .toMatchObject({ models: { anthropic: "claude-sonnet-5-5" } });

  await options.getByText("고급 설정", { exact: true }).click();
  await expect(options.getByLabel("모델", { exact: true })).toHaveValue("claude-sonnet-5-5");
  await options.getByLabel("번역 방식").selectOption({ label: "빠르게 (사고 끔)" });
  await expect(quality).toHaveValue("custom");
  await expect(quality.locator("option:checked")).toHaveText("직접 설정");
});

test("팝업: 번역된 페이지에서 품질을 바꾸고 \"이 품질로 다시 번역\"을 누르면 새 모델로 다시 번역한다", async ({
  context,
  page,
  serviceWorker,
  extensionId,
}) => {
  await mockTranslationApi(serviceWorker);
  await page.goto(SENTENCES);
  const popup = await openPopup(context, serviceWorker, extensionId, await tabIdOf(serviceWorker, SENTENCES));
  await popup.getByRole("button", { name: "번역" }).click();
  await expect(popup.getByRole("status")).toHaveText("번역 완료");
  const retranslate = popup.getByRole("button", { name: "이 품질로 다시 번역" });
  await expect(retranslate).toBeHidden();

  await popup.getByLabel("번역 품질").selectOption({ label: SONNET });
  await expect(retranslate).toBeVisible();
  await retranslate.click();

  await expect(retranslate).toBeHidden();
  await expect(popup.getByRole("status")).toHaveText("번역 완료");
  await expect(page.locator("#start")).toHaveText("GET STARTED");
  const models = (await apiCalls(serviceWorker)).map((call) => JSON.parse(call.body).model);
  expect(models).toEqual(["claude-haiku-5-5", "claude-sonnet-5-5"]);
});

/** 목 API가 받은 요청의 모델 */
async function requestedModels(serviceWorker: Parameters<typeof apiCalls>[0]): Promise<string[]> {
  return (await apiCalls(serviceWorker)).map((call) => JSON.parse(call.body).model);
}

test("팝업: 높은 품질로 번역해 둔 페이지는 낮은 품질로 바꿔 다시 번역해도 새로 요청하지 않는다 (SPEC 13장 \"캐시를 모델끼리 나눠 씀\")", async ({
  context,
  page,
  serviceWorker,
  extensionId,
}) => {
  await mockTranslationApi(serviceWorker);
  await page.goto(SENTENCES);
  const popup = await openPopup(context, serviceWorker, extensionId, await tabIdOf(serviceWorker, SENTENCES));
  await popup.getByLabel("번역 품질").selectOption({ label: SONNET });
  await popup.getByRole("button", { name: "번역" }).click();
  await expect(popup.getByRole("status")).toHaveText("번역 완료");
  expect(await requestedModels(serviceWorker)).toEqual(["claude-sonnet-5-5"]);

  await popup.getByLabel("번역 품질").selectOption({ label: HAIKU });
  await popup.getByRole("button", { name: "이 품질로 다시 번역" }).click();

  // 다시 번역은 새 턴을 연다. 모든 문장을 Sonnet 번역에서 꺼내 쓴다.
  await expect.poll(async () => (await readStorage(serviceWorker)).cacheTurn).toBe(2);
  await expect(popup.getByRole("status")).toHaveText("번역 완료");
  await expect(page.locator("#start")).toHaveText("GET STARTED");
  expect(await requestedModels(serviceWorker)).toEqual(["claude-sonnet-5-5"]);
});

test("직접 입력한 모델: 목록에 있는 모델의 번역을 쓰고, 번역된 페이지에서는 \"이 품질로 다시 번역\"이 늘 보이며 누르면 그 모델로 다시 번역한다 (SPEC 13장)", async ({
  context,
  page,
  serviceWorker,
  extensionId,
}) => {
  await mockTranslationApi(serviceWorker);
  await page.goto(SENTENCES);
  const tabId = await tabIdOf(serviceWorker, SENTENCES);
  const first = await openPopup(context, serviceWorker, extensionId, tabId);
  await first.getByRole("button", { name: "번역" }).click();
  await expect(first.getByRole("status")).toHaveText("번역 완료");
  await first.close();

  // 옵션 페이지의 고급 설정에서 모델을 직접 입력해 저장한 것과 같다.
  await serviceWorker.evaluate(() =>
    chrome.storage.local.set({ settings: { apiKeys: { anthropic: "sk-ant-e2e" }, models: { anthropic: "claude-custom-e2e" } } }),
  );
  await page.reload();
  const popup = await openPopup(context, serviceWorker, extensionId, tabId);
  await popup.getByRole("button", { name: "번역" }).click();
  await expect(popup.getByRole("status")).toHaveText("번역 완료");
  await expect(page.locator("#start")).toHaveText("GET STARTED");
  expect(await requestedModels(serviceWorker)).toEqual(["claude-haiku-5-5"]);

  await expect(popup.getByLabel("번역 품질")).toHaveValue("custom");
  const retranslate = popup.getByRole("button", { name: "이 품질로 다시 번역" });
  await expect(retranslate).toBeVisible();
  await retranslate.click();

  await expect.poll(() => requestedModels(serviceWorker)).toEqual(["claude-haiku-5-5", "claude-custom-e2e"]);
  await expect(popup.getByRole("status")).toHaveText("번역 완료");
  await expect(page.locator("#start")).toHaveText("GET STARTED");
  await expect(retranslate).toBeVisible();
});
