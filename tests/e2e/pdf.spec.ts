import { readFileSync } from "node:fs";
import type { Page, Worker } from "@playwright/test";
import { buildPdf, paragraphPages } from "../helpers/pdf-builder";
import { expect, test, TEST_EXTENSION_PATH } from "./fixtures";
import { apiCalls, injectContentScript, mockTranslationApi, openPopup, readStorage, releaseApi, storeApiKey, tabIdOf } from "./sw-helpers";

// PDF 번역 (SPEC 13장 "PDF 번역", 설계서 11.3). 픽스처 주소에 코드로 만든 PDF를 돌려준다.

const ORIGIN = "http://aitranslator.test";
const PDF_URL = `${ORIGIN}/paper.pdf`;

test.use({ extensionPath: TEST_EXTENSION_PATH });

/** PDF 주소를 내장 뷰어로 열고 문서가 뜰 때까지 기다린다. */
async function openPdf(page: Page, serviceWorker: Worker, url = PDF_URL): Promise<number> {
  await page.goto(url, { waitUntil: "commit" });
  const tabId = await tabIdOf(serviceWorker, `${ORIGIN}/*`);
  await expect
    .poll(() =>
      serviceWorker.evaluate(
        async (tabId) =>
          (await chrome.scripting.executeScript({ target: { tabId }, func: () => document.contentType }))[0]?.result,
        tabId,
      ),
    )
    .toBe("application/pdf");
  return tabId;
}

function viewerAddress(extensionId: string, source: string): string {
  return `chrome-extension://${extensionId}/pdf/viewer.html?file=${encodeURIComponent(source)}`;
}

const translatedBlocks = (page: Page) => page.locator(".pdf-block[data-translated]");
const allRequests = async (serviceWorker: Worker) => (await apiCalls(serviceWorker)).map((call) => call.body).join("\n");

test.describe("번역", () => {
  test.beforeEach(async ({ context, serviceWorker }) => {
    await context.route(`${ORIGIN}/**`, (route) =>
      route.fulfill({ contentType: "application/pdf", body: paragraphPages(6) }),
    );
    await storeApiKey(serviceWorker, "sk-ant-e2e");
    await mockTranslationApi(serviceWorker);
  });

  test("1·13: 팝업에서 번역하면 같은 탭이 뷰어로 바뀌어 번역하고, 기록에는 원본 주소와 파일명을 남긴다", async ({
    context,
    page,
    serviceWorker,
    extensionId,
  }) => {
    const tabId = await openPdf(page, serviceWorker, `${PDF_URL}?token=1#page=2`);
    const popup = await openPopup(context, serviceWorker, extensionId, tabId);

    await popup.getByRole("button", { name: "번역" }).click();

    await expect(page).toHaveURL(/\/pdf\/viewer\.html\?file=/);
    await expect(translatedBlocks(page).first()).toContainText("PARAGRAPH LINE ONE");
    await expect(popup.getByRole("status")).toHaveText("번역 완료");
    await expect(page.locator("#status")).toHaveText("번역 완료");
    await expect(page.locator("#page-input")).toHaveValue("2");
    await expect(page.locator("#page-total")).toHaveText("/ 6");
    await expect(page).toHaveTitle("paper.pdf");
    await expect
      .poll(async () => ((await readStorage(serviceWorker)).translationLog as { page: { url: string; title: string } }[])?.[0]?.page)
      .toEqual({ url: PDF_URL, title: "paper.pdf" });
  });

  test("2: 번역을 기다리는 동안 \"번역 완료\"로 보이지 않는다", async ({ context, page, serviceWorker, extensionId }) => {
    await mockTranslationApi(serviceWorker, { gated: true });
    const tabId = await openPdf(page, serviceWorker);
    const popup = await openPopup(context, serviceWorker, extensionId, tabId);

    await popup.getByRole("button", { name: "번역" }).click();
    await expect(page.locator(".pdf-block").first()).toBeAttached();
    await expect.poll(async () => (await apiCalls(serviceWorker)).length).toBeGreaterThan(0);
    await expect(popup.getByRole("status")).toHaveText(/^번역 중…/);

    await releaseApi(serviceWorker);
    await expect(popup.getByRole("status")).toHaveText("번역 완료");
  });

  test("3: 원문 보기는 번역문을 감추고, 다시 번역해도 API를 부르지 않는다", async ({ page, serviceWorker, extensionId }) => {
    await page.goto(viewerAddress(extensionId, PDF_URL));
    await expect(translatedBlocks(page).first()).toBeVisible();
    await expect(page.locator("#status")).toHaveText("번역 완료");
    const calls = (await apiCalls(serviceWorker)).length;

    await page.getByRole("button", { name: "원문 보기" }).click();
    await expect(page.locator("#status")).toHaveText("원문 표시 중");
    await expect(translatedBlocks(page)).toHaveCount(0);

    await page.getByRole("button", { name: "번역", exact: true }).click();
    await expect(translatedBlocks(page).first()).toBeVisible();
    expect(await apiCalls(serviceWorker)).toHaveLength(calls);
  });

  test("4: 그려진 쪽만 번역하고 스크롤하면 이어서 번역한다", async ({ page, serviceWorker, extensionId }) => {
    await page.goto(viewerAddress(extensionId, PDF_URL));
    await expect(translatedBlocks(page).first()).toBeVisible();
    await expect(page.locator("#status")).toHaveText("번역 완료");
    expect(await allRequests(serviceWorker)).not.toContain("Page 6 paragraph");

    await page.evaluate(() => {
      const container = document.querySelector("#viewerContainer")!;
      container.scrollTop = container.scrollHeight;
    });

    await expect(page.locator('.pdf-layer[data-page="6"] .pdf-block[data-translated]')).toContainText("PAGE 6 PARAGRAPH");
  });

  test("5: 확대해도 번역층이 페이지 안쪽과 맞고, 층이 늘거나 다시 번역하지 않는다", async ({ page, serviceWorker, extensionId }) => {
    await page.goto(viewerAddress(extensionId, PDF_URL));
    await expect(translatedBlocks(page).first()).toBeVisible();
    await expect(page.locator("#status")).toHaveText("번역 완료");
    const layers = await page.locator(".pdf-layer").count();
    const calls = (await apiCalls(serviceWorker)).length;

    await page.getByRole("button", { name: "확대" }).click();

    await expect
      .poll(() =>
        page.evaluate(() => {
          const div = document.querySelector<HTMLElement>('.page[data-page-number="1"]')!;
          const box = div.getBoundingClientRect();
          const layer = document.querySelector('.pdf-layer[data-page="1"]')!.getBoundingClientRect();
          return [
            layer.left - (box.left + div.clientLeft),
            layer.top - (box.top + div.clientTop),
            layer.width - div.clientWidth,
            layer.height - div.clientHeight,
          ].every((difference) => Math.abs(difference) <= 1);
        }),
      )
      .toBe(true);
    await expect(page.locator(".pdf-layer")).toHaveCount(layers);
    expect(await apiCalls(serviceWorker)).toHaveLength(calls);
  });

  test("6: 번역문은 마우스를 받지 않아 아래의 링크를 누를 수 있다", async ({ page, extensionId }) => {
    await page.goto(viewerAddress(extensionId, PDF_URL));
    await expect(translatedBlocks(page).first()).toBeVisible();

    expect(await translatedBlocks(page).first().evaluate((block) => getComputedStyle(block).pointerEvents)).toBe("none");
  });

  test("다운로드: 원본 바이트 그대로 paper.pdf로 저장한다", async ({ page, extensionId }) => {
    await page.goto(viewerAddress(extensionId, PDF_URL));
    await expect(translatedBlocks(page).first()).toBeVisible();

    const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#download").click()]);

    expect(download.suggestedFilename()).toBe("paper.pdf");
    const saved = readFileSync((await download.path())!);
    expect(saved.equals(paragraphPages(6))).toBe(true);
  });

  test("7: 뒤로 가면 원본 PDF로 돌아간다", async ({ context, page, serviceWorker, extensionId }) => {
    const tabId = await openPdf(page, serviceWorker);
    const popup = await openPopup(context, serviceWorker, extensionId, tabId);
    await popup.getByRole("button", { name: "번역" }).click();
    await expect(page).toHaveURL(/\/pdf\/viewer\.html/);

    await page.goBack({ waitUntil: "commit" });

    await expect(page).toHaveURL(PDF_URL);
  });

  test("12: 내장 뷰어의 PDF에 번역 스크립트가 들어가도 명령을 받지 않는다 (자동 번역 사이트)", async ({ page, serviceWorker }) => {
    const tabId = await openPdf(page, serviceWorker);

    await injectContentScript(serviceWorker, `${ORIGIN}/*`);

    const answered = await serviceWorker.evaluate(
      (tabId) => chrome.tabs.sendMessage(tabId, { type: "get-state" }, { frameId: 0 }).then(() => true, () => false),
      tabId,
    );
    expect(answered).toBe(false);
  });

  test("추가: 원문 보기 중에 그려진 쪽은 번역하지 않고, 번역을 누르면 번역한다", async ({ page, serviceWorker, extensionId }) => {
    await page.goto(viewerAddress(extensionId, PDF_URL));
    await expect(page.locator("#status")).toHaveText("번역 완료");
    await page.getByRole("button", { name: "원문 보기" }).click();
    await expect(page.locator("#status")).toHaveText("원문 표시 중");

    await page.evaluate(() => {
      const container = document.querySelector("#viewerContainer")!;
      container.scrollTop = container.scrollHeight;
    });
    await expect(page.locator('.pdf-layer[data-page="6"]')).toBeAttached();
    expect(await allRequests(serviceWorker)).not.toContain("Page 6 paragraph");

    await page.getByRole("button", { name: "번역", exact: true }).click();
    await expect(page.locator('.pdf-layer[data-page="6"] .pdf-block[data-translated]')).toContainText("PAGE 6 PARAGRAPH");
  });

  test("14: 키 오류면 뷰어에 알림과 \"설정 열기\"를 보여 준다", async ({ page, serviceWorker, extensionId }) => {
    await mockTranslationApi(serviceWorker, {
      error: { status: 401, body: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } } },
    });

    await page.goto(viewerAddress(extensionId, PDF_URL));

    await expect(page.locator("aitranslator-toast").getByText("API 키를 확인하세요.")).toBeVisible();
    await expect(page.locator("aitranslator-toast").getByRole("button", { name: "설정 열기" })).toBeVisible();
    await expect(page.locator("#status")).toHaveText("API 키를 확인하세요.");
  });
});

test.describe("열지 못하는 경우", () => {
  test.beforeEach(async ({ serviceWorker }) => {
    await storeApiKey(serviceWorker, "sk-ant-e2e");
    await mockTranslationApi(serviceWorker);
  });

  test("8: 사이트 권한이 없으면 안내와 \"허용\" 버튼을 보여 주고 PDF를 받지 않는다", async ({ context, page, extensionId }) => {
    let requested = false;
    await context.route("http://other.test/**", (route) => {
      requested = true;
      return route.fulfill({ contentType: "application/pdf", body: paragraphPages(1) });
    });

    await page.goto(viewerAddress(extensionId, "http://other.test/a.pdf"));

    await expect(page.locator("#notice-text")).toHaveText("이 PDF를 받으려면 http://other.test 접근 권한이 필요합니다.");
    await expect(page.getByRole("button", { name: "허용" })).toBeVisible();
    expect(requested).toBe(false);
  });

  test("9: 로컬 PDF는 파일을 고르면 번역한다", async ({ page, serviceWorker, extensionId }) => {
    await page.goto(viewerAddress(extensionId, "file:///Users/me/a.pdf"));
    await expect(page.locator("#notice-text")).toHaveText("내 컴퓨터의 PDF는 직접 읽을 수 없습니다. 번역할 파일을 골라 주세요.");
    await expect(page).toHaveTitle("a.pdf");

    await page.locator("#file").setInputFiles({ name: "local.pdf", mimeType: "application/pdf", buffer: paragraphPages(1) });

    await expect(translatedBlocks(page).first()).toContainText("PARAGRAPH LINE ONE");
    await expect(page.locator("#notice")).toBeHidden();
    await expect(page).toHaveTitle("local.pdf");
    expect((await apiCalls(serviceWorker)).length).toBeGreaterThan(0);
  });

  test("10: 받지 못하면 HTTP 문구와 원본 링크를 보여 준다", async ({ context, page, extensionId }) => {
    await context.route(`${ORIGIN}/**`, (route) => route.fulfill({ status: 404, body: "not found" }));

    await page.goto(viewerAddress(extensionId, PDF_URL));

    await expect(page.locator("#notice-text")).toHaveText("PDF를 받지 못했습니다. (HTTP 404)");
    await expect(page.getByRole("link", { name: "원본 PDF 열기" })).toHaveAttribute("href", PDF_URL);
    await expect(page.locator("#status")).toHaveText("PDF를 받지 못했습니다. (HTTP 404)");
  });

  test("추가: PDF가 아닌 응답이면 열기 실패 문구를 보여 준다", async ({ context, page, extensionId }) => {
    await context.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: "text/html", body: "<h1>login</h1>" }));

    await page.goto(viewerAddress(extensionId, PDF_URL));

    await expect(page.locator("#notice-text")).toHaveText("PDF를 열지 못했습니다.");
    await expect(page.getByRole("link", { name: "원본 PDF 열기" })).toBeVisible();
  });

  test("11: 텍스트가 없는 PDF는 문구를 보여 주고 API를 부르지 않는다", async ({ context, page, serviceWorker, extensionId }) => {
    await context.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: "application/pdf", body: buildPdf([[]]) }));

    await page.goto(viewerAddress(extensionId, PDF_URL));

    await expect(page.locator("#notice-text")).toHaveText("이 PDF에는 번역할 텍스트가 없습니다. 스캔한 문서일 수 있습니다.");
    await expect(page.locator(".page")).toHaveCount(1);
    await page.waitForTimeout(600);
    await expect(page.locator(".pdf-layer")).toHaveCount(0);
    expect(await apiCalls(serviceWorker)).toHaveLength(0);
  });
});
