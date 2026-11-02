import { UI_ATTRIBUTE } from "./collect";

// 원문 찾기 라벨 (설계 7절). 토스트처럼 전용 태그 + Shadow DOM으로 html 바로 아래에 붙이고, 번역문은 건드리지 않는다.

export type LookupView =
  | { kind: "loading" }
  | { kind: "term"; text: string }
  | { kind: "sentence"; text: string }
  | { kind: "paragraph"; text: string };

/** 라벨과 선택 영역, 화면 가장자리 사이의 간격 (px) */
const GAP = 8;

const TITLES: Record<LookupView["kind"], string | undefined> = {
  loading: undefined,
  term: undefined,
  sentence: "원문 문장",
  paragraph: "문단 원문",
};

// 페이지 CSS가 어떻든 자리를 지키도록 호스트 요소에 직접 !important로 준다.
const HOST_STYLE: Record<string, string> = {
  all: "initial",
  display: "block",
  position: "fixed",
  left: "0px",
  top: "0px",
  "z-index": "2147483647",
};

// 색은 토스트와 같다.
const STYLE = `
.label {
  box-sizing: border-box;
  max-width: 420px;
  max-height: 240px;
  overflow: auto;
  padding: 8px 10px;
  border: 1px solid #d1d9e0;
  border-radius: 8px;
  background: #ffffff;
  color: #1f2328;
  font: 13px/1.5 system-ui, sans-serif;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  user-select: text;
  -webkit-user-select: text;
}
.title { margin: 0 0 2px; font-size: 12px; font-weight: 600; opacity: 0.7; }
.text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
@media (prefers-color-scheme: dark) {
  .label { background: #151b23; color: #f0f6fc; border-color: #3d444d; }
}
`;

/**
 * 라벨 위치. 선택 영역 위쪽 8px, 가로 가운데. 위에 자리가 없으면 아래쪽 8px.
 * 좌우는 화면 가장자리에서 8px 안으로 제한한다.
 */
export function labelPosition(
  anchor: { left: number; top: number; width: number; bottom: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): { left: number; top: number } {
  const maxLeft = viewport.width - GAP - size.width;
  const left = Math.max(GAP, Math.min(anchor.left + anchor.width / 2 - size.width / 2, maxLeft));
  const above = anchor.top - GAP - size.height;
  return { left, top: above >= 0 ? above : anchor.bottom + GAP };
}

export class LookupPopup {
  private host: HTMLElement | undefined;
  private box: HTMLElement | undefined;
  private anchor: DOMRect | undefined;

  /** 라벨을 연다. 이미 열려 있으면 먼저 닫는다. */
  show(anchor: DOMRect, view: LookupView): void {
    this.close();
    // div 같은 흔한 태그를 고르는 페이지 CSS에 걸리지 않도록 전용 이름을 쓴다.
    const host = document.createElement("aitranslator-lookup");
    host.setAttribute(UI_ATTRIBUTE, "");
    for (const [name, value] of Object.entries(HOST_STYLE)) host.style.setProperty(name, value, "important");
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = STYLE;
    const box = document.createElement("div");
    box.className = "label";
    box.setAttribute("role", "status");
    root.append(style, box);
    this.host = host;
    this.box = box;
    this.anchor = anchor;
    this.render(view);
    // body 밖(html 바로 아래)에 붙여 번역 수집 대상과 페이지 레이아웃에서 떨어뜨린다.
    document.documentElement.append(host);
    this.place();
    document.addEventListener("mousedown", this.onMouseDown, true);
    document.addEventListener("keydown", this.onKeyDown, true);
    document.addEventListener("scroll", this.onScroll, true);
  }

  /** 열려 있는 라벨의 내용을 바꾼다 (찾는 중 → 결과). */
  update(view: LookupView): void {
    if (!this.box) return;
    this.render(view);
    this.place();
  }

  close(): void {
    document.removeEventListener("mousedown", this.onMouseDown, true);
    document.removeEventListener("keydown", this.onKeyDown, true);
    document.removeEventListener("scroll", this.onScroll, true);
    this.host?.remove();
    this.host = this.box = this.anchor = undefined;
  }

  /** 라벨 안에서 일어난 이벤트인지 */
  contains(event: Event): boolean {
    return this.host !== undefined && event.composedPath().includes(this.host);
  }

  private render(view: LookupView): void {
    const box = this.box!;
    const title = TITLES[view.kind];
    const children: HTMLElement[] = [];
    if (title) children.push(create("p", "title", title));
    children.push(create("p", "text", view.kind === "loading" ? "찾는 중…" : view.text));
    box.replaceChildren(...children);
  }

  private place(): void {
    if (!this.host || !this.box || !this.anchor) return;
    const size = this.box.getBoundingClientRect();
    const { left, top } = labelPosition(
      this.anchor,
      { width: size.width, height: size.height },
      { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight },
    );
    this.host.style.setProperty("left", `${left}px`, "important");
    this.host.style.setProperty("top", `${top}px`, "important");
  }

  private readonly onMouseDown = (event: Event): void => {
    if (!this.contains(event)) this.close();
  };

  private readonly onKeyDown = (event: Event): void => {
    if ((event as KeyboardEvent).key === "Escape") this.close();
  };

  // 라벨 자신의 스크롤은 닫지 않는다.
  private readonly onScroll = (event: Event): void => {
    if (!this.contains(event)) this.close();
  };
}

function create(tag: "p", className: string, text: string): HTMLElement {
  const el = document.createElement(tag);
  el.className = className;
  el.textContent = text;
  return el;
}
