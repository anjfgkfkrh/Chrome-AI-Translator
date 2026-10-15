import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { structureSnapshot, textSnapshot } from "../helpers/snapshot";

// M2 완료 기준: 10.1 구조 불변, 10.2 원문 복원 (SPEC 11장). 실제 Chromium의 CSS로 확인한다.

let harness = "";

test.beforeAll(async () => {
  const result = await build({
    entryPoints: [path.resolve(import.meta.dirname, "harness.ts")],
    bundle: true,
    write: false,
    format: "iife",
    target: "es2022",
  });
  harness = result.outputFiles[0]!.text;
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ content: harness });
});

function fixtureUrl(name: string): string {
  return pathToFileURL(path.resolve(import.meta.dirname, "../fixtures", name)).href;
}

for (const fixture of ["sentences.html", "layout.html"]) {
  test(`${fixture}: 번역 전후 구조가 같고(10.1), 원문 보기 후 텍스트가 같다(10.2)`, async ({ page }) => {
    await page.goto(fixtureUrl(fixture));
    const structure = await page.evaluate(structureSnapshot);
    const texts = await page.evaluate(textSnapshot);

    await page.evaluate(() => window.__aitranslator.translate());
    expect(await page.evaluate(textSnapshot)).not.toEqual(texts);
    expect(await page.evaluate(structureSnapshot)).toBe(structure);

    await page.evaluate(() => window.__aitranslator.showOriginal());
    expect(await page.evaluate(textSnapshot)).toEqual(texts);
    expect(await page.evaluate(structureSnapshot)).toBe(structure);
  });
}

test("sentences.html: 10.4 문장을 문맥 단위로 묶고, 건너뛸 텍스트는 요청에서 뺀다", async ({ page }) => {
  await page.goto(fixtureUrl("sentences.html"));

  await page.evaluate(() => window.__aitranslator.translate());

  const requests = await page.evaluate(() => window.__aitranslator.requests);
  expect(requests.map((groups) => groups.map((group) => group.segments))).toEqual([
    [
      ["We'll", "email you a confirmation link", "to complete sign up."],
      ["By continuing, you agree to our", "Terms of Service", "and", "Privacy Policy"],
      ["Code with an AI agent in your terminal using the open source", "CLI."],
      ["Build agents with code using LangChain, LangGraph, and Deep Agents."],
      ["Get started"],
    ],
  ]);
  expect(await page.locator("#start").evaluate((el) => el.firstChild!.nodeValue)).toBe("  GET STARTED  ");
});

test("layout.html: 실제 CSS 기준으로 묶는다 (flex 메뉴의 링크는 따로, 문장 속 링크는 함께)", async ({ page }) => {
  await page.goto(fixtureUrl("layout.html"));

  await page.evaluate(() => window.__aitranslator.translate());

  const groups = (await page.evaluate(() => window.__aitranslator.requests)).flat().map((group) => group.segments);
  for (const expected of [
    ["Open source"],
    ["Platform"],
    ["Pricing"],
    ["Get started"],
    ["Python"],
    ["Search"],
    ["New"],
    ["LangGraph gives you", "low-level control", "over", "agent workflows", ", with built-in", "persistence", "Start in minutes."],
    ["but translate this part"],
    ["Run", "to start the server, then open"],
    ["Version", "released on October 15."],
    ["Questions? Email"],
  ]) {
    expect(groups).toContainEqual(expected);
  }

  const segments = groups.flat();
  for (const excluded of [
    "Logo",
    "⌘K",
    "Do not translate this paragraph,",
    "This stays in English",
    "even here",
    "pip install -U langgraph",
    "langgraph dev",
    "http://localhost:2024",
    "Free plan",
    "Leave a note",
    "Editable draft text",
    "v1.2.3",
    "한국어 문서도 있습니다.",
    "Inside frame",
    "Canvas fallback text",
    "Please enable JavaScript.",
    "Template text",
    "help@example.com",
  ]) {
    expect(segments).not.toContain(excluded);
  }
  expect(segments.some((segment) => segment.includes("getElementById"))).toBe(false);
});

test("layout.html: 번역 뒤에도 페이지 기능이 그대로 동작한다", async ({ page }) => {
  await page.goto(fixtureUrl("layout.html"));

  await page.evaluate(() => window.__aitranslator.translate());

  await expect(page.locator("#counter")).toHaveText("CLICK ME");
  await page.locator("#counter").click();
  await expect(page.locator("#count")).toHaveText("1");
  await page.locator(".banner-close").click();
  await expect(page.locator(".banner")).toBeHidden();
});
