import type { TranslateGroups } from "../../src/content/page-translator";
import type { RequestGroup, SegmentGroup } from "../../src/shared/messages";

/** 세그먼트를 대문자로 바꾼 결과 (목 번역기, SPEC 13장). 세그먼트 개수와 순서는 그대로다. */
export function uppercase(groups: readonly RequestGroup[]): SegmentGroup[] {
  return groups.map((group) => ({ id: group.id, segments: group.segments.map((segment) => segment.toUpperCase()) }));
}

/** 목 번역기: 모든 그룹을 대문자로 바꿔 한 번에 넘긴다. */
export const uppercaseTranslate: TranslateGroups = async (groups, deliver) => {
  deliver(uppercase(groups));
};
