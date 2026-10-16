import type { ProviderId } from "./models";

// 확장 프로그램 내부 메시지 형식.
// API 키는 옵션 페이지 → 백그라운드 방향으로만 보낸다. 콘텐츠 스크립트와 주고받는 메시지에는 넣지 않는다 (SPEC 7.1).

/** 번역 요청의 그룹 (SPEC 4.3). context는 사이에 빠진 텍스트가 있는 그룹에만 붙는다 (SPEC 13장). */
export interface RequestGroup {
  id: string;
  segments: string[];
  context?: string;
}

/** 번역 결과 그룹 */
export interface SegmentGroup {
  id: string;
  segments: string[];
}

/** 콘텐츠 스크립트가 들고 있는 페이지 하나의 번역 상태 (SPEC 4.9) */
export interface PageState {
  status: "idle" | "translating" | "translated" | "original" | "error";
  /** 완료 = 번역한 그룹 + 원문으로 남긴 그룹 (SPEC 13장) */
  progress: { done: number; total: number };
  /** status가 error일 때의 오류 문구 */
  error?: string;
  /** 일부 그룹을 번역하지 못해 원문으로 두었는지 */
  partial: boolean;
  /** partial일 때 그 원인 문구 (SPEC 13장 "실패 원인 표시") */
  cause?: string;
}

/** 팝업이 보는 탭 상태: 콘텐츠 스크립트를 넣을 수 없는 페이지면 unsupported */
export type TabState = PageState | { status: "unsupported" };

/** retranslate: 기억한 번역문을 버리고 지금 번역 품질로 다시 번역 (SPEC 13장) */
export type TabAction = "translate" | "show-original" | "retranslate";

export interface TestConnectionMessage {
  type: "test-connection";
  /** 화면에서 고른 (저장 전) 제공업체 */
  provider: ProviderId;
  /** 입력란에 있는 (저장 전) 키 */
  apiKey: string;
  /** 화면에서 고른 (저장 전) 모델 */
  model: string;
}

/** 확장 프로그램 페이지·콘텐츠 스크립트 → 백그라운드 */
export type Message =
  | TestConnectionMessage
  | { type: "get-tab-state"; tabId: number }
  | { type: "tab-action"; tabId: number; action: TabAction }
  | { type: "get-shortcut" }
  // 옵션 페이지의 OpenRouter 모델 자동 완성 (SPEC 13장 "OpenRouter 모델 고르기")
  | { type: "get-openrouter-models" }
  | { type: "get-cache-stats" }
  | { type: "clear-cache" }
  // 캐시 상한·정리 기준을 바꾼 뒤 바로 정리한다
  | { type: "clean-cache" }
  // 사이트별 자동 번역 (SPEC 4.8): 팝업의 체크박스, 옵션 페이지의 삭제
  | { type: "get-auto-translate"; origin: string }
  | { type: "auto-translate-pending"; origin: string; tabId: number }
  // 팝업이 닫힌 사이 권한을 거부했는지 (팝업을 열 때 한 번 묻는다)
  | { type: "take-auto-translate-denied"; origin: string }
  | { type: "set-auto-translate"; origin: string; enabled: boolean; tabId?: number }
  // 콘텐츠 스크립트의 알림에서 "설정 열기"를 눌렀을 때 (콘텐츠 스크립트는 옵션 페이지를 직접 열 수 없다)
  | { type: "open-options" };

export interface TestConnectionResult {
  ok: boolean;
  message?: string;
}

interface Responses {
  "test-connection": TestConnectionResult;
  "get-tab-state": TabState;
  "tab-action": TabState;
  /** 할당된 단축키. 없으면 빈 문자열 */
  "get-shortcut": string;
  /** OpenRouter 모델 ID. 받지 못하면 빈 배열 */
  "get-openrouter-models": string[];
  "get-cache-stats": { count: number; bytes: number };
  "clear-cache": void;
  "clean-cache": void;
  /** 목록에 있고 권한도 있으면 true */
  "get-auto-translate": boolean;
  "auto-translate-pending": void;
  /** 거부했으면 true (한 번만) */
  "take-auto-translate-denied": boolean;
  /** 바뀐 뒤의 상태. 켜려 했지만 권한이 없으면 false */
  "set-auto-translate": boolean;
  "open-options": void;
}

export function sendMessage<M extends Message>(message: M): Promise<Responses[M["type"]]> {
  return chrome.runtime.sendMessage(message);
}

/** 백그라운드 → 콘텐츠 스크립트 (chrome.tabs.sendMessage). 응답은 모두 PageState다. */
export type ContentCommand =
  | { type: "get-state" }
  | { type: "translate" }
  | { type: "show-original" }
  | { type: "retranslate" };

/** 콘텐츠 스크립트 ↔ 백그라운드 번역 포트. 포트가 끊기면(탭 닫힘·페이지 이동) 진행 중인 요청을 취소한다. */
export const TRANSLATE_PORT = "translate";

export type ContentToBackground =
  // newTurn: 페이지 번역을 시작하는 요청이면 true, 번역 보기 중 화면이 바뀌어 더 번역하는 요청이면 false.
  // 캐시 정리의 턴을 센다 (SPEC 13장 "캐시 정리: 턴").
  | { type: "translate"; groups: RequestGroup[]; newTurn: boolean }
  // 번역을 기다리는 동안 서비스 워커가 멈추지 않게 보낸다.
  | { type: "ping" };

export type BackgroundToContent =
  // 배치가 끝날 때마다 검증을 통과한 그룹을 보낸다.
  | { type: "results"; groups: SegmentGroup[] }
  // failed: 번역하지 못해 원문으로 남은 그룹 수, error: 그 원인 (마지막 오류)
  | { type: "done"; failed: number; error?: string }
  // 키 오류처럼 번역 전체를 멈춘 오류. needsSettings면 알림에 "설정 열기"를 붙인다.
  // missingKey: 키가 아예 없음 (자동 번역 사이트에서는 알림 없이 건너뛴다, SPEC 13장)
  | { type: "error"; message: string; needsSettings: boolean; missingKey: boolean };
