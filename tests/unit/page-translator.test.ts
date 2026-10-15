import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PageTranslator, type TranslateGroups } from "../../src/content/page-translator";
import type { RequestGroup } from "../../src/shared/messages";
import { uppercase, uppercaseTranslate } from "../helpers/mock-translator";
import { structureSnapshot, textSnapshot } from "../helpers/snapshot";

function loadFixture(name: string): void {
  // new URL(..., import.meta.url)은 Vite가 자산 주소로 바꿔 버리므로 경로로 읽는다.
  const html = readFileSync(path.resolve(import.meta.dirname, "../fixtures", name), "utf8");
  const parsed = new DOMParser().parseFromString(html, "text/html");
  document.replaceChild(document.importNode(parsed.documentElement, true), document.documentElement);
}

/** 목 번역기를 감싸 번역 요청을 기록한다. */
function recordingTranslator() {
  const requests: RequestGroup[][] = [];
  const translate = vi.fn<TranslateGroups>(async (groups, deliver) => {
    requests.push(groups);
    deliver(uppercase(groups));
  });
  const segments = () => requests.map((groups) => groups.map((group) => group.segments));
  return { requests, segments, translate };
}

describe.each(["sentences.html", "layout.html"])("%s", (fixture) => {
  it("10.1 번역 전후로 태그·순서·개수·속성·텍스트 노드 위치가 같다", async () => {
    loadFixture(fixture);
    const structure = structureSnapshot();
    const texts = textSnapshot();

    await new PageTranslator(document.body).translate(uppercaseTranslate);

    expect(textSnapshot()).not.toEqual(texts); // 실제로 바뀐 텍스트가 있어야 비교가 의미 있다
    expect(structureSnapshot()).toBe(structure);
  });

  it("10.2 원문 보기 후 모든 텍스트 노드가 번역 전과 문자 단위로 같다", async () => {
    loadFixture(fixture);
    const texts = textSnapshot();
    const page = new PageTranslator(document.body);

    await page.translate(uppercaseTranslate);
    await page.showOriginal();

    expect(textSnapshot()).toEqual(texts);
  });
});

describe("PageTranslator", () => {
  it("번역 요청은 문맥 단위로 묶고, 건너뛸 텍스트는 넣지 않는다 (10.4)", async () => {
    loadFixture("sentences.html");
    const { segments, translate } = recordingTranslator();

    await new PageTranslator(document.body).translate(translate);

    expect(segments()).toEqual([
      [
        ["We'll", "email you a confirmation link", "to complete sign up."],
        ["By continuing, you agree to our", "Terms of Service", "and", "Privacy Policy"],
        ["Code with an AI agent in your terminal using the open source", "CLI."],
        ["Build agents with code using LangChain, LangGraph, and Deep Agents."],
        ["Get started"],
      ],
    ]);
  });

  it("번역하지 않는 텍스트(코드·문장 부호)가 낀 그룹에만 context를 붙여 보낸다 (10.4, 13장)", async () => {
    loadFixture("sentences.html");
    const { requests, translate } = recordingTranslator();

    await new PageTranslator(document.body).translate(translate);

    expect(requests[0]!.map((group) => group.context)).toEqual([
      undefined,
      "By continuing, you agree to our Terms of Service and Privacy Policy.",
      "Code with an AI agent in your terminal using the open source dcode CLI.",
      undefined,
      undefined,
    ]);
  });

  it("화면에 보이는 그룹부터 보낸다 (SPEC 4.5)", async () => {
    document.body.innerHTML = `<p>First in document</p><p id="visible">Visible now</p><p>Last in document</p>`;
    vi.spyOn(document.getElementById("visible")!, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 100, top: 100, left: 0, right: 300, bottom: 120, width: 300, height: 20, toJSON: () => ({}),
    } as DOMRect);
    const { segments, translate } = recordingTranslator();

    await new PageTranslator(document.body).translate(translate);

    expect(segments()).toEqual([[["Visible now"], ["First in document"], ["Last in document"]]]);
  });

  it("changed를 주면 그 노드가 속한 블록만 모아 번역한다 (SPEC 4.6)", async () => {
    document.body.innerHTML = "<p>Stays English</p>";
    const page = new PageTranslator(document.body);
    document.body.insertAdjacentHTML("beforeend", "<p>Added</p>");
    const { segments, translate } = recordingTranslator();

    await page.translate(translate, [document.body.lastElementChild!]);

    expect(segments()).toEqual([[["Added"]]]);
    expect(document.body.textContent).toBe("Stays EnglishADDED");
  });

  it("앞뒤 공백은 그대로 두고 가운데 텍스트만 바꾼다", async () => {
    document.body.innerHTML = "<button>  Get started  </button>";

    await new PageTranslator(document.body).translate(uppercaseTranslate);

    expect(document.querySelector("button")!.firstChild!.nodeValue).toBe("  GET STARTED  ");
  });

  it("결과가 나오는 대로 화면에 넣는다", async () => {
    document.body.innerHTML = "<p>First block</p><p>Second block</p>";
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const page = new PageTranslator(document.body);

    const translating = page.translate(async (groups, deliver) => {
      deliver(uppercase(groups.slice(0, 1)));
      await gate;
      deliver(uppercase(groups.slice(1)));
    });
    await vi.waitFor(() => expect(document.body.textContent).toBe("FIRST BLOCKSecond block"));
    release();
    await translating;

    expect(document.body.textContent).toBe("FIRST BLOCKSECOND BLOCK");
  });

  it("원문 보기 ↔ 번역 보기는 번역기를 다시 부르지 않는다 (시나리오 3)", async () => {
    document.body.innerHTML = `<p>Hello <a href="#">world</a></p>`;
    const { translate } = recordingTranslator();
    const page = new PageTranslator(document.body);

    await page.translate(translate);
    await page.showOriginal();
    expect(document.body.textContent).toBe("Hello world");
    expect(page.mode).toBe("original");

    await page.showTranslation();
    expect(document.body.textContent).toBe("HELLO WORLD");
    expect(page.mode).toBe("translation");
    expect(translate).toHaveBeenCalledTimes(1);
  });

  it("원문 보기에서 다시 번역하면 기억한 번역문은 요청 없이 보이고, 새 텍스트만 요청한다", async () => {
    document.body.innerHTML = "<p>Remembered</p>";
    const { segments, translate } = recordingTranslator();
    const page = new PageTranslator(document.body);

    await page.translate(translate);
    await page.showOriginal();
    document.body.insertAdjacentHTML("beforeend", "<p>Added later</p>");
    await page.translate(translate);

    expect(segments()).toEqual([[["Remembered"]], [["Added later"]]]);
    expect(document.body.textContent).toBe("REMEMBEREDADDED LATER");
  });

  it("번역 요청이 실패하면 오류를 던지지만 이미 번역한 부분은 그대로 둔다 (시나리오 5)", async () => {
    document.body.innerHTML = "<p>Already translated</p>";
    const page = new PageTranslator(document.body);
    await page.translate(uppercaseTranslate);
    await page.showOriginal();
    document.body.insertAdjacentHTML("beforeend", "<p>Request fails</p>");

    await expect(
      page.translate(async () => {
        throw new Error("network down");
      }),
    ).rejects.toThrow("network down");

    expect(document.body.textContent).toBe("ALREADY TRANSLATEDRequest fails");
    expect(page.mode).toBe("translation");
  });

  it("이미 번역한 노드는 다시 요청하지 않고, 새로 생긴 텍스트만 요청한다", async () => {
    document.body.innerHTML = "<p>First</p>";
    const { segments, translate } = recordingTranslator();
    const page = new PageTranslator(document.body);

    await page.translate(translate);
    document.body.insertAdjacentHTML("beforeend", "<p>Second</p>");
    await page.translate(translate);

    expect(segments()).toEqual([[["First"]], [["Second"]]]);
    expect(document.body.textContent).toBe("FIRSTSECOND");
  });

  it("수집한 뒤 페이지가 바꾼 노드는 교체하지 않고, 다음 번역 때 다시 모은다 (4.4)", async () => {
    document.body.innerHTML = "<p>Original text</p>";
    const node = document.querySelector("p")!.firstChild as Text;
    const { segments, translate } = recordingTranslator();
    const page = new PageTranslator(document.body);

    await page.translate(async (groups, deliver) => {
      node.nodeValue = "Changed by page"; // 번역을 기다리는 사이 페이지가 바꿈
      return translate(groups, deliver);
    });
    expect(node.nodeValue).toBe("Changed by page");

    await page.translate(translate);
    expect(node.nodeValue).toBe("CHANGED BY PAGE");
    expect(segments()).toEqual([[["Original text"]], [["Changed by page"]]]);
  });

  it("번역 뒤 페이지가 바꾼 텍스트는 원문 보기 때 그대로 둔다", async () => {
    document.body.innerHTML = "<p>Counter label</p>";
    const node = document.querySelector("p")!.firstChild as Text;
    const page = new PageTranslator(document.body);

    await page.translate(uppercaseTranslate);
    node.nodeValue = "Updated by page";
    await page.showOriginal();

    expect(node.nodeValue).toBe("Updated by page");
  });

  it("세그먼트 개수가 다르거나 응답에서 빠진 그룹은 원문으로 둔다", async () => {
    document.body.innerHTML = `<p>Keep <a href="#">this</a></p><p>Missing</p><p>Translate</p>`;
    const page = new PageTranslator(document.body);

    await page.translate(async (groups, deliver) =>
      deliver([
        { id: groups[0]!.id, segments: ["ONLY ONE"] }, // 개수 불일치
        { id: groups[2]!.id, segments: ["TRANSLATED"] }, // groups[1]은 빠짐
      ]),
    );

    expect(document.body.textContent).toBe("Keep thisMissingTRANSLATED");
  });

  it("번역을 기다리는 사이 원문 보기로 바꾸면 번역문은 넣지 않고, 번역 보기 때 보여 준다", async () => {
    document.body.innerHTML = "<p>Slow response</p>";
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const page = new PageTranslator(document.body);

    const translating = page.translate(async (groups, deliver) => {
      await gate;
      deliver(uppercase(groups));
    });
    await page.showOriginal();
    release();
    await translating;
    expect(document.body.textContent).toBe("Slow response");

    await page.showTranslation();
    expect(document.body.textContent).toBe("SLOW RESPONSE");
  });

  it("번역문을 넣는 도중 원문 보기를 누르면 진행 중이던 교체는 멈추고 모두 원문이 된다", async () => {
    document.body.innerHTML = Array.from({ length: 40 }, (_, i) => `<p>Paragraph number ${i}</p>`).join("");
    const texts = textSnapshot();
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (clock += 5)); // 노드 하나에 5ms → 여러 프레임에 걸침
    const page = new PageTranslator(document.body);

    const translating = page.translate(uppercaseTranslate);
    await vi.waitFor(() => expect(document.body.textContent).toContain("PARAGRAPH"));
    await page.showOriginal();
    await translating;

    expect(textSnapshot()).toEqual(texts);
  });
});

describe("문장 부호 겹침", () => {
  it("번역문 끝 문장 부호가 페이지에서 바로 뒤에 오는 문장 부호와 같으면 하나를 뺀다", async () => {
    document.body.innerHTML = `<p>By continuing, you agree to our <a href="#">Terms</a>.</p><p>Done?</p>`;
    const page = new PageTranslator(document.body);

    await page.translate(async (groups, deliver) =>
      deliver([
        { id: groups[0]!.id, segments: ["계속하면", "약관에 동의하게 됩니다."] },
        { id: groups[1]!.id, segments: ["끝났나요?"] },
      ]),
    );

    expect(document.body.textContent).toBe("계속하면 약관에 동의하게 됩니다.끝났나요?");
  });

  it("문장 부호만 있는 번역문은 비우지 않는다", async () => {
    document.body.innerHTML = "<p>Wait <b>now</b>.</p>";
    const page = new PageTranslator(document.body);

    await page.translate(async (groups, deliver) => deliver([{ id: groups[0]!.id, segments: ["잠깐", "."] }]));

    expect(document.body.textContent).toBe("잠깐 ..");
  });
});
