// 모델 목록은 이 파일 한 곳에 둔다 (SPEC 7.2). ID는 2026-10-15 공식 문서로 확인했다.

export interface ModelInfo {
  id: string;
  name: string;
  /** 비용 우선 / 균형 / 품질 우선 */
  description: string;
  /** "빠르게"에서 사고를 끄는 값. 없으면 끌 수 없는 모델이다 (SPEC 13장 "번역 방식", 2026-10 공식 문서). */
  thinkingOff?: { type: "disabled" | "between_tools" };
}

export const MODELS: readonly ModelInfo[] = [
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", description: "비용 우선", thinkingOff: { type: "disabled" } },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", description: "균형", thinkingOff: { type: "between_tools" } },
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", description: "품질 우선" },
];

/** 기본 모델: 비용 우선 */
export const DEFAULT_MODEL_ID = "claude-haiku-5-5";

/** 목록에 있는 모델인지. 직접 입력한 모델에는 effort·구조화된 출력을 보내지 않는다 (SPEC 13장). */
export function isListedModel(id: string): boolean {
  return MODELS.some((model) => model.id === id);
}

export function listedModel(id: string): ModelInfo | undefined {
  return MODELS.find((model) => model.id === id);
}

/** 이 설정으로 번역하면 실제로 사고를 끄는지. 빠르게여도 끌 수 없는 모델이면 false (SPEC 13장 "번역 방식과 캐시") */
export function thinkingDisabled(settings: { model: string; translationMode: "accurate" | "fast" }): boolean {
  return settings.translationMode === "fast" && listedModel(settings.model)?.thinkingOff !== undefined;
}
