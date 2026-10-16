import { isListedModel, listedModel } from "../../shared/models";
import type { TokenUsage } from "../../shared/usage";
import { errorMessage } from "../errors";
import { parseResponse, RESPONSE_SCHEMA, systemPrompt, userMessage } from "../prompt";
import { requestJson } from "./http";
import {
  ProviderError,
  type ProviderErrorKind,
  type RequestOptions,
  type TranslateOptions,
  type TranslateRequest,
  type TranslateResponse,
  type TranslationProvider,
} from "./types";

// HTTP 요청·응답 형식 변환만 맡는다 (SPEC 5.2, 5.3). 헤더·버전·파라미터는 2026-10 공식 문서로 확인했다.
const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";
const TEST_TIMEOUT_MS = 30_000;

interface MessageResponse {
  content?: { type: string; text?: string }[];
  stop_reason?: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export class AnthropicProvider implements TranslationProvider {
  readonly id = "anthropic";

  /** 목록의 모델 가운데 끄는 값이 있는 모델만 (Opus와 직접 입력한 모델은 끌 수 없음) */
  async canDisableThinking(model: string): Promise<boolean> {
    return listedModel(model)?.thinkingOff !== undefined;
  }

  async translate(
    req: TranslateRequest,
    { apiKey, model, signal, onUsage, maxTokens, fast }: TranslateOptions,
  ): Promise<TranslateResponse> {
    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      // 시스템 프롬프트와 용어집은 요청마다 같으므로 캐시한다 (SPEC 13장).
      system: [{ type: "text", text: systemPrompt(req.glossary), cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: userMessage(req) }],
    };
    // 직접 입력한 모델은 구형일 수 있으므로 effort·구조화된 출력을 보내지 않는다 (SPEC 13장).
    if (isListedModel(model)) {
      body.output_config = { effort: "medium", format: { type: "json_schema", schema: RESPONSE_SCHEMA } };
    }
    // 빠르게: 사고를 끈다. Opus처럼 끌 수 없는 모델과 직접 입력한 모델은 그대로 둔다 (SPEC 13장 "번역 방식").
    const thinkingOff = listedModel(model)?.thinkingOff;
    if (fast && thinkingOff) body.thinking = thinkingOff;

    const res = (await postMessages(apiKey, body, signal)) as MessageResponse;
    const usage = toUsage(res.usage);
    if (usage) onUsage?.(usage);
    if (res.stop_reason === "refusal") throw new ProviderError("refusal", "모델이 번역을 거절했습니다.");
    if (res.stop_reason === "max_tokens") throw new ProviderError("truncated", "응답이 max_tokens에서 잘렸습니다.");
    const text = (res.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("");
    return { groups: parseResponse(text), usage };
  }

  /** 짧은 요청 1회. 재시도하지 않는다 (SPEC 13장). */
  async testConnection({ apiKey, model, onUsage }: RequestOptions) {
    try {
      const res = (await postMessages(
        apiKey,
        { model, max_tokens: 16, messages: [{ role: "user", content: "ping" }] },
        AbortSignal.timeout(TEST_TIMEOUT_MS),
      )) as MessageResponse;
      const usage = toUsage(res.usage);
      if (usage) onUsage?.(usage);
      return { ok: true, message: `연결 성공 (${model})` };
    } catch (err) {
      return { ok: false, message: errorMessage(err, model) };
    }
  }
}

function postMessages(apiKey: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  return requestJson(
    API_URL,
    {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": API_VERSION,
        "content-type": "application/json",
        // 확장 프로그램의 요청에는 Origin 헤더가 붙어 브라우저 요청으로 취급된다 (없으면 401).
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(body),
      signal,
    },
    classify,
  );
}

function classify(status: number): ProviderErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "server";
  return "other";
}

/** 입력은 캐시를 쓰지 않은 부분, 캐시에 쓴 부분, 캐시에서 읽은 부분으로 따로 온다 (SPEC 13장 "사용량 표시"). */
function toUsage(usage: MessageResponse["usage"]): TokenUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
  };
}
