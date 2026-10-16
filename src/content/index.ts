import type { ContentCommand, PageState } from "../shared/messages";
import { TranslationController } from "./controller";

// 콘텐츠 스크립트 진입점. 번역을 시작할 때(우클릭 메뉴, 팝업, 단축키) 백그라운드가 이 파일을 넣고,
// 자동 번역 사이트에서는 페이지가 열릴 때 Chrome이 넣는다 (auto.js 다음).
// 다시 넣어도 처음 만든 컨트롤러를 계속 써서, 이미 번역한 텍스트는 다시 요청하지 않는다.

declare global {
  // 확장 프로그램 전용 공간(isolated world)의 전역이라 페이지 스크립트에서는 보이지 않는다.
  var __aitranslatorController: TranslationController | undefined;
  /** auto.js가 남기는 "자동 번역으로 열림" 표시 */
  var __aitranslatorAutoRun: boolean | undefined;
}

if (document.body) {
  const auto = globalThis.__aitranslatorAutoRun === true;
  globalThis.__aitranslatorAutoRun = undefined; // 다음에 직접 넣을 때 섞이지 않도록 한 번 읽고 지운다
  let controller = globalThis.__aitranslatorController;
  if (!controller) {
    controller = globalThis.__aitranslatorController = new TranslationController(document.body);
    listen(controller);
  }
  // 이 파일을 넣는 것은 번역을 시작할 때뿐이다.
  void controller.translate({ auto });
}

/** 백그라운드의 명령 (팝업·단축키). 응답은 언제나 그 시점의 페이지 상태다. */
function listen(controller: TranslationController): void {
  chrome.runtime.onMessage.addListener((message: ContentCommand, _sender, sendResponse: (state: PageState) => void) => {
    switch (message?.type) {
      case "get-state":
        sendResponse(controller.state());
        return false;
      case "translate":
        void controller.translate();
        sendResponse(controller.state());
        return false;
      case "retranslate":
        void controller.retranslate().then(() => sendResponse(controller.state()));
        return true; // 비동기로 응답한다
      case "show-original":
        void controller.showOriginal().then(() => sendResponse(controller.state()));
        return true; // 비동기로 응답한다
    }
    return false;
  });
}
