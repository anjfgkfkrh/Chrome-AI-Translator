import { splitWhitespace, type TextUnit } from "./collect";

// 텍스트 교체와 복원 (SPEC 4.4). 텍스트 노드의 nodeValue만 바꾸고 요소와 속성은 건드리지 않는다.

/** 한 프레임에 교체하는 최대 시간 (SPEC 13장 "requestAnimationFrame 교체 단위") */
const FRAME_BUDGET_MS = 8;

/**
 * items를 requestAnimationFrame마다 최대 8ms씩 나눠 처리한다 (SPEC 7.2).
 * isCurrent()가 false가 되면 남은 항목은 처리하지 않고 false로 끝낸다.
 */
export function runInFrames<T>(
  items: readonly T[],
  work: (item: T) => void,
  isCurrent: () => boolean = () => true,
): Promise<boolean> {
  if (items.length === 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    let index = 0;
    const step = () => {
      if (!isCurrent()) return resolve(false);
      const start = performance.now();
      while (index < items.length) {
        work(items[index++]!);
        if (performance.now() - start >= FRAME_BUDGET_MS) break;
      }
      if (index < items.length) requestAnimationFrame(step);
      else resolve(true);
    };
    requestAnimationFrame(step);
  });
}

interface TextRecord {
  /** 수집할 때의 nodeValue 전체 */
  original: string;
  /** 번역문 (앞뒤 공백 제외) */
  translated: string;
}

/** 번역을 아는 텍스트 노드의 원문과 번역문을 들고, 화면을 원문 또는 번역문으로 바꾼다. */
export class TextReplacer {
  private readonly records = new WeakMap<Text, TextRecord>();
  // WeakMap은 순회할 수 없으므로, 전환할 때 돌 노드 목록을 따로 둔다.
  private readonly nodes = new Set<Text>();
  private generation = 0;

  /** 번역 결과를 기억한다. 화면에는 showTranslations()에서 넣는다. */
  remember(unit: TextUnit, translated: string): void {
    this.records.set(unit.node, { original: unit.value, translated });
    this.nodes.add(unit.node);
  }

  /** 지금 원문이나 우리가 넣은 번역문을 보여 주는 노드인지. 아니면 다시 수집할 대상이다. */
  isTracking(node: Text): boolean {
    const record = this.records.get(node);
    return record !== undefined && (node.nodeValue === record.original || node.nodeValue === translatedValue(record));
  }

  /** 지금 우리가 넣은 번역문을 보여 주는 노드인지. 이 노드의 변경 알림은 우리가 만든 것이다 (SPEC 4.6). */
  isShowingTranslation(node: Text): boolean {
    const record = this.records.get(node);
    return record !== undefined && node.nodeValue === translatedValue(record);
  }

  /** 기억한 번역문을 넣는다. 수집한 뒤 페이지가 값을 바꾼 노드는 교체하지 않고 잊는다 (다시 수집 대상). */
  showTranslations(): Promise<boolean> {
    return this.pass((node, record) => {
      const translated = translatedValue(record);
      if (node.nodeValue === translated) return;
      if (node.nodeValue === record.original) node.nodeValue = translated;
      else this.forget(node);
    });
  }

  /** 원문으로 되돌린다. 우리가 넣은 번역문이 아닌 값(페이지가 바꾼 값)은 그대로 두고 잊는다. */
  showOriginals(): Promise<boolean> {
    return this.pass((node, record) => {
      if (node.nodeValue === record.original) return;
      if (node.nodeValue === translatedValue(record)) node.nodeValue = record.original;
      else this.forget(node);
    });
  }

  /** 기억한 원문·번역문을 모두 버린다. 화면은 바꾸지 않으므로 먼저 showOriginals()로 되돌린다. */
  clear(): void {
    this.generation++; // 진행 중인 전환이 있으면 멈춘다
    for (const node of this.nodes) this.records.delete(node);
    this.nodes.clear();
  }

  private pass(work: (node: Text, record: TextRecord) => void): Promise<boolean> {
    // 새 전환이 시작되면 진행 중이던 전환은 멈춘다.
    const generation = ++this.generation;
    return runInFrames(
      [...this.nodes],
      (node) => {
        const record = this.records.get(node);
        if (record && node.isConnected) work(node, record);
        else this.forget(node);
      },
      () => generation === this.generation,
    );
  }

  private forget(node: Text): void {
    this.records.delete(node);
    this.nodes.delete(node);
  }
}

function translatedValue(record: TextRecord): string {
  const { lead, tail } = splitWhitespace(record.original);
  return lead + record.translated + tail;
}
