// OpenRouter 모델 목록 예시 (단위 테스트와 E2E가 함께 쓴다). 2026-10-16 실제 목록에서 필요한 필드만 옮겼다.

export const SAMPLE_MODELS = {
  data: [
    {
      id: "anthropic/claude-haiku-5.5",
      supported_parameters: ["max_tokens", "reasoning", "response_format", "structured_outputs"],
      top_provider: { max_completion_tokens: 128_000 },
      reasoning: { mandatory: false, supported_efforts: ["max", "xhigh", "high", "medium", "low", "none"] },
    },
    {
      id: "anthropic/claude-sonnet-5.5",
      supported_parameters: ["max_tokens", "reasoning", "response_format", "structured_outputs"],
      top_provider: { max_completion_tokens: 128_000 },
      reasoning: { mandatory: true, supported_efforts: ["max", "xhigh", "high", "medium", "low"] },
    },
    {
      id: "deepseek/deepseek-chat",
      supported_parameters: ["max_tokens", "response_format", "structured_outputs"],
      top_provider: { max_completion_tokens: 16_000 },
      reasoning: null,
    },
    { id: "plain/model", supported_parameters: ["max_tokens"], top_provider: null },
    { id: "anthropic/claude-haiku-5.5:batch", supported_parameters: [], top_provider: null },
  ],
};
