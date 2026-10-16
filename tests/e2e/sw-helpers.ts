import type { BrowserContext, Page, Worker } from "@playwright/test";
import type { UsageStats } from "../../src/shared/usage";
import { SAMPLE_MODELS } from "../helpers/openrouter-sample";

// 서비스 워커 안에서 실행하는 E2E 도우미. evaluate()에 넘기는 함수는 바깥 변수를 쓰지 않는다.

export interface ApiCall {
  url: string;
  headers: unknown;
  /** 요청 본문(JSON 문자열) */
  body: string;
}

export function readStorage(serviceWorker: Worker) {
  return serviceWorker.evaluate(() => chrome.storage.local.get(null));
}

/** 이번 달 사용량 (SPEC 4.10). 아직 없으면 undefined */
export async function readUsage(serviceWorker: Worker): Promise<UsageStats | undefined> {
  return (await readStorage(serviceWorker)).usage as UsageStats | undefined;
}

export async function storeApiKey(serviceWorker: Worker, apiKey: string): Promise<void> {
  await serviceWorker.evaluate((apiKey) => chrome.storage.local.set({ settings: { apiKeys: { anthropic: apiKey } } }), apiKey);
}

/** 서비스 워커의 fetch를 바꿔 고정 응답을 돌려주고, 보낸 요청을 기록한다. */
export async function mockApi(serviceWorker: Worker, status: number, body: unknown): Promise<void> {
  await serviceWorker.evaluate(
    ({ status, body }) => {
      const calls: ApiCall[] = [];
      Object.assign(globalThis, {
        __apiCalls: calls,
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          calls.push({ url: String(input), headers: init?.headers, body: String(init?.body) });
          return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
        },
      });
    },
    { status, body },
  );
}

export interface MockApiOptions {
  /** 응답하지 않고 기다리다가 요청이 취소되면 __apiAborted를 true로 바꾼다 */
  hang?: boolean;
  /** releaseApi()를 부를 때까지 응답을 미룬다 (진행률 확인용) */
  gated?: boolean;
  /** 네트워크 오류를 낸다 */
  networkError?: boolean;
  /** 이 상태 코드·본문·헤더로 응답한다. times를 주면 처음 그 횟수만 */
  error?: { status: number; body: unknown; headers?: Record<string, string>; times?: number };
  /** JSON이 아닌 번역문을 돌려준다. times를 주면 처음 그 횟수만 */
  invalidJson?: { times?: number };
  /** 요청마다 첫 그룹에 세그먼트를 하나 더 붙여 개수를 틀리게 돌려준다 */
  extraSegmentInFirstGroup?: boolean;
  /** 응답의 usage (기본: 입력 1, 출력 1) */
  usage?: Record<string, number>;
}

/**
 * 번역 요청의 세그먼트를 대문자로 돌려주는 목 API (Messages API 응답 형식).
 * 다시 부르면 동작만 바뀌고, 지금까지의 요청 기록(__apiCalls)은 이어진다.
 */
export async function mockTranslationApi(serviceWorker: Worker, options: MockApiOptions = {}): Promise<void> {
  await serviceWorker.evaluate(({ hang, gated, networkError, error, invalidJson, extraSegmentInFirstGroup, usage }) => {
    const scope = globalThis as unknown as { __apiCalls?: ApiCall[] };
    const calls = scope.__apiCalls ?? [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let errors = 0;
    let invalid = 0;
    const message = (text: string) =>
      new Response(
        JSON.stringify({
          type: "message",
          content: [{ type: "text", text }],
          stop_reason: "end_turn",
          usage: usage ?? { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    Object.assign(globalThis, {
      __apiCalls: calls,
      __apiAborted: false,
      __releaseApi: release,
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), headers: init?.headers, body: String(init?.body) });
        if (networkError) throw new TypeError("Failed to fetch");
        if (error && (error.times === undefined || errors < error.times)) {
          errors++;
          return new Response(JSON.stringify(error.body), {
            status: error.status,
            headers: { "content-type": "application/json", ...error.headers },
          });
        }
        if (invalidJson && (invalidJson.times === undefined || invalid < invalidJson.times)) {
          invalid++;
          return message("이건 JSON이 아닙니다");
        }
        if (gated) await gate;
        if (hang) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              Object.assign(globalThis, { __apiAborted: true });
              reject(init.signal!.reason);
            });
          });
        }
        const request = JSON.parse(String(init?.body));
        const { groups } = JSON.parse(request.messages[0].content) as {
          groups: { id: string; segments: string[] }[];
        };
        const translated = groups.map((group, i) => ({
          id: group.id,
          segments: [
            ...group.segments.map((segment) => segment.toUpperCase()),
            ...(extraSegmentInFirstGroup && i === 0 ? ["EXTRA"] : []),
          ],
        }));
        return message(JSON.stringify({ groups: translated }));
      },
    });
  }, options);
}

/** gated 목 API의 미뤄 둔 응답을 보낸다. */
export async function releaseApi(serviceWorker: Worker): Promise<void> {
  await serviceWorker.evaluate(() => (globalThis as unknown as { __releaseApi: () => void }).__releaseApi());
}

export function apiCalls(serviceWorker: Worker) {
  return serviceWorker.evaluate(() => (globalThis as unknown as { __apiCalls: ApiCall[] }).__apiCalls);
}

export function apiAborted(serviceWorker: Worker) {
  return serviceWorker.evaluate(() => (globalThis as unknown as { __apiAborted: boolean }).__apiAborted);
}

/** 우클릭 메뉴가 하는 일(콘텐츠 스크립트 넣기)을 그대로 한다. 테스트용 빌드에서만 권한이 있다. */
export async function injectContentScript(serviceWorker: Worker, urlPattern: string): Promise<void> {
  await serviceWorker.evaluate(async (urlPattern) => {
    const [tab] = await chrome.tabs.query({ url: urlPattern });
    if (tab?.id === undefined) throw new Error(`탭을 찾지 못했습니다: ${urlPattern}`);
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
  }, urlPattern);
}

export function tabIdOf(serviceWorker: Worker, urlPattern: string): Promise<number> {
  return serviceWorker.evaluate(async (urlPattern) => {
    const [tab] = await chrome.tabs.query({ url: urlPattern });
    if (tab?.id === undefined) throw new Error(`탭을 찾지 못했습니다: ${urlPattern}`);
    return tab.id;
  }, urlPattern);
}

/**
 * 팝업을 별도 창으로 연다. 같은 창의 탭으로 열면 대상 탭이 가려져 requestAnimationFrame이 멈추기 때문이다.
 * 대상 탭은 ?tabId=로 알려 준다.
 */
export async function openPopup(
  context: BrowserContext,
  serviceWorker: Worker,
  extensionId: string,
  tabId: number,
): Promise<Page> {
  const url = `chrome-extension://${extensionId}/popup/popup.html?tabId=${tabId}`;
  await serviceWorker.evaluate((url) => chrome.windows.create({ url, type: "popup", width: 320, height: 240 }), url);
  // 다른 탭의 page 이벤트와 섞이지 않도록 주소로 찾는다.
  for (let tries = 0; tries < 100; tries++) {
    const popup = context.pages().find((page) => page.url() === url);
    if (popup) {
      await popup.waitForLoadState();
      return popup;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("팝업 창이 열리지 않았습니다.");
}

/** 설치 때 열린 옵션 페이지를 닫는다. openOptionsPage()가 새 탭을 여는지 확인하려면 먼저 닫아야 한다. */
export async function closeOptionsPages(context: BrowserContext): Promise<void> {
  for (const page of context.pages()) if (page.url().endsWith("/options/options.html")) await page.close();
}

export interface MockOpenRouterOptions {
  /** 키 확인 주소의 상태 코드 (기본 200) */
  keyStatus?: number;
  /** 번역 응답의 usage */
  usage?: Record<string, unknown>;
}

/**
 * OpenRouter API를 흉내 낸다: 모델 목록, 키 확인, 번역(세그먼트를 대문자로). 보낸 요청은 __apiCalls에 남긴다.
 * 모델 목록은 tests/helpers/openrouter-sample.ts의 예시다.
 */
export async function mockOpenRouterApi(serviceWorker: Worker, options: MockOpenRouterOptions = {}): Promise<void> {
  await serviceWorker.evaluate(
    ({ keyStatus, usage, models }) => {
      const scope = globalThis as unknown as { __apiCalls?: ApiCall[] };
      const calls = scope.__apiCalls ?? [];
      const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      Object.assign(globalThis, {
        __apiCalls: calls,
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          calls.push({ url, headers: init?.headers, body: String(init?.body) });
          if (url === "https://openrouter.ai/api/v1/models") return json(200, models);
          if (url === "https://openrouter.ai/api/v1/key") {
            return keyStatus === 200
              ? json(200, { data: { label: "e2e" } })
              : json(keyStatus, { error: { code: keyStatus, message: "User not found." } });
          }
          if (url === "https://openrouter.ai/api/v1/chat/completions") {
            const request = JSON.parse(String(init?.body));
            const { groups } = JSON.parse(request.messages[1].content) as { groups: { id: string; segments: string[] }[] };
            const translated = groups.map((group) => ({
              id: group.id,
              segments: group.segments.map((segment) => segment.toUpperCase()),
            }));
            return json(200, {
              id: "gen-e2e",
              choices: [
                { message: { role: "assistant", content: JSON.stringify({ groups: translated }) }, finish_reason: "stop" },
              ],
              usage: usage ?? { prompt_tokens: 1, completion_tokens: 1 },
            });
          }
          return json(404, { error: { code: 404, message: `unexpected ${url}` } });
        },
      });
    },
    { keyStatus: options.keyStatus ?? 200, usage: options.usage, models: SAMPLE_MODELS },
  );
}
