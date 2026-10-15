import type { RequestGroup, SegmentGroup } from "../shared/messages";
import { ProviderError, type TranslateRequest } from "./providers/types";

// 제공업체와 무관한 프롬프트 생성, 응답 파싱, 검증 (SPEC 4.3, 5.2).

const INSTRUCTIONS = `You translate the text of a web page into Korean. A browser extension puts each translated segment back into the page in place of the original text, so the page structure must stay exactly the same.

The user message is JSON:
{"target_language": "ko", "groups": [{"id": "g1", "segments": ["...", "..."], "context": "..."}]}

- Each group is one block of the page, such as a paragraph, list item, heading, or button.
- "segments" are consecutive pieces of the block's text, split where inline elements such as links or bold text start and end. The page keeps the original spaces between segments, so do not add spaces at the start or end of a segment.
- "context", when present, is the whole text of the block. It also contains text that is not sent for translation, such as code, numbers, URLs, or punctuation. That text stays on the page as it is, so use the context only to understand the sentence and never copy that text into your segments.

Reply with JSON only, in this shape:
{"groups": [{"id": "g1", "segments": ["...", "..."]}]}

Rules:
1. Return every group with the same id and exactly as many segments as you received, in the same order. This is the most important rule: the page breaks if a group has more or fewer segments. Never split one segment into two, and never merge two segments into one.
2. Translate each group as a whole so that its segments, read in order, form natural Korean that keeps all of the original meaning. Korean word order differs from English, so you may move words between segments of the same group; a verb that comes early in English often belongs in the last segment. When Korean seems to need a different split, put the extra words into a neighboring segment instead of adding a segment.
3. Each segment is a separate element on the page, often a link or bold text. Keep each segment's own meaning in that segment so that a link still names what it links to; move only the words that Korean word order requires, such as a verb.
4. Never return an empty segment. If the meaning of a segment moves elsewhere, keep at least a particle, a short word, or punctuation in it.
5. Keep proper nouns, product and brand names, code, commands, file names, and URLs in their original form.
6. Use the technical terms Korean developers actually use, for example deploy → 배포, trace → 트레이스, evaluation → 평가.
7. Keep short UI text such as buttons and menu items short, for example "Get started" → "시작하기".
8. Output only the JSON, with no explanations, notes, or code fences.

Examples (input segments → output segments, always the same count):
- ["Sign in to", "your account", "to continue."] → ["계속하려면", "계정에", "로그인하세요."]
- ["You can", "export", "your traces at any time."] → ["트레이스는 언제든지", "내보낼", "수 있습니다."]
- ["Before you deploy, review", "the checklist", "and", "the security guide"] → ["배포하기 전에", "체크리스트", "및", "보안 가이드를 검토하세요"]`;

/** 응답 JSON 스키마 (구조화된 출력). 배열 개수는 스키마로 강제할 수 없어 validateGroups()로 확인한다. */
export const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    groups: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          segments: { type: "array", items: { type: "string" } },
        },
        required: ["id", "segments"],
        additionalProperties: false,
      },
    },
  },
  required: ["groups"],
  additionalProperties: false,
} as const;

/** 시스템 프롬프트: 지시문 + 용어집. 요청마다 같으므로 프롬프트 캐시에 들어간다 (SPEC 13장). */
export function systemPrompt(glossary: TranslateRequest["glossary"]): string {
  const lines: string[] = [];
  if (glossary.keep.length > 0) {
    lines.push(`- Do not translate these terms; keep them exactly as written: ${glossary.keep.join(", ")}`);
  }
  const pairs = Object.entries(glossary.map);
  if (pairs.length > 0) {
    lines.push("- Always translate these terms as given:", ...pairs.map(([term, korean]) => `  - ${term} → ${korean}`));
  }
  return lines.length > 0 ? `${INSTRUCTIONS}\n\nGlossary:\n${lines.join("\n")}` : INSTRUCTIONS;
}

/** 사용자 메시지: 4.3의 요청 JSON. 용어집은 시스템 프롬프트로 옮겼다 (SPEC 13장). */
export function userMessage(req: TranslateRequest): string {
  return JSON.stringify({ target_language: req.targetLanguage, groups: req.groups });
}

/** 모델 응답 텍스트를 읽는다. 읽을 수 없으면 format 오류를 던진다 (그 배치를 1회 재요청). */
export function parseResponse(text: string): SegmentGroup[] {
  let data: unknown;
  try {
    data = JSON.parse(stripCodeFence(text));
  } catch {
    throw new ProviderError("format", "응답이 JSON 형식이 아닙니다.");
  }
  const groups = (data as { groups?: unknown } | null)?.groups;
  if (!Array.isArray(groups)) throw new ProviderError("format", "응답에 groups 배열이 없습니다.");
  // 형식이 틀린 그룹은 빠진 그룹으로 보고 validateGroups()가 재요청 대상으로 돌린다.
  return groups.filter(isSegmentGroup);
}

/**
 * 응답을 요청과 맞춰 본다 (SPEC 4.3, 13장): 같은 ID가 있고, 세그먼트 개수가 같고, 빈(공백뿐인) 세그먼트가 없어야 한다.
 * 세그먼트 앞뒤 공백은 원문 쪽 공백을 쓰므로 떼어 낸다.
 */
export function validateGroups(
  requested: readonly RequestGroup[],
  received: readonly SegmentGroup[],
): { valid: SegmentGroup[]; invalid: RequestGroup[] } {
  const byId = new Map<string, SegmentGroup>();
  for (const group of received) if (!byId.has(group.id)) byId.set(group.id, group);

  const valid: SegmentGroup[] = [];
  const invalid: RequestGroup[] = [];
  for (const group of requested) {
    const segments = byId.get(group.id)?.segments.map((segment) => segment.trim());
    if (segments && segments.length === group.segments.length && segments.every((segment) => segment !== "")) {
      valid.push({ id: group.id, segments });
    } else {
      invalid.push(group);
    }
  }
  return { valid, invalid };
}

function stripCodeFence(text: string): string {
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(text);
  return fenced ? fenced[1]! : text;
}

function isSegmentGroup(value: unknown): value is SegmentGroup {
  const group = value as { id?: unknown; segments?: unknown } | null;
  return (
    typeof group?.id === "string" &&
    Array.isArray(group.segments) &&
    group.segments.every((segment) => typeof segment === "string")
  );
}
