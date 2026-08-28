import { describe, expect, it } from "vitest";
import { createExecutionStats, mergeExecutionStats } from "./execution";

describe("execution statistics", () => {
  it("creates independent stats and merges counters and ranges", () => {
    const first = createExecutionStats({
      apiCalls: 1,
      cellsRead: 10,
      joinFanOut: 2,
      rangesRead: ["'Assets'!A:A"],
    });
    const second = createExecutionStats({
      apiCalls: 1,
      cellsWritten: 2,
      joinFanOut: 3,
      rangesWritten: ["'Assets'!B2:B3"],
    });

    expect(mergeExecutionStats(first, second)).toMatchObject({
      apiCalls: 2,
      cellsRead: 10,
      cellsWritten: 2,
      joinFanOut: 5,
      rangesRead: ["'Assets'!A:A"],
      rangesWritten: ["'Assets'!B2:B3"],
    });
  });
});
