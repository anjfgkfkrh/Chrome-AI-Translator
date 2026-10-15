import type { Page } from "@playwright/test";
import path from "node:path";
import { textSnapshot } from "../helpers/snapshot";
import { expect, test, TEST_EXTENSION_PATH } from "./fixtures";
import {
  apiCalls,
  closeOptionsPages,
  injectContentScript,
  mockTranslationApi,
  openPopup,
  releaseApi,
  storeApiKey,
  tabIdOf,
} from "./sw-helpers";

// M4 완료 기준: 3장 시나리오 1~3, 5 동작 (SPEC 11장). 시나리오 2의 "보이는 영역부터"는 M5에서 한다.

const FIXTURE_ORIGIN = "http://aitranslator.test";
const FIXTURES_DIR = path.resolve(import.meta.dirname, "../fixtures");
const SENTENCES = `${FIXTURE_ORIGIN}/sentences.html`;

test.use({ extensionPath: TEST_EXTENSION_PATH });

test.beforeEach(async ({ context }) => {
  await context.route(`${FIXTURE_ORIGIN}/**`, (route) =>
    route.fulfill({ path: path.join(FIXTURES_DIR, new URL(route.request().url()).pathname) }),
  );
});

function popupStatus(popup: Page) {
  return popup.getByRole("status");
}

test("시나리오 2·3: 팝업 \"번역\" → 진행률 → 번역 완료 → \"원문 보기\" → 다시 \"번역\"(API 호출 없음)", async ({
  context,
  page,
  serviceWorker,
  extensionId,
}) => {
  await storeApiKey(serviceWorker, "sk-ant-e2e");
  await mockTranslationApi(serviceWorker, { gated: true });
  await page.goto(SENTENCES);
  const original = await page.evaluate(textSnapshot);
  const popup = await openPopup(context, serviceWorker, extensionId, await tabIdOf(serviceWorker, SENTENCES));

  await expect(popupStatus(popup)).toBeHidden();
  await popup.getByRole("button", { name: "번역" }).click();
  await expect(popupStatus(popup)).toHaveText("번역 중… 0/5");
  await expect(popup.getByRole("button", { name: "원문 보기" })).toBeVisible();

  await releaseApi(serviceWorker);
  await expect(popupStatus(popup)).toHaveText("번역 완료");
  await expect(page.locator("#start")).toHaveText("GET STARTED");

  await popup.getByRole("button", { name: "원문 보기" }).click();
  await expect(popupStatus(popup)).toHaveText("원문 표시 중");
  expect(await page.evaluate(textSnapshot)).toEqual(original);

  await popup.getByRole("button", { name: "번역" }).click();
  await expect(popupStatus(popup)).toHaveText("번역 완료");
  await expect(page.locator("#start")).toHaveText("GET STARTED");
  expect(await apiCalls(serviceWorker)).toHaveLength(1);
});

test("시나리오 1: 키가 없으면 팝업이 \"API 키를 먼저 설정하세요\"를 보여 주고 \"설정 열기\"로 옵션 페이지를 연다", async ({
  context,
  page,
  serviceWorker,
  extensionId,
}) => {
  await page.goto(SENTENCES);
  const popup = await openPopup(context, serviceWorker, extensionId, await tabIdOf(serviceWorker, SENTENCES));
  await expect(popupStatus(popup)).toHaveText("API 키를 먼저 설정하세요");
  await expect(popup.getByRole("button", { name: "번역" })).toBeHidden();
  await closeOptionsPages(context);

  const opened = context.waitForEvent("page");
  await popup.getByRole("button", { name: "설정 열기" }).click();

  await expect(await opened).toHaveURL(/\/options\/options\.html$/);
});

test("번역할 수 없는 페이지(chrome://)면 팝업이 \"이 페이지는 번역할 수 없습니다.\"를 보여 준다", async ({
  context,
  serviceWorker,
  extensionId,
}) => {
  await storeApiKey(serviceWorker, "sk-ant-e2e");
  const tabId = await serviceWorker.evaluate(async () => (await chrome.tabs.create({ url: "chrome://version" })).id!);
  const popup = await openPopup(context, serviceWorker, extensionId, tabId);

  // 주소를 볼 권한이 없으면 일단 "번역"을 보여 주고, 눌렀을 때 스크립트를 넣을 수 없으면 안내한다.
  const translate = popup.getByRole("button", { name: "번역" });
  const unsupported = popup.getByText("이 페이지는 번역할 수 없습니다.");
  await expect(translate.or(unsupported)).toBeVisible();
  if (await translate.isVisible()) await translate.click();

  await expect(unsupported).toBeVisible();
  await expect(translate).toBeHidden();
});

test("시나리오 5: 키 오류면 팝업과 페이지 오른쪽 아래 알림에 원인을 보여 주고, 알림의 \"설정 열기\"로 옵션 페이지를 연다", async ({
  context,
  page,
  serviceWorker,
  extensionId,
}) => {
  await storeApiKey(serviceWorker, "sk-ant-wrong");
  await mockTranslationApi(serviceWorker, {
    error: { status: 401, body: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } } },
  });
  await page.goto(SENTENCES);
  const popup = await openPopup(context, serviceWorker, extensionId, await tabIdOf(serviceWorker, SENTENCES));

  await popup.getByRole("button", { name: "번역" }).click();

  await expect(popupStatus(popup)).toHaveText("API 키를 확인하세요.");
  await expect(popup.getByRole("button", { name: "번역" })).toBeVisible();
  const toast = page.locator("aitranslator-toast");
  await expect(toast.getByText("API 키를 확인하세요.")).toBeVisible();
  // 오른쪽 아래 (SPEC 4.11): 화면 오른쪽·아래 끝에서 16px 안쪽
  const box = (await toast.locator(".toast").boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(Math.round(viewport.width - (box.x + box.width))).toBe(16);
  expect(Math.round(viewport.height - (box.y + box.height))).toBe(16);

  await closeOptionsPages(context);
  const opened = context.waitForEvent("page");
  await toast.getByRole("button", { name: "설정 열기" }).click();
  await expect(await opened).toHaveURL(/\/options\/options\.html$/);

  await toast.getByRole("button", { name: "닫기" }).click();
  await expect(toast).toHaveCount(0);
});

test("시나리오 5: 일부만 실패하면 이미 번역된 부분은 그대로 두고 \"일부는 번역하지 못해…\"를 알린다", async ({
  context,
  page,
  serviceWorker,
  extensionId,
}) => {
  await storeApiKey(serviceWorker, "sk-ant-e2e");
  await mockTranslationApi(serviceWorker);
  await page.goto(SENTENCES);
  await injectContentScript(serviceWorker, SENTENCES);
  await expect(page.locator("#start")).toHaveText("GET STARTED");

  await page.evaluate(() => document.body.insertAdjacentHTML("beforeend", '<p id="late">Added after translation</p>'));
  await mockTranslationApi(serviceWorker, { networkError: true });
  const popup = await openPopup(context, serviceWorker, extensionId, await tabIdOf(serviceWorker, SENTENCES));
  await popup.getByRole("button", { name: "원문 보기" }).click();
  await popup.getByRole("button", { name: "번역" }).click();

  await expect(page.locator("aitranslator-toast").getByText("일부는 번역하지 못해 원문으로 두었습니다.")).toBeVisible({
    timeout: 10_000,
  });
  await expect(popupStatus(popup)).toHaveText("번역 완료");
  await expect(popup.getByText("일부는 번역하지 못해 원문으로 두었습니다.")).toBeVisible();
  await expect(page.locator("#start")).toHaveText("GET STARTED");
  await expect(page.locator("#late")).toHaveText("Added after translation");
});

test("단축키: Chrome이 할당한 단축키를 팝업과 옵션 페이지에 보여 준다 (SPEC 4.8.1)", async ({
  context,
  page,
  serviceWorker,
  extensionId,
}) => {
  const shortcut = await serviceWorker.evaluate(
    async () => (await chrome.commands.getAll()).find((command) => command.name === "toggle-translation")?.shortcut,
  );
  expect(shortcut).toMatch(/^(⌥T|Alt\+T)$/);
  await page.goto(SENTENCES);

  const popup = await openPopup(context, serviceWorker, extensionId, await tabIdOf(serviceWorker, SENTENCES));
  await expect(popup.getByText(`단축키 ${shortcut}`)).toBeVisible();

  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options/options.html`);
  await expect(options.getByText(`단축키 ${shortcut}`)).toBeVisible();
});
