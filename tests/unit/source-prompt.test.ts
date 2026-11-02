import { describe, expect, it } from "vitest";
import { parseSourceResponse, sourceUserMessage } from "../../src/background/source-prompt";
import { ProviderError } from "../../src/background/providers/types";
import { normalizeSource } from "../../src/shared/source-text";

describe("normalizeSource", () => {
  it("합자를 풀고 공백을 하나로 만든다", () => {
    expect(normalizeSource("ﬁnding  the\ntarget")).toBe("finding the target");
  });
  it("줄바꿈 하이픈을 없애되 복합어 하이픈은 둔다", () => {
    expect(normalizeSource("atten- tion")).toBe("attention");
    expect(normalizeSource("state-of-the-art")).toBe("state-of-the-art");
  });
});

describe("sourceUserMessage", () => {
  it("selection, translation, source 키로 보낸다", () => {
    expect(JSON.parse(sourceUserMessage({ selection: "a", original: "b", translated: "c" }))).toEqual({
      selection: "a",
      translation: "c",
      source: "b",
    });
  });
});

describe("parseSourceResponse", () => {
  const original = "The attention mechanism works. Next sentence.";

  it.each(["term", "sentence"] as const)("%s 응답을 읽고 앞뒤 공백을 자른다", (kind) => {
    expect(parseSourceResponse(JSON.stringify({ kind, text: " attention mechanism " }), original)).toEqual({
      kind,
      text: "attention mechanism",
    });
  });

  it("코드 울타리로 감싼 JSON도 읽는다", () => {
    const text = '```json\n{"kind":"term","text":"attention mechanism"}\n```';
    expect(parseSourceResponse(text, original)).toEqual({ kind: "term", text: "attention mechanism" });
  });

  it.each([
    ['{"kind":"term","text":"gradient"}', "원문에 없는 text"],
    ['{"kind":"term","text":"  "}', "빈 text"],
    ['{"kind":"phrase","text":"attention"}', "틀린 kind"],
    ["attention mechanism", "JSON이 아닌 응답"],
  ])("%s (%s)는 format 오류다", (text) => {
    try {
      parseSourceResponse(text, original);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).kind).toBe("format");
    }
  });

  it("PDF 합자 원문에도 통과한다", () => {
    expect(parseSourceResponse('{"kind":"term","text":"finding the target"}', "ﬁnding the target")).toEqual({
      kind: "term",
      text: "finding the target",
    });
  });
});
