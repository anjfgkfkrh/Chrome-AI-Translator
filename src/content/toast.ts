import { UI_ATTRIBUTE } from "./collect";

// 페이지 오른쪽 아래의 작은 알림 (SPEC 4.11, 13장 "토스트 동작").
// 페이지 DOM에 더하는 것은 이 알림 하나뿐이다. Shadow DOM 안에 그려 페이지 스타일과 섞이지 않게 한다.

const AUTO_CLOSE_MS = 8_000;

// 페이지 CSS가 어떻든 자리를 지키도록 호스트 요소에 직접 !important로 준다.
const HOST_STYLE: Record<string, string> = {
  all: "initial",
  display: "block",
  position: "fixed",
  right: "16px",
  bottom: "16px",
  "z-index": "2147483647",
};

const STYLE = `
.toast {
  box-sizing: border-box;
  max-width: 320px;
  padding: 10px 12px;
  border: 1px solid #d1d9e0;
  border-radius: 8px;
  background: #ffffff;
  color: #1f2328;
  font: 13px/1.5 system-ui, sans-serif;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}
.header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.title { font-weight: 600; }
.message { margin: 4px 0 0; }
button { font: inherit; color: inherit; background: none; border: none; padding: 0; cursor: pointer; }
button:focus-visible { outline: 2px solid #0969da; outline-offset: 2px; }
.close { font-size: 16px; line-height: 1; }
.settings { margin-top: 6px; color: #0969da; text-decoration: underline; }
@media (prefers-color-scheme: dark) {
  .toast { background: #151b23; color: #f0f6fc; border-color: #3d444d; }
  .settings { color: #4493f8; }
}
`;

export interface ToastHandle {
  readonly root: ShadowRoot;
  close(): void;
}

let current: ToastHandle | undefined;

/** 알림을 띄운다. 이미 떠 있는 알림은 닫는다. onOpenSettings를 주면 "설정 열기"를 붙인다 (키 오류). */
export function showToast(message: string, options: { onOpenSettings?: () => void } = {}): ToastHandle {
  current?.close();

  // div 같은 흔한 태그를 고르는 페이지 CSS에 걸리지 않도록 전용 이름을 쓴다.
  const host = document.createElement("aitranslator-toast");
  host.setAttribute(UI_ATTRIBUTE, "");
  for (const [name, value] of Object.entries(HOST_STYLE)) host.style.setProperty(name, value, "important");
  const root = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = STYLE;
  const box = create("div", "toast");
  box.setAttribute("role", "alert");
  const header = create("div", "header");
  const closeButton = create("button", "close", "×");
  closeButton.type = "button";
  closeButton.setAttribute("aria-label", "닫기");
  header.append(create("span", "title", "AITranslator"), closeButton);
  box.append(header, create("p", "message", message));
  if (options.onOpenSettings) {
    const settingsButton = create("button", "settings", "설정 열기");
    settingsButton.type = "button";
    settingsButton.addEventListener("click", options.onOpenSettings);
    box.append(settingsButton);
  }
  root.append(style, box);
  // body 밖(html 바로 아래)에 붙여 번역 수집 대상과 페이지 레이아웃에서 떨어뜨린다.
  document.documentElement.append(host);

  const timer = setTimeout(() => handle.close(), AUTO_CLOSE_MS);
  const handle: ToastHandle = {
    root,
    close() {
      clearTimeout(timer);
      host.remove();
      if (current === handle) current = undefined;
    },
  };
  closeButton.addEventListener("click", () => handle.close());
  current = handle;
  return handle;
}

function create<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
  const el = document.createElement(tag);
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
