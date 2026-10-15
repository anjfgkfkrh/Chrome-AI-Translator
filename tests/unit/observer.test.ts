import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MutationWatcher } from "../../src/content/observer";

/** MutationObserver 알림(마이크로태스크)이 지나가게 한다. */
const settle = () => new Promise<void>((resolve) => queueMicrotask(resolve));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.useRealTimers();
});

function watch(isOwnChange: (node: Text) => boolean = () => false) {
  const onChange = vi.fn<(nodes: Node[]) => void>();
  const watcher = new MutationWatcher(document.body, onChange, isOwnChange);
  watcher.start();
  return { watcher, onChange };
}

function addParagraph(text: string): HTMLParagraphElement {
  const p = document.createElement("p");
  p.textContent = text;
  document.body.append(p);
  return p;
}

describe("MutationWatcher (SPEC 4.6, 13장)", () => {
  it("새로 들어온 노드를 300ms 모았다가 한 번에 알린다", async () => {
    const { onChange } = watch();

    const first = addParagraph("First");
    await settle();
    const second = addParagraph("Second");
    await settle();
    vi.advanceTimersByTime(299);
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange.mock.calls[0]![0]).toEqual([first, second]);
  });

  it("계속 바뀌는 페이지에서도 첫 변경 300ms 뒤에는 알린다", async () => {
    const { onChange } = watch();

    for (let i = 0; i < 4; i++) {
      addParagraph(`Item ${i}`);
      await settle();
      vi.advanceTimersByTime(100);
    }

    expect(onChange).toHaveBeenCalledOnce();
  });

  it("페이지가 바꾼 텍스트는 알리고, 우리가 넣은 번역문으로 생긴 변경은 무시한다", async () => {
    const ours = addParagraph("Ours").firstChild as Text;
    const theirs = addParagraph("Theirs").firstChild as Text;
    const { onChange } = watch((node) => node === ours);

    ours.nodeValue = "우리가 넣은 번역";
    theirs.nodeValue = "Updated by page";
    await settle();
    vi.advanceTimersByTime(300);

    expect(onChange.mock.calls[0]![0]).toEqual([theirs]);
  });

  it("멈추면 더 알리지 않는다", async () => {
    const { watcher, onChange } = watch();

    watcher.stop();
    addParagraph("After stop");
    await settle();
    vi.advanceTimersByTime(300);

    expect(onChange).not.toHaveBeenCalled();
  });

  it("알리기 전에 문서에서 빠진 노드는 알리지 않는다", async () => {
    const { onChange } = watch();

    addParagraph("Gone soon").remove();
    await settle();
    vi.advanceTimersByTime(300);

    expect(onChange).not.toHaveBeenCalled();
  });
});
