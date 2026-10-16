import path from "node:path";
import { expect, test, TEST_EXTENSION_PATH } from "./fixtures";
import { injectContentScript, mockTranslationApi, readStorage, storeApiKey } from "./sw-helpers";

// 고도화: 최근 번역 기록 (SPEC 13장 "최근 번역 기록" …)

const FIXTURE_ORIGIN = "http://aitranslator.test";
const FIXTURES_DIR = path.resolve(import.meta.dirname, "../fixtures");
const SENTENCES = `${FIXTURE_ORIGIN}/sentences.html`;

test.use({ extensionPath: TEST_EXTENSION_PATH });

test.beforeEach(async ({ context, serviceWorker }) => {
  await context.route(`${FIXTURE_ORIGIN}/**`, (route) =>
    route.fulfill({ path: path.join(FIXTURES_DIR, new URL(route.request().url()).pathname) }),
  );
  await storeApiKey(serviceWorker, "sk-ant-e2e");
});

test("최근 번역: 번역하면 열어 둔 옵션 페이지에 한 건이 생기고, 펼치면 자세히 보이며, 지울 수 있다", async ({
  context,
  page,
  serviceWorker,
  extensionId,
}) => {
  await mockTranslationApi(serviceWorker, { usage: { input_tokens: 120, output_tokens: 40 } });
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options/options.html`);
  await expect(options.getByText("아직 번역 기록이 없습니다.")).toBeVisible();
  const summaries = options.locator(".log-entry summary");

  await page.goto(SENTENCES);
  await injectContentScript(serviceWorker, SENTENCES);
  await expect(page.locator("#start")).toHaveText("GET STARTED");

  await expect(summaries).toHaveCount(1);
  await expect(summaries.first()).toContainText("Fixture: sentences · Haiku5.5-medium(기본) · 완료 · 5개 (캐시 0)");

  // 다시 열면 모두 캐시로 번역한다: 새로 번역한 것이 없으므로 기록을 남기지 않는다 (SPEC 13장).
  await page.reload();
  await injectContentScript(serviceWorker, SENTENCES);
  await expect(page.locator("#start")).toHaveText("GET STARTED");
  await expect.poll(async () => (await readStorage(serviceWorker)).cacheTurn).toBe(2);
  await expect
    .poll(async () => ((await readStorage(serviceWorker)).translationLog as { status: string }[]).map((e) => e.status))
    .toEqual(["done"]);
  await expect(summaries).toHaveCount(1);

  await summaries.first().click();
  const details = options.locator(".log-entry").first().locator("dl");
  await expect(details).toContainText("Fixture: sentences (http://aitranslator.test/sentences.html)");
  await expect(details).toContainText("claude-haiku-5-5");
  await expect(details).toContainText("전체 5 · 캐시 0 · 새로 번역 5 · 원문으로 남김 0");
  await expect(details).toContainText("입력 120 · 캐시 쓰기 0 · 캐시 읽기 0 · 출력 40");
  await expect(details).toContainText("1회");
  await expect(details).toContainText("직접");

  await options.getByRole("button", { name: "기록 지우기" }).click();

  await expect(summaries).toHaveCount(0);
  await expect(options.getByText("아직 번역 기록이 없습니다.")).toBeVisible();
});

test("최근 번역: 페이지를 새로 읽지 않는 사이트(SPA)에서 주소가 바뀌면 새 건·새 턴으로 센다 (SPEC 13장)", async ({
  context,
  page,
  serviceWorker,
  extensionId,
}) => {
  await mockTranslationApi(serviceWorker);
  await page.goto(`${FIXTURE_ORIGIN}/spa.html`);
  await injectContentScript(serviceWorker, `${FIXTURE_ORIGIN}/spa.html`);
  await expect(page.locator("h1")).toHaveText("WELCOME TO THE APP");

  await page.locator("#next").click();

  await expect(page).toHaveURL(`${FIXTURE_ORIGIN}/spa/next`);
  await expect(page.locator("h1")).toHaveText("SECOND SCREEN");
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options/options.html`);
  const entries = options.locator(".log-entry");
  await expect(entries).toHaveCount(2);
  await entries.nth(0).locator("summary").click();
  await expect(entries.nth(0).locator("dl")).toContainText(`${FIXTURE_ORIGIN}/spa/next`);
  await entries.nth(1).locator("summary").click();
  await expect(entries.nth(1).locator("dl")).toContainText(`${FIXTURE_ORIGIN}/spa.html`);
  expect((await readStorage(serviceWorker)).cacheTurn).toBe(2);
});
