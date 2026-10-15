import type { Page } from "@playwright/test";
import path from "node:path";
import { structureSnapshot, textSnapshot } from "../helpers/snapshot";
import { expect, test, TEST_EXTENSION_PATH } from "./fixtures";
import {
  apiAborted,
  apiCalls,
  injectContentScript,
  mockApi,
  mockTranslationApi,
  readStorage,
  storeApiKey,
} from "./sw-helpers";

// M3 완료 기준: 실제 페이지 번역, 10.4 픽스처 통과 (SPEC 11장)

const FIXTURE_ORIGIN = "http://aitranslator.test";
const FIXTURES_DIR = path.resolve(import.meta.dirname, "../fixtures");
const HANGUL = /\p{Script=Hangul}/u;

test.describe("옵션 페이지: 모델 선택 (SPEC 4.10, 7.2)", () => {
  test.beforeEach(async ({ page, extensionId }) => {
    await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  });

  test("모델 목록을 보여 주고, 기본값은 비용 우선 모델이다", async ({ page }) => {
    const select = page.getByLabel("모델", { exact: true });

    await expect(select.locator("option")).toHaveText([
      "Claude Haiku 5.5 — 비용 우선 (기본)",
      "Claude Sonnet 5.5 — 균형",
      "Claude Opus 5.5 — 품질 우선",
      "직접 입력",
    ]);
    await expect(select).toHaveValue("claude-haiku-5-5");
    await expect(page.getByLabel("모델 ID")).toBeHidden();
  });

  test("고른 (저장 전) 모델로 연결 테스트를 하고, 저장하면 키와 모델을 함께 저장한다", async ({
    page,
    serviceWorker,
  }) => {
    await mockApi(serviceWorker, 200, { type: "message", content: [] });
    await page.getByLabel("Anthropic API 키").fill("sk-ant-e2e-typed");
    await page.getByLabel("모델", { exact: true }).selectOption("claude-sonnet-5-5");

    await page.getByRole("button", { name: "연결 테스트" }).click();
    await expect(page.getByRole("status")).toHaveText("연결 성공 (claude-sonnet-5-5)");
    const [call] = await apiCalls(serviceWorker);
    expect(JSON.parse(call!.body).model).toBe("claude-sonnet-5-5");
    expect(await readStorage(serviceWorker)).toEqual({});

    await page.getByRole("button", { name: "저장" }).click();
    await expect(page.getByRole("status")).toHaveText("저장했습니다.");
    expect(await readStorage(serviceWorker)).toEqual({
      settings: { apiKeys: { anthropic: "sk-ant-e2e-typed" }, model: "claude-sonnet-5-5" },
    });
  });

  test("직접 입력: 빈 칸이면 안내하고, 입력한 모델 ID는 다시 열어도 남아 있다", async ({ page, serviceWorker }) => {
    await page.getByLabel("모델", { exact: true }).selectOption("custom");
    const customInput = page.getByLabel("모델 ID");
    await expect(customInput).toBeVisible();

    await page.getByRole("button", { name: "저장" }).click();
    await expect(page.getByRole("status")).toHaveText("모델 ID를 입력하세요.");
    expect(await readStorage(serviceWorker)).toEqual({});

    await customInput.fill("claude-custom-model");
    await page.getByRole("button", { name: "저장" }).click();
    await expect(page.getByRole("status")).toHaveText("저장했습니다.");
    await page.reload();
    await expect(page.getByLabel("모델", { exact: true })).toHaveValue("custom");
    await expect(customInput).toHaveValue("claude-custom-model");
  });
});

test.describe("페이지 번역 (테스트용 빌드)", () => {
  test.use({ extensionPath: TEST_EXTENSION_PATH });

  test.beforeEach(async ({ context }) => {
    // 픽스처를 실제 웹 주소처럼 응답한다. 테스트용 빌드에만 이 주소의 접근 권한이 있다.
    await context.route(`${FIXTURE_ORIGIN}/**`, (route) =>
      route.fulfill({ path: path.join(FIXTURES_DIR, new URL(route.request().url()).pathname) }),
    );
  });

  async function openFixture(page: Page, name: string) {
    await page.goto(`${FIXTURE_ORIGIN}/${name}`);
    return { structure: await page.evaluate(structureSnapshot), texts: await page.evaluate(textSnapshot) };
  }

  test("sentences.html: 콘텐츠 스크립트 → 백그라운드 → API(목)로 번역하고 구조는 그대로다 (10.1, 10.4)", async ({
    page,
    serviceWorker,
  }) => {
    await storeApiKey(serviceWorker, "sk-ant-e2e");
    await mockTranslationApi(serviceWorker);
    const before = await openFixture(page, "sentences.html");

    await injectContentScript(serviceWorker, `${FIXTURE_ORIGIN}/sentences.html`);

    await expect(page.locator("#start")).toHaveText("GET STARTED");
    await expect(page.locator("#signup")).toHaveText("WE'LL EMAIL YOU A CONFIRMATION LINK TO COMPLETE SIGN UP.");
    expect(await page.evaluate(structureSnapshot)).toBe(before.structure);
    await expect(page.locator("#korean")).toHaveText("이미 한국어로 쓰인 문장입니다.");
    await expect(page.locator("#code code")).toHaveText("dcode");
    await expect(page.locator("#url")).toHaveText("https://docs.langchain.com/llms.txt");

    const calls = await apiCalls(serviceWorker);
    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0]!.body);
    expect(body.model).toBe("claude-haiku-5-5");
    expect(body.output_config).toMatchObject({ effort: "medium", format: { type: "json_schema" } });
    expect(body.system[0]).toMatchObject({ cache_control: { type: "ephemeral" } });
    expect(body.system[0].text).toContain("LangChain");
    expect(JSON.stringify(body.messages)).not.toContain("sk-ant-e2e");
    expect(JSON.parse(body.messages[0].content).groups).toContainEqual({
      id: expect.stringMatching(/^g\d+$/),
      segments: ["Code with an AI agent in your terminal using the open source", "CLI."],
      context: "Code with an AI agent in your terminal using the open source dcode CLI.",
    });
  });

  test("layout.html: 번역해도 구조가 그대로이고 버튼이 동작한다", async ({ page, serviceWorker }) => {
    await storeApiKey(serviceWorker, "sk-ant-e2e");
    await mockTranslationApi(serviceWorker);
    const before = await openFixture(page, "layout.html");

    await injectContentScript(serviceWorker, `${FIXTURE_ORIGIN}/layout.html`);

    await expect(page.locator("footer p").last()).toContainText("QUESTIONS? EMAIL");
    await expect(page.locator("#title")).toHaveText("BUILD RELIABLE AGENTS");
    expect(await page.evaluate(structureSnapshot)).toBe(before.structure);
    await page.locator("#counter").click();
    await expect(page.locator("#count")).toHaveText("1");
  });

  test("다시 넣으면 이미 번역한 텍스트는 다시 요청하지 않고 새 텍스트만 요청한다", async ({ page, serviceWorker }) => {
    await storeApiKey(serviceWorker, "sk-ant-e2e");
    await mockTranslationApi(serviceWorker);
    await openFixture(page, "sentences.html");
    await injectContentScript(serviceWorker, `${FIXTURE_ORIGIN}/sentences.html`);
    await expect(page.locator("#start")).toHaveText("GET STARTED");

    await page.evaluate(() => document.body.insertAdjacentHTML("beforeend", '<p id="late">Added after translation</p>'));
    await injectContentScript(serviceWorker, `${FIXTURE_ORIGIN}/sentences.html`);

    await expect(page.locator("#late")).toHaveText("ADDED AFTER TRANSLATION");
    const calls = await apiCalls(serviceWorker);
    expect(calls).toHaveLength(2);
    const groups = JSON.parse(JSON.parse(calls[1]!.body).messages[0].content).groups as { segments: string[] }[];
    expect(groups.map((group) => group.segments)).toEqual([["Added after translation"]]);
  });

  test("키가 없으면 번역하지 않고 오류를 알린다", async ({ page, serviceWorker }) => {
    await mockTranslationApi(serviceWorker);
    const before = await openFixture(page, "sentences.html");
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });

    await injectContentScript(serviceWorker, `${FIXTURE_ORIGIN}/sentences.html`);

    await expect.poll(() => errors).toContainEqual(expect.stringContaining("API 키를 먼저 설정하세요"));
    await expect(page.locator("aitranslator-toast").getByText("API 키를 먼저 설정하세요")).toBeVisible();
    // 알림의 글자는 Shadow DOM 안에 있어 페이지 텍스트에 섞이지 않는다.
    expect(await page.evaluate(textSnapshot)).toEqual(before.texts);
    expect(await apiCalls(serviceWorker)).toHaveLength(0);
  });

  test("탭을 닫으면 진행 중인 요청을 취소한다 (5.4)", async ({ page, serviceWorker }) => {
    await storeApiKey(serviceWorker, "sk-ant-e2e");
    await mockTranslationApi(serviceWorker, { hang: true });
    await openFixture(page, "sentences.html");
    await injectContentScript(serviceWorker, `${FIXTURE_ORIGIN}/sentences.html`);
    await expect.poll(async () => (await apiCalls(serviceWorker)).length).toBe(1);

    await page.close();

    await expect.poll(() => apiAborted(serviceWorker)).toBe(true);
  });

  test.describe("실제 API (ANTHROPIC_API_KEY가 있을 때만)", () => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    test.skip(!apiKey, "ANTHROPIC_API_KEY 환경 변수가 없어 건너뜀");

    test("sentences.html: 10.4 픽스처를 실제로 번역한다", async ({ page, serviceWorker }) => {
      test.setTimeout(120_000);
      await storeApiKey(serviceWorker, apiKey!);
      const before = await openFixture(page, "sentences.html");
      const untouched = ["#korean", "#number", "#url", "#path", "#email"];
      const untouchedBefore = await Promise.all(untouched.map((id) => page.locator(id).textContent()));

      await injectContentScript(serviceWorker, `${FIXTURE_ORIGIN}/sentences.html`);

      for (const id of ["#signup", "#terms", "#code", "#names", "#start"]) {
        await expect(page.locator(id)).toHaveText(HANGUL, { timeout: 90_000 });
      }
      expect(await page.evaluate(structureSnapshot)).toBe(before.structure);
      await expect(page.locator("#code code")).toHaveText("dcode");
      for (const term of ["LangChain", "LangGraph", "Deep Agents"]) await expect(page.locator("#names")).toContainText(term);
      expect(await Promise.all(untouched.map((id) => page.locator(id).textContent()))).toEqual(untouchedBefore);

      const translated = await page.evaluate(() =>
        ["#signup", "#terms", "#code", "#names", "#start"].map((id) => document.querySelector(id)!.textContent!.trim()),
      );
      console.log(`실제 번역 결과:\n${translated.join("\n")}`);
    });

    test("실제 페이지(docs.langchain.com)를 번역한다", async ({ page, serviceWorker }) => {
      test.setTimeout(180_000);
      await storeApiKey(serviceWorker, apiKey!);
      await page.goto("https://docs.langchain.com/", { waitUntil: "load" });
      const errors: string[] = [];
      const warnings: string[] = [];
      page.on("console", (message) => {
        if (!message.text().includes("[AITranslator]")) return;
        if (message.type() === "error") errors.push(message.text());
        if (message.type() === "warning") warnings.push(message.text());
      });

      await injectContentScript(serviceWorker, "https://docs.langchain.com/*");

      await expect
        .poll(async () => ((await page.locator("body").innerText()).match(/\p{Script=Hangul}/gu) ?? []).length, {
          timeout: 150_000,
        })
        .toBeGreaterThan(100);
      expect(errors).toEqual([]);
      const headings = await page.locator("h1, h2").allInnerTexts();
      console.log(`실제 페이지 제목 일부:\n${headings.slice(0, 8).join("\n")}`);
      console.log(`원문으로 남은 그룹 경고: ${warnings.length === 0 ? "없음" : warnings.join(" / ")}`);
    });
  });
});
