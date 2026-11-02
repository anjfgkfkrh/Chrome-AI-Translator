import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BlockText } from "../../src/content/apply";
import { TermLookup } from "../../src/content/lookup";
import type { FindSourceRequest, FindSourceResult } from "../../src/shared/messages";

// 원문 찾기: 선택을 문단 정보로 바꿔 라벨에 보여 준다 (설계 2·3·7절)

const blockA: BlockText = { original: "The attention mechanism works well.", translated: "주의 메커니즘이 잘 작동한다." };
const blockB: BlockText = { original: "Second paragraph here.", translated: "둘째 문단이다." };

let lookup: TermLookup;
let find: ReturnType<typeof vi.fn<(request: FindSourceRequest) => Promise<FindSourceResult>>>;
let blocks: Map<Node, BlockText>;
let text: Record<"a" | "b", Text>;

beforeEach(() => {
  document.body.innerHTML = `<p id="a">${blockA.translated}</p><p id="b">${blockB.translated}</p>
    <textarea id="field">입력란 글자</textarea>`;
  text = { a: document.getElementById("a")!.firstChild as Text, b: document.getElementById("b")!.firstChild as Text };
  blocks = new Map([
    [text.a, blockA],
    [text.b, blockB],
  ]);
  Range.prototype.getBoundingClientRect = () =>
    ({ left: 100, top: 200, width: 60, bottom: 220, right: 160, height: 20, x: 100, y: 200 }) as DOMRect;
  find = vi.fn(async () => ({ kind: "term", text: "attention mechanism" }) as FindSourceResult);
  lookup = new TermLookup({ blockOf: (node) => blocks.get(node) }, find);
});

afterEach(() => {
  lookup.dispose();
  document.getSelection()?.removeAllRanges();
});

function select(start: Text, from: number, end: Text, to: number): void {
  document.getSelection()!.setBaseAndExtent(start, from, end, to);
}

function release(options: MouseEventInit = { altKey: true }, target: EventTarget = document): void {
  target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, composed: true, ...options }));
}

/** 라벨의 .title, .text 글자 */
function labelParts(): { title?: string; text?: string } | undefined {
  const root = document.querySelector("aitranslator-lookup")?.shadowRoot;
  if (!root) return undefined;
  return { title: root.querySelector(".title")?.textContent ?? undefined, text: root.querySelector(".text")?.textContent ?? undefined };
}

/** 대기 중인 응답을 직접 풀어 주는 find */
function deferredFind() {
  const resolvers: ((result: FindSourceResult) => void)[] = [];
  find.mockImplementation(() => new Promise<FindSourceResult>((resolve) => resolvers.push(resolve)));
  return resolvers;
}

describe("찾기를 시작하지 않는 경우", () => {
  it("Option 없음", () => {
    select(text.a, 0, text.a, 6);
    release({ altKey: false });
    expect(find).not.toHaveBeenCalled();
    expect(labelParts()).toBeUndefined();
  });

  it("빈 선택", () => {
    release();
    expect(labelParts()).toBeUndefined();
  });

  it("번역문이 아닌 선택 (원문 보기 포함)", () => {
    blocks.clear();
    select(text.a, 0, text.a, 6);
    release();
    expect(find).not.toHaveBeenCalled();
    expect(labelParts()).toBeUndefined();
  });

  it("입력란 안의 선택", () => {
    const field = document.getElementById("field") as HTMLTextAreaElement;
    blocks.set(field.firstChild!, blockA);
    select(field.firstChild as Text, 0, field.firstChild as Text, 3);
    release({ altKey: true }, field);
    expect(find).not.toHaveBeenCalled();
    expect(labelParts()).toBeUndefined();
  });

  it("라벨 안의 mouseup", async () => {
    select(text.a, 0, text.a, 6);
    release();
    await vi.waitFor(() => expect(labelParts()?.text).toBe("attention mechanism"));
    find.mockClear();

    release({ altKey: true }, document.querySelector("aitranslator-lookup")!.shadowRoot!.querySelector(".text")!);
    expect(find).not.toHaveBeenCalled();
    expect(labelParts()?.text).toBe("attention mechanism");
  });
});

describe("표시 규칙", () => {
  it("60자를 넘으면 요청 없이 문단 원문", () => {
    blocks.set(text.a, { original: "Long original paragraph.", translated: "가".repeat(70) });
    text.a.data = "가".repeat(70);
    select(text.a, 0, text.a, 70);
    release();
    expect(find).not.toHaveBeenCalled();
    expect(labelParts()).toEqual({ title: "문단 원문", text: "Long original paragraph." });
  });

  it("문단 원문에 그대로 있는 선택은 요청 없이 그 글자", () => {
    text.a.data = "이것은 attention mechanism 이다";
    select(text.a, 4, text.a, 23);
    release();
    expect(find).not.toHaveBeenCalled();
    expect(labelParts()).toEqual({ title: undefined, text: "attention mechanism" });
  });

  it("정상: 찾는 중 다음 용어", async () => {
    const resolvers = deferredFind();
    select(text.a, 0, text.a, 7);
    release();

    expect(labelParts()?.text).toBe("찾는 중…");
    expect(find).toHaveBeenCalledWith({ selection: "주의 메커니즘", original: blockA.original, translated: blockA.translated });
    resolvers[0]!({ kind: "term", text: "attention mechanism" });
    await vi.waitFor(() => expect(labelParts()).toEqual({ title: undefined, text: "attention mechanism" }));
  });

  it("sentence는 제목과 함께", async () => {
    find.mockResolvedValue({ kind: "sentence", text: "The attention mechanism works well." });
    select(text.a, 0, text.a, 6);
    release();
    await vi.waitFor(() => expect(labelParts()).toEqual({ title: "원문 문장", text: "The attention mechanism works well." }));
  });

  it("같은 선택 재시도는 저장된 결과를 쓴다", async () => {
    select(text.a, 0, text.a, 6);
    release();
    await vi.waitFor(() => expect(labelParts()?.text).toBe("attention mechanism"));
    select(text.a, 0, text.a, 6);
    release();

    expect(labelParts()?.text).toBe("attention mechanism");
    expect(find).toHaveBeenCalledTimes(1);
  });

  it("실패는 저장하지 않아 다시 요청한다", async () => {
    find.mockResolvedValue({ kind: "failed" });
    select(text.a, 0, text.a, 6);
    release();
    await vi.waitFor(() => expect(labelParts()).toEqual({ title: "문단 원문", text: blockA.original }));
    select(text.a, 0, text.a, 6);
    release();
    await vi.waitFor(() => expect(find).toHaveBeenCalledTimes(2));
  });

  it("find가 거부되면 문단 원문", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    find.mockRejectedValue(new Error("Extension context invalidated."));
    select(text.a, 0, text.a, 6);
    release();
    await vi.waitFor(() => expect(labelParts()).toEqual({ title: "문단 원문", text: blockA.original }));
  });
});

describe("동시 요청과 여러 문단", () => {
  it("첫 요청이 끝나기 전에 둘째 찾기를 하면 첫 응답을 무시한다", async () => {
    const resolvers = deferredFind();
    select(text.a, 0, text.a, 6);
    release();
    select(text.b, 0, text.b, 3);
    release();

    resolvers[0]!({ kind: "term", text: "첫 응답" });
    await Promise.resolve();
    await Promise.resolve();
    expect(labelParts()?.text).toBe("찾는 중…");

    resolvers[1]!({ kind: "term", text: "Second" });
    await vi.waitFor(() => expect(labelParts()?.text).toBe("Second"));
  });

  it("close() 뒤에 온 응답은 버린다", async () => {
    const resolvers = deferredFind();
    select(text.a, 0, text.a, 6);
    release();
    lookup.close();
    resolvers[0]!({ kind: "term", text: "늦은 응답" });
    await Promise.resolve();
    await Promise.resolve();
    expect(labelParts()).toBeUndefined();
  });

  it("두 문단을 선택하면 시작 문단 부분만 보낸다", () => {
    select(text.a, 0, text.b, 3);
    release();
    expect(find).toHaveBeenCalledWith({
      selection: blockA.translated,
      original: blockA.original,
      translated: blockA.translated,
    });
  });
});
