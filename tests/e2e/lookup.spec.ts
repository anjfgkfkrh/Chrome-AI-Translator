import type { Locator, Page, Worker } from "@playwright/test";
import path from "node:path";
import { paragraphPages } from "../helpers/pdf-builder";
import { expect, test, TEST_EXTENSION_PATH } from "./fixtures";
import { apiCalls, findSourceCalls, injectContentScript, mockTranslationApi, storeApiKey } from "./sw-helpers";

// 원문 찾기: 번역문을 Option+드래그하면 라벨로 원문을 보여 준다 (설계 9절, 목 API)

const ORIGIN = "http://aitranslator.test";
const FIXTURES_DIR = path.resolve(import.meta.dirname, "../fixtures");
const PDF_URL = `${ORIGIN}/paper.pdf`;
const SIGNUP = "We'll email you a confirmation link to complete sign up.";

test.use({ extensionPath: TEST_EXTENSION_PATH });

const label = (page: Page) => page.locator("aitranslator-lookup");

/** 요소 안 글자의 화면 위치 (블록 요소는 가로로 넓어 글자 위치를 따로 잰다). */
function textBox(locator: Locator) {
  return locator.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const { x, y, width, height } = range.getBoundingClientRect();
    return { x, y, width, height };
  });
}

/** 글자 영역의 왼쪽 절반을 드래그한다. alt면 Option을 누른 채로 마우스를 놓는다. */
async function drag(page: Page, box: { x: number; y: number; width: number; height: number }, alt: boolean) {
  const y = box.y + box.height / 2;
  if (alt) await page.keyboard.down("Alt");
  await page.mouse.move(box.x + 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, y, { steps: 8 });
  await page.mouse.up();
  if (alt) await page.keyboard.up("Alt");
}

test.describe("웹", () => {
  test.beforeEach(async ({ context, page, serviceWorker }) => {
    await context.route(`${ORIGIN}/**`, (route) =>
      route.fulfill({ path: path.join(FIXTURES_DIR, new URL(route.request().url()).pathname) }),
    );
    // 링크 이동이 일어나면 알아볼 수 있게 이동할 곳을 만들어 둔다.
    await context.route(`${ORIGIN}/confirm`, (route) => route.fulfill({ contentType: "text/html", body: "<p>moved</p>" }));
    await storeApiKey(serviceWorker, "sk-ant-e2e");
    await page.goto(`${ORIGIN}/sentences.html`);
  });

  async function translate(page: Page, serviceWorker: Worker, find: Parameters<typeof mockTranslationApi>[1]) {
    await mockTranslationApi(serviceWorker, find);
    await injectContentScript(serviceWorker, `${ORIGIN}/sentences.html`);
    await expect(page.locator("#signup")).toHaveText(SIGNUP.toUpperCase());
  }

  test("Option+드래그: 라벨에 용어가 뜨고 찾기 요청은 1회다", async ({ page, serviceWorker }) => {
    await translate(page, serviceWorker, { findSource: { kind: "term", text: "confirmation link" } });
    const before = (await apiCalls(serviceWorker)).length;

    await drag(page, await textBox(page.locator("#signup")), true);

    await expect(label(page).getByText("confirmation link")).toBeVisible();
    expect(await findSourceCalls(serviceWorker)).toHaveLength(1);
    expect(await apiCalls(serviceWorker)).toHaveLength(before + 1);
    const body = JSON.parse((await findSourceCalls(serviceWorker))[0]!.body);
    expect(body.model).toBe("claude-haiku-5-5");
    expect(JSON.parse(body.messages[0].content)).toMatchObject({ source: SIGNUP });
    // 번역문은 그대로다.
    await expect(page.locator("#signup")).toHaveText(SIGNUP.toUpperCase());
  });

  test("Option 없는 드래그: 라벨도 요청도 없다", async ({ page, serviceWorker }) => {
    await translate(page, serviceWorker, { findSource: { kind: "term", text: "confirmation link" } });

    await drag(page, await textBox(page.locator("#signup")), false);

    await expect(label(page)).toHaveCount(0);
    expect(await findSourceCalls(serviceWorker)).toHaveLength(0);
  });

  test("sentence 응답은 제목과 함께, 오류 응답은 문단 원문으로 보인다", async ({ page, serviceWorker }) => {
    await translate(page, serviceWorker, { findSource: { kind: "sentence", text: SIGNUP } });
    await drag(page, await textBox(page.locator("#signup")), true);
    await expect(label(page).getByText("원문 문장")).toBeVisible();
    await expect(label(page).getByText(SIGNUP)).toBeVisible();

    // 다른 문단에서 오류 응답
    await mockTranslationApi(serviceWorker, { findSource: "error" });
    await drag(page, await textBox(page.locator("#names")), true);
    await expect(label(page).getByText("문단 원문")).toBeVisible();
    await expect(label(page).getByText("Build agents with code using LangChain, LangGraph, and Deep Agents.")).toBeVisible();
  });

  test("링크가 있는 번역문에서 짧은 Option+드래그: 다운로드도 이동도 없다", async ({ page, serviceWorker }) => {
    await translate(page, serviceWorker, { findSource: { kind: "term", text: "confirmation link" } });
    let downloaded = false;
    page.on("download", () => (downloaded = true));
    const link = await textBox(page.locator("#signup a"));
    const y = link.y + link.height / 2;

    await page.keyboard.down("Alt");
    await page.mouse.move(link.x + 5, y);
    await page.mouse.down();
    await page.mouse.move(link.x + 40, y, { steps: 5 });
    await page.mouse.up();
    await page.keyboard.up("Alt");

    await page.waitForTimeout(500);
    expect(downloaded).toBe(false);
    expect(page.url()).toBe(`${ORIGIN}/sentences.html`);
  });
});

test.describe("PDF", () => {
  test.beforeEach(async ({ context, page, serviceWorker, extensionId }) => {
    await context.route(`${ORIGIN}/**`, (route) =>
      route.fulfill({ contentType: "application/pdf", body: paragraphPages(2) }),
    );
    await storeApiKey(serviceWorker, "sk-ant-e2e");
    await mockTranslationApi(serviceWorker, { findSource: { kind: "term", text: "paragraph line one" } });
    await page.goto(`chrome-extension://${extensionId}/pdf/viewer.html?file=${encodeURIComponent(PDF_URL)}`);
    await expect(page.locator(".pdf-block[data-translated]").first()).toBeVisible();
    await expect(page.locator("#status")).toHaveText("번역 완료");
  });

  const block = (page: Page) => page.locator('.pdf-layer[data-page="1"] .pdf-block[data-translated]').first();
  const pointerEvents = (page: Page) => block(page).evaluate((element) => getComputedStyle(element).pointerEvents);

  test("Option+드래그로 번역문이 선택되고 라벨이 뜬다. 키를 떼면 pointer-events가 none으로 돌아간다", async ({
    page,
    serviceWorker,
  }) => {
    const box = (await block(page).boundingBox())!;

    await page.keyboard.down("Alt");
    await expect.poll(() => pointerEvents(page)).toBe("auto");
    const y = box.y + 6;
    await page.mouse.move(box.x + 3, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, y, { steps: 8 });
    await page.mouse.up();
    await page.keyboard.up("Alt");

    await expect(label(page).getByText("paragraph line one")).toBeVisible();
    expect(await findSourceCalls(serviceWorker)).toHaveLength(1);
    await expect.poll(() => pointerEvents(page)).toBe("none");
  });

  test("Option 없는 드래그: 요청이 없다", async ({ page, serviceWorker }) => {
    const box = (await block(page).boundingBox())!;
    const y = box.y + 6;

    await page.mouse.move(box.x + 3, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, y, { steps: 8 });
    await page.mouse.up();

    await expect(label(page)).toHaveCount(0);
    expect(await findSourceCalls(serviceWorker)).toHaveLength(0);
  });
});
