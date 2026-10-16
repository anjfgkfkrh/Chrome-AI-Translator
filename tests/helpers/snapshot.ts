// SPEC 10.1·10.2 비교용 스냅숏. Playwright의 page.evaluate()에도 넘기므로 바깥 변수를 쓰지 않는다.

/**
 * 10.1: 텍스트 노드 값만 "T"로 바꾼 직렬화. 태그·순서·개수·속성·텍스트 노드 위치를 비교한다.
 * root가 노드면 그 노드만 (locator.evaluate()가 요소를 넘긴다), 아니면 문서 전체 (page.evaluate()).
 */
export function structureSnapshot(root?: unknown): string {
  const parts: string[] = [];
  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push("T");
    } else if (node.nodeType === Node.COMMENT_NODE) {
      parts.push("<!---->");
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as Element;
      const attributes = Array.from(el.attributes, (attr) => ` ${attr.name}=${JSON.stringify(attr.value)}`).join("");
      parts.push(`<${el.tagName}${attributes}>`);
      el.childNodes.forEach(visit);
      parts.push(`</${el.tagName}>`);
    }
  };
  visit(root instanceof Node ? root : document.documentElement);
  return parts.join("");
}

/** 10.2: 문서 순서대로 모든 텍스트 노드의 값 */
export function textSnapshot(): string[] {
  const values: string[] = [];
  const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) values.push(node.nodeValue ?? "");
  return values;
}
