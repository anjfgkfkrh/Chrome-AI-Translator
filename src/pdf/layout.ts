// PDF 텍스트 항목 → 줄 → 문단 (SPEC 13장 "PDF 번역", 설계서 9절). 이 모듈은 DOM을 쓰지 않는다.
// 좌표는 모두 page.getViewport({ scale: 1 }) 기준의 포인트이고 원점은 왼쪽 위다.

/** 이 배수를 넘는 가로 간격은 표의 칸 사이로 본다 (글자 크기 기준). 아래 수치도 모두 글자 크기 기준 배수다. */
const WIDE_GAP = 2;
const SAME_LINE_Y = 0.6;
const WORD_GAP = 0.12;
const ASCENT = 0.85;
const DESCENT = 0.27;
const LINE_GAP_MIN = 0.4;
const LINE_GAP_MAX = 1.7;
const LEFT_TOLERANCE = 2.5;
const INDENT = 0.7;
const SHORT_LINE = 3;
/** 같은 문단으로 보는 글자 크기 차이 (포인트) */
const SIZE_TOLERANCE = 0.6;
/** 두 줄의 가로 겹침이 짧은 줄 폭의 이 비율을 넘어야 같은 문단이다. */
const MIN_OVERLAP = 0.3;
/** 가운데 정렬로 보는 폭 비율 */
const CENTERED_WIDTH = 0.8;
/** 한 줄 문단의 중심이 쪽 중심에서 쪽 폭의 이 비율 안에 있으면 가운데 정렬로 본다. */
const PAGE_CENTER = 0.01;
const PAGE_WIDE = 0.9;
/** 표로 보는 줄 비율, 수식으로 보는 글자 비율 */
const TABLE_RATIO = 0.5;
const LETTER_RATIO = 0.5;
const MIN_WORDS = 3;

const LETTER = /\p{L}/gu;
const WORD = /\p{L}{2,}/u;
const NUMBERED_HEADING = /^(?:[IVX]+\.|[A-Z]\.|\d+(?:\.\d+)*\.?)\s+\S/;
const SINGLE_WORD = /^[A-Z][a-z]+$/;
const UPPERCASE_TITLE = /^[A-Z ]+$/;
const REFERENCES = /^(?:[IVX]+\.?\s+|\d+\.?\s+)?(?:references|bibliography)$/i;

export interface TextItemLike {
  str: string;
  transform: number[];
  width: number;
  height: number;
}

export interface Block {
  text: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** 본문 글자 크기 (포인트) */
  size: number;
  centered: boolean;
  lines: number;
  /** 넓은 간격이 있는 줄 수 */
  wideLines: number;
}

/** 참고문헌 제목의 위치. 그 뒤로는 번역하지 않는다. */
export interface ReferencesStart {
  pageNumber: number;
  headingIndex: number;
}

export type SkipReason = "no-letters" | "table" | "math" | "short";

interface Run {
  text: string;
  x: number;
  y: number;
  width: number;
  size: number;
}

interface Line {
  text: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
  y: number;
  size: number;
  /** 줄의 크기와 y를 정한 조각의 길이 */
  mainLength: number;
  wideGaps: number;
}

/** 한 쪽의 텍스트 항목을 문단으로 묶는다. viewportTransform은 getViewport({ scale: 1 }).transform이다. */
export function pageBlocks(items: readonly TextItemLike[], viewportTransform: readonly number[], pageWidth: number): Block[] {
  return finishBlocks(toBlocks(toLines(toRuns(items, viewportTransform))), pageWidth);
}

/** 항목을 뷰포트 좌표로 바꾼다. 공백뿐인 항목과 세로·회전 글자는 버린다. */
function toRuns(items: readonly TextItemLike[], view: readonly number[]): Run[] {
  const [v0, v1, v2, v3, v4, v5] = view as [number, number, number, number, number, number];
  const runs: Run[] = [];
  for (const item of items) {
    if (item.str.trim() === "") continue;
    const [m0, m1, m2, m3, m4, m5] = item.transform as [number, number, number, number, number, number];
    const a = v0 * m0 + v2 * m1;
    const b = v1 * m0 + v3 * m1;
    const c = v0 * m2 + v2 * m3;
    const d = v1 * m2 + v3 * m3;
    if (Math.abs(b) > 0.01 || Math.abs(c) > 0.01 || a <= 0) continue;
    const size = Math.hypot(c, d) || item.height;
    if (size === 0) continue;
    runs.push({ text: item.str, x: v0 * m4 + v2 * m5 + v4, y: v1 * m4 + v3 * m5 + v5, width: item.width, size });
  }
  return runs;
}

function toLines(runs: readonly Run[]): Line[] {
  const lines: Line[] = [];
  let line: Line | undefined;
  for (const run of runs) {
    const size = line ? Math.max(run.size, line.size) : 0;
    if (line && Math.abs(run.y - line.y) < SAME_LINE_Y * size && run.x >= line.right - size) {
      const gap = run.x - line.right;
      if (gap > WIDE_GAP * size) line.wideGaps++;
      if (gap > WORD_GAP * size && !line.text.endsWith(" ") && !run.text.startsWith(" ")) line.text += " ";
      line.text += run.text;
      line.right = Math.max(line.right, run.x + run.width);
      line.top = Math.min(line.top, run.y - ASCENT * run.size);
      line.bottom = Math.max(line.bottom, run.y + DESCENT * run.size);
      // 위첨자가 줄의 기준이 되지 않도록 가장 긴 조각을 기준으로 삼는다.
      if (run.text.length > line.mainLength) {
        line.mainLength = run.text.length;
        line.size = run.size;
        line.y = run.y;
      }
    } else {
      line = {
        text: run.text,
        left: run.x,
        right: run.x + run.width,
        top: run.y - ASCENT * run.size,
        bottom: run.y + DESCENT * run.size,
        y: run.y,
        size: run.size,
        mainLength: run.text.length,
        wideGaps: 0,
      };
      lines.push(line);
    }
  }
  return lines;
}

function joinLines(text: string, next: string): string {
  const head = text.trimEnd();
  const tail = next.trimStart();
  return /[a-z]-$/.test(head) && /^[a-z]/.test(tail) ? head.slice(0, -1) + tail : `${head} ${tail}`;
}

function toBlocks(lines: readonly Line[]): Block[] {
  const blocks: Block[] = [];
  let block: Block | undefined;
  let previous: Line | undefined;
  for (const line of lines) {
    const centered = block && previous ? isCentered(line, previous, Math.max(line.size, previous.size)) : false;
    if (block && previous && continues(block, previous, line, centered)) {
      block.text = joinLines(block.text, line.text);
      block.left = Math.min(block.left, line.left);
      block.right = Math.max(block.right, line.right);
      block.top = Math.min(block.top, line.top);
      block.bottom = Math.max(block.bottom, line.bottom);
      block.lines++;
      if (line.wideGaps > 0) block.wideLines++;
      if (centered) block.centered = true;
    } else {
      block = {
        text: line.text,
        left: line.left,
        right: line.right,
        top: line.top,
        bottom: line.bottom,
        size: line.size,
        centered: false,
        lines: 1,
        wideLines: line.wideGaps > 0 ? 1 : 0,
      };
      blocks.push(block);
    }
    previous = line;
  }
  return blocks;
}

function isCentered(line: Line, previous: Line, size: number): boolean {
  const width = line.right - line.left;
  const previousWidth = previous.right - previous.left;
  const offset = Math.abs(line.left + line.right - previous.left - previous.right) / 2;
  return offset <= size && (width < CENTERED_WIDTH * previousWidth || previousWidth < CENTERED_WIDTH * width);
}

function continues(block: Block, previous: Line, line: Line, centered: boolean): boolean {
  const size = Math.max(line.size, previous.size);
  const gap = line.y - previous.y;
  const shorter = Math.min(previous.right - previous.left, line.right - line.left);
  const overlap = Math.min(previous.right, line.right) - Math.max(previous.left, line.left);
  if (Math.abs(line.size - block.size) > SIZE_TOLERANCE) return false;
  if (gap <= LINE_GAP_MIN * size || gap >= LINE_GAP_MAX * size) return false;
  if (overlap <= MIN_OVERLAP * shorter) return false;
  if (centered) return true;
  if (Math.abs(line.left - block.left) > LEFT_TOLERANCE * size) return false;
  if (line.left > block.left + INDENT * size) return false; // 들여쓴 줄은 새 문단이다
  return !(block.lines >= 2 && previous.right < block.right - SHORT_LINE * size); // 짧은 줄은 문단의 끝이다
}

function finishBlocks(blocks: Block[], pageWidth: number): Block[] {
  for (const block of blocks) {
    const center = (block.left + block.right) / 2;
    const narrow = block.right - block.left < PAGE_WIDE * pageWidth;
    if (block.lines === 1 && narrow && Math.abs(center - pageWidth / 2) <= PAGE_CENTER * pageWidth) block.centered = true;
  }
  // 위아래 문단의 영역이 겹치면 번역문이 다음 문단의 배경에 가려진다. 겹친 영역의 가운데를 경계로 삼는다.
  for (const [i, upper] of blocks.entries()) {
    for (const lower of blocks.slice(i + 1)) {
      const overlapsX = Math.min(upper.right, lower.right) > Math.max(upper.left, lower.left);
      if (overlapsX && lower.top < upper.bottom && lower.top > upper.top) {
        const middle = (lower.top + upper.bottom) / 2;
        upper.bottom = middle;
        lower.top = middle;
      }
    }
  }
  return blocks;
}

export function isReferencesHeading(text: string): boolean {
  return REFERENCES.test(text.trim());
}

/** 번역하지 않을 문단의 사유. 번역할 문단이면 undefined */
export function skipReason(block: Block): SkipReason | undefined {
  const text = block.text.trim();
  const letters = text.match(LETTER)?.length ?? 0;
  if (letters === 0) return "no-letters";
  if (block.wideLines / block.lines >= TABLE_RATIO) return "table";
  if (letters / text.length < LETTER_RATIO) return "math";
  const words = text.split(/\s+/).filter((word) => WORD.test(word)).length;
  if (words >= MIN_WORDS) return undefined;
  return NUMBERED_HEADING.test(text) || SINGLE_WORD.test(text) || UPPERCASE_TITLE.test(text) ? undefined : "short";
}

/** 번역층에 넣을 문단을 고른다. 참고문헌 제목과 그 뒤는 뺀다. */
export function translatableBlocks(
  blocks: readonly Block[],
  pageNumber: number,
  references: ReferencesStart | undefined,
): Block[] {
  if (references && pageNumber > references.pageNumber) return [];
  const end = references?.pageNumber === pageNumber ? references.headingIndex : blocks.length;
  return blocks.slice(0, end).filter((block) => skipReason(block) === undefined);
}
