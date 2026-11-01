import * as pdfjsLib from "pdfjs-dist";

// web/pdf_viewer.mjs는 불러올 때 globalThis.pdfjsLib를 읽는다. viewer.ts에서 이 파일을 먼저 import한다.
(globalThis as { pdfjsLib?: typeof pdfjsLib }).pdfjsLib = pdfjsLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("pdf/pdf.worker.min.mjs");

export { pdfjsLib };
