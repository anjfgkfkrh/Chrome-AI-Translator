import type { BrowserContext, Page, Worker } from "@playwright/test";
import path from "node:path";
import { expect, test, TEST_EXTENSION_PATH } from "./fixtures";
import {
  apiCalls,
  injectContentScript,
  mockTranslationApi,
  openPopup,
  readStorage,
  storeApiKey,
  tabIdOf,
} from "./sw-helpers";

// M7 완료 기준: 10장 전체 통과 (SPEC 11장). 이 파일은 10.5 오류 테스트와 M7에서 더한 옵션 페이지 기능을 확인한다.
// 10.3은 실제 사이트가 필요해 tests/live에 있다 (npm run test:live).

const FIXTURE_ORIGIN = "http://aitranslator.test";
const FIXTURES_DIR = path.resolve(import.meta.dirname, "../fixtures");
const SENTENCES = `${FIXTURE_ORIGIN}/sentences.html`;
const PARTIAL = "일부는 번역하지 못해 원문으로 두었습니다.";

test.use({ extensionPath: TEST_EXTENSION_PATH });

test.beforeEach(async ({ context, serviceWorker }) => {
  await context.route(`${FIXTURE_ORIGIN}/**`, (route) =>
    route.fulfill({ path: path.join(FIXTURES_DIR, new URL(route.request().url()).pathname) }),
  );
  await storeApiKey(serviceWorker, "sk-ant-e2e");
});

/** sentences.html을 열고 팝업에서 "번역"을 누른다. */
async function translateFromPopup(
  context: BrowserContext,
  page: Page,
  serviceWorker: Worker,
  extensionId: string,
): Promise<Page> {
  await page.goto(SENTENCES);
  const popup = await openPopup(context, serviceWorker, extensionId, await tabIdOf(serviceWorker, SENTENCES));
  await popup.getByRole("button", { name: "번역" }).click();
  return popup;
}

async function openOptions(context: BrowserContext, extensionId: string): Promise<Page> {
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options/options.html`);
  return options;
}

/** 요청마다 보낸 그룹 */
async function requestedGroups(serviceWorker: Worker): Promise<{ id: string; segments: string[] }[][]> {
  return (await apiCalls(serviceWorker)).map((call) => JSON.parse(JSON.parse(call.body).messages[0].content).groups);
}

function apiError(type: string) {
  return { type: "error", error: { type, message: "mocked" } };
}

test.describe("10.5 오류 테스트 (목 API, SPEC 4.3·5.4)", () => {
  const RATE_LIMITED = "요청 한도를 초과했습니다. 잠시 후 다시 시도하세요.";

  test("429: retry-after만큼 기다렸다 3번 다시 보내고, 끝내 실패하면 팝업과 알림에 원인을 보여 준다", async ({
    context,
    page,
    serviceWorker,
    extensionId,
  }) => {
    await mockTranslationApi(serviceWorker, {
      error: { status: 429, body: apiError("rate_limit_error"), headers: { "retry-after": "0" } },
    });

    const popup = await translateFromPopup(context, page, serviceWorker, extensionId);

    // 하나도 번역하지 못했으므로 일부 실패가 아니라 오류다 (SPEC 13장 "실패 원인 표시").
    await expect(popup.getByRole("status")).toHaveText(RATE_LIMITED);
    await expect(popup.getByRole("button", { name: "번역" })).toBeVisible();
    await expect(page.locator("aitranslator-toast").getByText(RATE_LIMITED)).toBeVisible();
    expect(await apiCalls(serviceWorker)).toHaveLength(4);
    await expect(page.locator("#start")).toHaveText("Get started");
  });

  test("429 뒤에 성공하면 그대로 번역한다", async ({ context, page, serviceWorker, extensionId }) => {
    await mockTranslationApi(serviceWorker, {
      error: { status: 429, body: apiError("rate_limit_error"), headers: { "retry-after": "0" }, times: 1 },
    });

    const popup = await translateFromPopup(context, page, serviceWorker, extensionId);

    await expect(popup.getByRole("status")).toHaveText("번역 완료");
    await expect(page.locator("#start")).toHaveText("GET STARTED");
    expect(await apiCalls(serviceWorker)).toHaveLength(2);
  });

  test("529: 1초·2초·4초 뒤 3번 다시 보내고, 끝내 실패하면 원인을 보여 준다", async ({
    context,
    page,
    serviceWorker,
    extensionId,
  }) => {
    await mockTranslationApi(serviceWorker, { error: { status: 529, body: apiError("overloaded_error") } });

    const popup = await translateFromPopup(context, page, serviceWorker, extensionId);

    await expect(popup.getByRole("status")).toHaveText("Anthropic 서버가 혼잡합니다. 잠시 후 다시 시도하세요.", {
      timeout: 15_000,
    });
    expect(await apiCalls(serviceWorker)).toHaveLength(4);
    await expect(page.locator("#start")).toHaveText("Get started");
  });

  test("잘못된 JSON: 그 배치를 한 번 더 보내고, 또 틀리면 원인을 보여 준다", async ({
    context,
    page,
    serviceWorker,
    extensionId,
  }) => {
    await mockTranslationApi(serviceWorker, { invalidJson: {} });

    const popup = await translateFromPopup(context, page, serviceWorker, extensionId);

    await expect(popup.getByRole("status")).toHaveText("번역 실패: 응답이 JSON 형식이 아닙니다.");
    expect(await apiCalls(serviceWorker)).toHaveLength(2);
    await expect(page.locator("#start")).toHaveText("Get started");
  });

  test("잘못된 JSON 뒤에 올바른 응답이 오면 그대로 번역한다", async ({ context, page, serviceWorker, extensionId }) => {
    await mockTranslationApi(serviceWorker, { invalidJson: { times: 1 } });

    const popup = await translateFromPopup(context, page, serviceWorker, extensionId);

    await expect(popup.getByRole("status")).toHaveText("번역 완료");
    await expect(page.locator("#start")).toHaveText("GET STARTED");
    expect(await apiCalls(serviceWorker)).toHaveLength(2);
  });

  test("세그먼트 개수 불일치: 그 그룹만 다시 보내고, 또 틀리면 그 그룹만 원문으로 두고 원인을 함께 알린다", async ({
    context,
    page,
    serviceWorker,
    extensionId,
  }) => {
    await mockTranslationApi(serviceWorker, { extraSegmentInFirstGroup: true });

    const popup = await translateFromPopup(context, page, serviceWorker, extensionId);

    await expect(popup.getByRole("status")).toHaveText("번역 완료");
    const cause = "번역 실패: 응답 형식이 맞지 않는 그룹이 있습니다.";
    await expect(popup.locator("#detail")).toContainText(PARTIAL);
    await expect(popup.locator("#detail")).toContainText(cause);
    const toast = page.locator("aitranslator-toast");
    await expect(toast.getByText(PARTIAL)).toBeVisible();
    await expect(toast.getByText(cause)).toBeVisible();

    const [first, retry] = await requestedGroups(serviceWorker);
    expect(retry).toEqual([first![0]]);
    expect(first!.length).toBeGreaterThan(1);
    // 첫 그룹(#signup)만 원문이고 나머지는 번역됐다.
    await expect(page.locator("#signup")).toHaveText("We'll email you a confirmation link to complete sign up.");
    await expect(page.locator("#start")).toHaveText("GET STARTED");
  });
});

test.describe("용어집 편집 (SPEC 4.10, 13장)", () => {
  test("고쳐 저장하면 다음 번역부터 그 용어집으로 요청하고, 바뀌기 전의 캐시 번역은 쓰지 않는다", async ({
    context,
    page,
    serviceWorker,
    extensionId,
  }) => {
    await mockTranslationApi(serviceWorker);
    await page.goto(SENTENCES);
    await injectContentScript(serviceWorker, SENTENCES);
    await expect(page.locator("#start")).toHaveText("GET STARTED");

    const options = await openOptions(context, extensionId);
    const keep = options.getByLabel("번역하지 않을 단어");
    await expect(keep).toHaveValue(/^LangChain\nLangGraph\n/);
    await keep.fill(`${await keep.inputValue()}\n\n  Mintlify  `);
    await options.getByLabel("지정 번역어").fill("agent = 에이전트");
    await options.getByRole("button", { name: "용어집 저장" }).click();

    await expect(options.getByText("용어집을 저장했습니다.")).toBeVisible();
    // 빈 줄과 앞뒤 공백을 정리해 다시 보여 준다.
    await expect(keep).toHaveValue(/\nSDK\nMintlify$/);
    expect((await readStorage(serviceWorker)).settings).toMatchObject({
      glossary: { map: { agent: "에이전트" }, version: 2 },
    });

    await page.reload();
    await injectContentScript(serviceWorker, SENTENCES);
    await expect(page.locator("#start")).toHaveText("GET STARTED");
    const calls = await apiCalls(serviceWorker);
    expect(calls).toHaveLength(2);
    const system = JSON.parse(calls[1]!.body).system[0].text as string;
    expect(system).toContain("Mintlify");
    expect(system).toContain("agent → 에이전트");
  });

  test("형식이 틀리면 저장하지 않고 안내한다", async ({ context, serviceWorker, extensionId }) => {
    const options = await openOptions(context, extensionId);
    const map = options.getByLabel("지정 번역어");
    const save = options.getByRole("button", { name: "용어집 저장" });

    await map.fill("agent = 에이전트\ntrace 트레이스");
    await save.click();
    await expect(options.getByText("2번째 줄에 '='가 없습니다.")).toBeVisible();

    await map.fill("agent = 에이전트\nagent = 요원");
    await save.click();
    await expect(options.getByText("'agent'의 번역어가 두 개 있습니다.")).toBeVisible();

    await map.fill("LangChain = 랭체인");
    await save.click();
    await expect(options.getByText("'LangChain'이(가) 두 목록에 모두 있습니다.")).toBeVisible();

    expect((await readStorage(serviceWorker)).settings).not.toHaveProperty("glossary");
  });
});

test("사용량: 번역하면 열어 둔 옵션 페이지의 이번 달 사용량이 바로 바뀐다 (SPEC 4.10, 13장)", async ({
  context,
  page,
  serviceWorker,
  extensionId,
}) => {
  await mockTranslationApi(serviceWorker, {
    usage: { input_tokens: 1200, cache_creation_input_tokens: 3000, cache_read_input_tokens: 0, output_tokens: 450 },
  });
  const options = await openOptions(context, extensionId);
  await expect(options.locator("#usage")).toHaveText("이번 달 사용량이 없습니다.");

  await page.goto(SENTENCES);
  await injectContentScript(serviceWorker, SENTENCES);
  await expect(page.locator("#start")).toHaveText("GET STARTED");

  await expect(options.locator("#usage")).toHaveText(
    "이번 달: 입력 1,200 · 캐시 쓰기 3,000 · 캐시 읽기 0 · 출력 450 토큰",
  );
});

test.describe("캐시 정리 (SPEC 13장)", () => {
  test("정리 기준: 바꾸면 바로 저장하고, 범위를 벗어나면 가까운 값으로 맞춘다", async ({
    context,
    serviceWorker,
    extensionId,
  }) => {
    const options = await openOptions(context, extensionId);
    const percent = options.locator("#cleanup-percent");
    const turns = options.locator("#idle-turns");
    await expect(options.getByText("캐시가")).toContainText("% 이상 차면");
    await expect(percent).toHaveValue("80");
    await expect(turns).toHaveValue("10");

    await percent.fill("150");
    await percent.press("Tab");
    await expect(percent).toHaveValue("100");
    await expect(options.getByText("정리 기준을 저장했습니다.")).toBeVisible();

    await turns.fill("0");
    await turns.press("Tab");
    await expect(turns).toHaveValue("1");
    await expect
      .poll(async () => (await readStorage(serviceWorker)).settings)
      .toMatchObject({ cacheCleanupPercent: 100, cacheIdleTurns: 1 });

    await options.reload();
    await expect(percent).toHaveValue("100");
    await expect(turns).toHaveValue("1");
  });

  test("저장소가 정리 기준만큼 차면 최근에 쓰이지 않은 번역문을 지운다 (실제 저장소)", async ({
    page,
    serviceWorker,
  }) => {
    await mockTranslationApi(serviceWorker);
    // 정리 기준을 낮추고(상한의 10% ≈ 0.8MB, 1턴), 아직 한 번도 쓰이지 않은 번역문을 약 1MB 넣어 둔다.
    await serviceWorker.evaluate(async () => {
      const stale: Record<string, unknown> = {};
      for (let i = 0; i < 1000; i++) stale[`t:stale${i}`] = { s: ["오래된 번역문".repeat(50)], u: 0 };
      await chrome.storage.local.set({
        ...stale,
        settings: { apiKeys: { anthropic: "sk-ant-e2e" }, cacheCleanupPercent: 10, cacheIdleTurns: 1 },
      });
    });

    await page.goto(SENTENCES);
    await injectContentScript(serviceWorker, SENTENCES);
    await expect(page.locator("#start")).toHaveText("GET STARTED");

    await expect
      .poll(async () => {
        const storage = await readStorage(serviceWorker);
        const keys = Object.keys(storage).filter((key) => key.startsWith("t:"));
        return {
          turn: storage.cacheTurn,
          stale: keys.filter((key) => key.startsWith("t:stale")).length,
          fresh: keys.filter((key) => !key.startsWith("t:stale")).length,
        };
      })
      .toEqual({ turn: 1, stale: 0, fresh: 5 });
  });
});
