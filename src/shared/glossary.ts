// 용어집 편집 (SPEC 4.10, 13장 "용어집 편집"): 옵션 페이지의 여러 줄 입력란과 용어집을 오간다.

export interface GlossaryTerms {
  /** 번역하지 않을 단어 */
  keep: string[];
  /** 지정 번역어 (원어 → 번역어) */
  map: Record<string, string>;
}

export type GlossaryParseResult = { ok: true; terms: GlossaryTerms } | { ok: false; error: string };

/** 입력란에 보여 줄 글: 한 줄에 하나, 지정 번역어는 "원어 = 번역어" */
export function glossaryText(terms: GlossaryTerms): { keep: string; map: string } {
  return {
    keep: terms.keep.join("\n"),
    map: Object.entries(terms.map)
      .map(([term, translation]) => `${term} = ${translation}`)
      .join("\n"),
  };
}

/**
 * 입력란의 글을 읽는다. 빈 줄·앞뒤 공백·똑같은 줄은 조용히 정리하고, '='가 없는 줄, 같은 원어에 다른 번역어,
 * 두 목록에 모두 있는 단어는 저장하지 않고 안내한다 (SPEC 13장 "M7 화면 문구"). 같은 단어인지는 대소문자를 구분한다.
 */
export function parseGlossary(keepText: string, mapText: string): GlossaryParseResult {
  const keep = unique(lines(keepText).map((line) => line.text).filter((text) => text !== ""));
  const map = new Map<string, string>();
  for (const { text, number } of lines(mapText)) {
    if (text === "") continue;
    const at = text.indexOf("=");
    if (at < 0) return { ok: false, error: `${number}번째 줄에 '='가 없습니다.` };
    const term = text.slice(0, at).trim();
    const translation = text.slice(at + 1).trim();
    // 원어나 번역어 한쪽이 비어 있으면 빈 줄처럼 뺀다.
    if (term === "" || translation === "") continue;
    const existing = map.get(term);
    if (existing !== undefined && existing !== translation) {
      return { ok: false, error: `'${term}'의 번역어가 두 개 있습니다.` };
    }
    map.set(term, translation);
  }
  const inBoth = keep.find((word) => map.has(word));
  if (inBoth !== undefined) return { ok: false, error: `'${inBoth}'이(가) 두 목록에 모두 있습니다.` };
  // Object.fromEntries는 "__proto__" 같은 원어도 보통 속성으로 넣는다.
  return { ok: true, terms: { keep, map: Object.fromEntries(map) } };
}

/** 같은 용어집인지. 순서는 보지 않는다. */
export function sameTerms(a: GlossaryTerms, b: GlossaryTerms): boolean {
  const keep = (terms: GlossaryTerms) => JSON.stringify([...terms.keep].sort());
  const map = (terms: GlossaryTerms) =>
    JSON.stringify(Object.entries(terms.map).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));
  return keep(a) === keep(b) && map(a) === map(b);
}

function lines(text: string): { text: string; number: number }[] {
  return text.split(/\r?\n/).map((line, i) => ({ text: line.trim(), number: i + 1 }));
}

function unique(words: string[]): string[] {
  return [...new Set(words)];
}
