import type { RequestGroup, SegmentGroup } from "../shared/messages";
import { TextReplacer } from "./apply";
import { collectGroups, collectGroupsAround, type Group } from "./collect";

/**
 * 번역 방법. groups를 번역해 결과가 나오는 대로 deliver()로 넘기고, 모두 끝나면 끝난다.
 * M3부터는 백그라운드 요청(index.ts), 테스트에서는 목 번역기를 넘긴다.
 */
export type TranslateGroups = (groups: RequestGroup[], deliver: (results: SegmentGroup[]) => void) => Promise<void>;

/** 페이지 하나의 번역 상태: 수집 → 번역 → 교체, 원문 보기 ↔ 번역 보기. */
export class PageTranslator {
  private readonly root: Element;
  private readonly replacer = new TextReplacer();
  /** 번역 요청 중인 노드. 결과가 오기 전에 다시 수집하지 않도록 한다. */
  private readonly pending = new Set<Text>();
  private showing: "original" | "translation" = "original";

  constructor(root: Element) {
    this.root = root;
  }

  get mode(): "original" | "translation" {
    return this.showing;
  }

  /** 지금 우리가 넣은 번역문을 보여 주는 노드인지 (자기 변경 무시, SPEC 4.6) */
  isShowingTranslation(node: Text): boolean {
    return this.replacer.isShowingTranslation(node);
  }

  /**
   * 기억한 번역문을 보여 주고, 아직 번역하지 않은 텍스트를 모아 번역한다. 결과는 배치가 끝날 때마다 화면에 넣는다.
   * changed를 주면 그 노드가 속한 블록만 모은다 (동적 콘텐츠). 화면에 보이는 그룹부터 보낸다 (SPEC 4.5).
   * 번역이 실패하면 오류를 던지지만 이미 번역된 부분은 그대로 둔다 (시나리오 5).
   */
  async translate(translateGroups: TranslateGroups, changed?: Iterable<Node>): Promise<void> {
    this.showing = "translation";
    // 기억한 번역문은 요청을 기다리지 않고 바로 보여 준다 (원문 보기에서 다시 번역할 때).
    const showRemembered = this.replacer.showTranslations();
    const isHandled = (node: Text) => this.pending.has(node) || this.replacer.isTracking(node);
    const collected = changed ? collectGroupsAround(changed, isHandled) : collectGroups(this.root, isHandled);
    const groups = [...collected.filter((group) => group.visible), ...collected.filter((group) => !group.visible)];
    if (groups.length === 0) {
      await showRemembered;
      return;
    }

    const byId = new Map(groups.map((group) => [group.id, group]));
    const nodes = groups.flatMap((group) => group.units.map((unit) => unit.node));
    nodes.forEach((node) => this.pending.add(node));
    let failure: { error: unknown } | undefined;
    try {
      await translateGroups(groups.map(toRequestGroup), (results) => {
        this.remember(byId, results);
        if (this.showing === "translation") void this.replacer.showTranslations();
      });
    } catch (error) {
      failure = { error };
    } finally {
      nodes.forEach((node) => this.pending.delete(node));
    }
    // 기다리는 사이 원문 보기로 바뀌었으면 번역문은 기억만 해 두고 넣지 않는다.
    if (this.showing === "translation") await this.replacer.showTranslations();
    if (failure) throw failure.error;
  }

  /** 원문으로 되돌리고 기억한 번역문을 모두 버린다. 다음 translate()는 처음부터 다시 요청한다 (SPEC 13장 "이 품질로 다시 번역"). */
  async reset(): Promise<void> {
    this.showing = "original";
    await this.replacer.showOriginals();
    this.replacer.clear();
  }

  /** 원문 보기 (API 호출 없음) */
  async showOriginal(): Promise<void> {
    this.showing = "original";
    await this.replacer.showOriginals();
  }

  /** 기억한 번역문을 다시 보여 준다 (API 호출 없음) */
  async showTranslation(): Promise<void> {
    this.showing = "translation";
    await this.replacer.showTranslations();
  }

  private remember(groups: Map<string, Group>, results: readonly SegmentGroup[]): void {
    for (const result of results) {
      const group = groups.get(result.id);
      // 세그먼트 개수가 다르면 DOM 구조에 맞춰 넣을 수 없으므로 그 그룹은 원문으로 둔다.
      if (!group || result.segments.length !== group.units.length) continue;
      group.units.forEach((unit, i) => {
        this.replacer.remember(unit, withoutRepeatedPunctuation(result.segments[i]!, unit.after));
      });
    }
  }
}

// 번역문 끝에 붙으면 페이지의 다음 텍스트와 겹칠 수 있는 문장 부호
const TRAILING_PUNCTUATION = new Set([".", ",", "!", "?", ":", ";", "…", ")", "]"]);

/**
 * 번역문 끝의 문장 부호가 페이지에서 바로 뒤에 오는 문장 부호와 같으면 뺀다.
 * 모델은 한국어 문장 끝에 마침표를 붙이는데, 링크 뒤의 "."처럼 원래 마침표가 따로 남아 있으면 ".."가 되기 때문이다.
 */
function withoutRepeatedPunctuation(translated: string, after: string): string {
  const next = after.trimStart()[0];
  if (next === undefined || !TRAILING_PUNCTUATION.has(next) || !translated.endsWith(next)) return translated;
  const trimmed = translated.slice(0, -1).trimEnd();
  return trimmed === "" ? translated : trimmed;
}

function toRequestGroup(group: Group): RequestGroup {
  const segments = group.units.map((unit) => unit.core);
  return group.context === undefined ? { id: group.id, segments } : { id: group.id, segments, context: group.context };
}
