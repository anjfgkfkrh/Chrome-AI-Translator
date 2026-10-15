import type { Worker } from "@playwright/test";
import path from "node:path";
import { expect, test, TEST_EXTENSION_PATH } from "./fixtures";
import { apiCalls, injectContentScript, mockTranslationApi, readStorage, storeApiKey, tabIdOf } from "./sw-helpers";

// M5 완료 기준: SPA 페이지 대응, 재방문 시 API 호출 없음 (SPEC 11장)
// 그리고 문자열 단위 캐시, 보이는 영역 우선, 옵션 페이지의 캐시 표시 (SPEC 13장)

const FIXTURE_ORIGIN = "http://aitranslator.test";
const FIXTURES_DIR = path.resolve(import.meta.dirname, "../fixtures");

test.use({ extensionPath: TEST_EXTENSION_PATH });

test.beforeEach(async ({ context, serviceWorker }) => {
  await context.route(`${FIXTURE_ORIGIN}/**`, (route) =>
    route.fulfill({ path: path.join(FIXTURES_DIR, new URL(route.request().url()).pathname) }),
  );
  await storeApiKey(serviceWorker, "sk-ant-e2e");
  await mockTranslationApi(serviceWorker);
});

/** 번역 요청에 들어 있던 그룹의 세그먼트 (호출마다) */
async function requestedSegments(serviceWorker: Worker): Promise<string[][][]> {
  return (await apiCalls(serviceWorker)).map((call) => {
    const groups = JSON.parse(JSON.parse(call.body).messages[0].content).groups as { segments: string[] }[];
    return groups.map((group) => group.segments);
  });
}

test("SPA: 번역 보기 중에 페이지 이동 없이 바뀐 화면도 번역한다 (SPEC 4.6)", async ({ page, serviceWorker }) => {
  await page.goto(`${FIXTURE_ORIGIN}/spa.html`);
  await injectContentScript(serviceWorker, `${FIXTURE_ORIGIN}/spa.html`);
  await expect(page.locator("h1")).toHaveText("WELCOME TO THE APP");

  await page.locator("#next").click();

  await expect(page).toHaveURL(`${FIXTURE_ORIGIN}/spa/next`);
  await expect(page.locator("h1")).toHaveText("SECOND SCREEN");
  await expect(page.locator("#app p")).toHaveText("LOADED WITHOUT A PAGE RELOAD.");
  await page.locator("#add").click();
  await expect(page.locator("#items li")).toHaveText("NEW ITEM ADDED BY THE PAGE");
});

test("우리가 넣은 번역문 때문에 다시 요청하지 않고, 원문 보기 중에는 새 텍스트를 번역하지 않는다", async ({
  page,
  serviceWorker,
}) => {
  await page.goto(`${FIXTURE_ORIGIN}/spa.html`);
  await injectContentScript(serviceWorker, `${FIXTURE_ORIGIN}/spa.html`);
  await expect(page.locator("#add")).toHaveText("ADD ITEM");
  await page.waitForTimeout(1_000);
  expect(await apiCalls(serviceWorker)).toHaveLength(1);

  const tabId = await tabIdOf(serviceWorker, `${FIXTURE_ORIGIN}/spa.html`);
  await serviceWorker.evaluate(
    (tabId) => chrome.tabs.sendMessage(tabId, { type: "show-original" }, { frameId: 0 }),
    tabId,
  );
  await expect(page.locator("#add")).toHaveText("Add item");
  await page.locator("#add").click();
  await page.waitForTimeout(1_000);

  await expect(page.locator("#items li")).toHaveText("New item added by the page");
  expect(await apiCalls(serviceWorker)).toHaveLength(1);
});

test("재방문(새로고침)하면 캐시로 번역하고 API를 부르지 않는다 (M5 완료 기준)", async ({ page, serviceWorker }) => {
  const url = `${FIXTURE_ORIGIN}/sentences.html`;
  await page.goto(url);
  await injectContentScript(serviceWorker, url);
  await expect(page.locator("#start")).toHaveText("GET STARTED");

  await page.reload();
  await expect(page.locator("#start")).toHaveText("Get started");
  await injectContentScript(serviceWorker, url);

  await expect(page.locator("#start")).toHaveText("GET STARTED");
  await expect(page.locator("#signup")).toHaveText("WE'LL EMAIL YOU A CONFIRMATION LINK TO COMPLETE SIGN UP.");
  expect(await apiCalls(serviceWorker)).toHaveLength(1);
});

test("다른 페이지라도 같은 문자열은 캐시를 쓰고, 없는 문장만 요청한다 (SPEC 13장)", async ({ page, serviceWorker }) => {
  await page.goto(`${FIXTURE_ORIGIN}/sentences.html`);
  await injectContentScript(serviceWorker, `${FIXTURE_ORIGIN}/sentences.html`);
  await expect(page.locator("#start")).toHaveText("GET STARTED");

  await page.goto(`${FIXTURE_ORIGIN}/shared.html`);
  await injectContentScript(serviceWorker, `${FIXTURE_ORIGIN}/shared.html`);

  await expect(page.locator("#only-here")).toHaveText("THIS PARAGRAPH APPEARS ONLY ON THIS PAGE.");
  await expect(page.locator("#start")).toHaveText("GET STARTED");
  await expect(page.locator("#names")).toHaveText("BUILD AGENTS WITH CODE USING LANGCHAIN, LANGGRAPH, AND DEEP AGENTS.");
  const requests = await requestedSegments(serviceWorker);
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual([["This paragraph appears only on this page."]]);
});

test("화면에 보이는 문단부터 번역을 요청한다 (SPEC 4.5)", async ({ page, serviceWorker }) => {
  await page.goto(`${FIXTURE_ORIGIN}/long.html`);
  await page.evaluate(() => document.getElementById("p120")!.scrollIntoView());

  await injectContentScript(serviceWorker, `${FIXTURE_ORIGIN}/long.html`);
  await expect(page.locator("#p150")).toHaveText("PARAGRAPH NUMBER 150 OF A LONG ARTICLE.");

  const [first] = await requestedSegments(serviceWorker);
  expect(first![0]).toEqual(["Paragraph number 120 of a long article."]);
  expect(first!.slice(0, 10).flat()).not.toContain("Paragraph number 1 of a long article.");
});

test("옵션 페이지: 저장된 번역 수와 크기를 보여 주고, 캐시를 비운다 (SPEC 4.10, 13장)", async ({
  context,
  page,
  serviceWorker,
  extensionId,
}) => {
  await page.goto(`${FIXTURE_ORIGIN}/sentences.html`);
  await injectContentScript(serviceWorker, `${FIXTURE_ORIGIN}/sentences.html`);
  await expect(page.locator("#start")).toHaveText("GET STARTED");
  await expect.poll(async () => Object.keys(await readStorage(serviceWorker)).filter((key) => key.startsWith("t:")).length).toBe(5);

  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options/options.html`);
  await expect(options.getByText("5개 · 약 0.1 MB")).toBeVisible();

  await options.getByRole("button", { name: "캐시 비우기" }).click();

  await expect(options.getByText("캐시를 비웠습니다.")).toBeVisible();
  await expect(options.getByText("저장된 번역이 없습니다.")).toBeVisible();
  expect(Object.keys(await readStorage(serviceWorker)).some((key) => key.startsWith("t:"))).toBe(false);
});
