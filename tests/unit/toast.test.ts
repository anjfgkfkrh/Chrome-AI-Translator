import { beforeEach, describe, expect, it, vi } from "vitest";
import { collectGroups, UI_ATTRIBUTE } from "../../src/content/collect";
import { showToast } from "../../src/content/toast";

beforeEach(() => {
  document.querySelectorAll("aitranslator-toast").forEach((toast) => toast.remove());
});

function hosts() {
  return document.querySelectorAll("aitranslator-toast");
}

describe("showToast (SPEC 4.11, 13장)", () => {
  it("html 바로 아래에 확장 UI 표시를 단 요소를 붙이고, Shadow DOM 안에 제목·문구·닫기를 그린다", () => {
    const { root } = showToast("API 키를 확인하세요.");

    const host = hosts()[0]!;
    expect(host.parentElement).toBe(document.documentElement);
    expect(host.hasAttribute(UI_ATTRIBUTE)).toBe(true);
    expect(root.querySelector(".title")?.textContent).toBe("AITranslator");
    expect(root.querySelector(".message")?.textContent).toBe("API 키를 확인하세요.");
    expect(root.querySelector("button.close")?.getAttribute("aria-label")).toBe("닫기");
    expect(root.textContent).not.toContain("설정 열기");
  });

  it("detail을 주면 문구 아래에 한 줄 더 쓴다 (일부 실패의 원인)", () => {
    const { root } = showToast("일부는 번역하지 못해 원문으로 두었습니다.", {
      detail: "요청 한도를 초과했습니다. 잠시 후 다시 시도하세요.",
    });

    expect(root.querySelector(".message")?.textContent).toBe("일부는 번역하지 못해 원문으로 두었습니다.");
    expect(root.querySelector(".detail")?.textContent).toBe("요청 한도를 초과했습니다. 잠시 후 다시 시도하세요.");
  });

  it("페이지 오른쪽 아래에 고정한다", () => {
    showToast("알림");

    const style = (hosts()[0] as HTMLElement).style;
    expect(style.getPropertyValue("position")).toBe("fixed");
    expect(style.getPropertyPriority("position")).toBe("important");
    expect(style.getPropertyValue("right")).toBe("16px");
    expect(style.getPropertyValue("bottom")).toBe("16px");
  });

  it("닫기를 누르면 사라진다", () => {
    const { root } = showToast("알림");

    root.querySelector<HTMLButtonElement>("button.close")!.click();

    expect(hosts()).toHaveLength(0);
  });

  it("8초 뒤 저절로 닫힌다", () => {
    vi.useFakeTimers();
    try {
      showToast("알림");
      vi.advanceTimersByTime(7_999);
      expect(hosts()).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(hosts()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("새 알림을 띄우면 이전 알림은 닫힌다", () => {
    showToast("첫째");
    const { root } = showToast("둘째");

    expect(hosts()).toHaveLength(1);
    expect(root.querySelector(".message")?.textContent).toBe("둘째");
  });

  it("onOpenSettings를 주면 '설정 열기'를 붙인다 (키 오류)", () => {
    const onOpenSettings = vi.fn();
    const { root } = showToast("API 키를 먼저 설정하세요", { onOpenSettings });

    root.querySelector<HTMLButtonElement>("button.settings")!.click();

    expect(root.querySelector("button.settings")?.textContent).toBe("설정 열기");
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("알림 텍스트는 번역 대상으로 모으지 않는다", () => {
    document.body.innerHTML = "<p>Page text</p>";
    showToast("Error notice");

    const segments = collectGroups(document.documentElement).flatMap((group) => group.units.map((unit) => unit.core));

    expect(segments).toEqual(["Page text"]);
  });
});
