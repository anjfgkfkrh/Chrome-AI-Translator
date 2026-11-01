import type { Block } from "./layout";

// 번역층 (설계서 10절): 쪽마다 문단 요소를 페이지 위에 겹친다. TranslationController는 #overlays를 웹 페이지처럼
// 수집·교체하고, 이 모듈은 텍스트가 원문과 달라지면 문단을 보이고 글자 크기를 맞춘다.

const LAYER_CLASS = "pdf-layer";
const BLOCK_CLASS = "pdf-block";
const TRANSLATED = "data-translated";
/** 문단 좌우로 넓히는 폭 (포인트). 글자 끝이 비치지 않게 한다. */
const SIDE_PADDING = 2;
/** CSS 픽셀 ÷ PDF 포인트 */
const CSS_UNITS = 96 / 72;
const MIN_FONT_PERCENT = 60;
const FONT_STEP = 5;
const DARK_LUMINANCE = 128;

/** PDFViewer에서 번역층이 쓰는 부분 */
export interface PageLookup {
  readonly currentScale: number;
  /** 사용자가 돌린 각도: 0, 90, 180, 270 */
  readonly pagesRotation: number;
  getPageView(index: number): { div: HTMLElement };
}

export class PdfOverlay {
  private readonly root: HTMLElement;
  private readonly container: HTMLElement;
  private readonly viewer: PageLookup;
  private readonly layers = new Map<number, HTMLElement>();
  private readonly originals = new WeakMap<Text, string>();
  private readonly sizes = new WeakMap<HTMLElement, number>();

  /** root: #overlays, container: #viewerContainer, pages: #viewer */
  constructor(root: HTMLElement, container: HTMLElement, pages: HTMLElement, viewer: PageLookup) {
    this.root = root;
    this.container = container;
    this.viewer = viewer;
    new ResizeObserver(() => this.place()).observe(pages);
    new MutationObserver((records) => {
      for (const record of records) this.onTextChanged(record.target as Text);
    }).observe(root, { characterData: true, subtree: true });
  }

  /** 쪽 번호의 번역층을 만들어 root에 붙이고 위치를 맞춘다. 같은 쪽을 두 번 부르지 않는다. */
  addPage(
    pageNumber: number,
    blocks: readonly Block[],
    viewport: { width: number; height: number },
    canvas: HTMLCanvasElement | null,
  ): void {
    const layer = document.createElement("div");
    layer.className = LAYER_CLASS;
    layer.dataset.page = String(pageNumber);
    const context = canvas?.getContext("2d") ?? undefined;
    for (const block of blocks) layer.append(this.createBlock(block, viewport, canvas, context));
    this.layers.set(pageNumber, layer);
    this.root.append(layer);
    this.place();
  }

  /** 모든 번역층을 페이지 위치에 맞춘다. 페이지의 투명 테두리는 빼고 안쪽 영역에 맞춘다. */
  place(): void {
    this.root.style.setProperty("--pdf-scale", String(this.viewer.currentScale * CSS_UNITS));
    const box = this.container.getBoundingClientRect();
    for (const [pageNumber, layer] of this.layers) {
      const { div } = this.viewer.getPageView(pageNumber - 1);
      const page = div.getBoundingClientRect();
      layer.style.left = `${page.left - box.left + this.container.scrollLeft + div.clientLeft}px`;
      layer.style.top = `${page.top - box.top + this.container.scrollTop + div.clientTop}px`;
      // 번역층은 돌리기 전의 크기로 두고 페이지와 함께 돌린다. 문단 좌표가 돌리기 전 쪽 기준이기 때문이다.
      const { pagesRotation: rotation } = this.viewer;
      const sideways = rotation % 180 !== 0;
      layer.style.width = `${sideways ? div.clientHeight : div.clientWidth}px`;
      layer.style.height = `${sideways ? div.clientWidth : div.clientHeight}px`;
      const moveX = rotation === 90 || rotation === 180 ? div.clientWidth : 0;
      const moveY = rotation === 180 || rotation === 270 ? div.clientHeight : 0;
      layer.style.transform = rotation === 0 ? "" : `translate(${moveX}px, ${moveY}px) rotate(${rotation}deg)`;
    }
  }

  private createBlock(
    block: Block,
    viewport: { width: number; height: number },
    canvas: HTMLCanvasElement | null,
    context: CanvasRenderingContext2D | undefined,
  ): HTMLElement {
    const left = block.left - SIDE_PADDING;
    const paragraph = document.createElement("p");
    paragraph.className = BLOCK_CLASS;
    paragraph.style.left = `${(left / viewport.width) * 100}%`;
    paragraph.style.width = `${((block.right - block.left + 2 * SIDE_PADDING) / viewport.width) * 100}%`;
    paragraph.style.top = `${(block.top / viewport.height) * 100}%`;
    paragraph.style.height = `${((block.bottom - block.top) / viewport.height) * 100}%`;
    if (block.centered) paragraph.style.textAlign = "center";
    if (canvas && context) {
      const [x, y] = rotatedPoint(left / viewport.width, block.top / viewport.height, this.viewer.pagesRotation);
      applyBackground(paragraph, canvas, context, x, y);
    }
    const text = document.createTextNode(block.text);
    this.originals.set(text, block.text);
    this.sizes.set(paragraph, block.size);
    paragraph.append(text);
    return paragraph;
  }

  private onTextChanged(text: Text): void {
    const paragraph = text.parentElement;
    if (!paragraph?.classList.contains(BLOCK_CLASS)) return;
    if (text.nodeValue === this.originals.get(text)) {
      paragraph.removeAttribute(TRANSLATED);
    } else {
      paragraph.setAttribute(TRANSLATED, "");
      fitFont(paragraph, this.sizes.get(paragraph) ?? 0);
    }
  }
}

/** 돌리기 전 쪽의 비율 좌표를 돌린 뒤의 캔버스 비율 좌표로 바꾼다. */
function rotatedPoint(x: number, y: number, rotation: number): [number, number] {
  if (rotation === 90) return [1 - y, x];
  if (rotation === 180) return [1 - x, 1 - y];
  if (rotation === 270) return [y, 1 - x];
  return [x, y];
}

/** 글자 크기를 5%씩 줄여 상자에 맞춘다. 60%에서도 넘치면 아래로 넘치게 둔다. */
function fitFont(paragraph: HTMLElement, size: number): void {
  for (let percent = 100; percent >= MIN_FONT_PERCENT; percent -= FONT_STEP) {
    paragraph.style.fontSize = `calc(var(--pdf-scale) * ${((size * percent) / 100).toFixed(2)}px)`;
    if (paragraph.scrollHeight <= paragraph.clientHeight + 1) return;
  }
}

/** 문단 왼쪽 위 바깥의 픽셀을 배경으로 쓴다. 읽지 못하면 CSS 기본값(흰 배경, 검은 글자)을 둔다. */
function applyBackground(
  paragraph: HTMLElement,
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
): void {
  try {
    const pixelX = Math.max(0, Math.floor(x * canvas.width));
    const pixelY = Math.max(0, Math.floor(y * canvas.height));
    const [red = 255, green = 255, blue = 255] = context.getImageData(pixelX, pixelY, 1, 1).data;
    paragraph.style.background = `rgb(${red}, ${green}, ${blue})`;
    if (0.299 * red + 0.587 * green + 0.114 * blue < DARK_LUMINANCE) paragraph.style.color = "#fff";
  } catch {
    // 기본 스타일을 쓴다.
  }
}
