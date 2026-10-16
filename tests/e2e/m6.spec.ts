import type { BrowserContext, Page, Worker } from "@playwright/test";
import path from "node:path";
import {
  expect,
  launchWithExtension,
  serviceWorkerOf,
  test,
  TEST_EXTENSION_PATH,
  waitForOptionsPage,
} from "./fixtures";
import { apiCalls, mockTranslationApi, openPopup, readStorage, storeApiKey, tabIdOf } from "./sw-helpers";

// M6 완료 기준: 시나리오 4 (사이트별 자동 번역) 동작 (SPEC 11장)
// 테스트용 빌드는 픽스처 주소의 권한을 이미 갖고 있어 권한 요청이 창 없이 바로 허용된다.
// 권한 창에서 거부하는 경우는 tests/unit/popup.test.ts에서 확인한다.

const FIXTURE_ORIGIN = "http://aitranslator.test";
const FIXTURES_DIR = path.resolve(import.meta.dirname, "../fixtures");
const SENTENCES = `${FIXTURE_ORIGIN}/sentences.html`;
const SHARED = `${FIXTURE_ORIGIN}/shared.html`;
const AUTO_TRANSLATE = "이 사이트는 항상 번역";

test.use({ extensionPath: TEST_EXTENSION_PATH });

test.beforeEach(async ({ context }) => {
  await serveFixtures(context);
});

async function serveFixtures(context: BrowserContext): Promise<void> {
  await context.route(`${FIXTURE_ORIGIN}/**`, (route) =>
    route.fulfill({ path: path.join(FIXTURES_DIR, new URL(route.request().url()).pathname) }),
  );
}

/** sentences.html을 열고 팝업에서 "이 사이트는 항상 번역"을 켠다. 지금 페이지가 번역될 때까지 기다린다. */
async function turnOnAutoTranslate(
  context: BrowserContext,
  page: Page,
  serviceWorker: Worker,
  extensionId: string,
): Promise<Page> {
  await page.goto(SENTENCES);
  const popup = await openPopup(context, serviceWorker, extensionId, await tabIdOf(serviceWorker, SENTENCES));
  await popup.getByLabel(AUTO_TRANSLATE).check();
  await expect(page.locator("#start")).toHaveText("GET STARTED");
  return popup;
}

/** 탭의 콘텐츠 스크립트가 들고 있는 상태. 콘텐츠 스크립트가 없으면 undefined */
function pageState(serviceWorker: Worker, tabId: number) {
  return serviceWorker.evaluate(
    (tabId) => chrome.tabs.sendMessage(tabId, { type: "get-state" }, { frameId: 0 }).catch(() => undefined),
    tabId,
  );
}

function registeredScripts(serviceWorker: Worker) {
  return serviceWorker.evaluate(async () =>
    (await chrome.scripting.getRegisteredContentScripts()).map((script) => script.id),
  );
}

test("시나리오 4: \"이 사이트는 항상 번역\"을 켜면 지금 페이지를 번역하고, 그 사이트의 다른 페이지도 열릴 때 번역한다", async ({
  context,
  page,
  serviceWorker,
  extensionId,
}) => {
  await storeApiKey(serviceWorker, "sk-ant-e2e");
  await mockTranslationApi(serviceWorker);
  await page.goto(SENTENCES);
  const popup = await openPopup(context, serviceWorker, extensionId, await tabIdOf(serviceWorker, SENTENCES));
  const checkbox = popup.getByLabel(AUTO_TRANSLATE);
  await expect(checkbox).not.toBeChecked();

  await checkbox.check();

  // 켤 때 지금 페이지도 바로 번역한다 (SPEC 13장)
  await expect(page.locator("#start")).toHaveText("GET STARTED");
  await expect(popup.getByRole("status")).toHaveText("번역 완료");
  await expect(checkbox).toBeChecked();
  expect((await readStorage(serviceWorker)).settings).toMatchObject({ autoTranslateOrigins: [FIXTURE_ORIGIN] });
  expect(await registeredScripts(serviceWorker)).toEqual([`auto:${FIXTURE_ORIGIN}`]);

  // 같은 탭에서 다른 페이지로
  await page.goto(SHARED);
  await expect(page.locator("#only-here")).toHaveText("THIS PARAGRAPH APPEARS ONLY ON THIS PAGE.");

  // 새 탭
  const another = await context.newPage();
  await another.goto(SENTENCES);
  await expect(another.locator("#names")).toHaveText(
    "BUILD AGENTS WITH CODE USING LANGCHAIN, LANGGRAPH, AND DEEP AGENTS.",
  );

  // 팝업을 다시 열면 켜진 채로 보인다.
  const again = await openPopup(context, serviceWorker, extensionId, await tabIdOf(serviceWorker, SHARED));
  await expect(again.getByLabel(AUTO_TRANSLATE)).toBeChecked();
});

test("자동 번역된 페이지도 팝업에서 원문을 볼 수 있다", async ({ context, page, serviceWorker, extensionId }) => {
  await storeApiKey(serviceWorker, "sk-ant-e2e");
  await mockTranslationApi(serviceWorker);
  await turnOnAutoTranslate(context, page, serviceWorker, extensionId);
  await page.goto(SHARED);
  await expect(page.locator("#only-here")).toHaveText("THIS PARAGRAPH APPEARS ONLY ON THIS PAGE.");

  const popup = await openPopup(context, serviceWorker, extensionId, await tabIdOf(serviceWorker, SHARED));
  await expect(popup.getByRole("status")).toHaveText("번역 완료");
  await popup.getByRole("button", { name: "원문 보기" }).click();

  await expect(page.locator("#only-here")).toHaveText("This paragraph appears only on this page.");
  await expect(popup.getByRole("status")).toHaveText("원문 표시 중");
});

test("팝업에서 체크를 풀면 그 사이트의 페이지를 열어도 번역하지 않는다", async ({
  context,
  page,
  serviceWorker,
  extensionId,
}) => {
  await storeApiKey(serviceWorker, "sk-ant-e2e");
  await mockTranslationApi(serviceWorker);
  const popup = await turnOnAutoTranslate(context, page, serviceWorker, extensionId);

  await popup.getByLabel(AUTO_TRANSLATE).uncheck();

  await expect.poll(() => registeredScripts(serviceWorker)).toEqual([]);
  expect((await readStorage(serviceWorker)).settings).not.toHaveProperty("autoTranslateOrigins");
  await page.goto(SHARED);
  // 자동 번역은 페이지가 다 읽힌 직후에 돈다. 그만큼 기다려도 콘텐츠 스크립트가 없어야 한다.
  await page.waitForTimeout(1_000);
  expect(await pageState(serviceWorker, await tabIdOf(serviceWorker, SHARED))).toBeUndefined();
  await expect(page.locator("#only-here")).toHaveText("This paragraph appears only on this page.");
});

test("옵션 페이지: 자동 번역 사이트를 보여 주고, 삭제하면 더는 자동으로 번역하지 않는다 (SPEC 4.10)", async ({
  context,
  page,
  serviceWorker,
  extensionId,
}) => {
  const optionsUrl = `chrome-extension://${extensionId}/options/options.html`;
  const options = await context.newPage();
  await options.goto(optionsUrl);
  await expect(options.getByText("자동 번역 사이트가 없습니다.")).toBeVisible();

  await storeApiKey(serviceWorker, "sk-ant-e2e");
  await mockTranslationApi(serviceWorker);
  await turnOnAutoTranslate(context, page, serviceWorker, extensionId);
  await options.reload();

  const sites = options.locator("#auto-sites li");
  await expect(sites).toHaveText([`${FIXTURE_ORIGIN} 삭제`]);
  await expect(options.getByText("자동 번역 사이트가 없습니다.")).toBeHidden();

  await options.getByRole("button", { name: `${FIXTURE_ORIGIN} 삭제` }).click();

  await expect(sites).toHaveCount(0);
  await expect(options.getByText("자동 번역 사이트가 없습니다.")).toBeVisible();
  expect(await registeredScripts(serviceWorker)).toEqual([]);
  await page.goto(SHARED);
  await page.waitForTimeout(1_000);
  expect(await pageState(serviceWorker, await tabIdOf(serviceWorker, SHARED))).toBeUndefined();
  await expect(page.locator("#only-here")).toHaveText("This paragraph appears only on this page.");
});

test("키가 없으면 자동 번역 사이트를 열어도 알림 없이 건너뛴다 (SPEC 13장)", async ({
  context,
  page,
  serviceWorker,
  extensionId,
}) => {
  await storeApiKey(serviceWorker, "sk-ant-e2e");
  await mockTranslationApi(serviceWorker);
  const popup = await turnOnAutoTranslate(context, page, serviceWorker, extensionId);
  await popup.close();
  // 키만 지우고 자동 번역 사이트 목록은 남긴다.
  await serviceWorker.evaluate(
    (origin) => chrome.storage.local.set({ settings: { autoTranslateOrigins: [origin] } }),
    FIXTURE_ORIGIN,
  );

  await page.goto(SHARED);

  const tabId = await tabIdOf(serviceWorker, SHARED);
  // 오류 상태가 되었으면 알림을 띄울 차례는 이미 지났다.
  await expect
    .poll(() => pageState(serviceWorker, tabId))
    .toMatchObject({ status: "error", error: "API 키를 먼저 설정하세요" });
  await expect(page.locator("aitranslator-toast")).toHaveCount(0);
  await expect(page.locator("#only-here")).toHaveText("This paragraph appears only on this page.");
  expect(await apiCalls(serviceWorker)).toHaveLength(1);
});

test("키가 없거나 웹 페이지가 아니면(chrome://) 팝업에 \"이 사이트는 항상 번역\"을 보여 주지 않는다", async ({
  context,
  page,
  serviceWorker,
  extensionId,
}) => {
  await page.goto(SENTENCES);
  const popup = await openPopup(context, serviceWorker, extensionId, await tabIdOf(serviceWorker, SENTENCES));
  await expect(popup.getByRole("status")).toHaveText("API 키를 먼저 설정하세요");
  await expect(popup.getByText(AUTO_TRANSLATE)).toBeHidden();

  // 키를 저장하면 열려 있는 팝업에도 나타난다.
  await storeApiKey(serviceWorker, "sk-ant-e2e");
  await expect(popup.getByLabel(AUTO_TRANSLATE)).toBeVisible();

  const tabId = await serviceWorker.evaluate(async () => (await chrome.tabs.create({ url: "chrome://version" })).id!);
  const chromePage = await openPopup(context, serviceWorker, extensionId, tabId);
  await expect(
    chromePage.getByRole("button", { name: "번역" }).or(chromePage.getByText("이 페이지는 번역할 수 없습니다.")),
  ).toBeVisible();
  await expect(chromePage.getByText(AUTO_TRANSLATE)).toBeHidden();
});

test("브라우저를 다시 시작해도 그 사이트의 페이지는 열릴 때 번역한다 (SPEC 13장)", async ({}, testInfo) => {
  const userDataDir = testInfo.outputPath("profile");

  const first = await launchWithExtension(TEST_EXTENSION_PATH, userDataDir);
  try {
    await waitForOptionsPage(first);
    await serveFixtures(first);
    const serviceWorker = await serviceWorkerOf(first);
    await storeApiKey(serviceWorker, "sk-ant-e2e");
    await mockTranslationApi(serviceWorker);
    const extensionId = new URL(serviceWorker.url()).host;
    await turnOnAutoTranslate(first, await first.newPage(), serviceWorker, extensionId);
  } finally {
    await first.close();
  }

  const second = await launchWithExtension(TEST_EXTENSION_PATH, userDataDir);
  try {
    await serveFixtures(second);
    const serviceWorker = await serviceWorkerOf(second);
    await mockTranslationApi(serviceWorker);
    await expect.poll(() => registeredScripts(serviceWorker)).toEqual([`auto:${FIXTURE_ORIGIN}`]);

    const page = await second.newPage();
    await page.goto(SHARED);

    await expect(page.locator("#only-here")).toHaveText("THIS PARAGRAPH APPEARS ONLY ON THIS PAGE.");
  } finally {
    await second.close();
  }
});
