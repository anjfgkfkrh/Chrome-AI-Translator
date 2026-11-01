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
