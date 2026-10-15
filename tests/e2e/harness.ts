import { PageTranslator } from "../../src/content/page-translator";
import type { RequestGroup } from "../../src/shared/messages";
import { uppercaseTranslate } from "../helpers/mock-translator";

// E2E 전용 진입점: 픽스처 페이지에서 수집·교체·복원을 실행한다 (목 번역기 = 대문자 변환).
// m2.spec.ts가 esbuild로 묶어 page.addInitScript()로 넣는다.

export interface Harness {
  /** 번역기에 보낸 요청 (호출마다 그룹 배열 하나) */
  requests: RequestGroup[][];
  translate(): Promise<void>;
  showOriginal(): Promise<void>;
  showTranslation(): Promise<void>;
}

declare global {
  interface Window {
    __aitranslator: Harness;
  }
}

let page: PageTranslator | undefined;
// init 스크립트는 body가 생기기 전에 돌기 때문에 처음 쓸 때 만든다.
const current = () => (page ??= new PageTranslator(document.body));

const requests: RequestGroup[][] = [];

window.__aitranslator = {
  requests,
  translate: () =>
    current().translate(async (groups, deliver) => {
      requests.push(groups);
      await uppercaseTranslate(groups, deliver);
    }),
  showOriginal: () => current().showOriginal(),
  showTranslation: () => current().showTranslation(),
};
