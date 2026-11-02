import { sendMessage, type FindSourceRequest, type FindSourceResult } from "../shared/messages";
import { MAX_SELECTION_LENGTH, normalizeSource } from "../shared/source-text";
import type { BlockText } from "./apply";
import { LookupPopup, type LookupView } from "./lookup-popup";

// 번역문을 Option+드래그하면 선택한 부분의 원문을 라벨로 보여 준다 (설계 2·3절). 웹과 PDF 뷰어가 같은 경로를 쓴다.

const EDITABLE = "input, textarea, select, [contenteditable]";

export class TermLookup {
  private readonly page: { blockOf(node: Text): BlockText | undefined };
  private readonly find: (request: FindSourceRequest) => Promise<FindSourceResult>;
  private readonly popup: LookupPopup;
  /** 찾은 용어·문장. 실패는 저장하지 않는다. */
  private readonly found = new Map<string, FindSourceResult & { kind: "term" | "sentence" }>();
  /** 가장 최근 찾기의 번호. 늦게 온 이전 응답을 버리는 데 쓴다. */
  private latest = 0;

  constructor(
    page: { blockOf(node: Text): BlockText | undefined },
    find: (request: FindSourceRequest) => Promise<FindSourceResult> = (request) =>
      sendMessage({ type: "find-source", ...request }),
    popup: LookupPopup = new LookupPopup(),
  ) {
    this.page = page;
    this.find = find;
    this.popup = popup;
    document.addEventListener("mouseup", this.onMouseUp);
  }

  /** 라벨을 닫고 진행 중인 응답을 버린다. */
  close(): void {
    this.latest++;
    this.popup.close();
  }

  /** 리스너를 뗀다. */
  dispose(): void {
    document.removeEventListener("mouseup", this.onMouseUp);
    this.close();
  }

  private readonly onMouseUp = (event: MouseEvent): void => {
    if (!event.altKey || this.popup.contains(event)) return;
    if (event.target instanceof Element && event.target.closest(EDITABLE)) return;
    const range = selectedRange();
    if (!range) return;
    const picked = this.pick(range);
    if (!picked) return;
    void this.lookup(range.getBoundingClientRect(), picked.block, picked.selection);
  };

  /** 선택이 시작된 번역문 문단과, 그 문단 안의 선택 글자. 찾을 수 없는 선택이면 undefined */
  private pick(range: Range): { block: BlockText; selection: string } | undefined {
    const parts = selectedTexts(range);
    const start = parts[0];
    const block = start && this.page.blockOf(start.node);
    if (!block) return undefined;
    const text = parts
      .filter((part) => this.page.blockOf(part.node) === block)
      .map((part) => part.text)
      .join("");
    const selection = text.replace(/\s+/g, " ").trim();
    return selection === "" ? undefined : { block, selection };
  }

  private async lookup(anchor: DOMRect, block: BlockText, selection: string): Promise<void> {
    const id = ++this.latest;
    if (selection.length > MAX_SELECTION_LENGTH) {
      this.popup.show(anchor, { kind: "paragraph", text: block.original });
      return;
    }
    // 번역하지 않고 남은 고유명사처럼 원문에 그대로 있는 글자는 묻지 않는다.
    if (normalizeSource(block.original).includes(normalizeSource(selection))) {
      this.popup.show(anchor, { kind: "term", text: selection });
      return;
    }
    const key = `${normalizeSource(selection)}\u0000${normalizeSource(block.original)}`;
    const saved = this.found.get(key);
    if (saved) {
      this.popup.show(anchor, saved);
      return;
    }

    this.popup.show(anchor, { kind: "loading" });
    let view: LookupView = { kind: "paragraph", text: block.original };
    try {
      const result = await this.find({ selection, original: block.original, translated: block.translated });
      if (result?.kind === "term" || result?.kind === "sentence") {
        this.found.set(key, result);
        view = result;
      }
    } catch (err) {
      // 확장을 새로고침해 메시지가 끊긴 경우 등: 찾는 중에 멈추지 않고 문단 원문을 보여 준다.
      console.warn("[AITranslator] 원문 찾기 요청이 실패했습니다.", err instanceof Error ? err.message : err);
    }
    if (id === this.latest) this.popup.update(view);
  }
}

function selectedRange(): Range | undefined {
  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return undefined;
  return selection.getRangeAt(0);
}

/** 범위 안의 텍스트 노드와 그 노드의 선택 부분을 문서 순서로. 선택 부분이 빈 노드(경계에 닿기만 한 노드)는 뺀다. */
function selectedTexts(range: Range): { node: Text; text: string }[] {
  const root = range.commonAncestorContainer;
  const nodes: Text[] = [];
  if (root instanceof Text) {
    nodes.push(root);
  } else {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (range.intersectsNode(node)) nodes.push(node as Text);
    }
  }
  return nodes
    .map((node) => {
      const from = node === range.startContainer ? range.startOffset : 0;
      const to = node === range.endContainer ? range.endOffset : node.length;
      return { node, text: node.data.slice(from, to) };
    })
    .filter((part) => part.text !== "");
}
