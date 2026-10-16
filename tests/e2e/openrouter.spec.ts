import type { BrowserContext, Page } from "@playwright/test";
import path from "node:path";
import { expect, test, TEST_EXTENSION_PATH } from "./fixtures";
import { apiCalls, injectContentScript, mockOpenRouterApi, readStorage } from "./sw-helpers";

// 고도화: OpenRouter 제공업체 (SPEC 5.3.1, 13장 "OpenRouter …" 결정)

const FIXTURE_ORIGIN = "http://aitranslator.test";
const FIXTURES_DIR = path.resolve(import.meta.dirname, "../fixtures");
const SENTENCES = `${FIXTURE_ORIGIN}/sentences.html`;

test.use({ extensionPath: TEST_EXTENSION_PATH });

test.beforeEach(async ({ context }) => {
  await context.route(`${FIXTURE_ORIGIN}/**`, (route) =>
    route.fulfill({ path: path.join(FIXTURES_DIR, new URL(route.request().url()).pathname) }),
  );
});

async function openOptions(context: BrowserContext, extensionId: string): Promise<Page> {
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options/options.html`);
  return options;
}

test("옵션 페이지: 제공업체를 바꾸면 키·모델이 그 제공업체 것으로 바뀌고, 저장하면 제공업체마다 따로 남는다", async ({
  context,
  serviceWorker,
  extensionId,
}) => {
  await mockOpenRouterApi(serviceWorker);
  const options = await openOptions(context, extensionId);
  const provider = options.getByLabel("제공업체");
  const model = options.getByLabel("모델", { exact: true });
  await expect(provider).toHaveValue("anthropic");
  await options.getByText("고급 설정", { exact: true }).click();

  await options.getByLabel("Anthropic API 키").fill("sk-ant-e2e");
  await provider.selectOption({ label: "OpenRouter" });

  const key = options.getByLabel("OpenRouter API 키");
  await expect(key).toHaveValue("");
  await expect(key).toHaveAttribute("placeholder", "sk-or-...");
  await expect(model.locator("option")).toHaveText([
    "Claude Haiku 5.5 — 비용 우선 (기본)",
    "Claude Sonnet 5.5 — 균형",
    "Claude Opus 5.5 — 품질 우선",
    "직접 입력",
  ]);
  await key.fill("sk-or-e2e");
  await model.selectOption({ label: "직접 입력" });
  const custom = options.getByLabel("모델 ID");
  await expect(custom).toHaveAttribute("placeholder", "모델 ID (예: google/gemini-3.5-flash)");
  // 자동 완성: OpenRouter의 실제 모델 목록. 일괄 처리용(:batch)은 뺀다.
  const suggestions = options.locator("#custom-model-list option");
  await expect(suggestions).toHaveCount(4);
  await expect(options.locator('#custom-model-list option[value="deepseek/deepseek-chat"]')).toHaveCount(1);
  await custom.fill("deepseek/deepseek-chat");

  await options.getByRole("button", { name: "저장", exact: true }).click();

  await expect(options.getByRole("status")).toHaveText("저장했습니다.");
  expect((await readStorage(serviceWorker)).settings).toEqual({
    provider: "openrouter",
    apiKeys: { anthropic: "sk-ant-e2e", openrouter: "sk-or-e2e" },
    models: { openrouter: "deepseek/deepseek-chat" },
  });

  await options.reload();
  await expect(provider).toHaveValue("openrouter");
  await expect(options.getByLabel("OpenRouter API 키")).toHaveValue("sk-or-e2e");
  await expect(options.getByLabel("모델 ID")).toHaveValue("deepseek/deepseek-chat");
  await provider.selectOption({ label: "Anthropic" });
  await expect(options.getByLabel("Anthropic API 키")).toHaveValue("sk-ant-e2e");
  await expect(model).toHaveValue("claude-haiku-5-5");
});

test("연결 테스트: OpenRouter는 키 확인 주소와 모델 목록으로 확인하고, 번역 요청(토큰)은 보내지 않는다", async ({
  context,
  serviceWorker,
  extensionId,
}) => {
  await mockOpenRouterApi(serviceWorker);
  const options = await openOptions(context, extensionId);
  await options.getByLabel("제공업체").selectOption({ label: "OpenRouter" });
  await options.getByLabel("OpenRouter API 키").fill("sk-or-typed");

  await options.getByRole("button", { name: "연결 테스트" }).click();

  await expect(options.getByRole("status")).toHaveText("연결 성공 (anthropic/claude-haiku-5.5)");
  const urls = (await apiCalls(serviceWorker)).map((call) => call.url);
  expect(urls).toContain("https://openrouter.ai/api/v1/key");
  expect(urls).not.toContain("https://openrouter.ai/api/v1/chat/completions");

  await mockOpenRouterApi(serviceWorker, { keyStatus: 401 });
  await options.getByRole("button", { name: "연결 테스트" }).click();
  await expect(options.getByRole("status")).toHaveText("API 키를 확인하세요.");
});

test("OpenRouter로 번역한다: 요청 형식, 페이지 교체, 사용량", async ({ context, page, serviceWorker, extensionId }) => {
  await serviceWorker.evaluate(() =>
    chrome.storage.local.set({ settings: { provider: "openrouter", apiKeys: { openrouter: "sk-or-e2e" } } }),
  );
  await mockOpenRouterApi(serviceWorker, {
    usage: {
      prompt_tokens: 1_200,
      completion_tokens: 400,
      prompt_tokens_details: { cached_tokens: 800, cache_write_tokens: 100 },
    },
  });

  await page.goto(SENTENCES);
  await injectContentScript(serviceWorker, SENTENCES);

  await expect(page.locator("#start")).toHaveText("GET STARTED");
  const chat = (await apiCalls(serviceWorker)).find((call) => call.url.endsWith("/chat/completions"))!;
  expect(chat.headers).toEqual({ Authorization: "Bearer sk-or-e2e", "Content-Type": "application/json" });
  const body = JSON.parse(chat.body);
  expect(body).toMatchObject({
    model: "anthropic/claude-haiku-5.5",
    max_tokens: 32_000,
    response_format: { type: "json_schema" },
    reasoning: { effort: "medium" },
  });
  expect(body.messages[0].content[0].cache_control).toEqual({ type: "ephemeral" });

  const options = await openOptions(context, extensionId);
  await expect(options.locator("#usage")).toHaveText("이번 달: 입력 300 · 캐시 쓰기 100 · 캐시 읽기 800 · 출력 400 토큰");
});

test.describe("실제 API (OPENROUTER_API_KEY가 있을 때만)", () => {
  const apiKey = process.env.OPENROUTER_API_KEY;
  test.skip(!apiKey, "OPENROUTER_API_KEY 환경 변수가 없어 건너뜀");

  test("연결 테스트와 10.4 픽스처 번역 (Claude Haiku 5.5, OpenRouter 경유)", async ({
    context,
    page,
    serviceWorker,
    extensionId,
  }) => {
    test.setTimeout(180_000);
    const options = await openOptions(context, extensionId);
    await options.getByLabel("제공업체").selectOption({ label: "OpenRouter" });
    await options.getByLabel("OpenRouter API 키").fill(apiKey!);
    await options.getByRole("button", { name: "연결 테스트" }).click();
    await expect(options.getByRole("status")).toHaveText("연결 성공 (anthropic/claude-haiku-5.5)", { timeout: 30_000 });
    await options.getByRole("button", { name: "저장", exact: true }).click();
    await expect(options.getByRole("status")).toHaveText("저장했습니다.");

    await page.goto(SENTENCES);
    await injectContentScript(serviceWorker, SENTENCES);

    for (const id of ["#signup", "#terms", "#code", "#names", "#start"]) {
      await expect(page.locator(id)).toHaveText(/\p{Script=Hangul}/u, { timeout: 150_000 });
    }
    await expect(page.locator("#code code")).toHaveText("dcode");
    const usage = (await readStorage(serviceWorker)).usage as { outputTokens: number } | undefined;
    expect(usage?.outputTokens).toBeGreaterThan(0);
    console.log(`OpenRouter 사용량: ${JSON.stringify(usage)}`);
  });
});
