import { ProviderError } from "./providers/types";

/** 키가 없을 때의 안내 (SPEC 4.9) */
export const NO_API_KEY_MESSAGE = "API 키를 먼저 설정하세요";

/**
 * 오류를 사용자 안내 문구로 바꾼다 (SPEC 13장 "M1 화면 문구", "M4 화면 문구"). API 키는 문구에 넣지 않는다.
 * purpose에 따라 그 밖의 오류 앞에 "연결 실패:"(연결 테스트) 또는 "번역 실패:"(번역)를 붙인다.
 */
export function errorMessage(err: unknown, model: string, purpose: "connection" | "translation" = "connection"): string {
  if (err instanceof ProviderError) {
    switch (err.kind) {
      case "auth":
        return "API 키를 확인하세요.";
      case "not_found":
        return `이 모델을 사용할 수 없습니다: ${model}`;
      case "rate_limit":
        return "요청 한도를 초과했습니다. 잠시 후 다시 시도하세요.";
      case "server":
        return "Anthropic 서버가 혼잡합니다. 잠시 후 다시 시도하세요.";
      case "network":
      case "timeout":
        return "네트워크에 연결할 수 없습니다. 인터넷 연결을 확인하세요.";
    }
  }
  const prefix = purpose === "connection" ? "연결 실패" : "번역 실패";
  return `${prefix}: ${err instanceof Error ? err.message : String(err)}`;
}

/** 키가 틀린 오류인지. 알림에 "설정 열기"를 붙인다 (SPEC 13장 "토스트 동작"). */
export function isKeyError(err: unknown): boolean {
  return err instanceof ProviderError && err.kind === "auth";
}
