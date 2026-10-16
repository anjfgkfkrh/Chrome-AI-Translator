import { expect, test } from "./fixtures";
import { apiCalls, mockApi, readStorage } from "./sw-helpers";

// M1 완료 기준: 확장 로드, 키 저장, 연결 테스트 성공 (SPEC 11장)

const MODEL = "claude-haiku-5-5";

test("설치하면 옵션 페이지가 새 탭으로 열린다", async ({ context, extensionId }) => {
  const optionsUrl = `chrome-extension://${extensionId}/options/options.html`;

  await expect.poll(() => context.pages().map((page) => page.url())).toContain(optionsUrl);
  const optionsPage = context.pages().find((page) => page.url() === optionsUrl)!;
  await expect(optionsPage.getByRole("heading", { name: "AITranslator 설정" })).toBeVisible();
});

test.describe("옵션 페이지", () => {
  test.beforeEach(async ({ page, extensionId }) => {
    await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  });

  test("API 키를 저장하면 다시 열어도 마스킹된 채로 남아 있다", async ({ page, serviceWorker }) => {
    const input = page.getByLabel("Anthropic API 키");
    await input.fill("  sk-ant-e2e-saved  ");
    await page.getByRole("button", { name: "저장", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("저장했습니다.");
    expect(await readStorage(serviceWorker)).toEqual({ settings: { apiKeys: { anthropic: "sk-ant-e2e-saved" } } });

    await page.reload();
    await expect(input).toHaveValue("sk-ant-e2e-saved");
    await expect(input).toHaveAttribute("type", "password");
    await page.getByRole("button", { name: "보기" }).click();
    await expect(input).toHaveAttribute("type", "text");
    await page.getByRole("button", { name: "숨기기" }).click();
    await expect(input).toHaveAttribute("type", "password");
  });

  test("빈 칸으로 저장하면 저장된 키가 지워진다", async ({ page, serviceWorker }) => {
    const input = page.getByLabel("Anthropic API 키");
    await input.fill("sk-ant-e2e-saved");
    await page.getByRole("button", { name: "저장", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("저장했습니다.");

    await input.fill("");
    await page.getByRole("button", { name: "저장", exact: true }).click();
    await expect.poll(() => readStorage(serviceWorker)).toEqual({ settings: { apiKeys: {} } });
  });

  test("빈 칸이면 연결 테스트 요청을 보내지 않는다", async ({ page, serviceWorker }) => {
    await mockApi(serviceWorker, 200, {});

    await page.getByRole("button", { name: "연결 테스트" }).click();

    await expect(page.getByRole("status")).toHaveText("API 키를 입력하세요.");
    expect(await apiCalls(serviceWorker)).toHaveLength(0);
  });

  test("연결 테스트: 입력한 키로 백그라운드가 API를 호출한다 (목 응답)", async ({ page, serviceWorker }) => {
    await mockApi(serviceWorker, 200, { type: "message", content: [] });

    await page.getByLabel("Anthropic API 키").fill("sk-ant-e2e-typed");
    await page.getByRole("button", { name: "연결 테스트" }).click();

    await expect(page.getByRole("status")).toHaveText(`연결 성공 (${MODEL})`);
    const calls = await apiCalls(serviceWorker);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: "https://api.anthropic.com/v1/messages",
      headers: {
        "x-api-key": "sk-ant-e2e-typed",
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
    });
    // 테스트만 하고 저장하지 않았으므로 저장소는 비어 있다.
    expect(await readStorage(serviceWorker)).toEqual({});
  });

  test("연결 테스트: 401이면 키를 확인하라고 안내한다 (목 응답)", async ({ page, serviceWorker }) => {
    await mockApi(serviceWorker, 401, {
      type: "error",
      error: { type: "authentication_error", message: "invalid x-api-key" },
    });

    await page.getByLabel("Anthropic API 키").fill("sk-ant-e2e-wrong");
    await page.getByRole("button", { name: "연결 테스트" }).click();

    await expect(page.getByRole("status")).toHaveText("API 키를 확인하세요.");
  });

  test("연결 테스트: 실제 API (ANTHROPIC_API_KEY가 있을 때만)", async ({ page }) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    test.skip(!apiKey, "ANTHROPIC_API_KEY 환경 변수가 없어 건너뜀");

    await page.getByLabel("Anthropic API 키").fill(apiKey!);
    await page.getByRole("button", { name: "연결 테스트" }).click();

    await expect(page.getByRole("status")).toHaveText(`연결 성공 (${MODEL})`, { timeout: 35_000 });
  });
});
