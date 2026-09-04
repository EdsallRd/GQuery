import { afterEach, expect, it, vi } from "vitest";
import { callHandler, configureGQueryObserver } from "./ratelimit";

afterEach(() => configureGQueryObserver());

it("counts actual attempts and value rows without exposing source data", () => {
  const report = vi.fn();
  configureGQueryObserver(report);
  const operation = vi.fn()
    .mockImplementationOnce(() => { throw new Error("429 private details"); })
    .mockReturnValue({ valueRanges: [{ values: [["private"]] }, { values: [[1], [2]] }] });
  expect(callHandler(operation, 1, "values.batchGet", 2).valueRanges).toHaveLength(2);
  expect(report.mock.calls.map(([event]) => [event.attempt, event.succeeded, event.valueRows]))
    .toEqual([[1, false, 0], [2, true, 3]]);
  expect(JSON.stringify(report.mock.calls)).not.toContain("private");
});

it("does not turn successful writes into failures if diagnostics fail", () => {
  configureGQueryObserver(() => { throw new Error("observer failed"); });
  expect(callHandler(() => 42)).toBe(42);
});
