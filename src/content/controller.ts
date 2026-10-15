import {
  TRANSLATE_PORT,
  type BackgroundToContent,
  type ContentToBackground,
  type PageState,
  type RequestGroup,
  type SegmentGroup,
} from "../shared/messages";
import { MutationWatcher } from "./observer";
import { PageTranslator } from "./page-translator";
import { showToast } from "./toast";

/** 번역을 기다리는 동안 서비스 워커가 멈추지 않게 보내는 신호 간격. Chrome은 이벤트 없이 30초가 지나면 멈춘다. */
const KEEPALIVE_MS = 20_000;
const PARTIAL_FAILURE_MESSAGE = "일부는 번역하지 못해 원문으로 두었습니다.";

/** 번역 전체를 멈춘 오류. needsSettings면 알림에 "설정 열기"를 붙인다. */
class TranslationError extends Error {
  readonly needsSettings: boolean;

  constructor(message: string, needsSettings: boolean) {
    super(message);
    this.needsSettings = needsSettings;
  }
}

/** 페이지 하나의 번역 상태, 진행률, 동적 콘텐츠, 오류 알림을 맡는다 (SPEC 4.5, 4.6, 4.9, 4.11). */
export class TranslationController {
  private readonly page: PageTranslator;
  private readonly watcher: MutationWatcher;
  private started = false;
  private running = 0;
  private progress = { done: 0, total: 0 };
  private error: string | undefined;
  private partial = false;

  constructor(root: Element) {
    this.page = new PageTranslator(root);
    this.watcher = new MutationWatcher(
      root,
      (nodes) => void this.translateChanges(nodes),
      (node) => this.page.isShowingTranslation(node),
    );
  }

  state(): PageState {
    let status: PageState["status"];
    if (!this.started) status = "idle";
    else if (this.page.mode === "original") status = "original";
    else if (this.running > 0) status = "translating";
    else if (this.error !== undefined) status = "error";
    else status = "translated";
    return { status, progress: { ...this.progress }, error: this.error, partial: this.partial };
  }

  /** 번역을 시작하고, 번역 보기인 동안 새로 생기는 텍스트도 번역한다. 진행 상황은 state()로 본다. */
  translate(): Promise<void> {
    this.watcher.start();
    return this.run();
  }

  /** 원문 보기 (API 호출 없음). 원문 보기 상태에서는 새 텍스트를 번역하지 않는다 (SPEC 4.6). */
  showOriginal(): Promise<void> {
    this.watcher.stop();
    return this.page.showOriginal();
  }

  /** 감시를 멈추고 페이지에서 손을 뗀다. */
  dispose(): void {
    this.watcher.stop();
  }

  /** 페이지가 바꾼 부분만 다시 모아 번역한다. */
  private translateChanges(nodes: Node[]): Promise<void> {
    // 확장 프로그램을 새로고침·업데이트하면 페이지에 남은 이전 콘텐츠 스크립트는 확장과 끊긴다. 조용히 멈춘다.
    if (chrome.runtime?.id === undefined) {
      this.dispose();
      return Promise.resolve();
    }
    if (this.page.mode !== "translation") return Promise.resolve();
    return this.run(nodes);
  }

  /** 돌려주는 Promise는 번역이 끝날 때 풀린다 (테스트용). */
  private run(changed?: Node[]): Promise<void> {
    this.started = true;
    this.error = undefined;
    if (this.running === 0) {
      this.progress = { done: 0, total: 0 };
      this.partial = false;
    }
    this.running++;
    return this.page
      .translate((groups, deliver) => this.request(groups, deliver), changed)
      .catch((err: unknown) => this.fail(err))
      .finally(() => {
        this.running--;
      });
  }

  /** 백그라운드에 번역을 맡긴다. 페이지 텍스트만 보내고 API 키는 주고받지 않는다 (SPEC 7.1). */
  private request(groups: RequestGroup[], deliver: (results: SegmentGroup[]) => void): Promise<void> {
    this.progress.total += groups.length;
    return new Promise((resolve, reject) => {
      const port = chrome.runtime.connect({ name: TRANSLATE_PORT });
      const send = (message: ContentToBackground) => port.postMessage(message);
      const keepAlive = setInterval(() => send({ type: "ping" }), KEEPALIVE_MS);
      const finish = (settle: () => void) => {
        clearInterval(keepAlive);
        port.disconnect();
        settle();
      };

      port.onMessage.addListener((message: BackgroundToContent) => {
        if (message.type === "results") {
          this.progress.done += message.groups.length;
          deliver(message.groups);
        } else if (message.type === "done") {
          this.progress.done += message.failed;
          if (message.failed > 0) this.reportPartialFailure(message.failed, message.error);
          finish(resolve);
        } else if (message.type === "error") {
          finish(() => reject(new TranslationError(message.message, message.needsSettings)));
        }
      });
      port.onDisconnect.addListener(() => {
        clearInterval(keepAlive);
        reject(new TranslationError("번역 실패: 백그라운드와 연결이 끊어졌습니다.", false));
      });
      send({ type: "translate", groups });
    });
  }

  /** 시나리오 5: 원인과 해결 방법을 알리고, 이미 번역된 부분은 그대로 둔다. */
  private fail(err: unknown): void {
    // 페이지가 바뀔 때마다 같은 오류가 되풀이되지 않도록 감시를 멈춘다. 다시 "번역"하면 이어서 감시한다.
    this.watcher.stop();
    this.error = err instanceof Error ? err.message : String(err);
    console.error("[AITranslator]", this.error);
    const needsSettings = err instanceof TranslationError && err.needsSettings;
    showToast(this.error, needsSettings ? { onOpenSettings: openSettings } : {});
  }

  private reportPartialFailure(failed: number, cause: string | undefined): void {
    this.partial = true;
    console.warn(`[AITranslator] ${failed}개 그룹은 원문으로 두었습니다.`, cause ?? "");
    showToast(PARTIAL_FAILURE_MESSAGE);
  }
}

function openSettings(): void {
  void chrome.runtime.sendMessage({ type: "open-options" });
}
