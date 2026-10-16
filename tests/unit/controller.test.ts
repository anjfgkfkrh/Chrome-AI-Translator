import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TranslationController } from "../../src/content/controller";
import type { RequestGroup } from "../../src/shared/messages";
import { uppercase } from "../helpers/mock-translator";
import { createPort, installChromeMock } from "./chrome-mock";

let chromeMock: ReturnType<typeof installChromeMock>;
/** 콘텐츠 스크립트가 연 번역 포트 (receive = 백그라운드가 보낸 메시지) */
let ports: ReturnType<typeof createPort>[];
/** 테스트가 끝나면 감시를 멈춘다. 남겨 두면 다음 테스트의 DOM 변경을 보고 요청을 보낸다. */
const controllers: TranslationController[] = [];

function newController(): TranslationController {
  const controller = new TranslationController(document.body);
  controllers.push(controller);
  return controller;
}

afterEach(() => {
  controllers.splice(0).forEach((controller) => controller.dispose());
});

beforeEach(() => {
  chromeMock = installChromeMock();
  ports = [];
  chromeMock.connect.mockImplementation(() => {
    const port = createPort({});
    ports.push(port);
    return port.port;
  });
  document.querySelectorAll("aitranslator-toast").forEach((toast) => toast.remove());
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

/** 마지막 포트로 보낸 번역 요청 그룹 */
function requested(): RequestGroup[] {
  return ports.at(-1)!.posted.find((message) => message.type === "translate").groups;
}

function toastRoot(): ShadowRoot | null | undefined {
  return document.querySelector("aitranslator-toast")?.shadowRoot;
}

describe("TranslationController (SPEC 4.5, 4.9)", () => {
  it("처음에는 대기 상태다", () => {
    document.body.innerHTML = "<p>Hello</p>";

    expect(newController().state()).toEqual({
      status: "idle",
      progress: { done: 0, total: 0 },
      error: undefined,
      partial: false,
    });
  });

  it("번역 중에는 결과가 오는 대로 진행률이 오르고, 끝나면 번역 완료가 된다", async () => {
    document.body.innerHTML = "<p>First</p><p>Second</p>";
    const controller = newController();

    const translating = controller.translate();
    expect(controller.state()).toMatchObject({ status: "translating", progress: { done: 0, total: 2 } });

    const [first, second] = requested();
    ports[0]!.receive({ type: "results", groups: uppercase([first!]) });
    expect(controller.state()).toMatchObject({ status: "translating", progress: { done: 1, total: 2 } });

    ports[0]!.receive({ type: "results", groups: uppercase([second!]) });
    ports[0]!.receive({ type: "done", failed: 0 });
    await translating;

    expect(controller.state()).toMatchObject({ status: "translated", progress: { done: 2, total: 2 } });
    expect(document.body.textContent).toBe("FIRSTSECOND");
    expect(ports[0]!.port.disconnect).toHaveBeenCalled();
  });

  it("원문 보기 → 원문 표시 중, 다시 번역하면 요청 없이 번역 완료 (시나리오 3)", async () => {
    document.body.innerHTML = "<p>Hello</p>";
    const controller = newController();
    const translating = controller.translate();
    ports[0]!.receive({ type: "results", groups: uppercase(requested()) });
    ports[0]!.receive({ type: "done", failed: 0 });
    await translating;

    await controller.showOriginal();
    expect(controller.state().status).toBe("original");
    expect(document.body.textContent).toBe("Hello");

    await controller.translate();
    expect(controller.state().status).toBe("translated");
    expect(document.body.textContent).toBe("HELLO");
    expect(chromeMock.connect).toHaveBeenCalledTimes(1);
  });

  it("키 오류면 오류 상태가 되고 '설정 열기'가 붙은 알림을 띄운다. 이미 번역된 부분은 그대로다 (시나리오 5)", async () => {
    document.body.innerHTML = "<p>Done</p>";
    const controller = newController();
    const first = controller.translate();
    ports[0]!.receive({ type: "results", groups: uppercase(requested()) });
    ports[0]!.receive({ type: "done", failed: 0 });
    await first;
    document.body.insertAdjacentHTML("beforeend", "<p>Added later</p>");

    const second = controller.translate();
    ports[1]!.receive({ type: "error", message: "API 키를 확인하세요.", needsSettings: true });
    await second;

    expect(controller.state()).toMatchObject({ status: "error", error: "API 키를 확인하세요." });
    expect(document.body.textContent).toBe("DONEAdded later");
    expect(toastRoot()?.textContent).toContain("API 키를 확인하세요.");
    const settings = [...toastRoot()!.querySelectorAll("button")].find((button) => button.textContent === "설정 열기");
    settings!.click();
    expect(chromeMock.runtimeSendMessage).toHaveBeenCalledWith({ type: "open-options" });
  });

  it("키 오류가 아니면 알림에 '설정 열기'를 붙이지 않는다", async () => {
    document.body.innerHTML = "<p>Hello</p>";
    const controller = newController();

    const translating = controller.translate();
    ports[0]!.receive({
      type: "error",
      message: "요청 한도를 초과했습니다. 잠시 후 다시 시도하세요.",
      needsSettings: false,
    });
    await translating;

    expect(toastRoot()?.textContent).toContain("요청 한도를 초과했습니다.");
    expect(toastRoot()?.textContent).not.toContain("설정 열기");
  });

  it("일부만 실패하면 번역 완료 + 일부 실패로 표시하고 알림을 띄운다", async () => {
    document.body.innerHTML = "<p>One</p><p>Two</p>";
    const controller = newController();

    const translating = controller.translate();
    ports[0]!.receive({ type: "results", groups: uppercase(requested().slice(0, 1)) });
    ports[0]!.receive({ type: "done", failed: 1, error: "네트워크에 연결할 수 없습니다. 인터넷 연결을 확인하세요." });
    await translating;

    expect(controller.state()).toMatchObject({ status: "translated", partial: true, progress: { done: 2, total: 2 } });
    expect(toastRoot()?.textContent).toContain("일부는 번역하지 못해 원문으로 두었습니다.");
  });

  it("백그라운드와 연결이 끊기면 오류로 알린다", async () => {
    document.body.innerHTML = "<p>Hello</p>";
    const controller = newController();

    const translating = controller.translate();
    ports[0]!.close();
    await translating;

    expect(controller.state()).toMatchObject({
      status: "error",
      error: "번역 실패: 백그라운드와 연결이 끊어졌습니다.",
    });
  });

  it("번역을 기다리는 동안 20초마다 ping을 보낸다", () => {
    vi.useFakeTimers();
    try {
      document.body.innerHTML = "<p>Hello</p>";
      void newController().translate();

      vi.advanceTimersByTime(20_000);

      expect(ports[0]!.posted).toContainEqual({ type: "ping" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("동적 콘텐츠 (SPEC 4.6)", () => {
  /** 디바운스(300ms)가 지나고도 남을 만큼 기다린다. */
  const pause = () => new Promise((resolve) => setTimeout(resolve, 500));

  async function translated(controller: TranslationController, port = ports.length - 1): Promise<void> {
    ports[port]!.receive({ type: "results", groups: uppercase(requested()) });
    ports[port]!.receive({ type: "done", failed: 0 });
    await vi.waitFor(() => expect(controller.state().status).toBe("translated"));
  }

  it("번역 보기 중에 새로 들어온 텍스트도 번역한다", async () => {
    document.body.innerHTML = "<p>First</p>";
    const controller = newController();
    void controller.translate();
    await translated(controller);

    document.body.insertAdjacentHTML("beforeend", "<p>Arrived later</p>");

    await vi.waitFor(() => expect(ports).toHaveLength(2), { timeout: 2_000 });
    expect(requested().map((group) => group.segments)).toEqual([["Arrived later"]]);
    await translated(controller);
    await vi.waitFor(() => expect(document.body.textContent).toBe("FIRSTARRIVED LATER"));
  });

  it("우리가 넣은 번역문 때문에 다시 요청하지 않는다 (무한 반복 방지)", async () => {
    document.body.innerHTML = "<p>One</p><p>Two</p>";
    const controller = newController();
    void controller.translate();
    await translated(controller);

    await pause();

    expect(ports).toHaveLength(1);
  });

  it("원문 보기 중에는 새 텍스트를 번역하지 않는다", async () => {
    document.body.innerHTML = "<p>First</p>";
    const controller = newController();
    void controller.translate();
    await translated(controller);
    await controller.showOriginal();

    document.body.insertAdjacentHTML("beforeend", "<p>While original</p>");
    await pause();

    expect(ports).toHaveLength(1);
  });

  it("번역 전체를 멈춘 오류가 나면 감시도 멈춘다 (같은 오류 되풀이 방지)", async () => {
    document.body.innerHTML = "<p>First</p>";
    const controller = newController();
    const translating = controller.translate();
    ports[0]!.receive({ type: "error", message: "API 키를 확인하세요.", needsSettings: true });
    await translating;

    document.body.insertAdjacentHTML("beforeend", "<p>After error</p>");
    await pause();

    expect(ports).toHaveLength(1);
  });
});

describe("확장 프로그램과 끊긴 콘텐츠 스크립트", () => {
  it("확장을 새로고침해 끊기면 페이지가 바뀌어도 요청하지 않고 감시를 멈춘다", async () => {
    document.body.innerHTML = "<p>First</p>";
    const controller = newController();
    const translating = controller.translate();
    ports[0]!.receive({ type: "results", groups: uppercase(requested()) });
    ports[0]!.receive({ type: "done", failed: 0 });
    await translating;

    (chrome.runtime as { id?: string }).id = undefined;
    document.body.insertAdjacentHTML("beforeend", "<p>After reload</p>");
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(ports).toHaveLength(1);
  });
});

describe("사이트별 자동 번역으로 열렸을 때 (SPEC 13장)", () => {
  const missingKey = { type: "error", message: "API 키를 먼저 설정하세요", needsSettings: true, missingKey: true };

  it("키가 없으면 알림 없이 건너뛴다", async () => {
    document.body.innerHTML = "<p>Hello</p>";
    const controller = newController();

    const translating = controller.translate({ auto: true });
    ports[0]!.receive(missingKey);
    await translating;

    expect(toastRoot()).toBeUndefined();
    expect(console.error).not.toHaveBeenCalled();
    expect(controller.state()).toMatchObject({ status: "error", error: "API 키를 먼저 설정하세요" });
    expect(document.body.textContent).toBe("Hello");
  });

  it("자동 번역 사이트라도 직접 번역하면 키가 없다고 알린다", async () => {
    document.body.innerHTML = "<p>Hello</p>";
    const controller = newController();
    const auto = controller.translate({ auto: true });
    ports[0]!.receive(missingKey);
    await auto;

    const manual = controller.translate();
    ports[1]!.receive(missingKey);
    await manual;

    expect(toastRoot()?.textContent).toContain("API 키를 먼저 설정하세요");
  });

  it("키 말고 다른 오류는 자동 번역이어도 알린다", async () => {
    document.body.innerHTML = "<p>Hello</p>";
    const controller = newController();

    const translating = controller.translate({ auto: true });
    ports[0]!.receive({ type: "error", message: "API 키를 확인하세요.", needsSettings: true, missingKey: false });
    await translating;

    expect(toastRoot()?.textContent).toContain("API 키를 확인하세요.");
  });
});

describe("실패 원인 표시 (SPEC 13장)", () => {
  const RATE_LIMITED = "요청 한도를 초과했습니다. 잠시 후 다시 시도하세요.";

  it("일부만 실패하면 \"일부는…\" 알림 아래에 원인 문구를 붙이고, 상태에도 원인을 남긴다", async () => {
    document.body.innerHTML = "<p>One</p><p>Two</p>";
    const controller = newController();

    const translating = controller.translate();
    ports[0]!.receive({ type: "results", groups: uppercase(requested().slice(0, 1)) });
    ports[0]!.receive({ type: "done", failed: 1, error: RATE_LIMITED });
    await translating;

    expect(controller.state()).toMatchObject({ status: "translated", partial: true, cause: RATE_LIMITED });
    expect(toastRoot()?.querySelector(".message")?.textContent).toBe("일부는 번역하지 못해 원문으로 두었습니다.");
    expect(toastRoot()?.querySelector(".detail")?.textContent).toBe(RATE_LIMITED);
  });

  it("하나도 번역하지 못하면 원인 문구를 오류로 알린다", async () => {
    document.body.innerHTML = "<p>One</p><p>Two</p>";
    const controller = newController();

    const translating = controller.translate();
    ports[0]!.receive({ type: "done", failed: 2, error: RATE_LIMITED });
    await translating;

    expect(controller.state()).toMatchObject({ status: "error", error: RATE_LIMITED, partial: false });
    expect(toastRoot()?.querySelector(".message")?.textContent).toBe(RATE_LIMITED);
    expect(toastRoot()?.textContent).not.toContain("일부는");
    expect(toastRoot()?.textContent).not.toContain("설정 열기");
  });

  it("이미 번역된 페이지에서 새 텍스트만 모두 실패하면 일부 실패로 알린다", async () => {
    document.body.innerHTML = "<p>First</p>";
    const controller = newController();
    const first = controller.translate();
    ports[0]!.receive({ type: "results", groups: uppercase(requested()) });
    ports[0]!.receive({ type: "done", failed: 0 });
    await first;
    document.body.insertAdjacentHTML("beforeend", "<p>Added later</p>");

    const second = controller.translate();
    ports[1]!.receive({ type: "done", failed: 1, error: RATE_LIMITED });
    await second;

    expect(controller.state()).toMatchObject({ status: "translated", partial: true, cause: RATE_LIMITED });
    expect(document.body.textContent).toBe("FIRSTAdded later");
  });

  it("다시 번역하면 지난 원인은 지운다", async () => {
    document.body.innerHTML = "<p>One</p><p>Two</p>";
    const controller = newController();
    const first = controller.translate();
    ports[0]!.receive({ type: "results", groups: uppercase(requested().slice(0, 1)) });
    ports[0]!.receive({ type: "done", failed: 1, error: RATE_LIMITED });
    await first;

    const second = controller.translate();
    ports[1]!.receive({ type: "results", groups: uppercase(requested()) });
    ports[1]!.receive({ type: "done", failed: 0 });
    await second;

    expect(controller.state()).toMatchObject({ status: "translated", partial: false, cause: undefined });
  });
});

describe("캐시 정리의 턴 (SPEC 13장)", () => {
  it("페이지 번역을 시작하는 요청에는 newTurn을, 화면이 바뀌어 더 번역하는 요청에는 붙이지 않는다", async () => {
    document.body.innerHTML = "<p>First</p>";
    const controller = newController();
    void controller.translate();
    expect(ports[0]!.posted[0]).toMatchObject({ type: "translate", newTurn: true });
    ports[0]!.receive({ type: "results", groups: uppercase(requested()) });
    ports[0]!.receive({ type: "done", failed: 0 });
    await vi.waitFor(() => expect(controller.state().status).toBe("translated"));

    document.body.insertAdjacentHTML("beforeend", "<p>Arrived later</p>");

    await vi.waitFor(() => expect(ports).toHaveLength(2), { timeout: 2_000 });
    expect(ports[1]!.posted[0]).toMatchObject({ type: "translate", newTurn: false });
  });
});

describe("이 품질로 다시 번역 (SPEC 13장)", () => {
  it("기억한 번역문을 버리고 원문으로 되돌린 뒤, 처음부터 새 턴으로 다시 요청한다", async () => {
    document.body.innerHTML = "<p>One</p><p>Two</p>";
    const controller = newController();
    const first = controller.translate();
    ports[0]!.receive({ type: "results", groups: uppercase(requested()) });
    ports[0]!.receive({ type: "done", failed: 0 });
    await first;
    expect(document.body.textContent).toBe("ONETWO");

    await controller.retranslate();

    expect(document.body.textContent).toBe("OneTwo");
    expect(ports).toHaveLength(2);
    expect(ports[1]!.posted[0]).toMatchObject({ type: "translate", newTurn: true });
    expect(requested().map((group) => group.segments)).toEqual([["One"], ["Two"]]);

    ports[1]!.receive({
      type: "results",
      groups: requested().map((group) => ({ id: group.id, segments: group.segments.map((segment) => `[${segment}]`) })),
    });
    ports[1]!.receive({ type: "done", failed: 0 });
    await vi.waitFor(() => expect(document.body.textContent).toBe("[One][Two]"));
    expect(controller.state().status).toBe("translated");
  });

  it("번역 중에는 다시 번역하지 않는다", async () => {
    document.body.innerHTML = "<p>One</p>";
    const controller = newController();
    void controller.translate();

    await controller.retranslate();

    expect(ports).toHaveLength(1);
  });
});

describe("최근 번역 기록 정보 (SPEC 13장 \"기록의 한 건\")", () => {
  function logOf(port: number) {
    return ports[port]!.posted.find((message) => message.type === "translate").log;
  }

  it("페이지 번역마다 새 ID, 화면 변화로 더 번역하면 같은 ID. 주소의 쿼리·해시는 뺀다", async () => {
    history.replaceState(null, "", "/docs/page?token=secret#part");
    document.title = "  Docs Page  ";
    document.body.innerHTML = "<p>First</p>";
    const controller = newController();
    void controller.translate();
    const first = logOf(0);
    expect(first).toMatchObject({ title: "Docs Page", url: `${location.origin}/docs/page`, automatic: false });
    expect(first.id).toMatch(/^[0-9a-z]+-[0-9a-z]+$/);
    ports[0]!.receive({ type: "results", groups: uppercase(requested()) });
    ports[0]!.receive({ type: "done", failed: 0 });
    await vi.waitFor(() => expect(controller.state().status).toBe("translated"));

    document.body.insertAdjacentHTML("beforeend", "<p>Arrived later</p>");
    await vi.waitFor(() => expect(ports).toHaveLength(2), { timeout: 2_000 });
    expect(logOf(1).id).toBe(first.id);

    ports[1]!.receive({ type: "results", groups: uppercase(requested()) });
    ports[1]!.receive({ type: "done", failed: 0 });
    await vi.waitFor(() => expect(controller.state().status).toBe("translated"));
    await controller.retranslate();
    expect(logOf(2).id).not.toBe(first.id);
    history.replaceState(null, "", "/");
  });

  it("자동 번역으로 열렸으면 그렇게 남긴다", () => {
    document.body.innerHTML = "<p>Hello</p>";
    void newController().translate({ auto: true });

    expect(logOf(0)).toMatchObject({ automatic: true });
  });
});

describe("페이지를 새로 읽지 않는 사이트의 페이지 이동 (SPEC 13장)", () => {
  function translateMessage(port: number) {
    return ports[port]!.posted.find((message) => message.type === "translate");
  }

  async function translatedFirst(controller: TranslationController): Promise<void> {
    void controller.translate();
    ports[0]!.receive({ type: "results", groups: uppercase(requested()) });
    ports[0]!.receive({ type: "done", failed: 0 });
    await vi.waitFor(() => expect(controller.state().status).toBe("translated"));
  }

  it("주소가 바뀐 뒤 화면이 바뀌어 더 번역하면 새 건이자 새 턴으로 보낸다", async () => {
    history.replaceState(null, "", "/app");
    document.body.innerHTML = "<p>Home</p>";
    const controller = newController();
    await translatedFirst(controller);

    history.pushState(null, "", "/app/settings");
    document.body.insertAdjacentHTML("beforeend", "<p>Settings screen</p>");

    await vi.waitFor(() => expect(ports).toHaveLength(2), { timeout: 2_000 });
    const next = translateMessage(1);
    expect(next.newTurn).toBe(true);
    expect(next.log.id).not.toBe(translateMessage(0).log.id);
    expect(next.log.url).toBe(`${location.origin}/app/settings`);
    history.replaceState(null, "", "/");
  });

  it("쿼리·해시만 바뀌면 같은 건·같은 턴이다", async () => {
    history.replaceState(null, "", "/search");
    document.body.innerHTML = "<p>Results</p>";
    const controller = newController();
    await translatedFirst(controller);

    history.pushState(null, "", "/search?q=agents#top");
    document.body.insertAdjacentHTML("beforeend", "<p>More results</p>");

    await vi.waitFor(() => expect(ports).toHaveLength(2), { timeout: 2_000 });
    expect(translateMessage(1).newTurn).toBe(false);
    expect(translateMessage(1).log.id).toBe(translateMessage(0).log.id);
    history.replaceState(null, "", "/");
  });
});
