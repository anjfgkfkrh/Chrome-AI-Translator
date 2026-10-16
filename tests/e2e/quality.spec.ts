import path from "node:path";
import { expect, test, TEST_EXTENSION_PATH } from "./fixtures";
import { apiCalls, mockTranslationApi, openPopup, readStorage, storeApiKey, tabIdOf } from "./sw-helpers";

// 고도화: 번역 품질을 쉽게 고르기 (SPEC 13장 "번역 품질 …" 결정)

const FIXTURE_ORIGIN = "http://aitranslator.test";
const FIXTURES_DIR = path.resolve(import.meta.dirname, "../fixtures");
const SENTENCES = `${FIXTURE_ORIGIN}/sentences.html`;
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
