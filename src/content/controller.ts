import {
  TRANSLATE_PORT,
  type BackgroundToContent,
  type ContentToBackground,
  type LogInfo,
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

/** 번역 전체를 멈춘 오류. needsSettings면 알림에 "설정 열기"를 붙인다. missingKey는 키가 아예 없을 때다. */
class TranslationError extends Error {
  readonly needsSettings: boolean;
  readonly missingKey: boolean;

  constructor(message: string, needsSettings: boolean, missingKey = false) {
    super(message);
    this.needsSettings = needsSettings;
    this.missingKey = missingKey;
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
  /** partial일 때 그 원인 문구 */
  private cause: string | undefined;
  /** 이 페이지에 번역문이 하나라도 있는지. 없는데 모두 실패하면 일부 실패가 아니라 오류로 알린다 (SPEC 13장). */
  private hasTranslations = false;
  /** 사이트별 자동 번역으로 시작했는지 */
  private automatic = false;
  /** 최근 번역 기록의 한 건 ID. 페이지 번역을 시작할 때마다 새로 정한다 (SPEC 13장 "기록의 한 건"). */
  private logId = "";
  /** 그 건을 시작한 주소 (쿼리·해시 뺌) */
  private logUrl = "";

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
    return { status, progress: { ...this.progress }, error: this.error, partial: this.partial, cause: this.cause };
  }

  /**
   * 번역을 시작하고, 번역 보기인 동안 새로 생기는 텍스트도 번역한다. 진행 상황은 state()로 본다.
   * auto: 사이트별 자동 번역으로 열린 경우. 키가 없으면 알림 없이 건너뛴다 (SPEC 13장).
   */
  translate(options: { auto?: boolean } = {}): Promise<void> {
    this.automatic = options.auto ?? false;
    this.watcher.start();
    return this.run();
  }

  /**
   * 기억한 번역문을 버리고 지금 설정(번역 품질)으로 처음부터 다시 번역한다 (SPEC 13장 "이 품질로 다시 번역").
   * 번역 중에는 하지 않는다. 돌려주는 Promise는 원문으로 되돌리고 새 번역을 시작했을 때 풀린다.
   */
  async retranslate(): Promise<void> {
    if (this.running > 0) return;
    this.watcher.stop();
    await this.page.reset();
    this.hasTranslations = false;
    void this.translate();
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
      this.cause = undefined;
    }
    this.running++;
    // 페이지 번역을 시작할 때만 캐시 정리의 새 턴과 기록의 새 건을 연다. 화면 변화로 더 번역하는 것은 같은 턴·같은 건이다.
    // 다만 주소가 바뀌었으면 페이지를 새로 읽지 않는 사이트(SPA)의 페이지 이동이므로 새로 연다 (SPEC 13장).
    const newTurn = changed === undefined || pageUrl() !== this.logUrl;
    if (newTurn) {
      this.logId = newLogId();
      this.logUrl = pageUrl();
    }
    return this.page
      .translate((groups, deliver) => this.request(groups, deliver, newTurn), changed)
      .catch((err: unknown) => this.fail(err))
      .finally(() => {
        this.running--;
      });
  }

  /** 백그라운드에 번역을 맡긴다. 페이지 텍스트만 보내고 API 키는 주고받지 않는다 (SPEC 7.1). */
  private request(
    groups: RequestGroup[],
    deliver: (results: SegmentGroup[]) => void,
    newTurn: boolean,
  ): Promise<void> {
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
          if (message.groups.length > 0) this.hasTranslations = true;
          deliver(message.groups);
        } else if (message.type === "done") {
          this.progress.done += message.failed;
          if (message.failed > 0 && !this.hasTranslations) {
            // 하나도 번역하지 못했으면 원인 문구를 오류로 알린다 (SPEC 13장 "실패 원인 표시").
            finish(() => reject(new TranslationError(message.error ?? PARTIAL_FAILURE_MESSAGE, false)));
            return;
          }
          if (message.failed > 0) this.reportPartialFailure(message.failed, message.error);
          finish(resolve);
        } else if (message.type === "error") {
          finish(() => reject(new TranslationError(message.message, message.needsSettings, message.missingKey)));
        }
      });
      port.onDisconnect.addListener(() => {
        clearInterval(keepAlive);
        reject(new TranslationError("번역 실패: 백그라운드와 연결이 끊어졌습니다.", false));
      });
      send({ type: "translate", groups, newTurn, log: this.logInfo() });
    });
  }

  /** 기록에 남길 페이지 정보. 주소의 쿼리·해시는 뺀다 (SPEC 13장 "기록 항목"). */
  private logInfo(): LogInfo {
    return {
      id: this.logId,
      title: document.title.trim().slice(0, 200),
      url: pageUrl(),
      automatic: this.automatic,
    };
  }

  /** 시나리오 5: 원인과 해결 방법을 알리고, 이미 번역된 부분은 그대로 둔다. */
  private fail(err: unknown): void {
    // 페이지가 바뀔 때마다 같은 오류가 되풀이되지 않도록 감시를 멈춘다. 다시 "번역"하면 이어서 감시한다.
    this.watcher.stop();
    this.error = err instanceof Error ? err.message : String(err);
    // 자동 번역 사이트를 열 때마다 "키를 설정하세요" 알림이 뜨지 않게 한다. 팝업에서는 미설정으로 보인다.
    if (this.automatic && err instanceof TranslationError && err.missingKey) return;
    console.error("[AITranslator]", this.error);
    const needsSettings = err instanceof TranslationError && err.needsSettings;
    showToast(this.error, needsSettings ? { onOpenSettings: openSettings } : {});
  }

  /** 일부만 실패하면 원인 문구를 한 줄 덧붙인다 (SPEC 13장 "실패 원인 표시"). */
  private reportPartialFailure(failed: number, cause: string | undefined): void {
    this.partial = true;
    this.cause = cause;
    console.warn(`[AITranslator] ${failed}개 그룹은 원문으로 두었습니다.`, cause ?? "");
    showToast(PARTIAL_FAILURE_MESSAGE, { detail: cause });
  }
}

/** 기록에 남기고 페이지 이동을 가늠하는 주소: 쿼리·해시는 뺀다 (SPEC 13장 "기록 항목") */
function pageUrl(): string {
  return location.href.split(/[?#]/)[0]!;
}

/** http 페이지에서는 crypto.randomUUID를 쓸 수 없으므로 시각과 난수로 만든다. */
function newLogId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function openSettings(): void {
  void chrome.runtime.sendMessage({ type: "open-options" });
}
