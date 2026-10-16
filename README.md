# AITranslator

Claude(Anthropic API)로 웹 페이지를 한국어로 번역하는 Chrome 확장 프로그램입니다.

- 페이지의 **텍스트 노드 값만** 바꿉니다. 요소, 속성, 이벤트는 그대로라서 번역한 뒤에도 메뉴, 검색, 버튼이 원래대로 동작합니다.
- "원문 보기"를 누르면 API 호출 없이 곧바로 원문으로 돌아갑니다.
- 링크나 굵은 글씨로 나뉜 문장도 문장 단위로 번역합니다. 화면에 보이는 부분부터 번역합니다.

설계와 결정 사항은 [SPEC.md](SPEC.md)에 있습니다.

## 설치

필요한 것: Chrome, Node.js와 npm, [Anthropic API 키](https://console.anthropic.com/)

```sh
npm install
npm run build
```

1. Chrome에서 `chrome://extensions`를 엽니다.
2. 오른쪽 위의 "개발자 모드"를 켭니다.
3. "압축해제된 확장 프로그램을 로드합니다"를 누르고 `dist` 폴더를 고릅니다.

설치하면 옵션 페이지가 열립니다. API 키를 넣고 "연결 테스트"로 확인한 뒤 "저장"을 누르세요. 아이콘은 따로 없어서 Chrome 기본 아이콘으로 보입니다.

## 사용법

| 방법 | 동작 |
|---|---|
| 툴바 아이콘 → 팝업 | "번역" / "원문 보기", 진행률("번역 중… 12/40"), 오류 문구 |
| 단축키 Option+T (macOS) / Alt+T | 번역 ↔ 원문 보기 |
| 페이지 빈 곳 우클릭 | "이 페이지 한국어로 번역" |
| 팝업의 "이 사이트는 항상 번역" | 그 사이트를 열 때마다 자동으로 번역 |

- **단축키:** 다른 확장 프로그램과 겹쳐 Chrome이 할당하지 않았으면 팝업에 "단축키 없음 · 설정하기"가 보입니다. `chrome://extensions/shortcuts`에서 바꿀 수 있습니다. macOS에서는 확장이 켜져 있는 동안 입력란에서 Option+T로 †를 입력할 수 없습니다.
- **자동 번역 사이트:** 체크하면 그 사이트에 대한 접근 권한을 묻습니다. 출처(`https://docs.langchain.com` 같은 주소) 단위로 켜지므로 하위 도메인과 포트는 따로 켜야 합니다. 옵션 페이지의 "자동 번역 사이트"에서 "삭제"하면 권한도 돌려줍니다.
- **바뀌는 화면:** 번역 보기 상태에서는 SPA처럼 새로 그려지는 내용도 이어서 번역합니다.
- **오류:** 키가 없거나 틀렸을 때, 요청 한도 초과, 네트워크 오류 같은 경우 팝업과 페이지 오른쪽 아래 알림에 원인을 보여 줍니다. 이미 번역된 부분은 그대로 둡니다.

### 옵션 페이지

- **API 키와 모델:** Claude Haiku 5.5(비용 우선, 기본) / Sonnet 5.5(균형) / Opus 5.5(품질 우선) / 직접 입력
- **용어집:** "번역하지 않을 단어"와 "지정 번역어"(한 줄에 하나, `원어 = 번역어`). 바꾼 뒤 새로 번역하는 것부터 적용됩니다.
- **자동 번역 사이트:** 목록과 삭제
- **저장된 번역:** 번역문은 문자열 단위로 저장해 다른 페이지에서도 같은 문장이면 다시 씁니다. 다시 열 때 API를 부르지 않습니다.
  - 저장 공간 상한은 8MB입니다.
  - 상한의 80%가 차면 최근 10번의 번역에서 쓰이지 않은 번역문을 지웁니다. 두 값은 여기서 바꿀 수 있습니다.
  - "캐시 비우기"로 모두 지울 수 있습니다.
- **사용량:** 이번 달 입력·캐시 쓰기·캐시 읽기·출력 토큰 수 (API 응답의 `usage` 합계)

## 권한과 데이터

| 권한 | 쓰는 곳 |
|---|---|
| `storage` | 설정, 번역 캐시, 사용량을 이 브라우저의 `chrome.storage.local`에 저장 (다른 기기로 동기화하지 않음) |
| `activeTab`, `scripting` | 팝업·단축키·우클릭으로 번역할 때 지금 탭에 번역 스크립트를 넣음 |
| `contextMenus` | 우클릭 메뉴 |
| `https://api.anthropic.com/*` | 백그라운드에서 Claude API 호출 |
| 선택 권한 `https://*/*`, `http://*/*` | "이 사이트는 항상 번역"을 켤 때 그 사이트만 요청 |

- 번역하는 **페이지 텍스트는 Anthropic API로 전송됩니다.** 다른 서버로는 보내지 않습니다.
- API 키는 이 브라우저의 `chrome.storage.local`에만 저장하고 백그라운드 서비스 워커에서만 씁니다. 웹 페이지나 콘텐츠 스크립트로는 보내지 않습니다.
- 비용은 고른 모델과 번역한 양에 따라 Anthropic 계정에 청구됩니다. 옵션 페이지의 사용량으로 확인할 수 있습니다.

## 알려진 제한

- 대상 언어는 한국어뿐입니다.
- iframe 안의 내용과 Shadow DOM 안의 텍스트는 번역하지 않습니다.
- 속성(`placeholder`, `title`, `alt`, `aria-label`)과 입력란 내용은 번역하지 않습니다.
- `chrome://` 페이지와 Chrome 웹 스토어는 번역할 수 없습니다.

## 개발

```sh
npm run build       # dist/ (배포용)
npm run watch       # 바뀔 때마다 다시 빌드
npm run typecheck
npm test            # 단위 테스트 (Vitest, jsdom)
npm run test:e2e    # E2E (Playwright가 확장을 넣은 Chromium을 띄움. 픽스처와 목 API만 써서 인터넷 불필요)
npm run test:live   # SPEC 10.3: 실제 docs.langchain.com + 목 API (인터넷 필요)
```

- Playwright가 처음이면 `npx playwright install chromium`으로 브라우저를 받습니다.
- E2E는 `dist-test`(테스트용 빌드)를 씁니다. 클릭 없이 스크립트를 넣을 수 있도록 픽스처 주소(`http://aitranslator.test/*`)와 `https://docs.langchain.com/*` 권한을 더한 빌드입니다. 배포용 `dist`의 manifest는 그대로입니다.
- 실제 API를 쓰는 테스트(연결 테스트, 10.4 픽스처, docs.langchain.com 번역)는 `ANTHROPIC_API_KEY`가 있을 때만 돌고, 없으면 건너뜁니다. 소액의 API 비용이 듭니다.

  ```sh
  ANTHROPIC_API_KEY=sk-ant-... npm run test:e2e
  ```

  키는 환경 변수로만 넘기고 저장소에 커밋하지 않습니다.

### 구조

```
src/background/   서비스 워커: 메시지, 단축키, 우클릭 메뉴, 자동 번역 등록, 배치·재시도(translator), 캐시, 프롬프트, 제공업체(providers/)
src/content/      콘텐츠 스크립트: 텍스트 수집(collect), 교체·복원(apply), 화면 변화 감시(observer), 상태(controller), 알림(toast)
src/popup/        팝업
src/options/      옵션 페이지
src/shared/       설정 저장소, 메시지 형식, 모델 목록, 용어집, 사용량
tests/unit/       단위 테스트          tests/e2e/   E2E (마일스톤별 m1~m7)
tests/live/       실제 사이트 테스트   tests/fixtures/   테스트용 HTML
```

### SPEC 10장 항목과 테스트

| 10장 항목 | 테스트 |
|---|---|
| 10.1 구조 불변 | `tests/unit/page-translator.test.ts`, `tests/e2e/m2.spec.ts`(sentences·layout 픽스처), `tests/e2e/m3.spec.ts` |
| 10.2 복원 | `tests/unit/page-translator.test.ts`, `tests/e2e/m2.spec.ts`, `tests/e2e/m4.spec.ts`(원문 보기) |
| 10.3 기능 (검색 창, 링크, 테마, 배너, SPA 이동) | `tests/live/docs-langchain.spec.ts`(`npm run test:live`, 배너가 없는 날은 그 항목만 건너뜀), `tests/e2e/m3.spec.ts`(layout 버튼), `tests/e2e/m5.spec.ts`(SPA 픽스처) |
| 10.4 번역 품질 픽스처 | `tests/unit/page-translator.test.ts`(목 응답), `tests/e2e/m2.spec.ts`, `tests/e2e/m3.spec.ts`(목 응답과 실제 API) |
| 10.5 오류 (401, 429, 529, 잘못된 JSON, 개수 불일치) | `tests/unit/translator.test.ts`, `tests/unit/anthropic.test.ts`, `tests/e2e/m4.spec.ts`(401), `tests/e2e/m7.spec.ts`(429·529·잘못된 JSON·개수 불일치) |
