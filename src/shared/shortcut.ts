import { sendMessage } from "./messages";

/**
 * 단축키 줄 (SPEC 4.8.1, 13장 "M4 화면 문구"): 할당됐으면 "단축키 ⌥T",
 * 다른 확장과 겹쳐 할당되지 않았으면 "단축키 없음 · 설정하기"(chrome://extensions/shortcuts로 이동).
 */
export async function renderShortcut(container: HTMLElement): Promise<void> {
  const shortcut = await sendMessage({ type: "get-shortcut" });
  if (shortcut) {
    container.textContent = `단축키 ${shortcut}`;
    return;
  }
  const link = document.createElement("a");
  link.href = "#";
  link.textContent = "설정하기";
  link.addEventListener("click", (event) => {
    event.preventDefault();
    void chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
  });
  container.replaceChildren("단축키 없음 · ", link);
}
