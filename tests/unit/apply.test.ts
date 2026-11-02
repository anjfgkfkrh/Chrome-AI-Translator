import { describe, expect, it, vi } from "vitest";
import { runInFrames, TextReplacer, type BlockText } from "../../src/content/apply";
import { splitWhitespace } from "../../src/content/collect";

/** requestAnimationFrame과 performance.now()를 직접 돌린다. */
function fakeFrames() {
  const queue: FrameRequestCallback[] = [];
  let clock = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => queue.push(callback));
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  return {
    advance(ms: number) {
      clock += ms;
    },
    runFrame() {
      queue.shift()?.(clock);
    },
    /** 대기 중인 프레임을 모두 돌리고, 돈 프레임 수를 돌려준다. */
    flush(): number {
      let frames = 0;
      for (; queue.length > 0; frames++) queue.shift()!(clock);
      return frames;
    },
  };
}

describe("runInFrames (7.2, 프레임당 최대 8ms)", () => {
  it("한 프레임에서 8ms가 지나면 나머지는 다음 프레임에 처리한다", async () => {
    const frames = fakeFrames();
    const done: number[] = [];

    const result = runInFrames([0, 1, 2, 3, 4, 5, 6], (item) => {
      done.push(item);
      frames.advance(3); // 항목 하나에 3ms → 프레임마다 3개
    });

    expect(frames.flush()).toBe(3);
    expect(done).toEqual([0, 1, 2, 3, 4, 5, 6]);
    await expect(result).resolves.toBe(true);
  });

  it("isCurrent()가 false가 되면 남은 항목을 처리하지 않고 false로 끝낸다", async () => {
    const frames = fakeFrames();
    const done: number[] = [];
    let current = true;

    const result = runInFrames(
      [0, 1, 2, 3],
      (item) => {
        done.push(item);
        frames.advance(8);
      },
      () => current,
    );
    frames.runFrame();
    current = false;
    frames.flush();

    expect(done).toEqual([0]);
    await expect(result).resolves.toBe(false);
  });

  it("항목이 없으면 프레임을 기다리지 않는다", async () => {
    const requestFrame = vi.fn();
    vi.stubGlobal("requestAnimationFrame", requestFrame);

    await expect(runInFrames([], () => {})).resolves.toBe(true);
    expect(requestFrame).not.toHaveBeenCalled();
  });
});

describe("TextReplacer.blockOf", () => {
  function setup() {
    const node = document.createTextNode("  Hello  ");
    document.body.replaceChildren(node);
    const { lead, core, tail } = splitWhitespace(node.nodeValue!);
    const block: BlockText = { original: "Hello", translated: "안녕" };
    const replacer = new TextReplacer();
    replacer.remember({ node, value: node.nodeValue!, lead, core, tail, after: "" }, "안녕", block);
    return { node, block, replacer };
  }

  it("번역문을 보여 주는 노드에만 값을 돌려준다", async () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
    const { node, block, replacer } = setup();
    expect(replacer.blockOf(node)).toBeUndefined(); // 원문 상태

    await replacer.showTranslations();
    expect(replacer.blockOf(node)).toBe(block);

    node.nodeValue = "페이지가 바꾼 값"; // 페이지가 값을 바꾼 노드
    expect(replacer.blockOf(node)).toBeUndefined();
  });

  it("clear() 뒤에는 undefined다", async () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
    const { node, replacer } = setup();
    await replacer.showTranslations();
    replacer.clear();
    expect(replacer.blockOf(node)).toBeUndefined();
  });
});
