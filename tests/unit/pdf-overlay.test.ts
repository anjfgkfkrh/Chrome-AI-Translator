import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Block } from "../../src/pdf/layout";
import { PdfOverlay, type PageLookup } from "../../src/pdf/overlay";

const BLOCK: Block = { text: "Original text.", left: 72, right: 300, top: 100, bottom: 112, size: 10, centered: false, lines: 1, wideLines: 0 };
const VIEWPORT = { width: 612, height: 792 };

function setup(pagesRotation = 0) {
  document.body.innerHTML = '<div id="container"><div id="pages"></div><div id="overlays"></div></div>';
  const root = document.querySelector<HTMLElement>("#overlays")!;
  const pageDiv = document.createElement("div");
  Object.defineProperty(pageDiv, "clientWidth", { value: 600 });
  Object.defineProperty(pageDiv, "clientHeight", { value: 800 });
  const viewer: PageLookup = { currentScale: 1.5, pagesRotation, getPageView: () => ({ div: pageDiv }) };
  const overlay = new PdfOverlay(root, document.querySelector("#container")!, document.querySelector("#pages")!, viewer);
  return { root, overlay, pageDiv };
}

const flush = () => new Promise((resolve) => setTimeout(resolve));

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} });
});

describe("PdfOverlay", () => {
  it("쪽의 문단을 원문 텍스트 노드 하나로 만들고 처음에는 표시하지 않는다", () => {
    const { root, overlay } = setup();

    overlay.addPage(2, [BLOCK], VIEWPORT, null);

    const paragraph = root.querySelector<HTMLElement>('.pdf-layer[data-page="2"] p.pdf-block')!;
    expect(paragraph.textContent).toBe("Original text.");
    expect(paragraph.childNodes).toHaveLength(1);
    expect(paragraph.hasAttribute("data-translated")).toBe(false);
    expect(parseFloat(paragraph.style.left)).toBeCloseTo((70 / 612) * 100);
    expect(parseFloat(paragraph.style.width)).toBeCloseTo((232 / 612) * 100);
    expect(parseFloat(paragraph.style.top)).toBeCloseTo((100 / 792) * 100);
    expect(parseFloat(paragraph.style.height)).toBeCloseTo((12 / 792) * 100);
  });

  it("텍스트가 원문과 달라지면 표시하고, 원문으로 돌아오면 숨긴다", async () => {
    const { root, overlay } = setup();
    overlay.addPage(1, [BLOCK], VIEWPORT, null);
    const paragraph = root.querySelector("p")!;

    paragraph.firstChild!.nodeValue = "번역문";
    await flush();
    expect(paragraph.hasAttribute("data-translated")).toBe(true);

    paragraph.firstChild!.nodeValue = "Original text.";
    await flush();
    expect(paragraph.hasAttribute("data-translated")).toBe(false);
  });

  it("상자에 들어갈 때까지 글자 크기를 5%씩 줄인다", async () => {
    const { root, overlay } = setup();
    overlay.addPage(1, [BLOCK], VIEWPORT, null);
    const paragraph = root.querySelector("p")!;
    Object.defineProperty(paragraph, "clientHeight", { value: 100 });
    // 글자 크기(9px 이하)가 되어야 들어가는 상자
    Object.defineProperty(paragraph, "scrollHeight", { get: () => (paragraph.style.fontSize.includes("9.00px") ? 100 : 130) });

    paragraph.firstChild!.nodeValue = "긴 번역문";
    await flush();

    expect(paragraph.style.fontSize).toBe("calc(var(--pdf-scale) * 9.00px)");
  });

  it("60%에서도 넘치면 그 크기로 둔다", async () => {
    const { root, overlay } = setup();
    overlay.addPage(1, [BLOCK], VIEWPORT, null);
    const paragraph = root.querySelector("p")!;
    Object.defineProperty(paragraph, "clientHeight", { value: 100 });
    Object.defineProperty(paragraph, "scrollHeight", { value: 500 });

    paragraph.firstChild!.nodeValue = "아주 긴 번역문";
    await flush();

    expect(paragraph.style.fontSize).toBe("calc(var(--pdf-scale) * 6.00px)");
  });

  it("가운데 정렬 문단을 표시하고 배율을 CSS 변수로 둔다", () => {
    const { root, overlay } = setup();

    overlay.addPage(1, [{ ...BLOCK, centered: true }], VIEWPORT, null);

    expect(root.querySelector("p")!.style.textAlign).toBe("center");
    expect(root.style.getPropertyValue("--pdf-scale")).toBe(String((1.5 * 96) / 72));
  });

  it("회전 0도에서는 transform을 비운다", () => {
    const { root, overlay } = setup(0);
    overlay.addPage(1, [BLOCK], VIEWPORT, null);

    const layer = root.querySelector<HTMLElement>(".pdf-layer")!;
    expect(layer.style.transform).toBe("");
    expect(layer.style.width).toBe("600px");
    expect(layer.style.height).toBe("800px");
  });

  it("회전 90도에서는 가로세로를 바꾸고 translate 후 회전한다", () => {
    const { root, overlay } = setup(90);
    overlay.addPage(1, [BLOCK], VIEWPORT, null);

    const layer = root.querySelector<HTMLElement>(".pdf-layer")!;
    expect(layer.style.width).toBe("800px");
    expect(layer.style.height).toBe("600px");
    expect(layer.style.transform).toBe("translate(600px, 0px) rotate(90deg)");
  });

  it("회전 180도와 270도의 transform", () => {
    const r180 = setup(180);
    r180.overlay.addPage(1, [BLOCK], VIEWPORT, null);
    const layer180 = r180.root.querySelector<HTMLElement>(".pdf-layer")!;
    expect(layer180.style.width).toBe("600px");
    expect(layer180.style.transform).toBe("translate(600px, 800px) rotate(180deg)");

    const r270 = setup(270);
    r270.overlay.addPage(1, [BLOCK], VIEWPORT, null);
    const layer270 = r270.root.querySelector<HTMLElement>(".pdf-layer")!;
    expect(layer270.style.width).toBe("800px");
    expect(layer270.style.transform).toBe("translate(0px, 800px) rotate(270deg)");
  });
});
