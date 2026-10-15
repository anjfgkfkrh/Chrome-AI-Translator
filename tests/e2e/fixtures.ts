import { test as base, chromium, type BrowserContext, type Worker } from "@playwright/test";
import path from "node:path";

/** 배포용 빌드 */
export const EXTENSION_PATH = path.resolve(import.meta.dirname, "../../dist");
/** 테스트용 빌드: 픽스처 주소 등에 접근 권한을 더했다 (scripts/build.mjs --test) */
export const TEST_EXTENSION_PATH = path.resolve(import.meta.dirname, "../../dist-test");

// 확장 프로그램을 압축해제된 상태로 설치한 Chromium을 테스트마다 새로 띄운다.
export const test = base.extend<{
  extensionPath: string;
  context: BrowserContext;
  serviceWorker: Worker;
  extensionId: string;
}>({
  extensionPath: [EXTENSION_PATH, { option: true }],
  context: async ({ extensionPath }, use) => {
    const context = await chromium.launchPersistentContext("", {
      // 확장 프로그램은 headless shell이 아닌 전체 Chromium에서만 실행된다.
      channel: "chromium",
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    });
    // 설치하면 옵션 페이지가 열린다(시나리오 1). 테스트의 페이지 이동과 겹치지 않게 열릴 때까지 기다린다.
    await waitForOptionsPage(context);
    await use(context);
    await context.close();
  },
  serviceWorker: async ({ context }, use) => {
    await use(context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker")));
  },
  extensionId: async ({ serviceWorker }, use) => {
    await use(new URL(serviceWorker.url()).host);
  },
});

export const expect = test.expect;

async function waitForOptionsPage(context: BrowserContext): Promise<void> {
  for (let tries = 0; tries < 100; tries++) {
    if (context.pages().some((page) => page.url().endsWith("/options/options.html"))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("설치 후 옵션 페이지가 열리지 않았습니다.");
}
