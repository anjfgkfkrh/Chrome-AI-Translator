// 원문 찾기의 길이 제한과 글자 정규화 (설계 6절). 콘텐츠 스크립트와 백그라운드가 같은 값을 쓴다.

/** 찾을 수 있는 선택 글자의 최대 길이 (공백 포함) */
export const MAX_SELECTION_LENGTH = 60;
/** 문단 원문·번역문의 최대 길이 */
export const MAX_BLOCK_LENGTH = 20_000;

/**
 * 원문 비교용으로 글자를 정리한다: NFKC(PDF의 ﬁ 합자 등), 줄바꿈 하이픈 제거, 연속 공백 하나로.
 * 대소문자는 구분한다.
 */
export function normalizeSource(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/([a-z])-\s+([a-z])/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}
