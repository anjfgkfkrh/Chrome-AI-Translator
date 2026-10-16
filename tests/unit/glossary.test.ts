import { describe, expect, it } from "vitest";
import { glossaryText, parseGlossary, sameTerms } from "../../src/shared/glossary";

describe("용어집 입력란 읽기 (SPEC 4.10, 13장 \"용어집 편집\")", () => {
  it("한 줄에 하나씩 읽고, 지정 번역어는 \"원어 = 번역어\"로 읽는다", () => {
    expect(parseGlossary("LangChain\nLangGraph", "agent = 에이전트\ntrace=트레이스")).toEqual({
      ok: true,
      terms: { keep: ["LangChain", "LangGraph"], map: { agent: "에이전트", trace: "트레이스" } },
    });
  });

  it("빈 줄·앞뒤 공백·똑같은 줄은 조용히 정리한다", () => {
    const keep = "  LangChain  \n\n\nLangChain\r\nAPI\n";
    const map = "\n agent  =  에이전트 \nagent = 에이전트\n";

    expect(parseGlossary(keep, map)).toEqual({
      ok: true,
      terms: { keep: ["LangChain", "API"], map: { agent: "에이전트" } },
    });
  });

  it("번역어에 '='가 있으면 첫 '=' 뒤는 모두 번역어다", () => {
    expect(parseGlossary("", "a=b = c=d")).toEqual({ ok: true, terms: { keep: [], map: { a: "b = c=d" } } });
  });

  it("원어나 번역어 한쪽이 빈 줄은 빈 줄처럼 뺀다", () => {
    expect(parseGlossary("", "agent =\n= 에이전트\ntrace = 트레이스")).toEqual({
      ok: true,
      terms: { keep: [], map: { trace: "트레이스" } },
    });
  });

  it("'='가 없는 줄은 몇 번째 줄인지 알린다 (빈 줄도 센다)", () => {
    expect(parseGlossary("", "agent = 에이전트\n\ntrace 트레이스")).toEqual({
      ok: false,
      error: "3번째 줄에 '='가 없습니다.",
    });
  });

  it("같은 원어에 번역어가 둘이면 저장하지 않는다", () => {
    expect(parseGlossary("", "agent = 에이전트\nagent = 요원")).toEqual({
      ok: false,
      error: "'agent'의 번역어가 두 개 있습니다.",
    });
  });

  it("두 목록에 모두 있는 단어는 저장하지 않는다. 대소문자는 구분한다", () => {
    expect(parseGlossary("LangChain\nagent", "agent = 에이전트")).toEqual({
      ok: false,
      error: "'agent'이(가) 두 목록에 모두 있습니다.",
    });
    expect(parseGlossary("Agent", "agent = 에이전트")).toEqual({
      ok: true,
      terms: { keep: ["Agent"], map: { agent: "에이전트" } },
    });
  });

  it("\"__proto__\" 같은 원어도 보통 단어로 다룬다", () => {
    const parsed = parseGlossary("", "__proto__ = 프로토");

    expect(parsed.ok && Object.entries(parsed.terms.map)).toEqual([["__proto__", "프로토"]]);
  });
});

describe("입력란에 보여 줄 글", () => {
  it("읽은 것과 같은 형식으로 되돌린다", () => {
    const terms = { keep: ["LangChain", "API"], map: { agent: "에이전트", trace: "트레이스" } };

    expect(glossaryText(terms)).toEqual({ keep: "LangChain\nAPI", map: "agent = 에이전트\ntrace = 트레이스" });
    const text = glossaryText(terms);
    expect(parseGlossary(text.keep, text.map)).toEqual({ ok: true, terms });
  });
});

describe("sameTerms", () => {
  it("순서만 다르면 같은 용어집이다", () => {
    expect(
      sameTerms(
        { keep: ["A", "B"], map: { x: "엑스", y: "와이" } },
        { keep: ["B", "A"], map: { y: "와이", x: "엑스" } },
      ),
    ).toBe(true);
  });

  it("단어나 번역어가 하나라도 다르면 다른 용어집이다", () => {
    const base = { keep: ["A"], map: { x: "엑스" } };

    expect(sameTerms(base, { keep: ["A", "B"], map: { x: "엑스" } })).toBe(false);
    expect(sameTerms(base, { keep: ["A"], map: { x: "엑스2" } })).toBe(false);
    expect(sameTerms(base, { keep: ["A"], map: {} })).toBe(false);
  });
});
