// 모델 목록은 이 파일 한 곳에 둔다 (SPEC 7.2). ID는 2026-10-15 공식 문서로 확인했다.

export interface ModelInfo {
  id: string;
  name: string;
  /** 비용 우선 / 균형 / 품질 우선 */
  description: string;
}

export const MODELS: readonly ModelInfo[] = [
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", description: "비용 우선" },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", description: "균형" },
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", description: "품질 우선" },
];

/** 기본 모델: 비용 우선 */
export const DEFAULT_MODEL_ID = "claude-haiku-5-5";

/** 목록에 있는 모델인지. 직접 입력한 모델에는 effort·구조화된 출력을 보내지 않는다 (SPEC 13장). */
export function isListedModel(id: string): boolean {
  return MODELS.some((model) => model.id === id);
}
