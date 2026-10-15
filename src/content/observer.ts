// 동적 콘텐츠 감시 (SPEC 4.6, 13장 "동적 콘텐츠"): 페이지가 새로 넣거나 바꾼 텍스트를 모아 알린다.

/** 변경을 모으는 시간. 첫 변경 뒤 이만큼 기다렸다가 한 번에 알린다 (계속 바뀌는 페이지에서도 굶지 않도록 타이머를 다시 걸지 않는다). */
const DEBOUNCE_MS = 300;

export class MutationWatcher {
  private readonly root: Element;
  private readonly onChange: (nodes: Node[]) => void;
  private readonly isOwnChange: (node: Text) => boolean;
  private readonly observer: MutationObserver;
  private readonly changed = new Set<Node>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private watching = false;

  /** isOwnChange: 우리가 넣은 번역문으로 생긴 변경인지. 이런 변경은 무시해 무한 반복을 막는다. */
  constructor(root: Element, onChange: (nodes: Node[]) => void, isOwnChange: (node: Text) => boolean) {
    this.root = root;
    this.onChange = onChange;
    this.isOwnChange = isOwnChange;
    this.observer = new MutationObserver((records) => this.collect(records));
  }

  start(): void {
    if (this.watching) return;
    this.watching = true;
    this.observer.observe(this.root, { childList: true, characterData: true, subtree: true });
  }

  stop(): void {
    if (!this.watching) return;
    this.watching = false;
    this.observer.disconnect();
    clearTimeout(this.timer);
    this.timer = undefined;
    this.changed.clear();
  }

  private collect(records: MutationRecord[]): void {
    for (const record of records) {
      if (record.type === "characterData") {
        const node = record.target as Text;
        if (!this.isOwnChange(node)) this.changed.add(node);
      } else {
        record.addedNodes.forEach((node) => this.changed.add(node));
      }
    }
    if (this.changed.size > 0 && this.timer === undefined) {
      this.timer = setTimeout(() => this.flush(), DEBOUNCE_MS);
    }
  }

  private flush(): void {
    this.timer = undefined;
    const nodes = [...this.changed].filter((node) => node.isConnected);
    this.changed.clear();
    if (nodes.length > 0) this.onChange(nodes);
  }
}
