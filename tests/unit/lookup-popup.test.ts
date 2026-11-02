import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UI_ATTRIBUTE } from "../../src/content/collect";
import { labelPosition, LookupPopup } from "../../src/content/lookup-popup";

const anchor = { left: 100, top: 200, width: 60, bottom: 220 } as DOMRect;
let popup: LookupPopup;

beforeEach(() => {
  popup = new LookupPopup();
});

afterEach(() => {
  popup.close();
  vi.restoreAllMocks();
});

function host(): HTMLElement | null {
  return document.querySelector("aitranslator-lookup");
}

describe("LookupPopup 표시 (설계 7절)", () => {
  it("네 가지 뷰의 제목과 글자", () => {
    popup.show(anchor, { kind: "loading" });
    const root = host()!.shadowRoot!;
    expect(root.querySelector(".text")?.textContent).toBe("찾는 중…");

    popup.update({ kind: "term", text: "attention" });
    expect(root.querySelector(".title")).toBeNull();
    expect(root.querySelector(".text")?.textContent).toBe("attention");

    popup.update({ kind: "sentence", text: "It works." });
    expect(root.querySelector(".title")?.textContent).toBe("원문 문장");
    expect(root.querySelector(".text")?.textContent).toBe("It works.");

    popup.update({ kind: "paragraph", text: "Whole paragraph." });
    expect(root.querySelector(".title")?.textContent).toBe("문단 원문");
    expect(root.querySelector(".text")?.textContent).toBe("Whole paragraph.");
    expect(root.querySelector('[role="status"]')).not.toBeNull();
  });

  it("HTML처럼 보이는 글자는 요소가 아니라 글자로 들어간다", () => {
    popup.show(anchor, { kind: "paragraph", text: "<img src=x onerror=alert(1)>" });

    const root = host()!.shadowRoot!;
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector(".text")?.textContent).toBe("<img src=x onerror=alert(1)>");
  });

  it("호스트는 documentElement 자식이고 확장 UI 표시가 있으며 Shadow DOM을 쓴다", () => {
    popup.show(anchor, { kind: "loading" });

    expect(host()!.parentElement).toBe(document.documentElement);
    expect(host()!.hasAttribute(UI_ATTRIBUTE)).toBe(true);
    expect(host()!.shadowRoot).not.toBeNull();
    expect(host()!.style.getPropertyPriority("position")).toBe("important");
  });

  it("다시 show()하면 이전 라벨을 닫는다", () => {
    popup.show(anchor, { kind: "loading" });
    popup.show(anchor, { kind: "term", text: "a" });

    expect(document.querySelectorAll("aitranslator-lookup")).toHaveLength(1);
  });
});

describe("labelPosition", () => {
  const viewport = { width: 1000, height: 800 };
  const size = { width: 200, height: 40 };

  it("위쪽 8px, 가로 가운데", () => {
    expect(labelPosition({ left: 400, top: 300, width: 100, bottom: 320 }, size, viewport)).toEqual({
      left: 350,
      top: 252,
    });
  });

  it("위에 자리가 없으면 아래쪽 8px", () => {
    expect(labelPosition({ left: 400, top: 20, width: 100, bottom: 40 }, size, viewport)).toEqual({
      left: 350,
      top: 48,
    });
  });

  it("좌우 8px 안으로 제한한다", () => {
    expect(labelPosition({ left: 0, top: 300, width: 20, bottom: 320 }, size, viewport).left).toBe(8);
    expect(labelPosition({ left: 990, top: 300, width: 10, bottom: 320 }, size, viewport).left).toBe(792);
  });
});

describe("LookupPopup 닫기", () => {
  it("바깥 mousedown, Esc, 페이지 scroll로 닫힌다", () => {
    popup.show(anchor, { kind: "loading" });
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(host()).toBeNull();

    popup.show(anchor, { kind: "loading" });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(host()).toBeNull();

    popup.show(anchor, { kind: "loading" });
    document.body.dispatchEvent(new Event("scroll"));
    expect(host()).toBeNull();
  });

  it("다른 키로는 닫히지 않는다", () => {
    popup.show(anchor, { kind: "loading" });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect(host()).not.toBeNull();
  });

  it("라벨 안 mousedown으로는 닫히지 않고, contains()가 참이다", () => {
    popup.show(anchor, { kind: "term", text: "attention" });
    const inner = host()!.shadowRoot!.querySelector(".text")!;
    let inside: boolean | undefined;
    // composedPath()는 이벤트가 전달되는 동안에만 채워진다.
    inner.addEventListener("mousedown", (event) => (inside = popup.contains(event)));
    inner.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, composed: true }));

    expect(host()).not.toBeNull();
    expect(inside).toBe(true);
  });

  it("닫은 뒤에는 리스너가 남지 않는다", () => {
    const add = vi.spyOn(document, "addEventListener");
    const remove = vi.spyOn(document, "removeEventListener");
    popup.show(anchor, { kind: "loading" });
    popup.close();

    const types = (spy: typeof add) => [...new Set(spy.mock.calls.map(([type]) => type))].sort();
    expect(types(remove)).toEqual(types(add));
    expect(add).toHaveBeenCalledTimes(3);
  });
});
