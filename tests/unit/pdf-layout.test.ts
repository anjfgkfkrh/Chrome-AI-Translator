import { describe, expect, it } from "vitest";
import { isReferencesHeading, pageBlocks, skipReason, translatableBlocks, type Block, type TextItemLike } from "../../src/pdf/layout";

// US Letter 쪽의 getViewport({ scale: 1 }).transform (원점이 왼쪽 아래 → 왼쪽 위)
const VIEW = [1, 0, 0, -1, 0, 792];
const PAGE_WIDTH = 612;

/** PDF 좌표 x, y(아래에서 위로)에 놓인 항목. 폭은 글자 수 × 크기 × 0.5로 잡는다. */
function item(str: string, x: number, y: number, size = 10): TextItemLike {
  return { str, transform: [size, 0, 0, size, x, y], width: str.length * size * 0.5, height: size };
}

function blocks(items: TextItemLike[]): Block[] {
  return pageBlocks(items, VIEW, PAGE_WIDTH);
}

const texts = (items: TextItemLike[]) => blocks(items).map((block) => block.text);

describe("pageBlocks", () => {
  it("같은 줄의 조각을 잇고, 간격이 있으면 공백을 넣는다", () => {
    expect(texts([item("Hello", 72, 700), item("world", 102, 700), item("!", 127, 700)])).toEqual(["Hello world!"]);
  });

  it("공백뿐인 항목은 버리고 위첨자는 같은 줄로 본다", () => {
    const [block] = blocks([item("Area in mm", 72, 700), item("3", 122.5, 703, 6), item("   ", 126, 700)]);

    expect(block?.text).toBe("Area in mm3");
    expect(block?.size).toBe(10);
  });

  it("다음 줄을 이어 문단을 만들고 줄 끝 하이픈을 지운다", () => {
    const lines = [item("The quick brown fox jumps over the lazy dog and exam-", 72, 700), item("ines the fence near the barn today.", 72, 688)];

    expect(texts(lines)).toEqual(["The quick brown fox jumps over the lazy dog and examines the fence near the barn today."]);
  });

  it("대문자가 뒤따르는 하이픈은 지우지 않고 공백으로 잇는다", () => {
    const lines = [item("This is the long-standing and well known Tendon-", 72, 700), item("Based design of the older robot hands.", 72, 688)];

    expect(texts(lines)).toEqual(["This is the long-standing and well known Tendon- Based design of the older robot hands."]);
  });

  it("문단 영역은 위쪽 0.85, 아래쪽 0.27 글자 크기까지이고 뷰포트 좌표다", () => {
    const [block] = blocks([item("Hello brave new world", 72, 700)]);

    expect(block?.left).toBe(72);
    expect(block?.top).toBeCloseTo(792 - 700 - 8.5);
    expect(block?.bottom).toBeCloseTo(792 - 700 + 2.7);
  });

  it("들여쓴 줄에서 새 문단을 시작한다", () => {
    const lines = [
      item("First paragraph line one goes on for a while here.", 72, 700),
      item("First paragraph line two goes on for a while here.", 72, 688),
      item("Second paragraph starts indented and goes on here.", 82, 676),
    ];

    expect(blocks(lines)).toHaveLength(2);
  });

  it("첫 줄만 들여쓴 문단은 한 문단이다", () => {
    const lines = [
      item("Indented first line goes on for a while here too.", 82, 700),
      item("Second line starts at the margin and goes on here.", 72, 688),
    ];

    expect(blocks(lines)).toHaveLength(1);
  });

  it("짧은 줄 뒤에서 문단을 나눈다", () => {
    const lines = [
      item("First paragraph line one goes on for a while here.", 72, 700),
      item("First paragraph line two goes on for a while here.", 72, 688),
      item("Short end.", 72, 676),
      item("Second paragraph starts at the margin and continues.", 72, 664),
    ];

    expect(blocks(lines)).toHaveLength(2);
  });

  it("왼쪽 단 끝과 오른쪽 단 시작을 잇지 않는다", () => {
    const lines = [item("Left column last line of the text goes here.", 72, 100), item("Right column first line of the text goes on.", 320, 700)];

    expect(blocks(lines)).toHaveLength(2);
  });

  it("글자 크기가 다르면 다른 문단이다", () => {
    expect(blocks([item("A Heading Line", 72, 700, 14), item("Body text under the heading goes here.", 72, 684)])).toHaveLength(2);
  });

  it("가운데 정렬 제목의 줄을 잇고 centered로 표시한다", () => {
    const [block, ...rest] = blocks([
      item("LEAP Hand: Low-Cost, Efficient, and Anthropomorphic Hand for", 96, 700, 14),
      item("Robot Learning", 257, 684, 14),
    ]);

    expect(rest).toEqual([]);
    expect(block?.text).toBe("LEAP Hand: Low-Cost, Efficient, and Anthropomorphic Hand for Robot Learning");
    expect(block?.centered).toBe(true);
  });

  it("쪽 가운데의 한 줄 문단은 centered다", () => {
    expect(blocks([item("Centered Title Text", 258.5, 700)])[0]?.centered).toBe(true);
    expect(blocks([item("Left Title Text", 72, 700)])[0]?.centered).toBe(false);
  });

  it("세로·회전 글자는 버린다", () => {
    const rotated: TextItemLike = { str: "arXiv:1706.03762v7", transform: [0, 10, -10, 0, 30, 300], width: 90, height: 10 };

    expect(texts([rotated, item("Body text here.", 72, 700)])).toEqual(["Body text here."]);
  });

  it("쪽이 90도 회전한 PDF도 뷰포트 좌표의 가로 글자로 읽는다", () => {
    // /Rotate 90인 쪽: 글자는 PDF 좌표에서 세로이고 뷰포트 변환을 거치면 가로가 된다.
    const rotatedView = [0, 1, 1, 0, 0, 0];
    const rotatedItem: TextItemLike = { str: "Rotated page body text.", transform: [0, 10, -10, 0, 700, 72], width: 115, height: 10 };

    const [block] = pageBlocks([rotatedItem], rotatedView, 792);

    expect(block?.text).toBe("Rotated page body text.");
    expect(block?.left).toBe(72);
  });

  it("위아래 문단의 영역이 겹치면 가운데를 경계로 삼는다", () => {
    const [upper, lower] = blocks([item("Upper block text goes here now.", 72, 700), item("Indented lower block text here.", 90, 690)]);

    expect(upper?.bottom).toBe(lower?.top);
    expect(upper?.bottom).toBeGreaterThan(92);
  });
});

function block(text: string, overrides: Partial<Block> = {}): Block {
  return { text, left: 0, right: 100, top: 0, bottom: 10, size: 10, centered: false, lines: 1, wideLines: 0, ...overrides };
}

describe("skipReason", () => {
  it("글자가 없으면 no-letters", () => {
    expect(skipReason(block("12 34 %"))).toBe("no-letters");
  });

  it("넓은 간격이 있는 줄이 절반 이상이면 table", () => {
    expect(skipReason(block("Allegro Hand Linear Angular", { lines: 3, wideLines: 2 }))).toBe("table");
    expect(skipReason(block("Allegro Hand Linear Angular", { lines: 3, wideLines: 1 }))).toBeUndefined();
  });

  it("글자 비율이 절반 미만이면 math", () => {
    expect(skipReason(block("x = 1 + 2 * (3 / 4) - 5"))).toBe("math");
  });

  it("단어가 3개 미만인 라벨은 short", () => {
    expect(skipReason(block("Allegro Failure"))).toBe("short");
    expect(skipReason(block("Up Down"))).toBe("short");
  });

  it("제목 번호, 대문자로 시작하는 한 단어, 대문자 제목은 짧아도 번역한다", () => {
    expect(skipReason(block("B. Robustness"))).toBeUndefined();
    expect(skipReason(block("I. INTRODUCTION"))).toBeUndefined();
    expect(skipReason(block("2.1 Encoder"))).toBeUndefined();
    expect(skipReason(block("Abstract"))).toBeUndefined();
    expect(skipReason(block("RELATED WORK"))).toBeUndefined();
  });

  it("본문은 번역한다", () => {
    expect(skipReason(block("Fig. 1: The hand is shown here."))).toBeUndefined();
  });
});

describe("isReferencesHeading", () => {
  it("참고문헌 제목을 찾는다", () => {
    for (const text of ["References", "REFERENCES", " Bibliography ", "VIII. REFERENCES", "7 References", "7. References"]) {
      expect(isReferencesHeading(text)).toBe(true);
    }
    expect(isReferencesHeading("See the references below for details.")).toBe(false);
  });
});

describe("translatableBlocks", () => {
  const page = [block("Body one goes here."), block("x = 1 + 2 * (3 / 4) - 5"), block("References"), block("Smith et al. wrote this.")];

  it("참고문헌이 없으면 건너뛸 문단만 뺀다", () => {
    expect(translatableBlocks(page, 3, undefined).map((item) => item.text)).toEqual([
      "Body one goes here.",
      "References",
      "Smith et al. wrote this.",
    ]);
  });

  it("제목이 있는 쪽은 제목 앞까지, 뒤의 쪽은 모두 뺀다", () => {
    const references = { pageNumber: 3, headingIndex: 2 };

    expect(translatableBlocks(page, 2, references)).toHaveLength(3);
    expect(translatableBlocks(page, 3, references).map((item) => item.text)).toEqual(["Body one goes here."]);
    expect(translatableBlocks(page, 4, references)).toEqual([]);
  });
});
