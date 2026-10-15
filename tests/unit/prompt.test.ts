import { describe, expect, it } from "vitest";
import { parseResponse, systemPrompt, userMessage, validateGroups } from "../../src/background/prompt";
import { ProviderError } from "../../src/background/providers/types";

describe("systemPrompt (SPEC 4.3)", () => {
  it("4.3의 지시와 용어집을 담는다", () => {
    const prompt = systemPrompt({ keep: ["LangChain", "LangSmith"], map: { agent: "에이전트" } });

    expect(prompt).toContain("exactly as many segments as you received, in the same order");
    expect(prompt).toContain("Never return an empty segment");
    expect(prompt).toContain("deploy → 배포");
    expect(prompt).toContain('"Get started" → "시작하기"');
    expect(prompt).toContain("Output only the JSON");
    expect(prompt).toContain("keep them exactly as written: LangChain, LangSmith");
    expect(prompt).toContain("  - agent → 에이전트");
  });

  it("용어집이 비어 있으면 용어집 부분을 넣지 않는다", () => {
    expect(systemPrompt({ keep: [], map: {} })).not.toContain("Glossary");
  });

  it("같은 용어집이면 항상 같은 문자열이다 (프롬프트 캐시)", () => {
    const glossary = { keep: ["GitHub"], map: { trace: "트레이스" } };
    expect(systemPrompt(glossary)).toBe(systemPrompt({ ...glossary }));
  });
});

describe("userMessage", () => {
  it("4.3의 요청 JSON에서 용어집을 뺀 형식이고, context는 있을 때만 넣는다", () => {
    const message = userMessage({
      targetLanguage: "ko",
      glossary: { keep: ["LangChain"], map: {} },
      groups: [
        { id: "g1", segments: ["We'll", "email you"] },
        { id: "g2", segments: ["Run", "now"], context: "Run dcode now" },
      ],
    });

    expect(JSON.parse(message)).toEqual({
      target_language: "ko",
      groups: [
        { id: "g1", segments: ["We'll", "email you"] },
        { id: "g2", segments: ["Run", "now"], context: "Run dcode now" },
      ],
    });
  });
});

describe("parseResponse", () => {
  it("응답 JSON에서 그룹을 읽는다", () => {
    expect(parseResponse('{"groups":[{"id":"g1","segments":["시작하기"]}]}')).toEqual([
      { id: "g1", segments: ["시작하기"] },
    ]);
  });

  it("코드 블록으로 감싼 JSON도 읽는다", () => {
    expect(parseResponse('```json\n{"groups":[{"id":"g1","segments":["a"]}]}\n```')).toEqual([
      { id: "g1", segments: ["a"] },
    ]);
  });

  it.each(["not json", '{"result": []}', '{"groups": "g1"}'])("%s → format 오류", (text) => {
    expect(() => parseResponse(text)).toThrow(ProviderError);
    try {
      parseResponse(text);
    } catch (err) {
      expect((err as ProviderError).kind).toBe("format");
    }
  });

  it("형식이 틀린 그룹은 빼고 읽는다 (빠진 그룹으로 보고 재요청)", () => {
    expect(
      parseResponse('{"groups":[{"id":"g1","segments":["ok"]},{"id":"g2","segments":[1]},{"segments":["x"]}]}'),
    ).toEqual([{ id: "g1", segments: ["ok"] }]);
  });
});

describe("validateGroups (SPEC 4.3, 13장)", () => {
  const requested = [
    { id: "g1", segments: ["a", "b"] },
    { id: "g2", segments: ["c"] },
    { id: "g3", segments: ["d"] },
    { id: "g4", segments: ["e"] },
  ];

  it("ID 누락·개수 불일치·빈 세그먼트는 형식 오류로, 나머지는 앞뒤 공백을 떼어 통과시킨다", () => {
    const result = validateGroups(requested, [
      { id: "g1", segments: [" 가 ", "나"] },
      { id: "g2", segments: ["다", "라"] }, // 개수 불일치
      { id: "g3", segments: ["   "] }, // 빈 세그먼트
      { id: "g9", segments: ["모르는 그룹"] }, // 요청에 없는 ID는 무시
      // g4 누락
    ]);

    expect(result.valid).toEqual([{ id: "g1", segments: ["가", "나"] }]);
    expect(result.invalid.map((group) => group.id)).toEqual(["g2", "g3", "g4"]);
  });

  it("같은 ID가 두 번 오면 처음 것을 쓴다", () => {
    const result = validateGroups(
      [{ id: "g1", segments: ["a"] }],
      [
        { id: "g1", segments: ["첫째"] },
        { id: "g1", segments: ["둘째"] },
      ],
    );

    expect(result.valid).toEqual([{ id: "g1", segments: ["첫째"] }]);
  });
});
