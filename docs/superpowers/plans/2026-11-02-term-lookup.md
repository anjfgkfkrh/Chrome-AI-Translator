# 원문 찾기 구현 계획

> **구현자 안내:** herdr로 띄운 Sonnet 에이전트가 이 계획을 작업 순서대로 직접 구현한다. 서브에이전트를 만들지 않고, brainstorming·writing-plans를 다시 돌리지 않는다. 단계는 체크박스(`- [ ]`)로 관리한다.

**목표:** 번역문을 Option+드래그하면 화면 위치를 바꾸지 않고 라벨로 원문 용어, 문장 또는 문단을 보여 준다.

**구조:** `TranslationController`가 `TermLookup`을 만들어 웹과 PDF가 같은 경로를 쓴다. `TermLookup`은 선택을 문단 정보로 바꿔 백그라운드에 묻고, 백그라운드는 제공업체의 Haiku로 찾은 답을 문단 원문과 대조해 돌려준다. PDF는 Option을 누른 동안만 번역문이 마우스를 받는다.

**기술:** TypeScript, Chrome MV3, vitest(jsdom), Playwright.

**스펙:** `docs/superpowers/specs/2026-11-02-term-lookup-design.md`. 값과 문구는 스펙이 기준이다.

## 공통 제약

- 번역문 텍스트 노드와 페이지 요소를 바꾸지 않는다(`SPEC.md` 1.2). `innerHTML`을 쓰지 않는다. 라벨 글자는 `textContent`로만 넣는다.
- 기존 테스트의 기대 동작을 바꾸지 않는다. 바꿔야 하면 멈추고 보고한다. `TranslationProvider`에 메서드가 늘어 생기는 타입 맞춤(테스트의 가짜 제공업체에 `findSource` 추가)은 동작 변경이 아니므로 해도 된다.
- 주석과 문구는 주변 코드처럼 한국어로 쓴다.
- 고정 값: 선택 60자, 문단 20,000자, `max_tokens` 512, 제한 시간 15,000ms, 재시도 없음, 문구 `찾는 중…`·`원문 문장`·`문단 원문`.
- 작업 끝마다 `npm run typecheck`와 `npm test`를 통과시킨다.
- API 키를 출력하거나 로그에 남기지 않는다. 실제 API를 호출하는 `npm run test:live`와 `claude_api_key.txt`, `openrouter_api_key.txt`는 쓰지 않는다.
- `term-lookup` 브랜치에 작업 단위로 커밋한다. push하지 않는다. 다른 브랜치를 바꾸지 않는다.
- 커밋 명령: `git -c user.name="dlawhdgur01" -c user.email="dlawhdgur01@gmail.com" commit ...`. 제목은 기존 기록처럼 짧은 한국어로 쓴다(예: `PDF 두 쪽 보기`). 첫 커밋은 `SPEC.md`와 이 계획서, 스펙 문서다.

## 멈추고 보고할 조건

`SPEC.md` 12.1의 모든 경우에 멈추고 상위 에이전트에게 보고한 뒤 답을 기다린다. 특히 다음 경우다.

- 스펙에 없는 동작, 수치, 화면 문구를 정해야 할 때
- 기존 테스트의 기대 동작을 바꿔야 할 때
- `SPEC.md` 1.2 원칙을 어겨야만 해결될 때
- 외부 API가 스펙과 다르게 동작할 때
- 같은 오류를 두 번 고쳐도 해결되지 않을 때
- 스펙 9절의 미검증 사실이 실패했을 때

내부 이름과 파일 안의 구조는 구현자가 정한다.

## 검토 초점

1. 페이지가 번역 뒤 텍스트를 바꾼 노드: `blockOf()`가 `undefined`를 돌려주고 찾지 않는다.
2. 확장을 새로고침해 메시지가 실패함: 라벨이 `찾는 중…`에 멈추지 않고 문단 원문을 보여 준다.
3. 입력란 안의 선택이나 라벨 안의 드래그: 찾기를 시작하지 않는다.
4. 화면 맨 위의 단어: 라벨이 잘리지 않고 아래로 내려온다.
5. 페이지 글자에 HTML이나 지시문이 있음: 라벨에 글자 그대로 나오고, 원문에 없는 응답은 거절한다.

---

### 작업 1: 문단 정보

**파일:**
- 수정: `src/content/apply.ts`, `src/content/page-translator.ts`
- 시험: `tests/unit/apply.test.ts`, `tests/unit/page-translator.test.ts`

**제공:**
- `apply.ts`: `export interface BlockText { original: string; translated: string }`
- `TextReplacer.remember(unit: TextUnit, translated: string, block: BlockText): void`
- `TextReplacer.blockOf(node: Text): BlockText | undefined`
- `PageTranslator.blockOf(node: Text): BlockText | undefined`: `mode`가 translation일 때만 값이 있다.

같은 그룹의 노드는 같은 `BlockText` 객체를 공유한다. 작업 6의 여러 문단 판정이 객체 동일성을 쓴다.

- [ ] **1단계: 실패하는 시험 작성**

`apply.test.ts`: `blockOf`가 번역문을 보여 주는 노드에만 값을 돌려주고, 원문 상태·`clear()` 뒤·페이지가 값을 바꾼 노드에는 `undefined`.
`page-translator.test.ts`: 두 세그먼트 그룹의 두 노드가 같은 객체를 돌려줌(`toBe`), `original`이 그룹 전체, `context`가 있으면 `original === context`, `showOriginal()` 뒤 `undefined`.

- [ ] **2단계:** `npx vitest run tests/unit/apply.test.ts tests/unit/page-translator.test.ts` → 실패 확인
- [ ] **3단계: 구현.** `PageTranslator.remember()`가 그룹마다 `BlockText`를 하나 만든다. 공백은 `/\s+/g`→`" "`로 정리한다. `translated`는 `withoutRepeatedPunctuation`을 적용한 번역문을 잇는다.
- [ ] **4단계:** 같은 명령 → 통과 확인, 이어서 `npm test` 전체 통과

### 작업 2: 프롬프트와 검증

**파일:**
- 생성: `src/shared/source-text.ts`, `src/background/source-prompt.ts`
- 수정: `src/shared/messages.ts`
- 시험: `tests/unit/source-prompt.test.ts`

**제공:**
- `source-text.ts`: `MAX_SELECTION_LENGTH = 60`, `MAX_BLOCK_LENGTH = 20_000`, `normalizeSource(text: string): string`
- `messages.ts`: `FindSourceRequest { selection: string; original: string; translated: string }`, `SourceMatch { kind: "term" | "sentence"; text: string }`, `FindSourceResult = SourceMatch | { kind: "failed" }`, `Message`에 `{ type: "find-source" } & FindSourceRequest`, `Responses`에 `"find-source": FindSourceResult`
- `source-prompt.ts`: `SOURCE_SYSTEM_PROMPT`, `SOURCE_RESPONSE_SCHEMA`, `SOURCE_MAX_TOKENS = 512`, `sourceUserMessage(req: FindSourceRequest): string`, `parseSourceResponse(text: string, original: string): SourceMatch`

`SOURCE_SYSTEM_PROMPT`와 스키마, 정규화 3단계는 스펙 6절 그대로 쓴다. 사용자 메시지 키는 `selection`, `translation`, `source`다.

- [ ] **1단계: 실패하는 시험 작성**

- `normalizeSource("ﬁnding  the\ntarget") === "finding the target"`
- `normalizeSource("atten- tion") === "attention"`
- `normalizeSource("state-of-the-art") === "state-of-the-art"`
- `parseSourceResponse('{"kind":"term","text":"attention mechanism"}', "The attention mechanism works.")` → `{ kind: "term", text: "attention mechanism" }`
- `"sentence"`도 같음. 앞뒤 공백은 자른다. 코드 울타리로 감싼 JSON도 읽는다.
- 원문에 없는 `text`, 빈 `text`, 틀린 `kind`, JSON이 아닌 응답 → `ProviderError`이고 `kind === "format"`
- PDF 합자 원문 `"ﬁnding the target"`에 응답 `"finding the target"` → 통과

- [ ] **2단계:** `npx vitest run tests/unit/source-prompt.test.ts` → 실패 확인
- [ ] **3단계: 구현.** 코드 울타리 처리는 `prompt.ts`의 `stripCodeFence`를 export해 재사용한다.
- [ ] **4단계:** 같은 명령 → 통과 확인

### 작업 3: 제공업체 `findSource`

**파일:**
- 수정: `src/background/providers/types.ts`, `anthropic.ts`, `openrouter.ts`
- 시험: `tests/unit/anthropic.test.ts`, `tests/unit/openrouter.test.ts`

**사용:** 작업 2 전체.

**제공:**
- `TranslationProvider.findSource(req: FindSourceRequest, opts: FindSourceOptions): Promise<SourceMatch>`
- `FindSourceOptions extends RequestOptions { signal?: AbortSignal }`

`refusal`·`truncated` 처리와 응답 글자 꺼내기는 `translate()`와 같으므로 파일 안의 함수로 묶어 함께 쓴다. `translate()`의 동작은 바꾸지 않는다.

- [ ] **1단계: 실패하는 시험 작성**

Anthropic 요청 본문: `model`은 넘긴 값, `max_tokens: 512`, `system`은 `SOURCE_SYSTEM_PROMPT` 문자열(`cache_control` 없음), `thinking: { type: "disabled" }`, `output_config: { effort: "low", format: { type: "json_schema", schema: SOURCE_RESPONSE_SCHEMA } }`.
OpenRouter 요청 본문: `info.structured`면 `response_format`의 `json_schema.name`이 `"source_lookup"`, 끌 수 있는 모델이면 `reasoning: { effort: "none" }`, `max_tokens`는 모델 한도로 줄임.
두 제공업체 공통: `onUsage` 호출, `refusal`과 잘림에서 `ProviderError`, 원문에 없는 응답에서 `format` 오류.

- [ ] **2단계:** `npx vitest run tests/unit/anthropic.test.ts tests/unit/openrouter.test.ts` → 실패 확인
- [ ] **3단계: 구현.** OpenRouter의 사고 설정은 `reasoningFor(info, true)`를 쓴다.
- [ ] **4단계:** 같은 명령 → 통과, `npm run typecheck` 통과

### 작업 4: 백그라운드 메시지

**파일:**
- 수정: `src/background/index.ts`
- 시험: `tests/unit/background.test.ts`

**사용:** `TranslationProvider.findSource`, `DEFAULT_MODELS`, `activeApiKey`.

**제공:** `find-source` 메시지가 `FindSourceResult`로 응답한다.

- [ ] **1단계: 실패하는 시험 작성**

- 탭에서 온 정상 메시지 → 제공업체 호출, 모델은 `DEFAULT_MODELS[settings.provider]`, 설정 모델이 Opus여도 Haiku
- 응답 사용량이 `recordUsage`로 합산됨, 번역 기록은 쓰지 않음
- `sender.tab` 없음, 문자열 아님, 빈 `selection`, 60자 초과, 문단 20,000자 초과 → `{ kind: "failed" }`이고 호출 없음
- 키 없음, 제공업체 오류 → `{ kind: "failed" }`
- 키가 메시지와 응답에 없음

- [ ] **2단계:** `npx vitest run tests/unit/background.test.ts` → 실패 확인
- [ ] **3단계: 구현.** `isExtensionPage` 확인 앞에서 처리한다. 제한 시간은 `AbortSignal.timeout(15_000)`, 오류는 `console.warn`으로 남긴다. 길이는 `selection.trim().length`로 잰다.
- [ ] **4단계:** 같은 명령 → 통과 확인

### 작업 5: 라벨

**파일:**
- 생성: `src/content/lookup-popup.ts`
- 수정: `src/content/toast.ts` (주석)
- 시험: `tests/unit/lookup-popup.test.ts`

**제공:**
```ts
export type LookupView =
  | { kind: "loading" }
  | { kind: "term"; text: string }
  | { kind: "sentence"; text: string }
  | { kind: "paragraph"; text: string };

export function labelPosition(
  anchor: { left: number; top: number; width: number; bottom: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): { left: number; top: number };

export class LookupPopup {
  show(anchor: DOMRect, view: LookupView): void; // 이미 열려 있으면 먼저 닫는다
  update(view: LookupView): void;
  close(): void;
  contains(event: Event): boolean; // composedPath로 라벨 안의 이벤트인지
}
```

위치·크기·닫기·색은 스펙 7절, 호스트는 스펙 4절 "페이지 DOM"을 따른다. 닫기 리스너는 `show`에서 달고 `close`에서 뗀다.

- [ ] **1단계: 실패하는 시험 작성**

- 네 가지 뷰의 글자와 제목(`찾는 중…`, `원문 문장`, `문단 원문`, 용어는 제목 없음)
- `<img src=x onerror=alert(1)>` 글자가 요소가 아니라 글자로 들어감
- 호스트가 `documentElement` 자식이고 `UI_ATTRIBUTE`가 있으며 Shadow DOM을 씀
- `labelPosition`: 위쪽 8px, 자리가 없으면 아래쪽 8px, 좌우 8px 안
- 바깥 `mousedown`, Esc, 페이지 scroll로 닫힘. 라벨 안 `mousedown`으로는 닫히지 않음. 닫은 뒤 리스너가 남지 않음

- [ ] **2단계:** `npx vitest run tests/unit/lookup-popup.test.ts` → 실패 확인
- [ ] **3단계: 구현**
- [ ] **4단계:** 같은 명령 → 통과 확인

### 작업 6: `TermLookup`과 컨트롤러 연결

**파일:**
- 생성: `src/content/lookup.ts`
- 수정: `src/content/controller.ts`
- 시험: `tests/unit/lookup.test.ts`, `tests/unit/controller.test.ts`

**사용:** `PageTranslator.blockOf`, `BlockText`, `LookupPopup`, `normalizeSource`, `MAX_SELECTION_LENGTH`, `sendMessage`.

**제공:**
```ts
export class TermLookup {
  constructor(
    page: { blockOf(node: Text): BlockText | undefined },
    find?: (request: FindSourceRequest) => Promise<FindSourceResult>, // 기본: sendMessage
    popup?: LookupPopup,
  );
  close(): void;   // 라벨을 닫고 진행 중인 응답을 버린다
  dispose(): void; // 리스너를 뗀다
}
```

`mouseup` 처리 순서:

1. `altKey`가 없거나 라벨 안의 이벤트면 끝.
2. 선택 범위가 없거나 접혀 있으면 끝.
3. 범위 안의 텍스트 노드를 문서 순서로 돈다. 첫 번째로 `blockOf`가 값을 돌려주는 시작 노드가 범위의 첫 텍스트 노드가 아니면 끝. 시작 노드의 `BlockText`와 같은 객체를 가진 노드의 선택 부분만 이어 선택 글자로 삼는다. 첫 노드와 마지막 노드는 오프셋으로 자른다.
4. 자른 뒤 글자가 비면 끝. 60자를 넘으면 `paragraph`.
5. `normalizeSource(원문)`에 `normalizeSource(선택 글자)`가 있으면 `term`으로 선택 글자.
6. 저장된 결과가 있으면 표시.
7. `loading`을 보이고 `find()`. 응답 때 요청 번호가 최신이 아니면 버린다. `term`·`sentence`는 저장 후 표시하고, `failed`나 거부되면 `paragraph`.

위치 기준은 `range.getBoundingClientRect()`다.

- [ ] **1단계: 실패하는 시험 작성** (`Range.prototype.getBoundingClientRect`는 시험에서 채운다)

- Option 없음, 빈 선택, 원문 보기, 번역문이 아닌 선택, 입력란 안의 선택, 라벨 안의 mouseup → `find` 호출 없음
- 60자 초과 → `find` 없음, `paragraph`
- 원문에 그대로 있는 선택 → `find` 없음, `term`
- 정상 → `loading` 다음 `term`, `sentence`도 같음
- 같은 선택 재시도 → `find` 1회, 실패는 저장하지 않음
- `find` 거부 → `paragraph`, `failed` → `paragraph`
- 첫 요청이 끝나기 전에 둘째 찾기 → 첫 응답을 무시
- 두 문단 선택 → `selection`이 첫 문단 부분만
- `TranslationController`: `showOriginal()`, `retranslate()`, `dispose()`에서 `close()` 호출, 번역 전에는 찾지 않음

- [ ] **2단계:** `npx vitest run tests/unit/lookup.test.ts tests/unit/controller.test.ts` → 실패 확인
- [ ] **3단계: 구현.** `TranslationController`에 `lookup`을 만들고, `PageTranslator`를 `page`로 넘긴다.
- [ ] **4단계:** 같은 명령 → 통과, `npm test` 전체 통과

### 작업 7: PDF 번역문 선택

**파일:**
- 수정: `src/pdf/overlay.ts`, `src/pdf/viewer.ts`, `src/pdf/viewer.css`
- 시험: `tests/unit/pdf-overlay.test.ts`

**제공:** `PdfOverlay.setSelectable(selectable: boolean): void`. root의 `data-selectable` 속성을 넣고 뺀다.

- [ ] **1단계: 실패하는 시험 작성.** `setSelectable(true)` → 속성 있음, `false` → 없음, 두 번 불러도 같음.
- [ ] **2단계:** `npx vitest run tests/unit/pdf-overlay.test.ts` → 실패 확인
- [ ] **3단계: 구현.** CSS는 스펙 8절 규칙을 그대로 쓴다. `viewer.ts`는 `window`의 `keydown`·`keyup`(`event.key === "Alt"`), `blur`에서 호출한다.
- [ ] **4단계:** 같은 명령 → 통과 확인

### 작업 8: E2E와 미검증 사실

**파일:**
- 생성: `tests/e2e/lookup.spec.ts`
- 수정: `tests/e2e/sw-helpers.ts`

**제공:** `mockTranslationApi`의 `findSource?: { kind: "term" | "sentence"; text: string } | "error"` 선택 값. 요청의 시스템 프롬프트가 `A reader of a Korean translation`으로 시작하면 찾기 요청으로 처리한다. 기존 호출의 기대를 바꾸지 않는다.

- [ ] **1단계: 시험 작성**

마우스 드래그는 `page.keyboard.down("Alt")`, `page.mouse.move/down/up`, `page.keyboard.up("Alt")`을 쓴다.

- 웹: `tests/fixtures/sentences.html`에서 스펙 9절 E2E 항목 전부
- PDF: 기존 `pdf.spec.ts` 도우미로 PDF를 열어 스펙 9절 항목 전부
- 링크가 있는 번역문에서 짧은 Option+드래그 → 다운로드와 이동이 일어나지 않음

- [ ] **2단계:** `npm run test:e2e` → `lookup.spec.ts`와 기존 E2E 전체 통과. 실패 시 원인을 보고, 미검증 사실의 실패면 멈추고 보고한다.
- [ ] **3단계:** 커밋

### 작업 9: 문서와 버전

**파일:**
- 수정: `README.md`, `GUIDE.md`, `manifest.json`, `package.json`, `package-lock.json`

- [ ] **1단계:** `README.md`와 `GUIDE.md`에 조작법을 쓴다: 번역문을 Option(Windows는 Alt)+드래그하면 원문을 볼 수 있음, 찾기마다 소량의 API 비용이 듦, 일반 드래그는 그대로임. Windows 동작은 시험하지 않았으므로 보장한다고 쓰지 않는다.
- [ ] **2단계:** 버전을 0.4.0으로 올린다.
- [ ] **3단계: 마감 확인.** `npm run typecheck`, `npm test`, `npm run test:e2e`, `npm run build`를 실행한다.
- [ ] **4단계:** 커밋하고, 3단계 결과 숫자와 커밋 목록을 상위 에이전트에게 보고한다.
