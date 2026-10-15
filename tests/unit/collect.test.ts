import { describe, expect, it, vi } from "vitest";
import {
  collectGroups,
  collectGroupsAround,
  isMostlyKorean,
  looksLikeAddress,
  splitWhitespace,
  UI_ATTRIBUTE,
} from "../../src/content/collect";

/** body에 html을 넣고 수집한 그룹을 세그먼트 배열로 돌려준다. */
function collect(html: string): string[][] {
  document.body.innerHTML = html;
  return collectGroups(document.body).map((group) => group.units.map((unit) => unit.core));
}

describe("splitWhitespace (4.1 공백 보존)", () => {
  it.each([
    ["  Get started  ", { lead: "  ", core: "Get started", tail: "  " }],
    ["\n    Docs\n", { lead: "\n    ", core: "Docs", tail: "\n" }],
    [" Next ", { lead: " ", core: "Next", tail: " " }],
    ["a  b", { lead: "", core: "a  b", tail: "" }],
    ["   ", { lead: "   ", core: "", tail: "" }],
  ])("%j", (value, expected) => {
    expect(splitWhitespace(value)).toEqual(expected);
  });
});

describe("이미 한국어인 텍스트 (한글 ÷ 문자 ≥ 50%)", () => {
  it.each([
    ["2026년 10월", true],
    ["API 키 설정", true],
    ["이미 한국어로 쓰인 문장입니다.", true],
    ["LangChain 문서", false],
    ["Get started", false],
    ["2026", false],
  ])("%s → %s", (text, expected) => {
    expect(isMostlyKorean(text)).toBe(expected);
  });
});

describe("URL·이메일·경로처럼 보이는 텍스트", () => {
  it.each([
    "https://docs.langchain.com/llms.txt",
    "http://localhost:2024",
    "www.example.com",
    "support@example.com",
    "/llms.txt",
    "./src/index.ts",
    "../README.md",
    "~/.config",
    "docs.langchain.com",
    "index.html",
    "v1.2.3",
    "Node.js",
  ])("%s → 건너뜀", (text) => {
    expect(looksLikeAddress(text)).toBe(true);
  });

  it.each(["Get started", "e.g.", "U.S.", "etc.", "@langchain", "Read docs.langchain.com"])("%s → 번역", (text) => {
    expect(looksLikeAddress(text)).toBe(false);
  });
});

describe("collectGroups: 건너뛰는 텍스트 (4.1)", () => {
  it("공백뿐·문자 없음·이미 한국어·주소처럼 보이는 노드는 모으지 않는다", () => {
    expect(
      collect(`
        <p> </p><p>2026</p><p>→ © 100%</p><p>🚀</p>
        <p>이미 한국어로 쓰인 문장입니다.</p>
        <p>https://docs.langchain.com</p><p>support@example.com</p><p>/llms.txt</p><p>v1.2.3</p>
        <p>Translate me</p>`),
    ).toEqual([["Translate me"]]);
  });
});

describe("collectGroups: 제외 대상 (4.1)", () => {
  it("제외 태그 안의 텍스트는 모으지 않는다", () => {
    expect(
      collect(`
        <script>var a = "Script text";</script><style>.a { color: red }</style><noscript>Enable JavaScript</noscript>
        <code>Code text</code><pre>Pre text</pre><kbd>Ctrl</kbd><samp>Sample output</samp><var>Variable</var>
        <textarea>Textarea text</textarea><select><option>Option text</option></select>
        <svg><text>Chart label</text></svg><math><mi>Math text</mi></math>
        <canvas>Canvas fallback</canvas><iframe>Iframe fallback</iframe><template>Template text</template>
        <p>Visible <code>inline code</code> text</p>`),
    ).toEqual([["Visible", "text"]]);
  });

  it("contenteditable이 true·빈 값·plaintext-only인 요소 아래는 모두 제외한다", () => {
    expect(
      collect(`
        <div contenteditable="true">Editable A</div>
        <div contenteditable="">Editable B</div>
        <div contenteditable="plaintext-only">Editable C</div>
        <div contenteditable="TRUE">Editable D</div>
        <div contenteditable="true"><span contenteditable="false">Island</span></div>
        <div contenteditable="false">Not editable</div>`),
    ).toEqual([["Not editable"]]);
  });

  it("translate 속성은 가장 가까운 값을 따르고, notranslate 클래스 안은 예외 없이 제외한다", () => {
    expect(
      collect(`
        <p translate="no">Skip this <span translate="yes">but translate this</span>.</p>
        <p class="notranslate">Keep this <span translate="yes">even here</span>.</p>
        <p translate="maybe">Invalid value is ignored</p>`),
    ).toEqual([["but translate this"], ["Invalid value is ignored"]]);
  });

  it("확장 프로그램 UI 안의 텍스트는 모으지 않는다", () => {
    expect(collect(`<div ${UI_ATTRIBUTE}><p>Toast message</p></div><p>Page text</p>`)).toEqual([["Page text"]]);
  });
});

describe("collectGroups: 블록 단위 묶기 (4.2)", () => {
  it("인라인 요소로 나뉜 문장은 한 그룹으로, 노드 순서대로 묶는다 (4.3 예시)", () => {
    expect(collect(`<p>We'll <a href="#">email you a confirmation link</a> to complete sign up.</p>`)).toEqual([
      ["We'll", "email you a confirmation link", "to complete sign up."],
    ]);
  });

  it("블록 요소가 끼면 그룹을 나눈다", () => {
    expect(collect(`<div>Outer text <div>Inner block</div> outer tail</div>`)).toEqual([
      ["Outer text", "outer tail"],
      ["Inner block"],
    ]);
  });

  it("BUTTON·LABEL·LI는 display와 관계없이 경계다", () => {
    expect(
      collect(`
        <div>Ready? <button>Get started</button></div>
        <div>Choose <label>Email</label></div>
        <ul><li style="display: inline">Python</li><li style="display: inline">JavaScript</li></ul>`),
    ).toEqual([["Ready?"], ["Get started"], ["Choose"], ["Email"], ["Python"], ["JavaScript"]]);
  });

  it("inline-block·contents 요소는 경계가 아니고, 그 밖의 display는 경계다", () => {
    expect(
      collect(`
        <div>Plan <span style="display: inline-block">Pro</span> now</div>
        <div>Before <span style="display: contents">inside</span> after</div>
        <div>Status <span style="display: inline-flex">New</span> badge</div>`),
    ).toEqual([["Plan", "Pro", "now"], ["Before", "inside", "after"], ["Status", "badge"], ["New"]]);
  });

  it("그룹 ID는 g로 시작하고 수집할 때마다 겹치지 않는다", () => {
    document.body.innerHTML = "<p>One</p><p>Two</p>";
    const ids = [...collectGroups(document.body), ...collectGroups(document.body)].map((group) => group.id);

    expect(new Set(ids).size).toBe(4);
    expect(ids.every((id) => /^g\d+$/.test(id))).toBe(true);
  });

  it("isHandled가 true인 노드는 다시 모으지 않는다", () => {
    document.body.innerHTML = "<p>Done</p><p>Todo</p>";
    const done = document.body.firstElementChild!.firstChild;

    const groups = collectGroups(document.body, (node) => node === done);

    expect(groups.map((group) => group.units.map((unit) => unit.core))).toEqual([["Todo"]]);
  });
});

describe("collectGroups: 빠진 텍스트의 문맥 (SPEC 13장)", () => {
  function contexts(html: string): (string | undefined)[] {
    document.body.innerHTML = html;
    return collectGroups(document.body).map((group) => group.context);
  }

  it("번역하지 않는 글자(코드·숫자·translate=no)가 끼면 블록 전체 텍스트를 붙인다", () => {
    expect(
      contexts(`
        <p>Code with an AI agent using the open source <code>dcode</code> CLI.</p>
        <p>Clicked <span>0</span> times</p>
        <p translate="no">Skip this <span translate="yes">but this</span>.</p>`),
    ).toEqual([
      "Code with an AI agent using the open source dcode CLI.",
      "Clicked 0 times",
      "Skip this but this.",
    ]);
  });

  it("빠진 텍스트가 없으면 붙이지 않고, 문장 부호만 빠져도 붙인다 (모델이 마침표를 되풀이하지 않게)", () => {
    expect(contexts(`<p>We'll <a href="#">email you</a> soon.</p><p>Read our <a href="#">Terms</a>.</p>`)).toEqual([
      undefined,
      "Read our Terms.",
    ]);
  });

  it("안쪽 블록의 텍스트와 입력란·SVG 같은 요소의 텍스트는 문맥에 넣지 않는다", () => {
    expect(
      contexts(`<div>Press <kbd>Enter</kbd> to send <svg><title>icon</title></svg>now <div>Inner block</div> <textarea>draft</textarea></div>`),
    ).toEqual(["Press Enter to send now", undefined]);
  });
});

describe("collectGroups: 노드 뒤 텍스트", () => {
  it("같은 블록에서 다음 번역 노드 전까지 붙은, 번역하지 않는 텍스트를 after에 담는다", () => {
    document.body.innerHTML = `<p>Run <code>npm test</code> then <a href="#">deploy</a>.</p>`;

    const [group] = collectGroups(document.body);

    expect(group!.units.map((unit) => [unit.core, unit.after])).toEqual([
      ["Run", "npm test"],
      ["then", ""],
      ["deploy", "."],
    ]);
  });
});

/** jsdom은 레이아웃이 없으므로 화면 위치를 직접 정한다. */
function placeOnScreen(element: Element, top: number): void {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    x: 0, y: top, top, left: 0, right: 200, bottom: top + 20, width: 200, height: 20, toJSON: () => ({}),
  } as DOMRect);
}

describe("collectGroups: 보이는 영역 (SPEC 4.5)", () => {
  it("블록이 화면 안에 있으면 visible이다", () => {
    document.body.innerHTML = `<p id="a">On screen</p><p id="b">Below the fold</p><p id="c">No layout</p>`;
    placeOnScreen(document.getElementById("a")!, 10);
    placeOnScreen(document.getElementById("b")!, 5_000);

    expect(collectGroups(document.body).map((group) => group.visible)).toEqual([true, false, false]);
  });
});

describe("collectGroupsAround (SPEC 4.6)", () => {
  it("새로 들어온 노드가 속한 블록만 모은다", () => {
    document.body.innerHTML = `<p>Untouched</p><div id="feed"><p>Old item</p></div>`;
    const feed = document.getElementById("feed")!;
    feed.insertAdjacentHTML("beforeend", "<p>New <b>item</b> text</p>");

    const groups = collectGroupsAround([feed.lastElementChild!]);

    expect(groups.map((group) => group.units.map((unit) => unit.core))).toEqual([["New", "item", "text"]]);
  });

  it("인라인 요소가 바뀌면 그 블록 전체를 모으고, 이미 번역한 노드는 건너뛴다", () => {
    document.body.innerHTML = `<p id="p">Count: <span id="n">one</span> left</p>`;
    const translated = document.getElementById("p")!.firstChild;

    const [group] = collectGroupsAround([document.getElementById("n")!], (node) => node === translated);

    expect(group!.units.map((unit) => unit.core)).toEqual(["one", "left"]);
    expect(group!.context).toBe("Count: one left");
  });

  it("겹치는 블록은 바깥 블록을 한 번만 모은다", () => {
    document.body.innerHTML = `<div id="outer">Outer <p id="inner">Inner</p></div>`;
    const inner = document.getElementById("inner")!;

    const groups = collectGroupsAround([inner.firstChild!, document.getElementById("outer")!]);

    expect(groups.map((group) => group.units.map((unit) => unit.core))).toEqual([["Outer"], ["Inner"]]);
  });
});
