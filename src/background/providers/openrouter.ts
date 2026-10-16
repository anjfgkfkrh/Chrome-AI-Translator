import { openRouterModels, type OpenRouterModel } from "../../shared/openrouter-models";
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

// OpenRouter (SPEC 5.3.1, 13장): OpenAI 형식의 chat completions. 요청·응답 형식 변환만 맡는다.
// 엔드포인트·헤더·파라미터·오류 형식은 2026-10-16 공식 문서와 실제 요청으로 확인했다.
const CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const KEY_URL = "https://openrouter.ai/api/v1/key";
const TEST_TIMEOUT_MS = 30_000;

interface ErrorBody {
  code?: number;
  message?: string;
}

interface ChatResponse {
  choices?: {
    message?: { content?: string | { type?: string; text?: string }[] | null };
    finish_reason?: string | null;
    error?: ErrorBody;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  };
  /** 200 응답인데 생성 중에 실패한 경우 */
  error?: ErrorBody;
}

export class OpenRouterProvider implements TranslationProvider {
  readonly id = "openrouter";

  /** 모델 정보상 사고를 끌 수 있는지 (effort "none"을 받고 사고가 필수가 아님) */
  async canDisableThinking(model: string): Promise<boolean> {
    const info = (await openRouterModels()).get(model);
    return info !== undefined && !info.reasoningMandatory && info.efforts.includes("none");
  }

  async translate(
    req: TranslateRequest,
    { apiKey, model, signal, onUsage, maxTokens, fast }: TranslateOptions,
  ): Promise<TranslateResponse> {
    const info = (await openRouterModels()).get(model);
    const system = systemPrompt(req.glossary);
    const body: Record<string, unknown> = {
      model,
      // 설정이 모델 한도보다 크면 모델 한도로 줄인다 (SPEC 13장 "OpenRouter 세부").
      max_tokens: info?.maxOutput === undefined ? maxTokens : Math.min(maxTokens, info.maxOutput),
      messages: [
        // Claude는 시스템 프롬프트를 캐시 지점으로 표시한다. 다른 모델은 제공업체가 자동으로 캐시한다.
        {
          role: "system",
          content: model.startsWith("anthropic/")
            ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }]
            : system,
        },
        { role: "user", content: userMessage(req) },
      ],
    };
    if (info?.structured) {
      body.response_format = { type: "json_schema", json_schema: { name: "translation", strict: true, schema: RESPONSE_SCHEMA } };
    }
    const reasoning = reasoningFor(info, fast);
    if (reasoning) body.reasoning = reasoning;

    const res = (await requestJson(
      CHAT_URL,
      { method: "POST", headers: headers(apiKey), body: JSON.stringify(body), signal },
      classify,
    )) as ChatResponse;
    const usage = toUsage(res.usage);
    if (usage) onUsage?.(usage);
    if (res.error) throw bodyError(res.error);
    const choice = res.choices?.[0];
    if (choice?.error) throw bodyError(choice.error);
    if (choice?.finish_reason === "error") throw new ProviderError("server", "응답을 만드는 중에 실패했습니다.");
    if (choice?.finish_reason === "length") throw new ProviderError("truncated", "응답이 max_tokens에서 잘렸습니다.");
    if (choice?.finish_reason === "content_filter") throw new ProviderError("refusal", "모델이 번역을 거절했습니다.");
    return { groups: parseResponse(textOf(choice?.message?.content)), usage };
  }

  /** 토큰을 쓰지 않는다: 키는 키 확인 주소로, 모델 ID는 모델 목록으로 확인한다 (SPEC 13장 "OpenRouter 연결 테스트"). */
  async testConnection({ apiKey, model }: RequestOptions) {
    try {
      await requestJson(
        KEY_URL,
        { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(TEST_TIMEOUT_MS) },
        classify,
      );
      const models = await openRouterModels();
      // 목록을 받지 못했으면 모델은 확인하지 않는다.
      if (models.size > 0 && !models.has(model)) throw new ProviderError("not_found", `목록에 없는 모델입니다: ${model}`);
      return { ok: true, message: `연결 성공 (${model})` };
    } catch (err) {
      return { ok: false, message: errorMessage(err, model, "connection", "OpenRouter") };
    }
  }
}

/** 앱 표시 헤더(HTTP-Referer, X-OpenRouter-Title)는 보내지 않는다. 공개 순위에 앱이 표시될 수 있다 (SPEC 13장). */
function headers(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

/**
 * 정확하게: 모델이 받으면 effort "medium" (Anthropic 직접 연결과 같음). 빠르게: 끌 수 있으면 "none".
 * 모델 정보를 모르면 보내지 않는다 (SPEC 13장 "OpenRouter 번역 방식").
 */
function reasoningFor(info: OpenRouterModel | undefined, fast: boolean): { effort: string } | undefined {
  if (!info) return undefined;
  if (fast && !info.reasoningMandatory && info.efforts.includes("none")) return { effort: "none" };
  return info.efforts.includes("medium") ? { effort: "medium" } : undefined;
}

/** SPEC 13장 "OpenRouter 오류" */
function classify(status: number): ProviderErrorKind {
  if (status === 401) return "auth";
  if (status === 402) return "credits";
  // 검열·차단은 키 오류가 아니다. 그 배치만 원문으로 둔다.
  if (status === 403) return "refusal";
  if (status === 404) return "not_found";
  if (status === 408) return "timeout";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "server";
  return "other";
}

/** 200 응답 안의 error도 상태 코드와 같은 기준으로 나눈다. */
function bodyError(error: ErrorBody): ProviderError {
  const status = typeof error.code === "number" ? error.code : 500;
  return new ProviderError(classify(status), error.message ?? `HTTP ${status}`, { status });
}

function textOf(content: string | { type?: string; text?: string }[] | null | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part.type === undefined || part.type === "text" ? (part.text ?? "") : "")).join("");
}

/** 전체 입력에는 캐시에서 읽은 것과 캐시에 쓴 것이 들어 있다 (SPEC 13장 "OpenRouter 세부"). */
function toUsage(usage: ChatResponse["usage"]): TokenUsage | undefined {
  if (!usage) return undefined;
  const read = usage.prompt_tokens_details?.cached_tokens ?? 0;
  const written = usage.prompt_tokens_details?.cache_write_tokens ?? 0;
  return {
    inputTokens: Math.max(0, (usage.prompt_tokens ?? 0) - read - written),
    cacheWriteTokens: written,
    cacheReadTokens: read,
    outputTokens: usage.completion_tokens ?? 0,
  };
}
