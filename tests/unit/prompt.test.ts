import { describe, expect, it } from "vitest";
import { parseResponse, systemPrompt, userMessage, validateGroups } from "../../src/background/prompt";
import { ProviderError } from "../../src/background/providers/types";
import type { RequestGroup } from "../../src/shared/messages";

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

describe("문맥의 텍스트를 따로 넣은 응답 (SPEC 13장)", () => {
  // docs.langchain.com/langsmith/observability-llm-tutorial에서 실제로 받은 응답 (코드 llm이 두 번 빠진 문단)
  const group: RequestGroup = {
    id: "g112",
    segments: [
      "Because you have been logging the",
      "metadata attribute, you can group monitoring charts by that attribute to compare model performance over time. From",
      "Monitoring",
      "in the UI sidebar, click",
      "Group by",
      "in the top left corner, select",
      "Metadata",
      "from the dropdown, then select",
      ". The charts update to show results grouped by that attribute. For more on grouping and custom charts, refer to",
      "Dashboards",
    ],
    context:
      "Because you have been logging the llm metadata attribute, you can group monitoring charts by that attribute to compare model performance over time. From Monitoring in the UI sidebar, click Group by in the top left corner, select Metadata from the dropdown, then select llm. The charts update to show results grouped by that attribute. For more on grouping and custom charts, refer to Dashboards.",
  };
  const received = [
    "지금까지 기록해 온",
    "메타데이터 속성을 기준으로 모니터링 차트를 그룹화하면 시간에 따른 모델 성능을 비교할 수 있습니다. 먼저",
    "Monitoring",
    "을 열고 UI 사이드바에서 클릭한 다음",
    "Group by",
    "를 왼쪽 상단 모서리에서 선택하고",
    "Metadata",
    "를 드롭다운에서",
    "llm",
    "을 선택하세요. 차트가 해당 속성 기준으로 그룹화된 결과로 업데이트됩니다. 그룹화 및 사용자 지정 차트에 대한 자세한 내용은",
    "Dashboards를 참고하세요.",
  ];

  it("남는 칸이 보내지 않은 텍스트(코드)와 같으면 그 칸을 빼고 받아들인다", () => {
    const result = validateGroups([group], [{ id: "g112", segments: received }]);

    expect(result.invalid).toEqual([]);
    expect(result.valid[0]!.segments).toEqual(received.filter((segment) => segment !== "llm"));
  });

  it("남는 칸이 보내지 않은 텍스트와 다르면 고치지 않고 형식 오류로 둔다", () => {
    const wrong = received.map((segment) => (segment === "llm" ? "엘엘엠" : segment));

    expect(validateGroups([group], [{ id: "g112", segments: wrong }]).invalid).toEqual([group]);
  });

  it("남는 칸이 둘이고 둘 다 보내지 않은 텍스트면 둘 다 뺀다 (문맥에 llm이 두 번 있음)", () => {
    const twice = ["llm", ...received];

    expect(validateGroups([group], [{ id: "g112", segments: twice }]).valid[0]!.segments).toHaveLength(10);
  });

  it("같은 칸이 남는 수보다 많으면(어느 것을 뺄지 모름) 고치지 않는다", () => {
    const ambiguous = ["llm", ...received.slice(1)];

    expect(validateGroups([group], [{ id: "g112", segments: ambiguous }]).invalid).toEqual([group]);
  });

  it("문맥이 없는 그룹은 고치지 않는다", () => {
    const plain: RequestGroup = { id: "g1", segments: ["Run", "now"] };

    expect(validateGroups([plain], [{ id: "g1", segments: ["지금", "llm", "실행"] }]).invalid).toEqual([plain]);
  });
});
