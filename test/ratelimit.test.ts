import { beforeEach, describe, expect, it, vi } from "vitest";
import { callHandler } from "../src/ratelimit";
import { GQueryApiError } from "../src/types";
import { gasFakes, resetGasFakes } from "./setup";

describe("callHandler", () => {
  beforeEach(() => resetGasFakes());

  it("returns the value when fn succeeds first try", () => {
    const fn = vi.fn(() => "ok");
    expect(callHandler(fn)).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on 429 / Quota exceeded errors", () => {
    let calls = 0;
    const fn = vi.fn(() => {
      calls++;
      if (calls < 3) throw new Error("Quota exceeded for foo");
      return "done";
    });
    expect(callHandler(fn, 5)).toBe("done");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(gasFakes.sleepCalls.length).toBe(2);
  });

  it("rethrows non-rate-limit errors immediately", () => {
    const fn = vi.fn(() => {
      throw new Error("schema mismatch");
    });
    expect(() => callHandler(fn, 5)).toThrow("schema mismatch");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("wraps exhausted retries in GQueryApiError", () => {
    const fn = vi.fn(() => {
      throw new Error("Rate Limit Exceeded");
    });
    expect(() => callHandler(fn, 2, { operation: "test-op" })).toThrow(
      GQueryApiError,
    );
  });

  it("retries UrlFetchApp 5xx responses", () => {
    let calls = 0;
    const fn = vi.fn(() => {
      calls++;
      return {
        getResponseCode: () => (calls < 2 ? 503 : 200),
        getContentText: () => (calls < 2 ? "transient" : "ok"),
      };
    });
    const res = callHandler(fn, 5, { urlFetch: true });
    expect(res.getResponseCode()).toBe(200);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("converts UrlFetchApp 4xx (non-429) into GQueryApiError without retry", () => {
    const fn = vi.fn(() => ({
      getResponseCode: () => 401,
      getContentText: () => "unauthorized",
    }));
    expect(() => callHandler(fn, 5, { urlFetch: true })).toThrow(
      GQueryApiError,
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
