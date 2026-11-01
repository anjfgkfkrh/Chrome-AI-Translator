import { pdfjsLib } from "./pdfjs";
import { EventBus, LinkTarget, PDFLinkService, PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import type { TextItem } from "pdfjs-dist/types/src/display/api";
import { listenForCommands, type CommandTarget } from "../content/commands";
import { TranslationController } from "../content/controller";
import type { PageState } from "../shared/messages";
import { originPattern } from "../shared/sites";
import { isReferencesHeading, pageBlocks, translatableBlocks, type Block, type ReferencesStart, type TextItemLike } from "./layout";
import { PdfOverlay } from "./overlay";
import { downloadPdf, fileNameOf, pageFromHash, PdfDownloadError, sourceUrl } from "./source";

// PDF 뷰어 (SPEC 13장 "PDF 번역", 설계서 6~8절).

/** 도구 막대가 상태를 다시 읽는 간격 (팝업과 같다) */
const POLL_MS = 500;
/** 텍스트가 있는지 살피는 앞쪽 쪽 수 */
const TEXT_CHECK_PAGES = 5;
/** 참고문헌 제목을 찾는 뒤쪽 쪽 수 */
const REFERENCES_SEARCH_PAGES = 30;

const LOADING_MESSAGE = "PDF를 받는 중…";
const LOCAL_FILE_MESSAGE = "내 컴퓨터의 PDF는 직접 읽을 수 없습니다. 번역할 파일을 골라 주세요.";
const DENIED_MESSAGE = "권한을 허용해야 이 PDF를 번역할 수 있습니다.";
const PASSWORD_MESSAGE = "암호로 보호된 PDF는 번역할 수 없습니다.";
const OPEN_FAILED_MESSAGE = "PDF를 열지 못했습니다.";
const NO_TEXT_MESSAGE = "이 PDF에는 번역할 텍스트가 없습니다. 스캔한 문서일 수 있습니다.";

type Phase = { kind: "opening" } | { kind: "failed"; message: string } | { kind: "ready" };

const pageInfo = element<HTMLSpanElement>("#page-info");
const statusText = element<HTMLSpanElement>("#status");
const toggleButton = element<HTMLButtonElement>("#toggle");
const notice = element<HTMLElement>("#notice");
const noticeText = element<HTMLParagraphElement>("#notice-text");
const allowButton = element<HTMLButtonElement>("#allow");
const fileInput = element<HTMLInputElement>("#file");
const openOriginal = element<HTMLAnchorElement>("#open-original");
const container = element<HTMLDivElement>("#viewerContainer");
const pagesElement = element<HTMLDivElement>("#viewer");
const overlaysElement = element<HTMLDivElement>("#overlays");

const source = sourceUrl(location.search);
const eventBus = new EventBus();
const linkService = new PDFLinkService({ eventBus, externalLinkTarget: LinkTarget.BLANK });
const viewer = new PDFViewer({
  container,
  viewer: pagesElement,
  eventBus,
  linkService,
  annotationMode: pdfjsLib.AnnotationMode.ENABLE,
});
linkService.setViewer(viewer);

const overlay = new PdfOverlay(overlaysElement, container, pagesElement, viewer);
const controller = new TranslationController(overlaysElement, {
  pageUrl: () => (source ?? location.href).split(/[?#]/)[0]!,
});

let phase: Phase = { kind: "opening" };
let references: ReferencesStart | undefined;
/** 번역층을 만들었거나 만드는 중인 쪽 */
const handledPages = new Set<number>();

const target: CommandTarget = {
  state,
  translate: () => (phase.kind === "ready" ? controller.translate() : undefined),
  retranslate: () => (phase.kind === "ready" ? controller.retranslate() : Promise.resolve()),
  showOriginal: () => (phase.kind === "ready" ? controller.showOriginal() : Promise.resolve()),
};

function state(): PageState {
  if (phase.kind === "ready") return controller.state();
  const progress = { done: 0, total: 0 };
  if (phase.kind === "opening") return { status: "translating", progress, partial: false };
  return { status: "error", progress, error: phase.message, partial: false };
}

document.title = fileNameOf(new URLSearchParams(location.search).get("file"));
listenForCommands(target);

element("#zoom-out").addEventListener("click", () => viewer.decreaseScale());
element("#zoom-in").addEventListener("click", () => viewer.increaseScale());
toggleButton.addEventListener("click", () => {
  if (toggleButton.textContent === "번역") void target.translate();
  else void target.showOriginal();
});
allowButton.addEventListener("click", () => {
  if (source === undefined) return;
  // 권한 요청은 사용자 동작 안에서 바로 불러야 한다 (await보다 먼저).
  void chrome.permissions.request({ origins: [originPattern(new URL(source).origin)] }).then((granted) => {
    if (granted) void download(source);
    else showNotice(DENIED_MESSAGE, { allow: true });
  });
});
fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  document.title = file.name;
  await open(await file.arrayBuffer());
});

eventBus.on("pagesinit", () => {
  viewer.currentScaleValue = "page-width";
  const page = pageFromHash(source, viewer.pagesCount);
  if (page !== undefined) viewer.currentPageNumber = page;
  renderPageInfo();
});
eventBus.on("pagechanging", renderPageInfo);
eventBus.on("scalechanging", () => requestAnimationFrame(() => overlay.place()));
eventBus.on("pagerendered", (event: { pageNumber: number; isDetailView?: boolean; error?: unknown }) => {
  if (phase.kind !== "failed" && !event.isDetailView && !event.error) void addPage(event.pageNumber);
});

setInterval(renderStatus, POLL_MS);
renderStatus();
void start();

async function start(): Promise<void> {
  if (source === undefined) return showNotice(LOCAL_FILE_MESSAGE, { file: true });
  const origins = [originPattern(new URL(source).origin)];
  if (await chrome.permissions.contains({ origins })) return download(source);
  showNotice(`이 PDF를 받으려면 ${new URL(source).origin} 접근 권한이 필요합니다.`, { allow: true });
}

async function download(url: string): Promise<void> {
  showNotice(LOADING_MESSAGE);
  try {
    await open(await downloadPdf(url));
  } catch (err) {
    if (err instanceof PdfDownloadError) fail(err.message);
    else throw err;
  }
}

async function open(data: ArrayBuffer): Promise<void> {
  notice.hidden = true;
  let pdf: PDFDocumentProxy;
  try {
    pdf = await pdfjsLib.getDocument({
      data,
      cMapUrl: chrome.runtime.getURL("pdf/cmaps/"),
      standardFontDataUrl: chrome.runtime.getURL("pdf/standard_fonts/"),
      wasmUrl: chrome.runtime.getURL("pdf/wasm/"),
      iccUrl: chrome.runtime.getURL("pdf/iccs/"),
    }).promise;
  } catch (err) {
    fail(err instanceof Error && err.name === "PasswordException" ? PASSWORD_MESSAGE : OPEN_FAILED_MESSAGE);
    return;
  }
  if (await hasText(pdf)) references = await findReferences(pdf);
  else fail(NO_TEXT_MESSAGE);
  viewer.setDocument(pdf);
  linkService.setDocument(pdf);
}

function fail(message: string): void {
  phase = { kind: "failed", message };
  showNotice(message, { original: source !== undefined });
  renderStatus();
}

async function hasText(pdf: PDFDocumentProxy): Promise<boolean> {
  for (let pageNumber = 1; pageNumber <= Math.min(TEXT_CHECK_PAGES, pdf.numPages); pageNumber++) {
    if ((await textItems(await pdf.getPage(pageNumber))).length > 0) return true;
  }
  return false;
}

/** 마지막 쪽부터 앞으로 찾아 처음 나오는 참고문헌 제목의 위치 */
async function findReferences(pdf: PDFDocumentProxy): Promise<ReferencesStart | undefined> {
  const first = Math.max(1, pdf.numPages - REFERENCES_SEARCH_PAGES + 1);
  for (let pageNumber = pdf.numPages; pageNumber >= first; pageNumber--) {
    const blocks = await blocksOf(await pdf.getPage(pageNumber));
    const headingIndex = blocks.findIndex((block) => isReferencesHeading(block.text));
    if (headingIndex >= 0) return { pageNumber, headingIndex };
  }
  return undefined;
}

async function textItems(page: PDFPageProxy): Promise<TextItemLike[]> {
  const { items } = await page.getTextContent();
  return items.filter((item): item is TextItem => "str" in item && item.str.trim() !== "");
}

async function blocksOf(page: PDFPageProxy): Promise<Block[]> {
  const viewport = page.getViewport({ scale: 1 });
  return pageBlocks(await textItems(page), viewport.transform, viewport.width);
}

/** 그려진 쪽의 번역층을 붙인다. 첫 쪽을 붙이면 번역을 시작하고, 그 뒤의 쪽은 컨트롤러가 화면 변화로 번역한다. */
async function addPage(pageNumber: number): Promise<void> {
  if (handledPages.has(pageNumber)) return;
  handledPages.add(pageNumber);
  const view = viewer.getPageView(pageNumber - 1);
  const page: PDFPageProxy = view.pdfPage;
  const viewport = page.getViewport({ scale: 1 });
  const blocks = translatableBlocks(await blocksOf(page), pageNumber, references);
  overlay.addPage(pageNumber, blocks, viewport, view.div.querySelector("canvas"));
  if (phase.kind === "opening") {
    phase = { kind: "ready" };
    void controller.translate();
    renderStatus();
  }
}

function renderPageInfo(): void {
  pageInfo.textContent = `${viewer.currentPageNumber} / ${viewer.pagesCount}`;
}

/** 도구 막대의 상태 문구와 번역/원문 버튼 (팝업과 같은 문구) */
function renderStatus(): void {
  if (phase.kind !== "ready") {
    statusText.textContent = phase.kind === "failed" ? phase.message : "";
    toggleButton.hidden = true;
    return;
  }
  const current = controller.state();
  toggleButton.hidden = false;
  toggleButton.textContent = current.status === "translating" || current.status === "translated" ? "원문 보기" : "번역";
  statusText.textContent = statusLabel(current);
}

function statusLabel(current: PageState): string {
  switch (current.status) {
    case "translating":
      return `번역 중… ${current.progress.done}/${current.progress.total}`;
    case "translated":
      return "번역 완료";
    case "original":
      return "원문 표시 중";
    case "error":
      return current.error ?? "";
    case "idle":
      return "";
  }
}

function showNotice(message: string, show: { allow?: boolean; file?: boolean; original?: boolean } = {}): void {
  noticeText.textContent = message;
  allowButton.hidden = !show.allow;
  fileInput.hidden = !show.file;
  openOriginal.hidden = !show.original;
  if (show.original && source !== undefined) openOriginal.href = source;
  notice.hidden = false;
}

function element<T extends Element>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`${selector} 요소가 없습니다.`);
  return found;
}
