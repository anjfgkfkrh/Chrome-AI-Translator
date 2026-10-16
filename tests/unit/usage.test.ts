// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { getUsage, isEmptyUsage, monthOf, recordUsage } from "../../src/shared/usage";
import { installChromeMock } from "./chrome-mock";

let chromeMock: ReturnType<typeof installChromeMock>;

beforeEach(() => {
  chromeMock = installChromeMock();
});

const october = new Date(2026, 9, 16, 12);
const one = { inputTokens: 10, cacheWriteTokens: 600, cacheReadTokens: 0, outputTokens: 15 };

describe("사용량 (SPEC 4.10, 6, 13장 \"사용량 표시\")", () => {
  it("달은 컴퓨터의 현지 시각 기준 \"YYYY-MM\"", () => {
    expect(monthOf(october)).toBe("2026-10");
    expect(monthOf(new Date(2026, 0, 1, 0, 0))).toBe("2026-01");
  });

  it("아직 없으면 이번 달 0", async () => {
    const usage = await getUsage(october);

    expect(usage).toEqual({ month: "2026-10", inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 });
    expect(isEmptyUsage(usage)).toBe(true);
  });

  it("입력·캐시 쓰기·캐시 읽기·출력을 따로 더한다", async () => {
    await recordUsage(one, october);
    await recordUsage({ inputTokens: 5, cacheWriteTokens: 0, cacheReadTokens: 600, outputTokens: 7 }, october);

    expect(await getUsage(october)).toEqual({
      month: "2026-10",
      inputTokens: 15,
      cacheWriteTokens: 600,
      cacheReadTokens: 600,
      outputTokens: 22,
    });
    expect(chromeMock.storage.usage).toEqual(await getUsage(october));
  });

  it("동시에 여러 응답이 와도 더한 값을 잃지 않는다", async () => {
    await Promise.all(Array.from({ length: 5 }, () => recordUsage(one, october)));

    expect(await getUsage(october)).toMatchObject({ inputTokens: 50, cacheWriteTokens: 3000, outputTokens: 75 });
  });

  it("달이 바뀌면 새로 센다 (한 달치만 저장)", async () => {
    await recordUsage(one, october);
    const november = new Date(2026, 10, 1, 9);

    expect(isEmptyUsage(await getUsage(november))).toBe(true);
    await recordUsage(one, november);

    expect(chromeMock.storage.usage).toEqual({ month: "2026-11", ...one });
  });

  it("저장된 값의 형식이 틀리면 0부터 센다", async () => {
    chromeMock.storage.usage = { month: "2026-10", inputTokens: "많이" };

    expect(isEmptyUsage(await getUsage(october))).toBe(true);
  });
});
