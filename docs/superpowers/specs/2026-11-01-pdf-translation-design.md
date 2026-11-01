# PDF 번역 설계

- 작성일: 2026-11-01
- 상태: 사용자 승인 (2026-11-01)
- 결정 기록: `SPEC.md` 13장의 "PDF" 항목과 "PDF 화면 문구"
- 대상 독자: 이 문서와 구현 계획서만 보고 코드를 작성할 구현자

이 문서에 없는 동작이 필요해지면 임의로 정하지 말고 `SPEC.md` 12.1절대로 멈춰서 보고한다.

## 1. 목표

크롬에서 연 PDF를 한국어로 읽을 수 있게 한다. 사용자가 PDF 탭에서 번역을 누르면 같은 탭이 확장의 PDF 뷰어로 바뀌고, 문단이 원래 자리에서 한국어로 보인다.

### 성공 기준

1. 텍스트 PDF에서 팝업·단축키·우클릭 메뉴의 번역이 모두 뷰어로 이어진다.
2. 2단 논문에서 본문, 제목, 그림·표 설명이 번역되고 표 안의 값, 수식, 그림, 참고문헌은 원본 그대로다.
3. 번역하는 범위는 화면에 그려진 쪽뿐이고, 스크롤하면 이어서 번역한다.
4. "원문 보기"는 API 호출 없이 원본 페이지 모습으로 돌아간다.
5. 웹 페이지 번역의 동작은 바뀌지 않는다. 기존 단위·E2E 테스트가 모두 통과한다.

### 범위에서 제외

OCR, 암호 입력, 인쇄·다운로드 버튼, 뷰어 안 검색 UI, 양식 입력, 번역문이 포함된 PDF 내보내기, PDF 자동 번역, 가이드 PDF·배포 zip 갱신.

## 2. 검증된 사실

2026-11-01 Chromium 156과 `pdfjs-dist` 6.4.299로 임시 확장을 만들어 확인했다.

| 사실 | 결과 |
|---|---|
| 내장 뷰어의 문서 | `document.contentType`은 `application/pdf`, `body` 텍스트 0자, 닫힌 Shadow DOM 안의 `about:blank` iframe. 뷰어 내용에 접근 불가 |
| 뷰어로 전환 | `chrome.tabs.update`로 `chrome-extension://…/pdf/viewer.html`을 열 수 있음. `web_accessible_resources` 불필요 |
| 메시지 | `chrome.tabs.sendMessage(tabId, m, {frameId: 0})`가 뷰어 페이지의 `runtime.onMessage`에 도착 |
| 번역 포트 | 뷰어의 `chrome.runtime.connect`는 `port.sender.tab`이 있어 기존 확인을 통과 |
| 뷰어 탭의 `tab.url` | `tabs` 권한 없이도 읽힘 |
| 교차 출처 받기 | 사이트 권한이 있으면 뷰어의 `fetch(url, {credentials: "include"})`가 성공. `SameSite=Lax` 쿠키가 필요한 PDF도 성공 |
| esbuild | `pdfjs-dist`와 `web/pdf_viewer.mjs`를 ESM으로 묶을 수 있음 |
| 재사용 | `TranslationController`, `PageTranslator`, `collect`, `apply`, `observer`, 캐시를 그대로 쓸 수 있음 |
| 한글 배치 | 실제 Haiku 번역으로 RSS 논문 1·2·5쪽 시험. 문단 대부분이 100~90% 글자 크기에 들어감 |
| 테스트 | Playwright `context.route`로 만든 PDF 응답을 뷰어의 `fetch`가 받음. 서비스 워커 `fetch` 목으로 번역 가능 |
| `PDFPageView.reset()` | `.page` 안에 직접 넣은 요소를 지움. 번역층은 `.page` 밖에 둬야 함 |
| 페이지 테두리 | `.page`에 투명 테두리 9px가 있음. 위치 계산에 `clientLeft`, `clientTop`, `clientWidth`, `clientHeight`를 써야 함 |

자동 테스트로 확인할 수 없어 수동 확인이 남은 항목은 11.4절에 있다.

## 3. 구조

```
PDF 탭 (크롬 내장 뷰어)
  │ 번역 (팝업·단축키·우클릭)
  ▼
background/index.ts ── chrome.tabs.update ──▶ pdf/viewer.html?file=<원본 주소>
                                                 │
                       ┌─────────────────────────┤
                       ▼                         ▼
                 pdf/source.ts              pdf/viewer.ts
                 권한·받기·파일 선택         상태·도구 막대·명령 처리
                                                 │
                       ┌─────────────────────────┼──────────────────┐
                       ▼                         ▼                  ▼
                 pdf.js PDFViewer          pdf/overlay.ts     TranslationController
                 페이지·텍스트층·링크       문단 번역층         수집·번역·교체 (기존 코드)
                                                 │
                                                 ▼
                                           pdf/layout.ts
                                           텍스트 항목 → 문단
```

번역층의 `<p>`에는 원문 텍스트 노드가 있다. 기존 컨트롤러는 이 텍스트 노드를 웹 페이지의 문단처럼 수집하고 교체한다. 번역층은 텍스트가 원문과 달라지는 것을 감지해 문단을 보이거나 숨긴다. 그래서 번역 파이프라인을 PDF용으로 복제하지 않는다.

## 4. 파일

### 새 파일

| 파일 | 책임 |
|---|---|
| `src/pdf/viewer.html` | 뷰어 페이지 구조 |
| `src/pdf/viewer.css` | 뷰어와 번역층 스타일 |
| `src/pdf/pdfjs.ts` | pdf.js를 불러오고 `globalThis.pdfjsLib`, 워커 주소를 설정 |
| `src/pdf/viewer.ts` | 진입점. 상태, 도구 막대, PDFViewer 연결, 명령 처리 |
| `src/pdf/source.ts` | 주소 해석, 권한 확인, PDF 받기, 파일 선택 |
| `src/pdf/layout.ts` | 순수 함수. 텍스트 항목을 문단으로 바꾸고 번역 대상을 고름 |
| `src/pdf/overlay.ts` | 쪽별 번역층 생성, 위치 맞춤, 글자 크기 맞춤, 표시 전환 |
| `src/shared/pdf.ts` | 뷰어 주소 만들기·판별 (background와 뷰어가 공유) |
| `src/content/commands.ts` | `content/index.ts`의 `listen()`을 옮긴 명령 수신 함수 |
| `tests/unit/pdf-layout.test.ts` | layout 단위 테스트 |
| `tests/unit/pdf-url.test.ts` | `shared/pdf.ts` 단위 테스트 |
| `tests/unit/pdf-source.test.ts` | `pdf/source.ts` 단위 테스트 |
| `tests/unit/pdf-overlay.test.ts` | 표시 전환·글자 크기 맞춤 단위 테스트 |
| `tests/helpers/pdf-builder.ts` | 테스트용 PDF를 코드로 생성 |
| `tests/e2e/pdf.spec.ts` | E2E |

### 고치는 파일

| 파일 | 변경 |
|---|---|
| `package.json`, `package-lock.json` | `dependencies`에 `"pdfjs-dist": "6.4.299"`, 버전 0.2.0 |
| `manifest.json` | 버전 0.2.0. 권한은 바꾸지 않음 |
| `scripts/build.mjs` | 뷰어 빌드, 정적 파일, pdf.js 자원 복사 |
| `src/background/index.ts` | PDF 탭 판별과 뷰어 전환 |
| `src/content/index.ts` | PDF 문서에서는 컨트롤러를 만들지 않음. `listen()`을 `commands.ts`로 이동 |
| `src/content/controller.ts` | 기록 주소를 주입할 수 있게 함 |
| `README.md` | 사용법, 권한, 제한, 구조 갱신 |
| `SPEC.md` | 11절 참고 |

`src/popup/`, `src/options/`, 번역·캐시·제공업체 코드는 바꾸지 않는다.

## 5. 뷰어 주소와 탭 전환

### `src/shared/pdf.ts`

```ts
const VIEWER_PATH = "pdf/viewer.html";

/** 원본 PDF 주소를 뷰어 주소로 바꾼다. 해시(#page=N)도 file 값 안에 그대로 넣는다. */
export function viewerUrl(source: string): string;
/** 이 확장의 PDF 뷰어 주소인지 */
export function isViewerUrl(url: string | undefined): boolean;
/** file:// 주소이면서 경로가 .pdf로 끝나는지 (대소문자 무시, 쿼리·해시 제외) */
export function isLocalPdfUrl(url: string | undefined): boolean;
```

`viewerUrl`은 `chrome.runtime.getURL(VIEWER_PATH) + "?file=" + encodeURIComponent(source)`다. `isViewerUrl`은 `chrome.runtime.getURL(VIEWER_PATH)`로 시작하는지 본다.

### `src/background/index.ts`

새 상수를 둔다.

```ts
/** 뷰어를 여는 중. 뷰어가 응답하기 전까지 팝업에 "번역" 버튼 대신 진행 상태를 보여 준다. */
const PDF_OPENING_STATE: PageState = { status: "translating", progress: { done: 0, total: 0 }, partial: false };
```

`translateTab`의 순서는 다음과 같다. 키 확인과 `sendToTab`은 지금과 같다.

```ts
const state = await sendToTab(tabId, { type: "translate" });
if (state) return state;
const tab = await chrome.tabs.get(tabId).catch(() => undefined);
if (isViewerUrl(tab?.url)) return PDF_OPENING_STATE; // 뷰어가 아직 뜨는 중
if (tab?.url !== undefined && (await isPdfTab(tabId, tab.url))) {
  await chrome.tabs.update(tabId, { url: viewerUrl(tab.url) });
  return PDF_OPENING_STATE;
}
// 이후 executeScript("content.js")는 지금과 같다.
```

`isPdfTab`은 다음과 같다.

```ts
/** 내장 PDF 뷰어로 열린 탭인지. file://은 파일 접근 설정이 꺼져 있으면 스크립트를 넣을 수 없어 주소로 판단한다. */
async function isPdfTab(tabId: number, url: string): Promise<boolean> {
  try {
    const [result] = await chrome.scripting.executeScript({ target: { tabId }, func: () => document.contentType });
    return result?.result === "application/pdf";
  } catch {
    return isLocalPdfUrl(url);
  }
}
```

`tabState`에서 `sendToTab`이 응답을 받지 못했을 때 `isViewerUrl(tab?.url)`이면 `PDF_OPENING_STATE`를 돌려준다. `canInject`는 바꾸지 않는다.

`retranslateTab`과 `toggleTab`은 바꾸지 않는다. 둘 다 응답이 없으면 `translateTab`으로 이어진다.

팝업을 연 채 뷰어로 바뀌면 팝업의 "이 사이트는 항상 번역"은 PDF가 있던 출처를 계속 가리킨다. 해로운 동작이 아니므로 고치지 않는다.

### `src/content/index.ts`

조건을 `if (document.body && document.contentType !== "application/pdf")`로 바꾼다. PDF 문서에 스크립트가 들어와도 컨트롤러와 메시지 수신기를 만들지 않는다. 그래서 다음이 함께 해결된다.

- 내장 뷰어에서 0개를 번역하고 "번역 완료"로 표시되던 문제
- 자동 번역 사이트의 PDF가 내장 뷰어에 그대로 남는 동작 (결정 6)
- 자동 번역 사이트의 PDF에서 번역을 누를 때 `sendToTab`이 응답하지 않아 뷰어로 전환되는 동작

`__aitranslatorAutoRun`을 읽고 지우는 코드는 조건문 안에 그대로 둔다.

### `src/content/commands.ts`

`listen()`을 옮기고 이름을 바꾼다. 메시지 처리 내용은 그대로 둔다.

```ts
/** 팝업·단축키의 명령을 받는 쪽. TranslationController와 PDF 뷰어가 구현한다. */
export interface CommandTarget {
  state(): PageState;
  translate(): unknown;
  retranslate(): Promise<void>;
  showOriginal(): Promise<void>;
}
export function listenForCommands(target: CommandTarget): void;
```

## 6. 뷰어 상태

`viewer.ts`는 단계를 하나의 변수로 관리한다.

```ts
type Phase =
  | { kind: "opening" }                 // 주소 해석, 권한 대기, 파일 대기, 받기, 첫 쪽 렌더링
  | { kind: "failed"; message: string } // 받기 실패, 암호, 열기 실패, 텍스트 없음
  | { kind: "ready" };                  // 컨트롤러로 번역을 시작함
```

`listenForCommands`에는 다음 대상을 넘긴다.

| 명령 | `opening` | `failed` | `ready` |
|---|---|---|---|
| `state()` | `translating`, 진행률 0/0 | `error`, `message`, 진행률 0/0 | `controller.state()` |
| `translate()` | 무시 | 무시 | `controller.translate()` |
| `retranslate()` | 무시 | 무시 | `controller.retranslate()` |
| `showOriginal()` | 무시 | 무시 | `controller.showOriginal()` |

`translate`가 첫 쪽의 번역층이 생기기 전에 돌면 0개를 번역하고 "번역 완료"가 된다. 그래서 `ready`로 바꾸는 곳은 13번 단계 하나뿐이다.

### 시작 순서

1. `document.title`을 파일명으로 정한다 (9절).
2. `listenForCommands`를 등록한다. `phase`는 `opening`이다.
3. `location.search`의 `file` 값을 읽는다. `http:`, `https:`가 아니면(없음, `file:`, 잘못된 주소) 7번으로 간다.
4. `chrome.permissions.contains({ origins: [originPattern(origin)] })`로 확인한다. 권한이 있으면 8번으로 간다.
5. 권한 안내와 "허용" 버튼을 보여 준다.
6. 버튼을 누르면 클릭 핸들러 안에서 `await` 없이 바로 `chrome.permissions.request`를 부른다. 허용하면 8번, 거부하면 거부 문구로 바꾸고 버튼을 그대로 둔다.
7. 로컬 파일 안내와 `<input type="file" accept="application/pdf,.pdf">`를 보여 준다. 파일을 고르면 `file.arrayBuffer()`를 읽어 10번으로 간다. `document.title`을 고른 파일 이름으로 바꾼다.
8. `#notice-text`에 "PDF를 받는 중…"을 보여 주고 `fetch(source, { credentials: "include" })`를 부른다.
9. 실패하면 `failed`로 바꾼다. `!response.ok`는 HTTP 문구, 예외는 네트워크 문구다. 성공하면 `arrayBuffer()`를 읽는다.
10. `#notice`를 숨기고 `pdfjsLib.getDocument`로 문서를 연다 (8.1절). 실패하면 `failed`로 바꾼다. `err.name === "PasswordException"`이면 암호 문구, 그 밖에는 열기 실패 문구다.
11. 처음 5쪽(문서가 더 짧으면 전체)의 `getTextContent()`에 공백이 아닌 항목이 하나도 없으면 `phase`를 텍스트 없음 문구의 `failed`로 바꾼다. 문서는 12번에서 그대로 보여 준다.
12. `failed`가 아니면 `findReferences`로 참고문헌 위치를 찾는다(9.5절). `failed` 여부와 상관없이 `viewer.setDocument`, `linkService.setDocument`를 부른다.
13. 첫 번역층을 붙인 직후 `phase`를 `ready`로 바꾸고 `controller.translate()`를 한 번 부른다.

`failed`가 되면 `#notice`에 문구를 보여 준다. 원본 주소가 `http:`, `https:`이면 "원본 PDF 열기" 링크도 보여 준다. `href`는 원본 주소이고 같은 탭에서 열린다. 텍스트 없음일 때도 같다.

### 원본 주소의 쪽 번호

`pagesinit`에서 `viewer.currentScaleValue = "page-width"`로 정한다. 원본 주소의 `#` 뒤 문자열에서 `/(?:^|&)page=(\d+)/`로 쪽 번호를 찾아 1 이상 `pagesCount` 이하이면 `viewer.currentPageNumber`에 넣는다.

## 7. 뷰어 화면

### 페이지 구조

```html
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
    <input id="file" type="file" accept="application/pdf,.pdf" hidden>
    <a id="open-original" hidden>원본 PDF 열기</a>
  </section>
  <div id="viewerContainer"><div id="viewer" class="pdfViewer"></div><div id="overlays"></div></div>
  <script type="module" src="viewer.js"></script>
</body>
```

`pdf_viewer.css`를 먼저, `viewer.css`를 나중에 불러온다. 스타일은 팝업처럼 꾸밈 없이 시스템 라이트·다크를 따른다.

레이아웃은 도구 막대 높이 36px 고정이다. `#viewerContainer`는 `position: absolute; top: 36px; left: 0; right: 0; bottom: 0; overflow: auto`다. PDFViewer가 요구하므로 `absolute`를 유지한다. `#notice`는 도구 막대 바로 아래에 겹쳐 뜬다 (`position: absolute; top: 36px; z-index: 10`).

### 도구 막대

- `#page-info`: `pagechanging` 이벤트로 `{현재 쪽} / {전체 쪽}`을 갱신한다.
- `#zoom-out`, `#zoom-in`: `viewer.decreaseScale()`, `viewer.increaseScale()`
- `#toggle`, `#status`: 500ms마다 대상의 `state()`를 읽어 갱신한다.

| 상태 | `#status` | `#toggle` |
|---|---|---|
| `opening` | 비움 | 숨김 |
| `translating` | `번역 중… {완료}/{전체}` | `원문 보기` |
| `translated` | `번역 완료` | `원문 보기` |
| `original` | `원문 표시 중` | `번역` |
| `error` (ready) | 오류 문구 | `번역` |
| `failed` | 오류 문구 | 숨김 |
| `idle` | 비움 | `번역` |

`opening`과 ready의 `translating`은 명령 응답에서는 같지만, 도구 막대는 `phase`를 보고 구분한다. `partial`이 true이면 팝업처럼 `#status`에 일부 실패 문구를 덧붙이지 않는다. 일부 실패는 기존 토스트가 알린다.

`#toggle`을 누르면 `#toggle`이 `원문 보기`일 때 `showOriginal()`, `번역`일 때 `translate()`를 부른다.

## 8. pdf.js 연결

### 8.1 불러오기

`src/pdf/pdfjs.ts`는 다음 순서를 지킨다.

```ts
import * as pdfjsLib from "pdfjs-dist";

// web/pdf_viewer.mjs는 불러올 때 globalThis.pdfjsLib를 읽는다. 이 파일을 먼저 import한다.
(globalThis as { pdfjsLib?: typeof pdfjsLib }).pdfjsLib = pdfjsLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("pdf/pdf.worker.min.mjs");

export { pdfjsLib };
```

`viewer.ts`의 첫 import는 `./pdfjs`, 그다음이 `pdfjs-dist/web/pdf_viewer.mjs`다.

문서를 여는 호출은 다음과 같다.

```ts
pdfjsLib.getDocument({
  data,
  cMapUrl: chrome.runtime.getURL("pdf/cmaps/"),
  standardFontDataUrl: chrome.runtime.getURL("pdf/standard_fonts/"),
  wasmUrl: chrome.runtime.getURL("pdf/wasm/"),
  iccUrl: chrome.runtime.getURL("pdf/iccs/"),
}).promise;
```

뷰어는 다음과 같이 만든다.

```ts
const eventBus = new EventBus();
const linkService = new PDFLinkService({ eventBus, externalLinkTarget: LinkTarget.BLANK });
const viewer = new PDFViewer({
  container, viewer: viewerElement, eventBus, linkService,
  annotationMode: pdfjsLib.AnnotationMode.ENABLE,
});
linkService.setViewer(viewer);
```

`EventBus`, `LinkTarget`, `PDFLinkService`, `PDFViewer`는 `pdfjs-dist/web/pdf_viewer.mjs`에서 가져온다. 텍스트층은 기본값으로 켜져 있어 지정하지 않는다. `scriptingManager`와 양식 입력은 쓰지 않는다.

### 8.2 빌드

`scripts/build.mjs`:

- ESM 엔트리에 `{ in: "src/pdf/viewer.ts", out: "pdf/viewer" }`를 더한다.
- `staticFiles`에 `src/pdf/viewer.html`, `src/pdf/viewer.css`를 더한다.
- 번들하지 않는 pdf.js 자원을 별도 목록으로 두고 빌드 시작 때 한 번 복사한다.

| 원본 (`node_modules/pdfjs-dist/`) | 대상 (`dist/pdf/`) |
|---|---|
| `build/pdf.worker.min.mjs` | `pdf.worker.min.mjs` |
| `web/pdf_viewer.css` | `pdf_viewer.css` |
| `web/images/` | `images/` |
| `cmaps/` | `cmaps/` |
| `standard_fonts/` | `standard_fonts/` |
| `wasm/` | `wasm/` |
| `iccs/` | `iccs/` |

디렉터리는 `cp(from, to, { recursive: true })`로 복사한다. `--watch`의 감시 대상에는 넣지 않는다.

## 9. 문단 만들기

좌표는 전부 **`page.getViewport({ scale: 1 })` 기준의 PDF 포인트**이고 원점은 왼쪽 위다. 이렇게 하면 회전한 쪽과 잘린 쪽(cropBox)도 같은 코드로 처리된다.

`layout.ts`의 공개 함수는 다음과 같다.

```ts
export interface TextItemLike { str: string; transform: number[]; width: number; height: number }
export interface Block {
  text: string;
  left: number; right: number; top: number; bottom: number; // 포인트
  size: number;        // 본문 글자 크기(포인트)
  centered: boolean;
  lines: number;       // 줄 수
  wideLines: number;   // wideGaps가 1 이상인 줄 수
}
export function pageBlocks(items: readonly TextItemLike[], viewportTransform: readonly number[], pageWidth: number): Block[];
export function isReferencesHeading(text: string): boolean;
export function skipReason(block: Block): "no-letters" | "table" | "math" | "short" | undefined;
export function translatableBlocks(blocks: readonly Block[], pageNumber: number, references: ReferencesStart | undefined): Block[];
export interface ReferencesStart { pageNumber: number; headingIndex: number }
```

`pageBlocks`는 9.1~9.4절을 차례로 수행한다.

### 9.1 텍스트 조각

각 항목에 뷰포트 변환을 곱해 `[a, b, c, d, x, y]`를 구한다. 공백뿐인 항목, `|b| > 0.01`, `|c| > 0.01`, `a <= 0`인 항목은 버린다 (세로·회전 글자). 글자 크기는 `Math.hypot(c, d) || item.height`이고 0이면 버린다.

### 9.2 줄

항목을 받은 순서대로 처리한다. 앞 줄의 기준 글자 크기를 `s = max(현재 항목 크기, 줄 크기)`라 할 때, 다음을 모두 만족하면 같은 줄이다.

- `|항목 y − 줄 y| < 0.6 × s`
- `항목 x ≥ 줄 오른쪽 − s`

같은 줄에 붙일 때:

- 간격 `항목 x − 줄 오른쪽`이 `2 × s`를 넘으면 그 줄의 `wideGaps`를 1 늘린다.
- 간격이 `0.12 × s`를 넘고 앞 글자가 공백으로 끝나지 않고 항목이 공백으로 시작하지 않으면 공백 하나를 넣는다.
- 항목 문자열이 줄에서 가장 길면 그 항목의 크기와 y를 줄의 크기와 y로 삼는다. 위첨자가 줄 기준이 되는 것을 막기 위해서다.

줄의 위쪽은 `y − 0.85 × 크기`, 아래쪽은 `y + 0.27 × 크기`의 최솟값·최댓값이다.

### 9.3 문단

줄을 순서대로 처리하고 앞 줄 `p`, 현재 문단 `b`, 현재 줄 `l`, `s = max(l.size, p.size)`로 다음을 계산한다.

| 이름 | 조건 |
|---|---|
| `centered` | 두 줄 중심 차이 ≤ `s` 이고, 한 줄 폭이 다른 줄 폭의 0.8배 미만 |
| `sizeOk` | `|l.size − b.size| ≤ 0.6` |
| `gapOk` | `0.4 × s < l.y − p.y < 1.7 × s` |
| `overlapOk` | 두 줄의 가로 겹침 > `0.3 × 짧은 줄 폭` |
| `leftOk` | `centered` 또는 `|l.left − b.left| ≤ 2.5 × s` |
| `indented` | `centered`가 아니고 `l.left > b.left + 0.7 × s` |
| `prevShort` | `centered`가 아니고 문단이 2줄 이상이고 `p.right < b.right − 3 × s` |

`sizeOk && gapOk && overlapOk && leftOk && !indented && !prevShort`이면 같은 문단이다.

줄을 이을 때 앞 줄이 `소문자-`로 끝나고 다음 줄이 소문자로 시작하면 하이픈을 지우고 공백 없이 붙인다. 그 밖에는 공백 하나로 잇는다. `centered`로 이었으면 문단의 `centered`를 true로 둔다.

### 9.4 마무리

1. 한 줄 문단의 중심이 쪽 중심에서 쪽 폭의 1% 이내이고 폭이 쪽 폭의 90% 미만이면 `centered`를 true로 둔다.
2. 모든 문단 쌍을 비교해 가로로 겹치고 `c.top`이 `a.top`보다 아래이면서 `a.bottom`보다 위이면, 겹친 영역의 가운데를 양쪽 경계로 삼는다. 글자가 겹치지 않게 하기 위해서다.

### 9.5 번역 대상 고르기

`skipReason`은 앞뒤 공백을 뗀 텍스트로 다음 순서대로 판단한다.

| 사유 | 조건 |
|---|---|
| `no-letters` | `\p{L}`이 없음 |
| `table` | `wideLines ÷ lines ≥ 0.5` |
| `math` | 글자 수 ÷ 전체 길이 < 0.5 |
| `short` | 2글자 이상 단어가 3개 미만이고, 제목 번호 형식이 아니고, 대문자로 시작하는 한 단어가 아니고, 대문자·공백만으로 된 텍스트가 아님 |

제목 번호 형식은 `/^(?:[IVX]+\.|[A-Z]\.|\d+(?:\.\d+)*\.?)\s+\S/`다. 한 단어는 `/^[A-Z][a-z]+$/`, 대문자 제목은 `/^[A-Z ]+$/`다.

`isReferencesHeading`은 `/^(?:[IVX]+\.?\s+|\d+\.?\s+)?(?:references|bibliography)$/i`로 판단한다.

`findReferences`는 `viewer.ts`에 두고 마지막 쪽부터 앞으로 최대 30쪽을 살핀다. 쪽 안에서는 문단을 앞에서 뒤로 보고 처음 맞는 문단의 위치를 `ReferencesStart`로 돌려준다. 찾으면 멈춘다.

`translatableBlocks`는 다음을 따른다.

- 그 쪽 번호가 `references.pageNumber`보다 크면 빈 배열
- 같으면 `headingIndex` 앞의 문단만 대상
- `skipReason`이 있는 문단은 제외

참고문헌 뒤에 부록이 있으면 그 부록도 번역하지 않는다. 알려진 한계이며 README에 적는다.

## 10. 번역층

### 10.1 구조

```
#overlays                position: absolute; top: 0; left: 0; width: 0; height: 0; pointer-events: none
  .pdf-layer[data-page]  position: absolute; z-index: 5; overflow: hidden
    p.pdf-block          position: absolute; visibility: hidden
      #text              원문
```

`#overlays`가 `TranslationController`의 루트다. `pointer-events: none`이므로 링크 클릭이 아래로 내려간다 (결정 5). `p`는 `BOUNDARY_TAGS`에 있어 문단 하나가 그룹 하나가 되고, 세그먼트도 하나다.

`.pdf-block` 스타일:

```css
margin: 0;
box-sizing: border-box;
color: #000;
background: #fff;
font-family: "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif;
line-height: 1.28;
word-break: keep-all;
overflow-wrap: anywhere;
white-space: normal;
```

`data-translated` 속성이 있으면 `visibility: visible`이다.

### 10.2 `src/pdf/overlay.ts`

```ts
export class PdfOverlay {
  constructor(root: HTMLElement, container: HTMLElement, viewerElement: HTMLElement, viewer: PDFViewer);
  /** 쪽 번호의 번역층을 만들어 root에 붙이고 위치를 맞춘다. 같은 쪽을 두 번 부르지 않는다 (10.3절의 2번이 막는다). */
  addPage(pageNumber: number, blocks: readonly Block[], viewport: { width: number; height: number }, canvas: HTMLCanvasElement | null): void;
  /** 모든 번역층을 페이지 위치에 맞춘다. */
  place(): void;
}
```

생성자에서 다음을 건다.

- `#viewer`에 `ResizeObserver`를 걸어 `place()`
- `root`에 `MutationObserver({ characterData: true, subtree: true })`를 걸어 표시 전환

`viewer.ts`는 `eventBus.on("scalechanging", () => requestAnimationFrame(() => overlay.place()))`를 건다.

`place()`:

```ts
root.style.setProperty("--pdf-scale", String((viewer.currentScale * 96) / 72)); // CSS 픽셀 ÷ PDF 포인트
// 쪽마다
const div = viewer.getPageView(pageNumber - 1).div;
const page = div.getBoundingClientRect();
const box = container.getBoundingClientRect();
layer.style.left = `${page.left - box.left + container.scrollLeft + div.clientLeft}px`;
layer.style.top = `${page.top - box.top + container.scrollTop + div.clientTop}px`;
layer.style.width = `${div.clientWidth}px`;
layer.style.height = `${div.clientHeight}px`;
```

### 10.3 쪽 추가

`viewer.ts`의 `pagerendered` 처리:

1. `phase`가 `failed`이거나 `evt.isDetailView` 또는 `evt.error`가 있으면 무시한다.
2. 처리 중이거나 처리한 쪽이면 무시한다 (`Set<number>`).
3. `pageView.pdfPage`로 `getViewport({ scale: 1 })`, `getTextContent()`를 얻는다.
4. `pageBlocks`와 `translatableBlocks`로 문단을 고른다.
5. `overlay.addPage`로 붙인다.
6. `phase`가 `opening`이면 6절의 13번을 수행한다.

쪽의 PDFViewer 캐시가 지워졌다가 다시 그려져도 번역층은 지우지 않는다. 그래서 다시 번역하지 않는다.

문단 요소 하나의 스타일은 다음과 같다. 값은 쪽 크기에 대한 백분율이다.

```
left   = (block.left − 2) ÷ 쪽 폭
width  = (block.right − block.left + 4) ÷ 쪽 폭
top    = block.top ÷ 쪽 높이
height = (block.bottom − block.top) ÷ 쪽 높이
```

`block.centered`이면 `text-align: center`다.

배경색은 쪽 캔버스(`pageView.div.querySelector("canvas")`)의 `(left − 2, top)` 위치 픽셀을 `getImageData`로 읽어 `rgb(...)`로 넣는다. 밝기 `0.299R + 0.587G + 0.114B < 128`이면 글자색을 `#fff`로 둔다. 캔버스나 컨텍스트를 얻지 못하거나 예외가 나면 CSS 기본값을 쓴다.

문단 요소의 텍스트는 `document.createTextNode(block.text)`로만 넣고 원문을 `WeakMap<Text, string>`에 저장한다. `innerHTML`은 쓰지 않는다.

### 10.4 표시 전환과 글자 크기

`MutationObserver` 처리:

- 텍스트가 원문과 다르면 `data-translated`를 붙이고 글자 크기를 맞춘다.
- 원문과 같으면 `data-translated`를 지운다.

글자 크기 맞춤:

```ts
for (let percent = 100; percent >= 60; percent -= 5) {
  p.style.fontSize = `calc(var(--pdf-scale) * ${((size * percent) / 100).toFixed(2)}px)`;
  if (p.scrollHeight <= p.clientHeight + 1) break;
}
```

루프가 끝날 때까지 맞지 않으면 60% 크기로 두고 아래로 넘치게 둔다. 글자 크기와 상자가 같은 배율로 커지므로 확대·축소할 때 다시 맞추지 않는다.

## 11. 기록, 문서, 테스트

### 11.1 기록

`TranslationController`의 생성자를 `constructor(root: Element, options: { pageUrl?: () => string } = {})`로 바꾼다. 기본값은 지금의 `pageUrl()`이다. 클래스 안의 `pageUrl()` 호출을 모두 주입된 함수로 바꾼다.

뷰어는 `pageUrl: () => source.split(/[?#]/)[0]!`를 넘긴다. 원본 주소가 없으면(로컬 파일) `location.href.split(/[?#]/)[0]!`를 쓴다.

`document.title`은 원본 주소의 마지막 경로 조각을 `decodeURIComponent`한 값이다. 디코딩에 실패하면 조각 그대로, 비어 있으면 `PDF`다. 파일을 고른 경우에는 `file.name`이다. 기록의 제목은 지금처럼 `document.title`을 쓴다.

### 11.2 문서

`SPEC.md`:

- 8장 로드맵에 PDF 번역을 추가된 항목으로 적는다.
- 9장 구조에 `src/pdf/`를 더한다.

`README.md`:

- 사용법: PDF 탭에서 번역하면 뷰어로 바뀌고, 사이트별 첫 사용 때 "허용"을 눌러야 하며, 보이는 쪽부터 번역한다는 내용. 내 컴퓨터의 PDF는 파일을 골라야 한다는 내용
- 권한 표: 선택 권한의 쓰임에 "PDF를 받을 때 그 사이트만 요청"
- 알려진 제한: 스캔본·암호 PDF, 표 안 글자·수식·그림 속 글자, 참고문헌과 그 뒤의 부록, 단·쪽을 넘는 문단은 조각별로 번역, 번역문을 드래그하면 영어가 복사됨
- 구조: `src/pdf/`, `tests/helpers/pdf-builder.ts`

### 11.3 자동 테스트

단위 테스트는 레이아웃 규칙, 주소 함수, 표시 전환을 다룬다. 레이아웃 입력은 `transform`을 직접 쓴 항목 배열이고 뷰포트 변환은 `[1, 0, 0, -1, 0, 792]`다. 다음을 포함한다.

- 같은 줄, 위첨자, 다음 줄
- 줄 끝 하이픈 잇기
- 첫 줄 들여쓰기에서 문단 나누기, 짧은 마지막 줄 뒤에서 문단 나누기
- 2단(왼쪽 단 끝 다음 오른쪽 단 시작)을 잇지 않음
- 가운데 정렬 제목 잇기, `centered`
- 표(`wideGaps`), 수식, 짧은 라벨 제외, 제목 번호 유지
- 회전 글자 제외
- 위아래 문단 겹침 정리
- 참고문헌 전후 처리

`tests/helpers/pdf-builder.ts`는 Helvetica만 쓰는 PDF를 `Buffer`로 만든다. 입력은 쪽별 `{ text, x, y, size }[]`다.

`tests/e2e/pdf.spec.ts`는 기존 패턴대로 `TEST_EXTENSION_PATH`, `context.route`, `mockTranslationApi`, `openPopup`을 쓴다. `http://aitranslator.test/*.pdf`를 만든 PDF로 응답한다.

| 번호 | 시나리오 | 확인 |
|---|---|---|
| 1 | 팝업에서 번역 | 주소가 뷰어로 바뀌고, 번역문이 대문자로 보이며, 팝업이 "번역 완료" |
| 2 | 조기 완료 없음 | gated 목 API로 막은 동안 팝업이 "번역 완료"가 아님 |
| 3 | 원문 ↔ 번역 | 원문 보기에서 `[data-translated]` 0개, 다시 번역해도 API 호출이 늘지 않음 |
| 4 | 스크롤 번역 | 6쪽 PDF에서 첫 요청에 마지막 쪽 문장이 없고, 스크롤하면 요청됨 |
| 5 | 위치 | 확대 후 `.pdf-layer`가 `.page`의 안쪽 영역과 1px 이내로 일치 |
| 6 | 마우스 | `.pdf-block`의 계산된 `pointer-events`가 `none` |
| 7 | 뒤로 가기 | 뒤로 가면 원본 PDF 주소 |
| 8 | 권한 안내 | 권한 없는 `http://other.test/a.pdf`로 뷰어를 열면 안내와 "허용" 버튼이 보임 |
| 9 | 로컬 파일 | `?file=file:///a.pdf`에서 안내와 파일 입력이 보이고, 파일을 고르면 번역됨 |
| 10 | 받기 실패 | 404 응답에서 HTTP 문구와 "원본 PDF 열기" |
| 11 | 텍스트 없음 | 글자 없는 PDF에서 문구가 보이고 API 호출 없음 |
| 12 | 내장 뷰어 스크립트 | PDF 문서에 `content.js`를 넣어도 메시지 수신기가 없음 |
| 13 | 기록 | 기록의 주소가 원본 PDF 주소, 제목이 파일명 |
| 14 | 오류 | 401이면 뷰어에 토스트와 "설정 열기" |

완료 기준 명령:

```sh
npm run typecheck
npm test
npm run test:e2e
```

전부 통과해야 한다. `npm run test:live`는 인터넷이 필요하므로 완료 기준에 넣지 않는다.

### 11.4 수동 확인

Playwright로 자동화할 수 없다. 구현자는 이 목록을 완료 보고에 그대로 넣어 사용자에게 넘기고, 확인했다고 적지 않는다.

1. 실제 권한 창에서 "허용"과 거부
2. 내장 뷰어에서 Option+T
3. 내장 뷰어의 우클릭 메뉴에 번역 항목이 보이는지. 보이지 않으면 12.1절대로 보고한다 (임의로 메뉴 조건을 바꾸지 않음)
4. 실제 팝업에서 번역을 누른 뒤의 화면 전환
5. 본문 링크 클릭

## 12. 작업 방식

- 작업은 브랜치 `pdf-translation`에서 한다. 첫 커밋에 이 설계서, 구현 계획서, `SPEC.md` 변경을 넣는다.
- 커밋은 작업 단위로 하고 **push하지 않는다**. 작성자는 `git -c user.name="dlawhdgur01" -c user.email="dlawhdgur01@gmail.com" commit`이다.
- `npm install`이 `~/.npm` 권한 문제로 실패하면 `--cache`로 임시 경로를 지정한다.
- 실제 API 키가 필요한 시험은 이 작업의 완료 기준이 아니다.
