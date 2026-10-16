import type { Page, Worker } from "@playwright/test";
import { expect, test, TEST_EXTENSION_PATH } from "../e2e/fixtures";
import { injectContentScript, mockTranslationApi, storeApiKey } from "../e2e/sw-helpers";
import { structureSnapshot } from "../helpers/snapshot";

// SPEC 10.3 기능 테스트: 실제 사이트(docs.langchain.com)를 번역한 뒤에도 페이지 기능이 그대로 동작하는지 본다.
// 번역은 목 API(대문자 변환)로 해 비용이 들지 않는다. 인터넷이 필요해 npm run test:live로 따로 돌린다 (SPEC 13장).

const SITE = "https://docs.langchain.com";
const HOME = `${SITE}/`;
const OVERVIEW = `${SITE}/oss/python/langchain/overview`;

test.use({ extensionPath: TEST_EXTENSION_PATH });

test.beforeEach(async ({ serviceWorker }) => {
  await storeApiKey(serviceWorker, "sk-ant-e2e");
  await mockTranslationApi(serviceWorker);
});

/** 우클릭 메뉴가 하는 일(콘텐츠 스크립트 넣기)을 하고, 첫 제목이 번역(대문자)될 때까지 기다린다. */
async function translate(page: Page, serviceWorker: Worker): Promise<void> {
  const heading = page.locator("h1").first();
  const original = (await heading.textContent()) ?? "";
  await injectContentScript(serviceWorker, `${SITE}/*`);
  await expect(heading).toHaveText(original.toUpperCase());
}

/** 검색 버튼을 눌러 검색 창을 연다. 안내 문구가 그려질 때까지 기다린다. */
async function openSearch(page: Page) {
  await page.locator("#search-bar-entry").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(/use the up and down arrow keys/i);
  return dialog;
}

test("검색 버튼: 번역한 뒤에도 검색 창이 원본과 똑같이 열리고 입력할 수 있다", async ({ page, serviceWorker }) => {
  await page.goto(HOME);
  const original = await (await openSearch(page)).evaluate(structureSnapshot);

  // 같은 페이지에서 창을 다시 열면 사이트가 새 ID를 붙이므로, 새로 연 페이지를 번역해 처음 연 창끼리 비교한다.
  await page.reload();
  await translate(page, serviceWorker);
  const dialog = await openSearch(page);
  await expect(dialog).toContainText("USE THE UP AND DOWN ARROW KEYS");

  expect(await dialog.evaluate(structureSnapshot)).toBe(original);
  await page.keyboard.type("agent");
  await expect(dialog.getByRole("combobox")).toHaveValue("agent");
});

test("사이드바 링크: 페이지를 새로 읽지 않고(SPA) 바뀐 화면도 번역한다", async ({ page, serviceWorker }) => {
  await page.goto(OVERVIEW);
  await translate(page, serviceWorker);
  // 페이지를 새로 읽으면 이 표시가 사라진다.
  await page.evaluate(() => Object.assign(window, { __beforeNavigation: true }));

  await page.locator("#sidebar-content").getByRole("link", { name: /^install$/i }).click();

  await expect(page).toHaveURL(`${SITE}/oss/python/langchain/install`);
  await expect(page.locator("h1").first()).toHaveText(/^INSTALL /);
  expect(await page.evaluate(() => "__beforeNavigation" in window)).toBe(true);
});

test("테마 메뉴: 번역한 뒤에도 다크 테마로 바꿀 수 있다", async ({ page, serviceWorker }) => {
  await page.goto(HOME);
  await translate(page, serviceWorker);
  await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);

  await page.locator("#theme-preference-menu-trigger").click();
  await page.getByRole("menuitem", { name: /dark/i }).click();

  await expect(page.locator("html")).toHaveClass(/\bdark\b/);
});

test("배너 닫기: 번역한 뒤에도 닫힌다 (배너가 없는 날은 건너뜀)", async ({ page, serviceWorker }) => {
  await page.goto(HOME, { waitUntil: "networkidle" });
  const banner = page.locator("#banner");
  test.skip((await banner.count()) === 0, "오늘은 사이트에 배너가 없습니다.");
  await translate(page, serviceWorker);

  await page.getByRole("button", { name: "Dismiss banner" }).click();

  await expect(banner).toBeHidden();
});
