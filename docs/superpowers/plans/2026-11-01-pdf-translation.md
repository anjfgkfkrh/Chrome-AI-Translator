# PDF 번역 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 크롬에서 연 PDF에서 번역을 누르면 같은 탭이 확장의 pdf.js 뷰어로 바뀌고, 문단이 원래 자리에서 한국어로 보이게 한다.

**Architecture:** 뷰어는 PDF를 pdf.js로 그리고, 텍스트 항목을 문단으로 복원해 페이지 위의 번역층에 원문 `<p>`로 둔다. 기존 `TranslationController`가 번역층을 웹 페이지처럼 수집·교체하고, 번역층은 텍스트가 원문과 달라진 문단만 보여 준다. 번역 파이프라인은 복제하지 않는다.

**Tech Stack:** TypeScript, esbuild, `pdfjs-dist` 6.4.299, Vitest(jsdom), Playwright

**Spec:** `docs/superpowers/specs/2026-11-01-pdf-translation-design.md`. 결정 기록은 `SPEC.md` 13장의 "PDF" 항목이다.

> **이 계획서의 코드는 그대로 옮겨 쓴다.** 저장소 사본에서 이 코드로 `npm run typecheck`, 단위 테스트 432개, E2E 75개(실제 API 테스트 4개 건너뜀)가 통과했고, `파일 내용`과 `diff`는 그 파일에서 자동으로 생성했다. 사용자 요청에 따라 구현자가 설계를 판단하지 않아도 되도록 본문 전체를 담았다. 코드를 더 낫게 고치거나 줄이지 않는다.

## Global Constraints

- 설계서에 없는 동작이 필요하면 임의로 정하지 말고 멈춰서 `SPEC.md` 12.1절 형식으로 보고한다.
- `pdfjs-dist`는 정확히 `6.4.299`로 고정한다 (`^` 없음).
- 작업 브랜치는 `pdf-translation`이다. 작업 단위로 커밋하고 **push하지 않는다.** `main`이나 `mvp`에 합치지 않는다.
- 커밋 작성자는 `git -c user.name="dlawhdgur01" -c user.email="dlawhdgur01@gmail.com" commit`이다. 커밋 메시지는 저장소처럼 한국어 한 줄이며, 끝의 저작 표시 줄은 실행 세션의 안내를 따른다.
- `claude_api_key.txt`, `openrouter_api_key.txt`를 읽거나 출력하거나 커밋하지 않는다. 이 계획의 시험에는 실제 API 키가 필요 없다.
- `manifest.json`의 권한은 바꾸지 않는다 (`version`만 0.2.0).
- `src/popup/`, `src/options/`, 번역·캐시·제공업체 코드는 바꾸지 않는다.
- 문단 텍스트는 텍스트 노드로만 넣는다. `innerHTML`을 쓰지 않는다.

## Review Focus

각 줄의 테스트는 해당 작업에 들어 있다.

1. **쪽이 회전한 PDF(`/Rotate`):** 글자가 뷰포트 좌표의 가로 글자로 읽혀야 한다 → 작업 3 `쪽이 90도 회전한 PDF도…`
2. **확대·축소로 같은 쪽이 다시 그려질 때:** 번역층이 늘지 않고 다시 번역하지 않아야 한다 → 작업 6 E2E `5: 확대해도…`
3. **쿼리, 해시, 한글이 든 PDF 주소:** 원본 주소를 잃지 않아야 한다 → 작업 2 `viewerUrl`, 작업 4 `fileNameOf`, 작업 6 E2E `1·13`
4. **`.pdf` 주소가 로그인 HTML을 돌려줄 때:** 열기 실패 문구와 원본 링크가 보여야 한다 → 작업 6 E2E `추가: PDF가 아닌 응답이면…`
5. **원문 보기 중 스크롤:** 그려진 쪽을 번역하지 않고, 번역을 누르면 그 쪽까지 번역해야 한다 → 작업 6 E2E `추가: 원문 보기 중에…`

---

### 작업 1: 브랜치와 pdf.js 의존성

**Files:**
- Modify: `package.json`, `package-lock.json`
- Commit: `SPEC.md`, `docs/superpowers/specs/2026-11-01-pdf-translation-design.md`, `docs/superpowers/plans/2026-11-01-pdf-translation.md`

**Interfaces:**
- Produces: `pdfjs-dist` 6.4.299 (`dependencies`), 브랜치 `pdf-translation`

- [ ] **Step 1: 시작 상태 확인**

Run: `git status --short && git branch --show-current`
Expected: 현재 브랜치 `mvp`. 변경은 `SPEC.md`와 `docs/superpowers/`뿐이다. 다른 변경이 있으면 멈추고 보고한다.

- [ ] **Step 2: 브랜치 생성**

Run: `git switch -c pdf-translation`
Expected: `Switched to a new branch 'pdf-translation'`

- [ ] **Step 3: 의존성 설치**

`~/.npm` 권한 문제를 피하려고 임시 캐시를 쓴다.

Run: `npm install -E pdfjs-dist@6.4.299 --ignore-scripts --no-audit --no-fund --cache "$(mktemp -d)"`
Expected: 설치 성공. `package.json`의 `dependencies`에 `"pdfjs-dist": "6.4.299"`.

- [ ] **Step 4: 버전을 0.2.0으로 변경**

`package.json`과 `manifest.json`의 `"version": "0.1.0"`을 `"version": "0.2.0"`으로 바꾼다.

Run: `npm install --package-lock-only --ignore-scripts --no-audit --no-fund --cache "$(mktemp -d)"`
Expected: `package-lock.json`의 루트 버전이 0.2.0.

- [ ] **Step 5: 기존 테스트 기준선 확인**

Run: `npm test`
Expected: 모두 통과. 실패하면 멈추고 보고한다.

- [ ] **Step 6: 커밋**

```bash
git add SPEC.md docs/superpowers package.json package-lock.json manifest.json
git -c user.name="dlawhdgur01" -c user.email="dlawhdgur01@gmail.com" commit -m "PDF 번역 설계와 pdf.js 의존성 추가"
```

---

### 작업 2: PDF 탭을 뷰어로 옮기기

**Files:**
- Create: `src/shared/pdf.ts`, `src/content/commands.ts`
- Modify: `src/content/index.ts`, `src/background/index.ts`
- Test: `tests/unit/pdf-url.test.ts`, `tests/unit/background.test.ts`, `tests/unit/chrome-mock.ts`

**Interfaces:**
- Produces:
  - `viewerUrl(source: string): string`, `isViewerUrl(url: string | undefined): boolean`, `isLocalPdfUrl(url: string | undefined): boolean`
  - `interface CommandTarget { state(): PageState; translate(): unknown; retranslate(): Promise<void>; showOriginal(): Promise<void> }`
  - `listenForCommands(target: CommandTarget): void`

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/unit/pdf-url.test.ts`를 만든다.

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isLocalPdfUrl, isViewerUrl, viewerUrl } from "../../src/shared/pdf";

beforeEach(() => {
  vi.stubGlobal("chrome", { runtime: { getURL: (path: string) => `chrome-extension://id/${path}` } });
});

describe("viewerUrl", () => {
  it("원본 주소의 쿼리·해시·한글을 잃지 않게 인코딩한다", () => {
    const source = "https://example.com/논문.pdf?token=a&b=1#page=3";
    const url = new URL(viewerUrl(source));

    expect(url.href.split("?")[0]).toBe("chrome-extension://id/pdf/viewer.html");
    expect(url.searchParams.get("file")).toBe(source);
    expect(url.hash).toBe("");
  });
});

describe("isViewerUrl", () => {
  it("뷰어 주소만 true", () => {
    expect(isViewerUrl("chrome-extension://id/pdf/viewer.html?file=x")).toBe(true);
    expect(isViewerUrl("chrome-extension://id/popup/popup.html")).toBe(false);
    expect(isViewerUrl("https://example.com/pdf/viewer.html")).toBe(false);
    expect(isViewerUrl(undefined)).toBe(false);
  });
});

describe("isLocalPdfUrl", () => {
  it("file:// 주소의 .pdf만 true (대소문자 무시, 쿼리·해시 제외)", () => {
    expect(isLocalPdfUrl("file:///Users/me/a.pdf")).toBe(true);
    expect(isLocalPdfUrl("file:///Users/me/a.PDF#page=2")).toBe(true);
    expect(isLocalPdfUrl("file:///Users/me/a.txt")).toBe(false);
    expect(isLocalPdfUrl("https://example.com/a.pdf")).toBe(false);
    expect(isLocalPdfUrl("not a url")).toBe(false);
    expect(isLocalPdfUrl(undefined)).toBe(false);
  });
});
```

`tests/unit/chrome-mock.ts`와 `tests/unit/background.test.ts`를 다음과 같이 바꾼다. 기존 `번역: 스크립트를 넣을 수 없으면…` 테스트가 `mockRejectedValue`로 바뀌는 이유는 `executeScript`를 이제 PDF 판별에도 부르기 때문이다.

```diff
--- a/tests/unit/chrome-mock.ts
+++ b/tests/unit/chrome-mock.ts
@@ -28,6 +28,7 @@ export function installChromeMock() {
     throw new Error("Could not establish connection. Receiving end does not exist.");
   });
   const getTab = vi.fn(async (tabId: number) => ({ id: tabId, url: "https://example.com/docs" }) as chrome.tabs.Tab);
+  const updateTab = vi.fn(async () => ({}) as chrome.tabs.Tab);
   /** 지금 보고 있는 탭 (팝업의 대상) */
   const queryTabs = vi.fn(async (_query: chrome.tabs.QueryInfo) => [{ id: 7 } as chrome.tabs.Tab]);
   const createTab = vi.fn(async () => ({}));
@@ -128,7 +129,7 @@ export function installChromeMock() {
       getAll: getCommands,
       onCommand: { addListener: (fn: Listener) => onCommand.push(fn) },
     },
-    tabs: { sendMessage: tabsSendMessage, get: getTab, create: createTab, query: queryTabs },
+    tabs: { sendMessage: tabsSendMessage, get: getTab, update: updateTab, create: createTab, query: queryTabs },
     scripting: {
       executeScript,
       registerContentScripts,
@@ -156,6 +157,7 @@ export function installChromeMock() {
     executeScript,
     tabsSendMessage,
     getTab,
+    updateTab,
     queryTabs,
     createTab,
     getCommands,
```

```diff
--- a/tests/unit/background.test.ts
+++ b/tests/unit/background.test.ts
@@ -313,12 +313,67 @@ describe("팝업 메시지", () => {
 
   it("번역: 스크립트를 넣을 수 없으면 번역할 수 없음을 돌려준다", async () => {
     saveKey();
-    chromeMock.executeScript.mockRejectedValueOnce(new Error("Cannot access contents of the page"));
+    chromeMock.executeScript.mockRejectedValue(new Error("Cannot access contents of the page"));
     vi.spyOn(console, "warn").mockImplementation(() => {});
 
     expect(await ask({ type: "tab-action", tabId: 7, action: "translate" })).toEqual({ status: "unsupported" });
   });
 
+  describe("PDF (SPEC 13장 \"PDF 번역\")", () => {
+    const pdfUrl = "https://example.com/paper.pdf#page=3";
+    const viewer = () => chrome.runtime.getURL("pdf/viewer.html");
+    const opening = { status: "translating", progress: { done: 0, total: 0 }, partial: false };
+
+    it("번역: 내장 뷰어로 열린 PDF면 같은 탭을 뷰어로 바꾸고 번역 스크립트를 넣지 않는다", async () => {
+      saveKey();
+      chromeMock.getTab.mockResolvedValue({ id: 7, url: pdfUrl } as chrome.tabs.Tab);
+      chromeMock.executeScript.mockResolvedValueOnce([{ result: "application/pdf" }] as never);
+
+      expect(await ask({ type: "tab-action", tabId: 7, action: "translate" })).toEqual(opening);
+      expect(chromeMock.updateTab).toHaveBeenCalledWith(7, { url: `${viewer()}?file=${encodeURIComponent(pdfUrl)}` });
+      expect(chromeMock.executeScript).not.toHaveBeenCalledWith({ target: { tabId: 7 }, files: ["content.js"] });
+    });
+
+    it("번역: 주소가 .pdf로 끝나도 문서가 PDF가 아니면 뷰어로 옮기지 않는다", async () => {
+      saveKey();
+      chromeMock.getTab.mockResolvedValue({ id: 7, url: "https://example.com/paper.pdf" } as chrome.tabs.Tab);
+      chromeMock.executeScript.mockResolvedValueOnce([{ result: "text/html" }] as never);
+
+      await ask({ type: "tab-action", tabId: 7, action: "translate" });
+
+      expect(chromeMock.updateTab).not.toHaveBeenCalled();
+      expect(chromeMock.executeScript).toHaveBeenCalledWith({ target: { tabId: 7 }, files: ["content.js"] });
+    });
+
+    it("번역: 스크립트를 넣을 수 없는 file:// PDF는 주소로 판단해 뷰어로 옮긴다", async () => {
+      saveKey();
+      chromeMock.getTab.mockResolvedValue({ id: 7, url: "file:///Users/me/a.PDF" } as chrome.tabs.Tab);
+      chromeMock.executeScript.mockRejectedValue(new Error("Cannot access contents of the page"));
+
+      expect(await ask({ type: "tab-action", tabId: 7, action: "translate" })).toEqual(opening);
+      expect(chromeMock.updateTab).toHaveBeenCalledTimes(1);
+    });
+
+    it("키가 없으면 PDF도 옵션 페이지를 연다", async () => {
+      chromeMock.getTab.mockResolvedValue({ id: 7, url: pdfUrl } as chrome.tabs.Tab);
+
+      await ask({ type: "tab-action", tabId: 7, action: "translate" });
+
+      expect(chromeMock.openOptionsPage).toHaveBeenCalled();
+      expect(chromeMock.updateTab).not.toHaveBeenCalled();
+    });
+
+    it("탭 상태·번역: 뷰어가 응답하기 전이면 여는 중이고 다시 옮기지 않는다", async () => {
+      saveKey();
+      chromeMock.getTab.mockResolvedValue({ id: 7, url: `${viewer()}?file=x` } as chrome.tabs.Tab);
+
+      expect(await ask({ type: "get-tab-state", tabId: 7 })).toEqual(opening);
+      expect(await ask({ type: "tab-action", tabId: 7, action: "translate" })).toEqual(opening);
+      expect(chromeMock.updateTab).not.toHaveBeenCalled();
+      expect(chromeMock.executeScript).not.toHaveBeenCalled();
+    });
+  });
+
   it("원문 보기: 콘텐츠 스크립트에 전달한다", async () => {
     chromeMock.tabsSendMessage.mockResolvedValue({ ...translatedState, status: "original" });
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run tests/unit/pdf-url.test.ts tests/unit/background.test.ts`
Expected: FAIL. `pdf-url.test.ts`는 `../../src/shared/pdf`를 찾지 못하고, `PDF (SPEC 13장…)` 테스트가 실패한다.

- [ ] **Step 3: `src/shared/pdf.ts` 작성**

```ts
// PDF 뷰어 주소 (SPEC 13장 "PDF 번역"). 백그라운드와 뷰어가 함께 쓴다.

const VIEWER_PATH = "pdf/viewer.html";

/** 원본 PDF 주소를 뷰어 주소로 바꾼다. 해시(#page=N)도 file 값 안에 그대로 넣는다. */
export function viewerUrl(source: string): string {
  return `${chrome.runtime.getURL(VIEWER_PATH)}?file=${encodeURIComponent(source)}`;
}

/** 이 확장의 PDF 뷰어 주소인지 */
export function isViewerUrl(url: string | undefined): boolean {
  return url?.startsWith(chrome.runtime.getURL(VIEWER_PATH)) === true;
}

/** file:// 주소이면서 경로가 .pdf로 끝나는지 (대소문자 무시, 쿼리·해시 제외) */
export function isLocalPdfUrl(url: string | undefined): boolean {
  if (url === undefined) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "file:" && parsed.pathname.toLowerCase().endsWith(".pdf");
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: `src/content/commands.ts` 작성**

`src/content/index.ts`의 `listen()`을 일반화해 옮긴 파일이다.

```ts
import type { ContentCommand, PageState } from "../shared/messages";

/** 팝업·단축키의 명령을 받는 쪽. TranslationController와 PDF 뷰어가 구현한다. */
export interface CommandTarget {
  state(): PageState;
  translate(): unknown;
  retranslate(): Promise<void>;
  showOriginal(): Promise<void>;
}

/** 백그라운드의 명령 (팝업·단축키). 응답은 언제나 그 시점의 페이지 상태다. */
export function listenForCommands(target: CommandTarget): void {
  chrome.runtime.onMessage.addListener((message: ContentCommand, _sender, sendResponse: (state: PageState) => void) => {
    switch (message?.type) {
      case "get-state":
        sendResponse(target.state());
        return false;
      case "translate":
        void target.translate();
        sendResponse(target.state());
        return false;
      case "retranslate":
        void target.retranslate().then(() => sendResponse(target.state()));
        return true; // 비동기로 응답한다
      case "show-original":
        void target.showOriginal().then(() => sendResponse(target.state()));
        return true; // 비동기로 응답한다
    }
    return false;
  });
}
```

- [ ] **Step 5: `src/content/index.ts` 변경**

```diff
--- a/src/content/index.ts
+++ b/src/content/index.ts
@@ -1,4 +1,4 @@
-import type { ContentCommand, PageState } from "../shared/messages";
+import { listenForCommands } from "./commands";
 import { TranslationController } from "./controller";
 
 // 콘텐츠 스크립트 진입점. 번역을 시작할 때(우클릭 메뉴, 팝업, 단축키) 백그라운드가 이 파일을 넣고,
@@ -12,36 +12,15 @@ declare global {
   var __aitranslatorAutoRun: boolean | undefined;
 }
 
-if (document.body) {
+// PDF 문서는 뷰어로 옮겨 번역한다. 내장 뷰어의 내용은 읽을 수 없으므로 여기서는 아무것도 하지 않는다 (SPEC 13장).
+if (document.body && document.contentType !== "application/pdf") {
   const auto = globalThis.__aitranslatorAutoRun === true;
   globalThis.__aitranslatorAutoRun = undefined; // 다음에 직접 넣을 때 섞이지 않도록 한 번 읽고 지운다
   let controller = globalThis.__aitranslatorController;
   if (!controller) {
     controller = globalThis.__aitranslatorController = new TranslationController(document.body);
-    listen(controller);
+    listenForCommands(controller);
   }
   // 이 파일을 넣는 것은 번역을 시작할 때뿐이다.
   void controller.translate({ auto });
 }
-
-/** 백그라운드의 명령 (팝업·단축키). 응답은 언제나 그 시점의 페이지 상태다. */
-function listen(controller: TranslationController): void {
-  chrome.runtime.onMessage.addListener((message: ContentCommand, _sender, sendResponse: (state: PageState) => void) => {
-    switch (message?.type) {
-      case "get-state":
-        sendResponse(controller.state());
-        return false;
-      case "translate":
-        void controller.translate();
-        sendResponse(controller.state());
-        return false;
-      case "retranslate":
-        void controller.retranslate().then(() => sendResponse(controller.state()));
-        return true; // 비동기로 응답한다
-      case "show-original":
-        void controller.showOriginal().then(() => sendResponse(controller.state()));
-        return true; // 비동기로 응답한다
-    }
-    return false;
-  });
-}
```

- [ ] **Step 6: `src/background/index.ts` 변경**

```diff
--- a/src/background/index.ts
+++ b/src/background/index.ts
@@ -13,6 +13,7 @@ import {
 } from "../shared/messages";
 import { isProviderId, providerInfo, type ProviderId } from "../shared/models";
 import { openRouterModelIds } from "../shared/openrouter-models";
+import { isLocalPdfUrl, isViewerUrl, viewerUrl } from "../shared/pdf";
 import { originPattern } from "../shared/sites";
 import { activeApiKey, getSettings } from "../shared/storage";
 import { clearTranslationLog } from "../shared/translation-log";
@@ -47,6 +48,8 @@ const MENU_ID = "translate-page";
 /** manifest.json의 commands 이름 */
 const TOGGLE_COMMAND = "toggle-translation";
 const IDLE_STATE: PageState = { status: "idle", progress: { done: 0, total: 0 }, partial: false };
+/** PDF 뷰어를 여는 중. 뷰어가 응답하기 전까지 팝업에 "번역" 버튼 대신 진행 상태를 보여 준다. */
+const PDF_OPENING_STATE: PageState = { status: "translating", progress: { done: 0, total: 0 }, partial: false };
 
 chrome.runtime.onInstalled.addListener((details) => {
   void createContextMenu();
@@ -161,6 +164,12 @@ async function translateTab(tabId: number): Promise<TabState> {
   // 이미 넣은 콘텐츠 스크립트가 있으면 그쪽에 맡기고, 없으면 넣는다. 넣으면 바로 번역을 시작한다.
   const state = await sendToTab(tabId, { type: "translate" });
   if (state) return state;
+  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
+  if (isViewerUrl(tab?.url)) return PDF_OPENING_STATE; // 뷰어가 아직 뜨는 중
+  if (tab?.url !== undefined && (await isPdfTab(tabId, tab.url))) {
+    await chrome.tabs.update(tabId, { url: viewerUrl(tab.url) });
+    return PDF_OPENING_STATE;
+  }
   try {
     // 메뉴·팝업·단축키를 쓴 탭에는 activeTab 권한이 생긴다.
     await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
@@ -171,6 +180,16 @@ async function translateTab(tabId: number): Promise<TabState> {
   return tabState(tabId);
 }
 
+/** 내장 PDF 뷰어로 열린 탭인지. file://은 파일 접근 설정이 꺼져 있으면 스크립트를 넣을 수 없어 주소로 판단한다. */
+async function isPdfTab(tabId: number, url: string): Promise<boolean> {
+  try {
+    const [result] = await chrome.scripting.executeScript({ target: { tabId }, func: () => document.contentType });
+    return result?.result === "application/pdf";
+  } catch {
+    return isLocalPdfUrl(url);
+  }
+}
+
 function tabAction(tabId: number, action: TabAction): Promise<TabState> {
   if (action === "retranslate") return retranslateTab(tabId);
   return action === "translate" ? translateTab(tabId) : showOriginal(tabId);
@@ -204,6 +223,7 @@ async function tabState(tabId: number): Promise<TabState> {
   const state = await sendToTab(tabId, { type: "get-state" });
   if (state) return state;
   const tab = await chrome.tabs.get(tabId).catch(() => undefined);
+  if (isViewerUrl(tab?.url)) return PDF_OPENING_STATE;
   return tab && !canInject(tab.url) ? { status: "unsupported" } : IDLE_STATE;
 }
```

- [ ] **Step 7: 통과 확인**

Run: `npx tsc --noEmit && npx vitest run tests/unit/pdf-url.test.ts tests/unit/background.test.ts tests/unit/controller.test.ts`
Expected: 타입 오류 없음, 모두 PASS

- [ ] **Step 8: 커밋**

```bash
git add src/shared/pdf.ts src/content/commands.ts src/content/index.ts src/background/index.ts tests/unit/pdf-url.test.ts tests/unit/background.test.ts tests/unit/chrome-mock.ts
git -c user.name="dlawhdgur01" -c user.email="dlawhdgur01@gmail.com" commit -m "PDF 탭에서 번역하면 뷰어로 옮기기"
```

---

### 작업 3: 텍스트 항목을 문단으로 복원

**Files:**
- Create: `src/pdf/layout.ts`
- Test: `tests/unit/pdf-layout.test.ts`

**Interfaces:**
- Produces:
  - `interface TextItemLike { str: string; transform: number[]; width: number; height: number }`
  - `interface Block { text; left; right; top; bottom; size; centered; lines; wideLines }`
  - `interface ReferencesStart { pageNumber: number; headingIndex: number }`
  - `pageBlocks(items, viewportTransform, pageWidth): Block[]`
  - `isReferencesHeading(text: string): boolean`
  - `skipReason(block: Block): SkipReason | undefined`
  - `translatableBlocks(blocks, pageNumber, references): Block[]`

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
import { describe, expect, it } from "vitest";
import { isReferencesHeading, pageBlocks, skipReason, translatableBlocks, type Block, type TextItemLike } from "../../src/pdf/layout";

// US Letter 쪽의 getViewport({ scale: 1 }).transform (원점이 왼쪽 아래 → 왼쪽 위)
const VIEW = [1, 0, 0, -1, 0, 792];
const PAGE_WIDTH = 612;

/** PDF 좌표 x, y(아래에서 위로)에 놓인 항목. 폭은 글자 수 × 크기 × 0.5로 잡는다. */
function item(str: string, x: number, y: number, size = 10): TextItemLike {
  return { str, transform: [size, 0, 0, size, x, y], width: str.length * size * 0.5, height: size };
}

function blocks(items: TextItemLike[]): Block[] {
  return pageBlocks(items, VIEW, PAGE_WIDTH);
}

const texts = (items: TextItemLike[]) => blocks(items).map((block) => block.text);

describe("pageBlocks", () => {
  it("같은 줄의 조각을 잇고, 간격이 있으면 공백을 넣는다", () => {
    expect(texts([item("Hello", 72, 700), item("world", 102, 700), item("!", 127, 700)])).toEqual(["Hello world!"]);
  });

  it("공백뿐인 항목은 버리고 위첨자는 같은 줄로 본다", () => {
    const [block] = blocks([item("Area in mm", 72, 700), item("3", 122.5, 703, 6), item("   ", 126, 700)]);

    expect(block?.text).toBe("Area in mm3");
    expect(block?.size).toBe(10);
  });

  it("다음 줄을 이어 문단을 만들고 줄 끝 하이픈을 지운다", () => {
    const lines = [item("The quick brown fox jumps over the lazy dog and exam-", 72, 700), item("ines the fence near the barn today.", 72, 688)];

    expect(texts(lines)).toEqual(["The quick brown fox jumps over the lazy dog and examines the fence near the barn today."]);
  });

  it("대문자가 뒤따르는 하이픈은 지우지 않고 공백으로 잇는다", () => {
    const lines = [item("This is the long-standing and well known Tendon-", 72, 700), item("Based design of the older robot hands.", 72, 688)];

    expect(texts(lines)).toEqual(["This is the long-standing and well known Tendon- Based design of the older robot hands."]);
  });

  it("문단 영역은 위쪽 0.85, 아래쪽 0.27 글자 크기까지이고 뷰포트 좌표다", () => {
    const [block] = blocks([item("Hello brave new world", 72, 700)]);

    expect(block?.left).toBe(72);
    expect(block?.top).toBeCloseTo(792 - 700 - 8.5);
    expect(block?.bottom).toBeCloseTo(792 - 700 + 2.7);
  });

  it("들여쓴 줄에서 새 문단을 시작한다", () => {
    const lines = [
      item("First paragraph line one goes on for a while here.", 72, 700),
      item("First paragraph line two goes on for a while here.", 72, 688),
      item("Second paragraph starts indented and goes on here.", 82, 676),
    ];

    expect(blocks(lines)).toHaveLength(2);
  });

  it("첫 줄만 들여쓴 문단은 한 문단이다", () => {
    const lines = [
      item("Indented first line goes on for a while here too.", 82, 700),
      item("Second line starts at the margin and goes on here.", 72, 688),
    ];

    expect(blocks(lines)).toHaveLength(1);
  });

  it("짧은 줄 뒤에서 문단을 나눈다", () => {
    const lines = [
      item("First paragraph line one goes on for a while here.", 72, 700),
      item("First paragraph line two goes on for a while here.", 72, 688),
      item("Short end.", 72, 676),
      item("Second paragraph starts at the margin and continues.", 72, 664),
    ];

    expect(blocks(lines)).toHaveLength(2);
  });

  it("왼쪽 단 끝과 오른쪽 단 시작을 잇지 않는다", () => {
    const lines = [item("Left column last line of the text goes here.", 72, 100), item("Right column first line of the text goes on.", 320, 700)];

    expect(blocks(lines)).toHaveLength(2);
  });

  it("글자 크기가 다르면 다른 문단이다", () => {
    expect(blocks([item("A Heading Line", 72, 700, 14), item("Body text under the heading goes here.", 72, 684)])).toHaveLength(2);
  });

  it("가운데 정렬 제목의 줄을 잇고 centered로 표시한다", () => {
    const [block, ...rest] = blocks([
      item("LEAP Hand: Low-Cost, Efficient, and Anthropomorphic Hand for", 96, 700, 14),
      item("Robot Learning", 257, 684, 14),
    ]);

    expect(rest).toEqual([]);
    expect(block?.text).toBe("LEAP Hand: Low-Cost, Efficient, and Anthropomorphic Hand for Robot Learning");
    expect(block?.centered).toBe(true);
  });

  it("쪽 가운데의 한 줄 문단은 centered다", () => {
    expect(blocks([item("Centered Title Text", 258.5, 700)])[0]?.centered).toBe(true);
    expect(blocks([item("Left Title Text", 72, 700)])[0]?.centered).toBe(false);
  });

  it("세로·회전 글자는 버린다", () => {
    const rotated: TextItemLike = { str: "arXiv:1706.03762v7", transform: [0, 10, -10, 0, 30, 300], width: 90, height: 10 };

    expect(texts([rotated, item("Body text here.", 72, 700)])).toEqual(["Body text here."]);
  });

  it("쪽이 90도 회전한 PDF도 뷰포트 좌표의 가로 글자로 읽는다", () => {
    // /Rotate 90인 쪽: 글자는 PDF 좌표에서 세로이고 뷰포트 변환을 거치면 가로가 된다.
    const rotatedView = [0, 1, 1, 0, 0, 0];
    const rotatedItem: TextItemLike = { str: "Rotated page body text.", transform: [0, 10, -10, 0, 700, 72], width: 115, height: 10 };

    const [block] = pageBlocks([rotatedItem], rotatedView, 792);

    expect(block?.text).toBe("Rotated page body text.");
    expect(block?.left).toBe(72);
  });

  it("위아래 문단의 영역이 겹치면 가운데를 경계로 삼는다", () => {
    const [upper, lower] = blocks([item("Upper block text goes here now.", 72, 700), item("Indented lower block text here.", 90, 690)]);

    expect(upper?.bottom).toBe(lower?.top);
    expect(upper?.bottom).toBeGreaterThan(92);
  });
});

function block(text: string, overrides: Partial<Block> = {}): Block {
  return { text, left: 0, right: 100, top: 0, bottom: 10, size: 10, centered: false, lines: 1, wideLines: 0, ...overrides };
}

describe("skipReason", () => {
  it("글자가 없으면 no-letters", () => {
    expect(skipReason(block("12 34 %"))).toBe("no-letters");
  });

  it("넓은 간격이 있는 줄이 절반 이상이면 table", () => {
    expect(skipReason(block("Allegro Hand Linear Angular", { lines: 3, wideLines: 2 }))).toBe("table");
    expect(skipReason(block("Allegro Hand Linear Angular", { lines: 3, wideLines: 1 }))).toBeUndefined();
  });

  it("글자 비율이 절반 미만이면 math", () => {
    expect(skipReason(block("x = 1 + 2 * (3 / 4) - 5"))).toBe("math");
  });

  it("단어가 3개 미만인 라벨은 short", () => {
    expect(skipReason(block("Allegro Failure"))).toBe("short");
    expect(skipReason(block("Up Down"))).toBe("short");
  });

  it("제목 번호, 대문자로 시작하는 한 단어, 대문자 제목은 짧아도 번역한다", () => {
    expect(skipReason(block("B. Robustness"))).toBeUndefined();
    expect(skipReason(block("I. INTRODUCTION"))).toBeUndefined();
    expect(skipReason(block("2.1 Encoder"))).toBeUndefined();
    expect(skipReason(block("Abstract"))).toBeUndefined();
    expect(skipReason(block("RELATED WORK"))).toBeUndefined();
  });

  it("본문은 번역한다", () => {
    expect(skipReason(block("Fig. 1: The hand is shown here."))).toBeUndefined();
  });
});

describe("isReferencesHeading", () => {
  it("참고문헌 제목을 찾는다", () => {
    for (const text of ["References", "REFERENCES", " Bibliography ", "VIII. REFERENCES", "7 References", "7. References"]) {
      expect(isReferencesHeading(text)).toBe(true);
    }
    expect(isReferencesHeading("See the references below for details.")).toBe(false);
  });
});

describe("translatableBlocks", () => {
  const page = [block("Body one goes here."), block("x = 1 + 2 * (3 / 4) - 5"), block("References"), block("Smith et al. wrote this.")];

  it("참고문헌이 없으면 건너뛸 문단만 뺀다", () => {
    expect(translatableBlocks(page, 3, undefined).map((item) => item.text)).toEqual([
      "Body one goes here.",
      "References",
      "Smith et al. wrote this.",
    ]);
  });

  it("제목이 있는 쪽은 제목 앞까지, 뒤의 쪽은 모두 뺀다", () => {
    const references = { pageNumber: 3, headingIndex: 2 };

    expect(translatableBlocks(page, 2, references)).toHaveLength(3);
    expect(translatableBlocks(page, 3, references).map((item) => item.text)).toEqual(["Body one goes here."]);
    expect(translatableBlocks(page, 4, references)).toEqual([]);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run tests/unit/pdf-layout.test.ts`
Expected: FAIL. `../../src/pdf/layout`을 찾지 못한다.

- [ ] **Step 3: `src/pdf/layout.ts` 작성**

수치는 실제 논문 3편으로 맞춘 값이다. 바꾸지 않는다.

```ts
// PDF 텍스트 항목 → 줄 → 문단 (SPEC 13장 "PDF 번역", 설계서 9절). 이 모듈은 DOM을 쓰지 않는다.
// 좌표는 모두 page.getViewport({ scale: 1 }) 기준의 포인트이고 원점은 왼쪽 위다.

/** 이 배수를 넘는 가로 간격은 표의 칸 사이로 본다 (글자 크기 기준). 아래 수치도 모두 글자 크기 기준 배수다. */
const WIDE_GAP = 2;
const SAME_LINE_Y = 0.6;
const WORD_GAP = 0.12;
const ASCENT = 0.85;
const DESCENT = 0.27;
const LINE_GAP_MIN = 0.4;
const LINE_GAP_MAX = 1.7;
const LEFT_TOLERANCE = 2.5;
const INDENT = 0.7;
const SHORT_LINE = 3;
/** 같은 문단으로 보는 글자 크기 차이 (포인트) */
const SIZE_TOLERANCE = 0.6;
/** 두 줄의 가로 겹침이 짧은 줄 폭의 이 비율을 넘어야 같은 문단이다. */
const MIN_OVERLAP = 0.3;
/** 가운데 정렬로 보는 폭 비율 */
const CENTERED_WIDTH = 0.8;
/** 한 줄 문단의 중심이 쪽 중심에서 쪽 폭의 이 비율 안에 있으면 가운데 정렬로 본다. */
const PAGE_CENTER = 0.01;
const PAGE_WIDE = 0.9;
/** 표로 보는 줄 비율, 수식으로 보는 글자 비율 */
const TABLE_RATIO = 0.5;
const LETTER_RATIO = 0.5;
const MIN_WORDS = 3;

const LETTER = /\p{L}/gu;
const WORD = /\p{L}{2,}/u;
const NUMBERED_HEADING = /^(?:[IVX]+\.|[A-Z]\.|\d+(?:\.\d+)*\.?)\s+\S/;
const SINGLE_WORD = /^[A-Z][a-z]+$/;
const UPPERCASE_TITLE = /^[A-Z ]+$/;
const REFERENCES = /^(?:[IVX]+\.?\s+|\d+\.?\s+)?(?:references|bibliography)$/i;

export interface TextItemLike {
  str: string;
  transform: number[];
  width: number;
  height: number;
}

export interface Block {
  text: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** 본문 글자 크기 (포인트) */
  size: number;
  centered: boolean;
  lines: number;
  /** 넓은 간격이 있는 줄 수 */
  wideLines: number;
}

/** 참고문헌 제목의 위치. 그 뒤로는 번역하지 않는다. */
export interface ReferencesStart {
  pageNumber: number;
  headingIndex: number;
}

export type SkipReason = "no-letters" | "table" | "math" | "short";

interface Run {
  text: string;
  x: number;
  y: number;
  width: number;
  size: number;
}

interface Line {
  text: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
  y: number;
  size: number;
  /** 줄의 크기와 y를 정한 조각의 길이 */
  mainLength: number;
  wideGaps: number;
}

/** 한 쪽의 텍스트 항목을 문단으로 묶는다. viewportTransform은 getViewport({ scale: 1 }).transform이다. */
export function pageBlocks(items: readonly TextItemLike[], viewportTransform: readonly number[], pageWidth: number): Block[] {
  return finishBlocks(toBlocks(toLines(toRuns(items, viewportTransform))), pageWidth);
}

/** 항목을 뷰포트 좌표로 바꾼다. 공백뿐인 항목과 세로·회전 글자는 버린다. */
function toRuns(items: readonly TextItemLike[], view: readonly number[]): Run[] {
  const [v0, v1, v2, v3, v4, v5] = view as [number, number, number, number, number, number];
  const runs: Run[] = [];
  for (const item of items) {
    if (item.str.trim() === "") continue;
    const [m0, m1, m2, m3, m4, m5] = item.transform as [number, number, number, number, number, number];
    const a = v0 * m0 + v2 * m1;
    const b = v1 * m0 + v3 * m1;
    const c = v0 * m2 + v2 * m3;
    const d = v1 * m2 + v3 * m3;
    if (Math.abs(b) > 0.01 || Math.abs(c) > 0.01 || a <= 0) continue;
    const size = Math.hypot(c, d) || item.height;
    if (size === 0) continue;
    runs.push({ text: item.str, x: v0 * m4 + v2 * m5 + v4, y: v1 * m4 + v3 * m5 + v5, width: item.width, size });
  }
  return runs;
}

function toLines(runs: readonly Run[]): Line[] {
  const lines: Line[] = [];
  let line: Line | undefined;
  for (const run of runs) {
    const size = line ? Math.max(run.size, line.size) : 0;
    if (line && Math.abs(run.y - line.y) < SAME_LINE_Y * size && run.x >= line.right - size) {
      const gap = run.x - line.right;
      if (gap > WIDE_GAP * size) line.wideGaps++;
      if (gap > WORD_GAP * size && !line.text.endsWith(" ") && !run.text.startsWith(" ")) line.text += " ";
      line.text += run.text;
      line.right = Math.max(line.right, run.x + run.width);
      line.top = Math.min(line.top, run.y - ASCENT * run.size);
      line.bottom = Math.max(line.bottom, run.y + DESCENT * run.size);
      // 위첨자가 줄의 기준이 되지 않도록 가장 긴 조각을 기준으로 삼는다.
      if (run.text.length > line.mainLength) {
        line.mainLength = run.text.length;
        line.size = run.size;
        line.y = run.y;
      }
    } else {
      line = {
        text: run.text,
        left: run.x,
        right: run.x + run.width,
        top: run.y - ASCENT * run.size,
        bottom: run.y + DESCENT * run.size,
        y: run.y,
        size: run.size,
        mainLength: run.text.length,
        wideGaps: 0,
      };
      lines.push(line);
    }
  }
  return lines;
}

function joinLines(text: string, next: string): string {
  const head = text.trimEnd();
  const tail = next.trimStart();
  return /[a-z]-$/.test(head) && /^[a-z]/.test(tail) ? head.slice(0, -1) + tail : `${head} ${tail}`;
}

function toBlocks(lines: readonly Line[]): Block[] {
  const blocks: Block[] = [];
  let block: Block | undefined;
  let previous: Line | undefined;
  for (const line of lines) {
    const centered = block && previous ? isCentered(line, previous, Math.max(line.size, previous.size)) : false;
    if (block && previous && continues(block, previous, line, centered)) {
      block.text = joinLines(block.text, line.text);
      block.left = Math.min(block.left, line.left);
      block.right = Math.max(block.right, line.right);
      block.top = Math.min(block.top, line.top);
      block.bottom = Math.max(block.bottom, line.bottom);
      block.lines++;
      if (line.wideGaps > 0) block.wideLines++;
      if (centered) block.centered = true;
    } else {
      block = {
        text: line.text,
        left: line.left,
        right: line.right,
        top: line.top,
        bottom: line.bottom,
        size: line.size,
        centered: false,
        lines: 1,
        wideLines: line.wideGaps > 0 ? 1 : 0,
      };
      blocks.push(block);
    }
    previous = line;
  }
  return blocks;
}

function isCentered(line: Line, previous: Line, size: number): boolean {
  const width = line.right - line.left;
  const previousWidth = previous.right - previous.left;
  const offset = Math.abs(line.left + line.right - previous.left - previous.right) / 2;
  return offset <= size && (width < CENTERED_WIDTH * previousWidth || previousWidth < CENTERED_WIDTH * width);
}

function continues(block: Block, previous: Line, line: Line, centered: boolean): boolean {
  const size = Math.max(line.size, previous.size);
  const gap = line.y - previous.y;
  const shorter = Math.min(previous.right - previous.left, line.right - line.left);
  const overlap = Math.min(previous.right, line.right) - Math.max(previous.left, line.left);
  if (Math.abs(line.size - block.size) > SIZE_TOLERANCE) return false;
  if (gap <= LINE_GAP_MIN * size || gap >= LINE_GAP_MAX * size) return false;
  if (overlap <= MIN_OVERLAP * shorter) return false;
  if (centered) return true;
  if (Math.abs(line.left - block.left) > LEFT_TOLERANCE * size) return false;
  if (line.left > block.left + INDENT * size) return false; // 들여쓴 줄은 새 문단이다
  return !(block.lines >= 2 && previous.right < block.right - SHORT_LINE * size); // 짧은 줄은 문단의 끝이다
}

function finishBlocks(blocks: Block[], pageWidth: number): Block[] {
  for (const block of blocks) {
    const center = (block.left + block.right) / 2;
    const narrow = block.right - block.left < PAGE_WIDE * pageWidth;
    if (block.lines === 1 && narrow && Math.abs(center - pageWidth / 2) <= PAGE_CENTER * pageWidth) block.centered = true;
  }
  // 위아래 문단의 영역이 겹치면 번역문이 다음 문단의 배경에 가려진다. 겹친 영역의 가운데를 경계로 삼는다.
  for (const [i, upper] of blocks.entries()) {
    for (const lower of blocks.slice(i + 1)) {
      const overlapsX = Math.min(upper.right, lower.right) > Math.max(upper.left, lower.left);
      if (overlapsX && lower.top < upper.bottom && lower.top > upper.top) {
        const middle = (lower.top + upper.bottom) / 2;
        upper.bottom = middle;
        lower.top = middle;
      }
    }
  }
  return blocks;
}

export function isReferencesHeading(text: string): boolean {
  return REFERENCES.test(text.trim());
}

/** 번역하지 않을 문단의 사유. 번역할 문단이면 undefined */
export function skipReason(block: Block): SkipReason | undefined {
  const text = block.text.trim();
  const letters = text.match(LETTER)?.length ?? 0;
  if (letters === 0) return "no-letters";
  if (block.wideLines / block.lines >= TABLE_RATIO) return "table";
  if (letters / text.length < LETTER_RATIO) return "math";
  const words = text.split(/\s+/).filter((word) => WORD.test(word)).length;
  if (words >= MIN_WORDS) return undefined;
  return NUMBERED_HEADING.test(text) || SINGLE_WORD.test(text) || UPPERCASE_TITLE.test(text) ? undefined : "short";
}

/** 번역층에 넣을 문단을 고른다. 참고문헌 제목과 그 뒤는 뺀다. */
export function translatableBlocks(
  blocks: readonly Block[],
  pageNumber: number,
  references: ReferencesStart | undefined,
): Block[] {
  if (references && pageNumber > references.pageNumber) return [];
  const end = references?.pageNumber === pageNumber ? references.headingIndex : blocks.length;
  return blocks.slice(0, end).filter((block) => skipReason(block) === undefined);
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx tsc --noEmit && npx vitest run tests/unit/pdf-layout.test.ts`
Expected: 타입 오류 없음, 모두 PASS

- [ ] **Step 5: 커밋**

```bash
git add src/pdf/layout.ts tests/unit/pdf-layout.test.ts
git -c user.name="dlawhdgur01" -c user.email="dlawhdgur01@gmail.com" commit -m "PDF 텍스트를 문단으로 복원"
```

---

### 작업 4: PDF 주소와 내려받기

**Files:**
- Create: `src/pdf/source.ts`
- Test: `tests/unit/pdf-source.test.ts`

**Interfaces:**
- Produces:
  - `class PdfDownloadError extends Error`
  - `sourceUrl(search: string): string | undefined`
  - `fileNameOf(url: string | null): string`
  - `pageFromHash(url: string | undefined, pagesCount: number): number | undefined`
  - `downloadPdf(url: string): Promise<ArrayBuffer>`

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
import { describe, expect, it, vi } from "vitest";
import { downloadPdf, fileNameOf, pageFromHash, PdfDownloadError, sourceUrl } from "../../src/pdf/source";

describe("sourceUrl", () => {
  it("http·https 주소만 돌려준다", () => {
    const search = (file: string) => `?file=${encodeURIComponent(file)}`;

    expect(sourceUrl(search("https://example.com/a.pdf?x=1#page=2"))).toBe("https://example.com/a.pdf?x=1#page=2");
    expect(sourceUrl(search("http://example.com/a.pdf"))).toBe("http://example.com/a.pdf");
    expect(sourceUrl(search("file:///a.pdf"))).toBeUndefined();
    expect(sourceUrl(search("javascript:alert(1)"))).toBeUndefined();
    expect(sourceUrl(search("not a url"))).toBeUndefined();
    expect(sourceUrl("")).toBeUndefined();
  });
});

describe("fileNameOf", () => {
  it("마지막 경로 조각을 디코딩하고 쿼리·해시를 뺀다", () => {
    expect(fileNameOf("https://example.com/rss19/p089.pdf?a=1#page=2")).toBe("p089.pdf");
    expect(fileNameOf("https://example.com/%EB%85%BC%EB%AC%B8.pdf")).toBe("논문.pdf");
    expect(fileNameOf("file:///Users/me/a.pdf")).toBe("a.pdf");
  });

  it("디코딩할 수 없으면 조각 그대로, 비어 있으면 PDF", () => {
    expect(fileNameOf("https://example.com/100%.pdf")).toBe("100%.pdf");
    expect(fileNameOf("https://example.com/")).toBe("PDF");
    expect(fileNameOf(null)).toBe("PDF");
  });
});

describe("pageFromHash", () => {
  it("#page=N을 읽고 범위 밖이면 undefined", () => {
    expect(pageFromHash("https://example.com/a.pdf#page=3", 11)).toBe(3);
    expect(pageFromHash("https://example.com/a.pdf#zoom=100&page=3", 11)).toBe(3);
    expect(pageFromHash("https://example.com/a.pdf#page=12", 11)).toBeUndefined();
    expect(pageFromHash("https://example.com/a.pdf#page=0", 11)).toBeUndefined();
    expect(pageFromHash("https://example.com/a.pdf?page=3", 11)).toBeUndefined();
    expect(pageFromHash(undefined, 11)).toBeUndefined();
  });
});

describe("downloadPdf", () => {
  it("쿠키를 함께 보내고 내용을 돌려준다", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
    vi.stubGlobal("fetch", fetchMock);

    expect((await downloadPdf("https://example.com/a.pdf")).byteLength).toBe(3);
    expect(fetchMock).toHaveBeenCalledWith("https://example.com/a.pdf", { credentials: "include" });
  });

  it("실패하면 화면에 보여 줄 문구로 던진다", async () => {
    vi.stubGlobal("fetch", async () => new Response("", { status: 404 }));
    await expect(downloadPdf("https://example.com/a.pdf")).rejects.toThrow(new PdfDownloadError("PDF를 받지 못했습니다. (HTTP 404)"));

    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(downloadPdf("https://example.com/a.pdf")).rejects.toThrow(
      new PdfDownloadError("PDF를 받지 못했습니다. 네트워크 연결을 확인하세요."),
    );
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run tests/unit/pdf-source.test.ts`
Expected: FAIL. `../../src/pdf/source`를 찾지 못한다.

- [ ] **Step 3: `src/pdf/source.ts` 작성**

```ts
// 뷰어가 열 PDF의 주소와 내려받기 (SPEC 13장 "PDF 번역"). pdf.js를 쓰지 않는다.

const FETCH_FAILED = "PDF를 받지 못했습니다. 네트워크 연결을 확인하세요.";

/** 내려받기 실패. message는 화면에 보여 줄 문구다. */
export class PdfDownloadError extends Error {}

/** 뷰어 주소의 file 값. 내려받을 수 있는 http·https 주소가 아니면 undefined */
export function sourceUrl(search: string): string | undefined {
  const file = new URLSearchParams(search).get("file");
  if (file === null) return undefined;
  try {
    return ["http:", "https:"].includes(new URL(file).protocol) ? file : undefined;
  } catch {
    return undefined;
  }
}

/** 탭 제목에 쓸 파일명: 주소의 마지막 경로 조각. 없으면 "PDF" */
export function fileNameOf(url: string | null): string {
  const piece = url?.split(/[?#]/)[0]?.split("/").pop() ?? "";
  if (piece === "") return "PDF";
  try {
    return decodeURIComponent(piece);
  } catch {
    return piece;
  }
}

/** 주소의 #page=N. 1 이상 pagesCount 이하가 아니면 undefined */
export function pageFromHash(url: string | undefined, pagesCount: number): number | undefined {
  const hash = url?.split("#")[1] ?? "";
  const page = Number(/(?:^|&)page=(\d+)/.exec(hash)?.[1]);
  return page >= 1 && page <= pagesCount ? page : undefined;
}

/** PDF를 내려받는다. 로그인이 필요한 PDF도 받도록 쿠키를 함께 보낸다. */
export async function downloadPdf(url: string): Promise<ArrayBuffer> {
  let response: Response;
  try {
    response = await fetch(url, { credentials: "include" });
  } catch {
    throw new PdfDownloadError(FETCH_FAILED);
  }
  if (!response.ok) throw new PdfDownloadError(`PDF를 받지 못했습니다. (HTTP ${response.status})`);
  try {
    return await response.arrayBuffer();
  } catch {
    throw new PdfDownloadError(FETCH_FAILED);
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx tsc --noEmit && npx vitest run tests/unit/pdf-source.test.ts`
Expected: 타입 오류 없음, 모두 PASS

- [ ] **Step 5: 커밋**

```bash
git add src/pdf/source.ts tests/unit/pdf-source.test.ts
git -c user.name="dlawhdgur01" -c user.email="dlawhdgur01@gmail.com" commit -m "PDF 주소 해석과 내려받기"
```

---

### 작업 5: 번역층

**Files:**
- Create: `src/pdf/overlay.ts`
- Test: `tests/unit/pdf-overlay.test.ts`

**Interfaces:**
- Consumes: `Block` (작업 3)
- Produces:
  - `interface PageLookup { readonly currentScale: number; getPageView(index: number): { div: HTMLElement } }`
  - `class PdfOverlay { constructor(root, container, pages, viewer: PageLookup); addPage(pageNumber, blocks, viewport, canvas): void; place(): void }`

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Block } from "../../src/pdf/layout";
import { PdfOverlay, type PageLookup } from "../../src/pdf/overlay";

const BLOCK: Block = { text: "Original text.", left: 72, right: 300, top: 100, bottom: 112, size: 10, centered: false, lines: 1, wideLines: 0 };
const VIEWPORT = { width: 612, height: 792 };

function setup() {
  document.body.innerHTML = '<div id="container"><div id="pages"></div><div id="overlays"></div></div>';
  const root = document.querySelector<HTMLElement>("#overlays")!;
  const pageDiv = document.createElement("div");
  const viewer: PageLookup = { currentScale: 1.5, getPageView: () => ({ div: pageDiv }) };
  const overlay = new PdfOverlay(root, document.querySelector("#container")!, document.querySelector("#pages")!, viewer);
  return { root, overlay, pageDiv };
}

const flush = () => new Promise((resolve) => setTimeout(resolve));

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} });
});

describe("PdfOverlay", () => {
  it("쪽의 문단을 원문 텍스트 노드 하나로 만들고 처음에는 표시하지 않는다", () => {
    const { root, overlay } = setup();

    overlay.addPage(2, [BLOCK], VIEWPORT, null);

    const paragraph = root.querySelector<HTMLElement>('.pdf-layer[data-page="2"] p.pdf-block')!;
    expect(paragraph.textContent).toBe("Original text.");
    expect(paragraph.childNodes).toHaveLength(1);
    expect(paragraph.hasAttribute("data-translated")).toBe(false);
    expect(parseFloat(paragraph.style.left)).toBeCloseTo((70 / 612) * 100);
    expect(parseFloat(paragraph.style.width)).toBeCloseTo((232 / 612) * 100);
    expect(parseFloat(paragraph.style.top)).toBeCloseTo((100 / 792) * 100);
    expect(parseFloat(paragraph.style.height)).toBeCloseTo((12 / 792) * 100);
  });

  it("텍스트가 원문과 달라지면 표시하고, 원문으로 돌아오면 숨긴다", async () => {
    const { root, overlay } = setup();
    overlay.addPage(1, [BLOCK], VIEWPORT, null);
    const paragraph = root.querySelector("p")!;

    paragraph.firstChild!.nodeValue = "번역문";
    await flush();
    expect(paragraph.hasAttribute("data-translated")).toBe(true);

    paragraph.firstChild!.nodeValue = "Original text.";
    await flush();
    expect(paragraph.hasAttribute("data-translated")).toBe(false);
  });

  it("상자에 들어갈 때까지 글자 크기를 5%씩 줄인다", async () => {
    const { root, overlay } = setup();
    overlay.addPage(1, [BLOCK], VIEWPORT, null);
    const paragraph = root.querySelector("p")!;
    Object.defineProperty(paragraph, "clientHeight", { value: 100 });
    // 글자 크기(9px 이하)가 되어야 들어가는 상자
    Object.defineProperty(paragraph, "scrollHeight", { get: () => (paragraph.style.fontSize.includes("9.00px") ? 100 : 130) });

    paragraph.firstChild!.nodeValue = "긴 번역문";
    await flush();

    expect(paragraph.style.fontSize).toBe("calc(var(--pdf-scale) * 9.00px)");
  });

  it("60%에서도 넘치면 그 크기로 둔다", async () => {
    const { root, overlay } = setup();
    overlay.addPage(1, [BLOCK], VIEWPORT, null);
    const paragraph = root.querySelector("p")!;
    Object.defineProperty(paragraph, "clientHeight", { value: 100 });
    Object.defineProperty(paragraph, "scrollHeight", { value: 500 });

    paragraph.firstChild!.nodeValue = "아주 긴 번역문";
    await flush();

    expect(paragraph.style.fontSize).toBe("calc(var(--pdf-scale) * 6.00px)");
  });

  it("가운데 정렬 문단을 표시하고 배율을 CSS 변수로 둔다", () => {
    const { root, overlay } = setup();

    overlay.addPage(1, [{ ...BLOCK, centered: true }], VIEWPORT, null);

    expect(root.querySelector("p")!.style.textAlign).toBe("center");
    expect(root.style.getPropertyValue("--pdf-scale")).toBe(String((1.5 * 96) / 72));
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run tests/unit/pdf-overlay.test.ts`
Expected: FAIL. `../../src/pdf/overlay`를 찾지 못한다.

- [ ] **Step 3: `src/pdf/overlay.ts` 작성**

```ts
import type { Block } from "./layout";

// 번역층 (설계서 10절): 쪽마다 문단 요소를 페이지 위에 겹친다. TranslationController는 #overlays를 웹 페이지처럼
// 수집·교체하고, 이 모듈은 텍스트가 원문과 달라지면 문단을 보이고 글자 크기를 맞춘다.

const LAYER_CLASS = "pdf-layer";
const BLOCK_CLASS = "pdf-block";
const TRANSLATED = "data-translated";
/** 문단 좌우로 넓히는 폭 (포인트). 글자 끝이 비치지 않게 한다. */
const SIDE_PADDING = 2;
/** CSS 픽셀 ÷ PDF 포인트 */
const CSS_UNITS = 96 / 72;
const MIN_FONT_PERCENT = 60;
const FONT_STEP = 5;
const DARK_LUMINANCE = 128;

/** PDFViewer에서 번역층이 쓰는 부분 */
export interface PageLookup {
  readonly currentScale: number;
  getPageView(index: number): { div: HTMLElement };
}

export class PdfOverlay {
  private readonly root: HTMLElement;
  private readonly container: HTMLElement;
  private readonly viewer: PageLookup;
  private readonly layers = new Map<number, HTMLElement>();
  private readonly originals = new WeakMap<Text, string>();
  private readonly sizes = new WeakMap<HTMLElement, number>();

  /** root: #overlays, container: #viewerContainer, pages: #viewer */
  constructor(root: HTMLElement, container: HTMLElement, pages: HTMLElement, viewer: PageLookup) {
    this.root = root;
    this.container = container;
    this.viewer = viewer;
    new ResizeObserver(() => this.place()).observe(pages);
    new MutationObserver((records) => {
      for (const record of records) this.onTextChanged(record.target as Text);
    }).observe(root, { characterData: true, subtree: true });
  }

  /** 쪽 번호의 번역층을 만들어 root에 붙이고 위치를 맞춘다. 같은 쪽을 두 번 부르지 않는다. */
  addPage(
    pageNumber: number,
    blocks: readonly Block[],
    viewport: { width: number; height: number },
    canvas: HTMLCanvasElement | null,
  ): void {
    const layer = document.createElement("div");
    layer.className = LAYER_CLASS;
    layer.dataset.page = String(pageNumber);
    const context = canvas?.getContext("2d") ?? undefined;
    for (const block of blocks) layer.append(this.createBlock(block, viewport, canvas, context));
    this.layers.set(pageNumber, layer);
    this.root.append(layer);
    this.place();
  }

  /** 모든 번역층을 페이지 위치에 맞춘다. 페이지의 투명 테두리는 빼고 안쪽 영역에 맞춘다. */
  place(): void {
    this.root.style.setProperty("--pdf-scale", String(this.viewer.currentScale * CSS_UNITS));
    const box = this.container.getBoundingClientRect();
    for (const [pageNumber, layer] of this.layers) {
      const { div } = this.viewer.getPageView(pageNumber - 1);
      const page = div.getBoundingClientRect();
      layer.style.left = `${page.left - box.left + this.container.scrollLeft + div.clientLeft}px`;
      layer.style.top = `${page.top - box.top + this.container.scrollTop + div.clientTop}px`;
      layer.style.width = `${div.clientWidth}px`;
      layer.style.height = `${div.clientHeight}px`;
    }
  }

  private createBlock(
    block: Block,
    viewport: { width: number; height: number },
    canvas: HTMLCanvasElement | null,
    context: CanvasRenderingContext2D | undefined,
  ): HTMLElement {
    const left = block.left - SIDE_PADDING;
    const paragraph = document.createElement("p");
    paragraph.className = BLOCK_CLASS;
    paragraph.style.left = `${(left / viewport.width) * 100}%`;
    paragraph.style.width = `${((block.right - block.left + 2 * SIDE_PADDING) / viewport.width) * 100}%`;
    paragraph.style.top = `${(block.top / viewport.height) * 100}%`;
    paragraph.style.height = `${((block.bottom - block.top) / viewport.height) * 100}%`;
    if (block.centered) paragraph.style.textAlign = "center";
    if (canvas && context) applyBackground(paragraph, canvas, context, left / viewport.width, block.top / viewport.height);
    const text = document.createTextNode(block.text);
    this.originals.set(text, block.text);
    this.sizes.set(paragraph, block.size);
    paragraph.append(text);
    return paragraph;
  }

  private onTextChanged(text: Text): void {
    const paragraph = text.parentElement;
    if (!paragraph?.classList.contains(BLOCK_CLASS)) return;
    if (text.nodeValue === this.originals.get(text)) {
      paragraph.removeAttribute(TRANSLATED);
    } else {
      paragraph.setAttribute(TRANSLATED, "");
      fitFont(paragraph, this.sizes.get(paragraph) ?? 0);
    }
  }
}

/** 글자 크기를 5%씩 줄여 상자에 맞춘다. 60%에서도 넘치면 아래로 넘치게 둔다. */
function fitFont(paragraph: HTMLElement, size: number): void {
  for (let percent = 100; percent >= MIN_FONT_PERCENT; percent -= FONT_STEP) {
    paragraph.style.fontSize = `calc(var(--pdf-scale) * ${((size * percent) / 100).toFixed(2)}px)`;
    if (paragraph.scrollHeight <= paragraph.clientHeight + 1) return;
  }
}

/** 문단 왼쪽 위 바깥의 픽셀을 배경으로 쓴다. 읽지 못하면 CSS 기본값(흰 배경, 검은 글자)을 둔다. */
function applyBackground(
  paragraph: HTMLElement,
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
): void {
  try {
    const pixelX = Math.max(0, Math.floor(x * canvas.width));
    const pixelY = Math.max(0, Math.floor(y * canvas.height));
    const [red = 255, green = 255, blue = 255] = context.getImageData(pixelX, pixelY, 1, 1).data;
    paragraph.style.background = `rgb(${red}, ${green}, ${blue})`;
    if (0.299 * red + 0.587 * green + 0.114 * blue < DARK_LUMINANCE) paragraph.style.color = "#fff";
  } catch {
    // 기본 스타일을 쓴다.
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx tsc --noEmit && npx vitest run tests/unit/pdf-overlay.test.ts`
Expected: 타입 오류 없음, 모두 PASS

- [ ] **Step 5: 커밋**

```bash
git add src/pdf/overlay.ts tests/unit/pdf-overlay.test.ts
git -c user.name="dlawhdgur01" -c user.email="dlawhdgur01@gmail.com" commit -m "PDF 번역층 추가"
```

---

### 작업 6: 뷰어와 빌드

**Files:**
- Create: `src/pdf/pdfjs.ts`, `src/pdf/viewer.ts`, `src/pdf/viewer.html`, `src/pdf/viewer.css`
- Modify: `src/content/controller.ts`, `scripts/build.mjs`
- Test: `tests/helpers/pdf-builder.ts`, `tests/e2e/pdf.spec.ts`

**Interfaces:**
- Consumes: 작업 2~5의 모든 공개 함수
- Produces:
  - `new TranslationController(root, { pageUrl?: () => string })`
  - `buildPdf(pages: readonly (readonly PdfRun[])[]): Buffer`, `paragraphPages(count: number): Buffer`
  - 빌드 결과 `dist/pdf/viewer.html`과 pdf.js 자원

- [ ] **Step 1: 테스트용 PDF 생성기 작성**

`tests/helpers/pdf-builder.ts`를 만든다.

```ts
// 테스트용 PDF를 코드로 만든다. Helvetica(라틴 문자)만 쓰며 쪽은 모두 US Letter(612×792)다.

export interface PdfRun {
  text: string;
  x: number;
  /** PDF 좌표: 아래에서 위로 */
  y: number;
  size: number;
}

export function buildPdf(pages: readonly (readonly PdfRun[])[]): Buffer {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const add = (body: string) => objects.push(body);
  const kids: number[] = [];
  for (const runs of pages) {
    const content = runs
      .map(({ text, x, y, size }) => `BT /F1 ${size} Tf ${x} ${y} Td (${text.replace(/[\\()]/g, "\\$&")}) Tj ET`)
      .join("\n");
    const contents = add(`<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`);
    kids.push(
      add(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contents} 0 R >>`,
      ),
    );
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.map((kid) => `${kid} 0 R`).join(" ")}] /Count ${kids.length} >>`;

  let output = "%PDF-1.4\n";
  const offsets = objects.map((body, index) => {
    const offset = output.length;
    output += `${index + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = output.length;
  const entries = offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${entries}`;
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output, "latin1");
}

/** 쪽마다 제목 없이 "Page {n} paragraph …" 문단 하나가 있는 PDF */
export function paragraphPages(count: number): Buffer {
  return buildPdf(
    Array.from({ length: count }, (_, index) => [
      { text: `Page ${index + 1} paragraph line one goes on for a while here.`, x: 72, y: 700, size: 10 },
      { text: `Page ${index + 1} paragraph line two goes on for a while here.`, x: 72, y: 688, size: 10 },
    ]),
  );
}
```

- [ ] **Step 2: 실패하는 E2E 작성**

`tests/e2e/pdf.spec.ts`를 만든다.

```ts
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
    await expect(page.locator("#page-info")).toHaveText("2 / 6");
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
```

- [ ] **Step 3: 실패 확인**

Run: `node scripts/build.mjs && node scripts/build.mjs --test && npx playwright test --project=e2e tests/e2e/pdf.spec.ts`
Expected: FAIL. 뷰어 파일이 아직 없어 뷰어 시험이 실패한다.

- [ ] **Step 4: `src/content/controller.ts` 변경**

기록에 원본 PDF 주소를 남기기 위해 주소를 주입할 수 있게 한다. 웹 페이지의 동작은 그대로다.

```diff
--- a/src/content/controller.ts
+++ b/src/content/controller.ts
@@ -46,8 +46,12 @@ export class TranslationController {
   private logId = "";
   /** 그 건을 시작한 주소 (쿼리·해시 뺌) */
   private logUrl = "";
+  /** 기록에 남기고 페이지 이동을 가늠하는 주소 */
+  private readonly pageUrl: () => string;
 
-  constructor(root: Element) {
+  /** pageUrl: 페이지 주소가 실제 문서 주소가 아닐 때(PDF 뷰어) 넘긴다. 기본은 지금 페이지 주소 */
+  constructor(root: Element, options: { pageUrl?: () => string } = {}) {
+    this.pageUrl = options.pageUrl ?? locationUrl;
     this.page = new PageTranslator(root);
     this.watcher = new MutationWatcher(
       root,
@@ -128,10 +132,10 @@ export class TranslationController {
     this.running++;
     // 페이지 번역을 시작할 때만 캐시 정리의 새 턴과 기록의 새 건을 연다. 화면 변화로 더 번역하는 것은 같은 턴·같은 건이다.
     // 다만 주소가 바뀌었으면 페이지를 새로 읽지 않는 사이트(SPA)의 페이지 이동이므로 새로 연다 (SPEC 13장).
-    const newTurn = changed === undefined || pageUrl() !== this.logUrl;
+    const newTurn = changed === undefined || this.pageUrl() !== this.logUrl;
     if (newTurn) {
       this.logId = newLogId();
-      this.logUrl = pageUrl();
+      this.logUrl = this.pageUrl();
     }
     return this.page
       .translate((groups, deliver) => this.request(groups, deliver, newTurn, retranslate), changed)
@@ -190,7 +194,7 @@ export class TranslationController {
     return {
       id: this.logId,
       title: document.title.trim().slice(0, 200),
-      url: pageUrl(),
+      url: this.pageUrl(),
       automatic: this.automatic,
     };
   }
@@ -217,7 +221,7 @@ export class TranslationController {
 }
 
 /** 기록에 남기고 페이지 이동을 가늠하는 주소: 쿼리·해시는 뺀다 (SPEC 13장 "기록 항목") */
-function pageUrl(): string {
+function locationUrl(): string {
   return location.href.split(/[?#]/)[0]!;
 }
```

- [ ] **Step 5: `scripts/build.mjs` 변경**

```diff
--- a/scripts/build.mjs
+++ b/scripts/build.mjs
@@ -22,6 +22,7 @@ const builds = [
       { in: "src/background/index.ts", out: "background" },
       { in: "src/options/options.ts", out: "options/options" },
       { in: "src/popup/popup.ts", out: "popup/popup" },
+      { in: "src/pdf/viewer.ts", out: "pdf/viewer" },
     ],
   },
   {
@@ -41,6 +42,19 @@ const staticFiles = [
   ["src/options/options.css", "options/options.css"],
   ["src/popup/popup.html", "popup/popup.html"],
   ["src/popup/popup.css", "popup/popup.css"],
+  ["src/pdf/viewer.html", "pdf/viewer.html"],
+  ["src/pdf/viewer.css", "pdf/viewer.css"],
+];
+
+// 번들하지 않는 pdf.js 자원: [node_modules/pdfjs-dist 안의 경로, dist/pdf 안의 경로]
+const pdfjsFiles = [
+  ["build/pdf.worker.min.mjs", "pdf.worker.min.mjs"],
+  ["web/pdf_viewer.css", "pdf_viewer.css"],
+  ["web/images", "images"],
+  ["cmaps", "cmaps"],
+  ["standard_fonts", "standard_fonts"],
+  ["wasm", "wasm"],
+  ["iccs", "iccs"],
 ];
 
 const common = {
@@ -61,6 +75,12 @@ async function copyStatic() {
   }
 }
 
+async function copyPdfjs() {
+  for (const [from, to] of pdfjsFiles) {
+    await cp(path.join(root, "node_modules/pdfjs-dist", from), path.join(outdir, "pdf", to), { recursive: true });
+  }
+}
+
 async function testManifest() {
   const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
   manifest.host_permissions = [...manifest.host_permissions, ...TEST_HOSTS];
@@ -69,6 +89,7 @@ async function testManifest() {
 
 await rm(outdir, { recursive: true, force: true });
 await copyStatic();
+await copyPdfjs();
 
 if (watching) {
   for (const build of builds) {
```

- [ ] **Step 6: `src/pdf/pdfjs.ts` 작성**

```ts
import * as pdfjsLib from "pdfjs-dist";

// web/pdf_viewer.mjs는 불러올 때 globalThis.pdfjsLib를 읽는다. viewer.ts에서 이 파일을 먼저 import한다.
(globalThis as { pdfjsLib?: typeof pdfjsLib }).pdfjsLib = pdfjsLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("pdf/pdf.worker.min.mjs");

export { pdfjsLib };
```

- [ ] **Step 7: `src/pdf/viewer.html` 작성**

```html
<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <title>PDF</title>
    <link rel="stylesheet" href="pdf_viewer.css" />
    <link rel="stylesheet" href="viewer.css" />
  </head>
  <body>
    <header id="toolbar">
      <span id="page-info"></span>
      <button id="zoom-out" type="button" aria-label="축소">−</button>
      <button id="zoom-in" type="button" aria-label="확대">+</button>
      <button id="toggle" type="button" hidden></button>
      <span id="status" role="status"></span>
    </header>
    <section id="notice" hidden>
      <p id="notice-text"></p>
      <button id="allow" type="button" hidden>허용</button>
      <input id="file" type="file" accept="application/pdf,.pdf" hidden />
      <a id="open-original" hidden>원본 PDF 열기</a>
    </section>
    <div id="viewerContainer">
      <div id="viewer" class="pdfViewer"></div>
      <div id="overlays"></div>
    </div>
    <script type="module" src="viewer.js"></script>
  </body>
</html>
```

- [ ] **Step 8: `src/pdf/viewer.css` 작성**

```css
:root {
  color-scheme: light dark;
}

html,
body {
  height: 100%;
  margin: 0;
  font: 13px/1.5 system-ui, sans-serif;
}

#toolbar {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  padding: 0 12px;
  border-bottom: 1px solid #d1d9e0;
}

#status {
  margin-left: 4px;
}

#notice {
  position: absolute;
  top: 36px;
  left: 0;
  right: 0;
  z-index: 10;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid #d1d9e0;
  background: Canvas;
}

#notice[hidden],
#notice [hidden] {
  display: none;
}

#notice-text {
  margin: 0;
}

/* PDFViewer는 컨테이너가 absolute이기를 요구한다. */
#viewerContainer {
  position: absolute;
  top: 36px;
  right: 0;
  bottom: 0;
  left: 0;
  overflow: auto;
}

/* 링크 클릭을 아래 페이지로 넘긴다 (SPEC 13장 "PDF: 번역문 위의 마우스"). */
#overlays {
  position: absolute;
  top: 0;
  left: 0;
  width: 0;
  height: 0;
  pointer-events: none;
}

.pdf-layer {
  position: absolute;
  z-index: 5;
  overflow: hidden;
}

.pdf-block {
  position: absolute;
  box-sizing: border-box;
  margin: 0;
  visibility: hidden;
  color: #000;
  background: #fff;
  font-family: "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif;
  line-height: 1.28;
  word-break: keep-all;
  overflow-wrap: anywhere;
  white-space: normal;
}

.pdf-block[data-translated] {
  visibility: visible;
}
```

- [ ] **Step 9: `src/pdf/viewer.ts` 작성**

`./pdfjs`가 반드시 첫 import여야 한다. `web/pdf_viewer.mjs`가 불러올 때 `globalThis.pdfjsLib`를 읽기 때문이다.

```ts
import { pdfjsLib } from "./pdfjs";
import { EventBus, LinkTarget, PDFLinkService, PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import type { TextItem } from "pdfjs-dist/types/src/display/api";
import { listenForCommands, type CommandTarget } from "../content/commands";
import { TranslationController } from "../content/controller";
import type { PageState } from "../shared/messages";
import { originPattern } from "../shared/sites";
import { isReferencesHeading, pageBlocks, translatableBlocks, type Block, type ReferencesStart, type TextItemLike } from "./layout";
import { PdfOverlay } from "./overlay";
import { downloadPdf, fileNameOf, pageFromHash, PdfDownloadError, sourceUrl } from "./source";

// PDF 뷰어 (SPEC 13장 "PDF 번역", 설계서 6~8절).

/** 도구 막대가 상태를 다시 읽는 간격 (팝업과 같다) */
const POLL_MS = 500;
/** 텍스트가 있는지 살피는 앞쪽 쪽 수 */
const TEXT_CHECK_PAGES = 5;
/** 참고문헌 제목을 찾는 뒤쪽 쪽 수 */
const REFERENCES_SEARCH_PAGES = 30;

const LOADING_MESSAGE = "PDF를 받는 중…";
const LOCAL_FILE_MESSAGE = "내 컴퓨터의 PDF는 직접 읽을 수 없습니다. 번역할 파일을 골라 주세요.";
const DENIED_MESSAGE = "권한을 허용해야 이 PDF를 번역할 수 있습니다.";
const PASSWORD_MESSAGE = "암호로 보호된 PDF는 번역할 수 없습니다.";
const OPEN_FAILED_MESSAGE = "PDF를 열지 못했습니다.";
const NO_TEXT_MESSAGE = "이 PDF에는 번역할 텍스트가 없습니다. 스캔한 문서일 수 있습니다.";

type Phase = { kind: "opening" } | { kind: "failed"; message: string } | { kind: "ready" };

const pageInfo = element<HTMLSpanElement>("#page-info");
const statusText = element<HTMLSpanElement>("#status");
const toggleButton = element<HTMLButtonElement>("#toggle");
const notice = element<HTMLElement>("#notice");
const noticeText = element<HTMLParagraphElement>("#notice-text");
const allowButton = element<HTMLButtonElement>("#allow");
const fileInput = element<HTMLInputElement>("#file");
const openOriginal = element<HTMLAnchorElement>("#open-original");
const container = element<HTMLDivElement>("#viewerContainer");
const pagesElement = element<HTMLDivElement>("#viewer");
const overlaysElement = element<HTMLDivElement>("#overlays");

const source = sourceUrl(location.search);
const eventBus = new EventBus();
const linkService = new PDFLinkService({ eventBus, externalLinkTarget: LinkTarget.BLANK });
const viewer = new PDFViewer({
  container,
  viewer: pagesElement,
  eventBus,
  linkService,
  annotationMode: pdfjsLib.AnnotationMode.ENABLE,
});
linkService.setViewer(viewer);

const overlay = new PdfOverlay(overlaysElement, container, pagesElement, viewer);
const controller = new TranslationController(overlaysElement, {
  pageUrl: () => (source ?? location.href).split(/[?#]/)[0]!,
});

let phase: Phase = { kind: "opening" };
let references: ReferencesStart | undefined;
/** 번역층을 만들었거나 만드는 중인 쪽 */
const handledPages = new Set<number>();

const target: CommandTarget = {
  state,
  translate: () => (phase.kind === "ready" ? controller.translate() : undefined),
  retranslate: () => (phase.kind === "ready" ? controller.retranslate() : Promise.resolve()),
  showOriginal: () => (phase.kind === "ready" ? controller.showOriginal() : Promise.resolve()),
};

function state(): PageState {
  if (phase.kind === "ready") return controller.state();
  const progress = { done: 0, total: 0 };
  if (phase.kind === "opening") return { status: "translating", progress, partial: false };
  return { status: "error", progress, error: phase.message, partial: false };
}

document.title = fileNameOf(new URLSearchParams(location.search).get("file"));
listenForCommands(target);

element("#zoom-out").addEventListener("click", () => viewer.decreaseScale());
element("#zoom-in").addEventListener("click", () => viewer.increaseScale());
toggleButton.addEventListener("click", () => {
  if (toggleButton.textContent === "번역") void target.translate();
  else void target.showOriginal();
});
allowButton.addEventListener("click", () => {
  if (source === undefined) return;
  // 권한 요청은 사용자 동작 안에서 바로 불러야 한다 (await보다 먼저).
  void chrome.permissions.request({ origins: [originPattern(new URL(source).origin)] }).then((granted) => {
    if (granted) void download(source);
    else showNotice(DENIED_MESSAGE, { allow: true });
  });
});
fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  document.title = file.name;
  await open(await file.arrayBuffer());
});

eventBus.on("pagesinit", () => {
  viewer.currentScaleValue = "page-width";
  const page = pageFromHash(source, viewer.pagesCount);
  if (page !== undefined) viewer.currentPageNumber = page;
  renderPageInfo();
});
eventBus.on("pagechanging", renderPageInfo);
eventBus.on("scalechanging", () => requestAnimationFrame(() => overlay.place()));
eventBus.on("pagerendered", (event: { pageNumber: number; isDetailView?: boolean; error?: unknown }) => {
  if (phase.kind !== "failed" && !event.isDetailView && !event.error) void addPage(event.pageNumber);
});

setInterval(renderStatus, POLL_MS);
renderStatus();
void start();

async function start(): Promise<void> {
  if (source === undefined) return showNotice(LOCAL_FILE_MESSAGE, { file: true });
  const origins = [originPattern(new URL(source).origin)];
  if (await chrome.permissions.contains({ origins })) return download(source);
  showNotice(`이 PDF를 받으려면 ${new URL(source).origin} 접근 권한이 필요합니다.`, { allow: true });
}

async function download(url: string): Promise<void> {
  showNotice(LOADING_MESSAGE);
  try {
    await open(await downloadPdf(url));
  } catch (err) {
    if (err instanceof PdfDownloadError) fail(err.message);
    else throw err;
  }
}

async function open(data: ArrayBuffer): Promise<void> {
  notice.hidden = true;
  let pdf: PDFDocumentProxy;
  try {
    pdf = await pdfjsLib.getDocument({
      data,
      cMapUrl: chrome.runtime.getURL("pdf/cmaps/"),
      standardFontDataUrl: chrome.runtime.getURL("pdf/standard_fonts/"),
      wasmUrl: chrome.runtime.getURL("pdf/wasm/"),
      iccUrl: chrome.runtime.getURL("pdf/iccs/"),
    }).promise;
  } catch (err) {
    fail(err instanceof Error && err.name === "PasswordException" ? PASSWORD_MESSAGE : OPEN_FAILED_MESSAGE);
    return;
  }
  if (await hasText(pdf)) references = await findReferences(pdf);
  else fail(NO_TEXT_MESSAGE);
  viewer.setDocument(pdf);
  linkService.setDocument(pdf);
}

function fail(message: string): void {
  phase = { kind: "failed", message };
  showNotice(message, { original: source !== undefined });
  renderStatus();
}

async function hasText(pdf: PDFDocumentProxy): Promise<boolean> {
  for (let pageNumber = 1; pageNumber <= Math.min(TEXT_CHECK_PAGES, pdf.numPages); pageNumber++) {
    if ((await textItems(await pdf.getPage(pageNumber))).length > 0) return true;
  }
  return false;
}

/** 마지막 쪽부터 앞으로 찾아 처음 나오는 참고문헌 제목의 위치 */
async function findReferences(pdf: PDFDocumentProxy): Promise<ReferencesStart | undefined> {
  const first = Math.max(1, pdf.numPages - REFERENCES_SEARCH_PAGES + 1);
  for (let pageNumber = pdf.numPages; pageNumber >= first; pageNumber--) {
    const blocks = await blocksOf(await pdf.getPage(pageNumber));
    const headingIndex = blocks.findIndex((block) => isReferencesHeading(block.text));
    if (headingIndex >= 0) return { pageNumber, headingIndex };
  }
  return undefined;
}

async function textItems(page: PDFPageProxy): Promise<TextItemLike[]> {
  const { items } = await page.getTextContent();
  return items.filter((item): item is TextItem => "str" in item && item.str.trim() !== "");
}

async function blocksOf(page: PDFPageProxy): Promise<Block[]> {
  const viewport = page.getViewport({ scale: 1 });
  return pageBlocks(await textItems(page), viewport.transform, viewport.width);
}

/** 그려진 쪽의 번역층을 붙인다. 첫 쪽을 붙이면 번역을 시작하고, 그 뒤의 쪽은 컨트롤러가 화면 변화로 번역한다. */
async function addPage(pageNumber: number): Promise<void> {
  if (handledPages.has(pageNumber)) return;
  handledPages.add(pageNumber);
  const view = viewer.getPageView(pageNumber - 1);
  const page: PDFPageProxy = view.pdfPage;
  const viewport = page.getViewport({ scale: 1 });
  const blocks = translatableBlocks(await blocksOf(page), pageNumber, references);
  overlay.addPage(pageNumber, blocks, viewport, view.div.querySelector("canvas"));
  if (phase.kind === "opening") {
    phase = { kind: "ready" };
    void controller.translate();
    renderStatus();
  }
}

function renderPageInfo(): void {
  pageInfo.textContent = `${viewer.currentPageNumber} / ${viewer.pagesCount}`;
}

/** 도구 막대의 상태 문구와 번역/원문 버튼 (팝업과 같은 문구) */
function renderStatus(): void {
  if (phase.kind !== "ready") {
    statusText.textContent = phase.kind === "failed" ? phase.message : "";
    toggleButton.hidden = true;
    return;
  }
  const current = controller.state();
  toggleButton.hidden = false;
  toggleButton.textContent = current.status === "translating" || current.status === "translated" ? "원문 보기" : "번역";
  statusText.textContent = statusLabel(current);
}

function statusLabel(current: PageState): string {
  switch (current.status) {
    case "translating":
      return `번역 중… ${current.progress.done}/${current.progress.total}`;
    case "translated":
      return "번역 완료";
    case "original":
      return "원문 표시 중";
    case "error":
      return current.error ?? "";
    case "idle":
      return "";
  }
}

function showNotice(message: string, show: { allow?: boolean; file?: boolean; original?: boolean } = {}): void {
  noticeText.textContent = message;
  allowButton.hidden = !show.allow;
  fileInput.hidden = !show.file;
  openOriginal.hidden = !show.original;
  if (show.original && source !== undefined) openOriginal.href = source;
  notice.hidden = false;
}

function element<T extends Element>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`${selector} 요소가 없습니다.`);
  return found;
}
```

- [ ] **Step 10: 타입 검사**

Run: `npm run typecheck`
Expected: 오류 없음

- [ ] **Step 11: E2E 통과 확인**

Run: `node scripts/build.mjs && node scripts/build.mjs --test && npx playwright test --project=e2e tests/e2e/pdf.spec.ts`
Expected: 15 passed

- [ ] **Step 12: 커밋**

```bash
git add src/pdf src/content/controller.ts scripts/build.mjs tests/helpers/pdf-builder.ts tests/e2e/pdf.spec.ts
git -c user.name="dlawhdgur01" -c user.email="dlawhdgur01@gmail.com" commit -m "pdf.js 뷰어에서 PDF 번역"
```

---

### 작업 7: 문서와 전체 검증

**Files:**
- Modify: `README.md`, `SPEC.md`

- [ ] **Step 1: `README.md` 변경**

```diff
--- a/README.md
+++ b/README.md
@@ -1,6 +1,6 @@
 # AITranslator
 
-Claude(Anthropic API) 또는 OpenRouter의 모델로 웹 페이지를 한국어로 번역하는 Chrome 확장 프로그램입니다.
+Claude(Anthropic API) 또는 OpenRouter의 모델로 웹 페이지와 PDF를 한국어로 번역하는 Chrome 확장 프로그램입니다.
 
 - 페이지의 **텍스트 노드 값만** 바꿉니다. 요소, 속성, 이벤트는 그대로라서 번역한 뒤에도 메뉴, 검색, 버튼이 원래대로 동작합니다.
 - "원문 보기"를 누르면 API 호출 없이 곧바로 원문으로 돌아갑니다.
@@ -41,6 +41,7 @@ npm run build
 
 - **단축키:** 다른 확장 프로그램과 겹쳐 Chrome이 할당하지 않았으면 팝업에 "단축키 없음 · 설정하기"가 보입니다. `chrome://extensions/shortcuts`에서 바꿀 수 있습니다. macOS에서는 확장이 켜져 있는 동안 입력란에서 Option+T로 †를 입력할 수 없습니다.
 - **자동 번역 사이트:** 체크하면 그 사이트에 대한 접근 권한을 묻습니다. 권한 창이 뜨면 팝업이 닫히므로, 거부했다면 다음에 팝업을 열 때 안내합니다. 출처(`https://docs.langchain.com` 같은 주소) 단위로 켜지므로 하위 도메인과 포트는 따로 켜야 합니다. 옵션 페이지의 "자동 번역 사이트"에서 "삭제"하면 권한도 돌려줍니다.
+- **PDF:** 크롬에서 연 PDF에서 번역하면 같은 탭이 확장의 PDF 뷰어로 바뀌고, 문단이 원래 자리에서 한국어로 보입니다. 그 사이트에서 처음 쓸 때는 뷰어에서 "허용"을 눌러야 합니다. 화면에 그려진 쪽만 번역하고 스크롤하면 이어서 번역합니다. 내 컴퓨터의 PDF는 뷰어에서 같은 파일을 다시 골라야 합니다. "이 사이트는 항상 번역"을 켠 사이트라도 PDF는 눌렀을 때만 번역합니다.
 - **바뀌는 화면:** 번역 보기 상태에서는 SPA처럼 새로 그려지는 내용도 이어서 번역합니다.
 - **오류:** 키가 없거나 틀렸을 때, 요청 한도 초과, 네트워크 오류 같은 경우 팝업과 페이지 오른쪽 아래 알림에 원인을 보여 줍니다. 이미 번역된 부분은 그대로 둡니다.
 
@@ -81,7 +82,7 @@ npm run build
 | `activeTab`, `scripting` | 팝업·단축키·우클릭으로 번역할 때 지금 탭에 번역 스크립트를 넣음 |
 | `contextMenus` | 우클릭 메뉴 |
 | `https://api.anthropic.com/*` | 백그라운드에서 Claude API 호출 (OpenRouter는 모든 출처의 요청을 허용해서 권한을 따로 받지 않습니다) |
-| 선택 권한 `https://*/*`, `http://*/*` | "이 사이트는 항상 번역"을 켤 때 그 사이트만 요청 |
+| 선택 권한 `https://*/*`, `http://*/*` | "이 사이트는 항상 번역"을 켤 때와 PDF를 받을 때 그 사이트만 요청 |
 
 - 번역하는 **페이지 텍스트는 고른 제공업체(Anthropic API 또는 OpenRouter)로 전송됩니다.** OpenRouter는 고른 모델의 제공업체로 전달합니다. 그 밖의 서버로는 보내지 않습니다. OpenRouter 모델 목록은 키 없이 하루에 한 번 받습니다.
 - API 키는 이 브라우저의 `chrome.storage.local`에만 저장하고 백그라운드 서비스 워커에서만 씁니다. 웹 페이지나 콘텐츠 스크립트로는 보내지 않습니다.
@@ -95,6 +96,13 @@ npm run build
 - iframe 안의 내용과 Shadow DOM 안의 텍스트는 번역하지 않습니다.
 - 속성(`placeholder`, `title`, `alt`, `aria-label`)과 입력란 내용은 번역하지 않습니다.
 - `chrome://` 페이지와 Chrome 웹 스토어는 번역할 수 없습니다.
+- PDF
+  - 스캔한 PDF와 암호로 보호된 PDF는 번역할 수 없습니다.
+  - 표 안의 글자, 수식, 그림 속 글자는 원본 그대로 둡니다. 표와 그림의 설명은 번역합니다.
+  - 참고문헌과 그 뒤의 부록은 번역하지 않습니다.
+  - 단이나 쪽을 넘어가는 문단은 조각별로 번역합니다.
+  - 번역문을 드래그하면 가려진 영어가 복사됩니다. 대신 번역문 아래의 링크를 누를 수 있습니다.
+  - 번역을 누르면 1쪽부터 열립니다. 주소에 `#page=N`이 있을 때만 그 쪽부터 엽니다.
 
 ## 개발
 
@@ -122,11 +130,13 @@ npm run test:live   # SPEC 10.3: 실제 docs.langchain.com + 목 API (인터넷
 ```
 src/background/   서비스 워커: 메시지, 단축키, 우클릭 메뉴, 자동 번역 등록, 배치·재시도(translator), 캐시, 프롬프트, 제공업체(providers/)
 src/content/      콘텐츠 스크립트: 텍스트 수집(collect), 교체·복원(apply), 화면 변화 감시(observer), 상태(controller), 알림(toast)
+src/pdf/          PDF 뷰어: 받기(source), 문단 복원(layout), 번역층(overlay), pdf.js 연결(pdfjs, viewer)
 src/popup/        팝업
 src/options/      옵션 페이지
 src/shared/       설정 저장소, 메시지 형식, 모델 목록, 용어집, 사용량
 tests/unit/       단위 테스트          tests/e2e/   E2E (마일스톤별 m1~m7)
 tests/live/       실제 사이트 테스트   tests/fixtures/   테스트용 HTML
+tests/helpers/    목 번역기, 목 API, 테스트용 PDF 생성(pdf-builder)
 ```
 
 ### SPEC 10장 항목과 테스트
```

- [ ] **Step 2: `SPEC.md` 변경**

8장과 9장을 갱신한다. 13장은 이미 기록되어 있다.

```diff
--- a/SPEC.md
+++ b/SPEC.md
@@ -368,6 +368,7 @@ interface UsageStats {
 5. **Shadow DOM, 같은 출처 iframe** 지원.
 6. **키 없는 모드**: Chrome 내장 온디바이스 번역 API 사용 가능 여부 조사 후 대체 제공업체로 추가.
 7. Chrome 웹 스토어 배포.
+8. **PDF 번역**: 확장 안의 pdf.js 뷰어로 PDF를 번역. (2026-11-01 추가함. 13장 "PDF 번역")
 
 ---
 
@@ -396,6 +397,7 @@ interface UsageStats {
 │   │   ├── apply.ts            # 교체/복원 (WeakMap)
 │   │   ├── observer.ts         # MutationObserver
 │   │   └── toast.ts            # Shadow DOM 알림
+│   ├── pdf/    (viewer.html, viewer.css, viewer.ts, pdfjs.ts, source.ts, layout.ts, overlay.ts)
 │   ├── popup/  (popup.html, popup.ts, popup.css)
 │   ├── options/ (options.html, options.ts, options.css)
 │   └── shared/  (messages.ts, storage.ts, hash.ts)
```

- [ ] **Step 3: 전체 검증**

Run: `npm run typecheck && npm test && npm run test:e2e`
Expected:
- 타입 오류 없음
- 단위 테스트 25개 파일, 432개 통과
- E2E 75개 통과, 4개 건너뜀 (`ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`가 없어서 건너뛰는 실제 API 테스트)

수가 다르면 멈추고 원인을 확인한다. 테스트를 건너뛰게 바꾸거나 기대값을 낮추지 않는다.

- [ ] **Step 4: 배포용 manifest 확인**

Run: `node -e "const m=require('./dist/manifest.json');console.log(m.version,JSON.stringify(m.permissions),JSON.stringify(m.host_permissions),m.web_accessible_resources)"`
Expected: `0.2.0 ["storage","activeTab","scripting","contextMenus"] ["https://api.anthropic.com/*"] undefined`

- [ ] **Step 5: 커밋**

```bash
git add README.md SPEC.md
git -c user.name="dlawhdgur01" -c user.email="dlawhdgur01@gmail.com" commit -m "PDF 번역 문서 갱신"
```

- [ ] **Step 6: 완료 보고**

push하지 않는다. 사용자에게 검증 결과와 함께 아래 **수동 확인 목록을 그대로** 넘긴다. 자동 시험이 어려운 항목이므로 확인했다고 적지 않는다.

```text
dist 폴더를 chrome://extensions에서 다시 불러온 뒤 확인해 주세요.
1. 실제 PDF에서 "허용"과 거부 (권한 창)
2. 내장 뷰어에서 Option+T
3. 내장 뷰어의 우클릭 메뉴에 "이 페이지 한국어로 번역"이 보이는지
4. 실제 팝업에서 번역을 누른 뒤의 화면 전환
5. 번역문 아래 본문 링크 클릭
예시 PDF: https://www.roboticsproceedings.org/rss19/p089.pdf
```
