// 텍스트 노드 수집, 필터, 그룹화 (SPEC 4.1, 4.2). 이 모듈은 DOM을 읽기만 한다.

/** 확장 프로그램 자신의 UI(토스트 등)에 붙이는 표시. 이 요소 아래는 수집하지 않는다. */
export const UI_ATTRIBUTE = "data-aitranslator-ui";

// 4.1의 제외 태그를 둘로 나눈다.
// 화면에 글자로 보이지 않거나 입력 요소라서 수집하지도, 문맥(context)에 넣지도 않는 태그
const OMIT_TAGS = new Set([
  "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TEXTAREA", "INPUT", "SELECT", "OPTION", "SVG", "MATH", "CANVAS", "IFRAME",
]);
// 번역하지 않고 원문을 두지만 문장의 일부이므로 문맥에는 넣는 태그
const KEEP_TAGS = new Set(["CODE", "PRE", "KBD", "SAMP", "VAR"]);

// CSS display와 관계없이 항상 블록 경계로 보는 태그 (SPEC 13장 "블록 경계")
const BOUNDARY_TAGS = new Set([
  "P", "LI", "H1", "H2", "H3", "H4", "H5", "H6", "TD", "TH", "BUTTON", "LABEL",
  "DT", "DD", "SUMMARY", "CAPTION", "FIGCAPTION", "BLOCKQUOTE",
]);

// 이 display 값을 가진 요소는 블록 경계가 아니다. 그 밖의 값은 모두 경계로 본다.
const INLINE_DISPLAYS = new Set(["inline", "inline-block", "contents"]);

const EDITABLE_VALUES = new Set(["", "true", "plaintext-only"]);

/** 한글 글자 수 ÷ 문자 수가 이 값 이상이면 이미 한국어로 보고 건너뛴다 (SPEC 13장). */
const KOREAN_RATIO = 0.5;

const LETTER = /\p{L}/u;
const HANGUL = /\p{Script=Hangul}/u;

// 공백 없는 한 덩어리일 때만 적용한다 (SPEC 13장 "URL·이메일·경로 판정").
const ADDRESS_PATTERNS = [
  /^(?:https?:\/\/|www\.)/i, // ① URL
  /^[^@]+@[^@]+\.[^@]+$/, // ② 이메일
  /^(?:\/|\.\.?\/|~\/)/, // ③ 경로
  /^[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)+$/u, // ④ 점으로 이어진 한 단어
];

export interface TextUnit {
  node: Text;
  /** 수집할 때의 nodeValue 전체 */
  value: string;
  lead: string;
  core: string;
  tail: string;
  /** 같은 블록에서 이 노드 바로 뒤에 붙은, 번역하지 않는 텍스트 (다음 번역 노드 전까지). 예: 링크 뒤의 "." */
  after: string;
}

/** 같은 블록 안의 텍스트 노드 묶음. 번역할 때의 문맥 단위다 (4.2). */
export interface Group {
  id: string;
  units: TextUnit[];
  /** 블록 안에 번역하지 않는 텍스트(코드, URL, 숫자, 문장 부호 등)가 끼어 있을 때 블록 전체 텍스트 (SPEC 13장) */
  context?: string;
  /** 수집할 때 블록이 화면 안에 있었는지. 보이는 그룹부터 번역한다 (SPEC 4.5, 13장 "보이는 영역 우선"). */
  visible: boolean;
}

let lastGroupId = 0;

/**
 * root 아래 텍스트 노드를 모아 가장 가까운 블록 조상 단위로 묶는다. 그룹과 그룹 안의 노드는 문서 순서를 따른다.
 * isHandled가 true를 돌려주는 노드(이미 번역한 노드 등)는 다시 모으지 않는다.
 */
export function collectGroups(root: Element, isHandled?: (node: Text) => boolean): Group[] {
  const states = new Map<Element, ElementState>();
  const boundaries = new Map<Element, boolean>();
  const blocks = new Map<Element, BlockText>();
  const groups: Group[] = [];
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    const parent = text.parentElement;
    if (!parent) continue;
    const state = stateOf(parent, states);
    if (state.omit) continue;

    const value = text.nodeValue ?? "";
    const blockElement = blockOf(parent, boundaries);
    let block = blocks.get(blockElement);
    if (!block) {
      block = { pieces: [], hasGap: false };
      blocks.set(blockElement, block);
    }
    block.pieces.push(value);

    const { lead, core, tail } = splitWhitespace(value);
    if (!state.keep && !state.translateNo && !isHandled?.(text) && !shouldSkip(core)) {
      if (!block.group) {
        block.group = { id: `g${++lastGroupId}`, units: [], visible: false };
        groups.push(block.group);
      }
      block.lastUnit = { node: text, value, lead, core, tail, after: "" };
      block.group.units.push(block.lastUnit);
    } else {
      if (block.lastUnit) block.lastUnit.after += value;
      // 번역하지 않는 텍스트(코드, URL, 숫자, 문장 부호 등)가 끼어 있다. 모델이 이 텍스트를 세그먼트에 넣지 않도록 문맥으로 알려 준다.
      if (core !== "") block.hasGap = true;
    }
  }

  for (const [element, block] of blocks) {
    if (!block.group) continue;
    if (block.hasGap) block.group.context = block.pieces.join("").replace(/\s+/g, " ").trim();
    block.group.visible = isOnScreen(element);
  }
  return groups;
}

/**
 * 페이지가 새로 넣거나 바꾼 노드가 속한 블록만 다시 모은다 (SPEC 4.6, 13장 "동적 콘텐츠").
 * 블록 전체를 모으므로 문맥(context)도 블록 단위로 맞고, 이미 번역한 노드는 isHandled로 건너뛴다.
 */
export function collectGroupsAround(nodes: Iterable<Node>, isHandled?: (node: Text) => boolean): Group[] {
  const boundaries = new Map<Element, boolean>();
  const blocks = new Set<Element>();
  for (const node of nodes) {
    const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    if (element?.isConnected) blocks.add(blockOf(element, boundaries));
  }
  // 다른 블록 안에 든 블록은 바깥 블록을 모을 때 함께 모인다.
  const roots = [...blocks].filter((block) => ![...blocks].some((other) => other !== block && other.contains(block)));
  return roots.flatMap((root) => collectGroups(root, isHandled));
}

function isOnScreen(element: Element): boolean {
  const view = element.ownerDocument.defaultView;
  const rect = element.getBoundingClientRect();
  if (!view || rect.width === 0 || rect.height === 0) return false;
  return rect.bottom > 0 && rect.right > 0 && rect.top < view.innerHeight && rect.left < view.innerWidth;
}

interface BlockText {
  group?: Group;
  /** 이 블록에서 마지막으로 모은 번역 노드 */
  lastUnit?: TextUnit;
  /** 블록 안 텍스트를 문서 순서대로 (번역하지 않는 텍스트 포함) */
  pieces: string[];
  /** 번역하지 않는 글자가 끼어 있는지 */
  hasGap: boolean;
}

/** 앞뒤 공백을 떼어 낸다. 교체할 값은 lead + 번역(core) + tail이다 (4.1). */
export function splitWhitespace(value: string): { lead: string; core: string; tail: string } {
  const withoutLead = value.trimStart();
  const core = withoutLead.trimEnd();
  return {
    lead: value.slice(0, value.length - withoutLead.length),
    core,
    tail: withoutLead.slice(core.length),
  };
}

/** 번역 요청에서 뺄 텍스트: 공백뿐, 문자 없음, 이미 한국어, 주소처럼 보임 (4.1) */
export function shouldSkip(core: string): boolean {
  return !LETTER.test(core) || isMostlyKorean(core) || looksLikeAddress(core);
}

export function isMostlyKorean(text: string): boolean {
  let letters = 0;
  let hangul = 0;
  for (const char of text) {
    if (!LETTER.test(char)) continue;
    letters++;
    if (HANGUL.test(char)) hangul++;
  }
  return letters > 0 && hangul / letters >= KOREAN_RATIO;
}

export function looksLikeAddress(text: string): boolean {
  return !/\s/.test(text) && ADDRESS_PATTERNS.some((pattern) => pattern.test(text));
}

interface ElementState {
  /** 수집하지도 문맥에 넣지도 않음: OMIT_TAGS, 편집 영역, 확장 UI 아래 */
  omit: boolean;
  /** 원문을 두지만 문맥에는 넣음: KEEP_TAGS, notranslate 클래스 아래 */
  keep: boolean;
  /** 가장 가까운 translate 속성이 "no" */
  translateNo: boolean;
}

const ROOT_STATE: ElementState = { omit: false, keep: false, translateNo: false };

function stateOf(el: Element, cache: Map<Element, ElementState>): ElementState {
  let state = cache.get(el);
  if (!state) {
    const parent = el.parentElement ? stateOf(el.parentElement, cache) : ROOT_STATE;
    const tag = el.tagName.toUpperCase();
    state = {
      omit: parent.omit || OMIT_TAGS.has(tag) || isEditableRoot(el) || el.hasAttribute(UI_ATTRIBUTE),
      keep: parent.keep || KEEP_TAGS.has(tag) || el.classList.contains("notranslate"),
      translateNo: translateNoOf(el, parent.translateNo),
    };
    cache.set(el, state);
  }
  return state;
}

function isEditableRoot(el: Element): boolean {
  const editable = el.getAttribute("contenteditable");
  return editable !== null && EDITABLE_VALUES.has(editable.toLowerCase());
}

/** HTML 표준: 가장 가까운 translate 속성을 따른다. 잘못된 값이면 부모 값을 물려받는다. */
function translateNoOf(el: Element, inherited: boolean): boolean {
  const value = el.getAttribute("translate")?.toLowerCase();
  if (value === "no") return true;
  if (value === "yes" || value === "") return false;
  return inherited;
}

function blockOf(el: Element, cache: Map<Element, boolean>): Element {
  let current = el;
  while (!isBoundary(current, cache) && current.parentElement) current = current.parentElement;
  return current;
}

function isBoundary(el: Element, cache: Map<Element, boolean>): boolean {
  let boundary = cache.get(el);
  if (boundary === undefined) {
    boundary = BOUNDARY_TAGS.has(el.tagName.toUpperCase()) || !INLINE_DISPLAYS.has(getComputedStyle(el).display);
    cache.set(el, boundary);
  }
  return boundary;
}
