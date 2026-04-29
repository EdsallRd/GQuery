import { describe, expect, it } from "vitest";
import {
  buildA1Range,
  columnLetter,
  decodeCellValue,
  encodeCellValue,
  normalizeForSchema,
  parseRows,
} from "../src/utils";

describe("decodeCellValue", () => {
  it("returns booleans for 'true'/'false' (mixed case)", () => {
    expect(decodeCellValue("true")).toBe(true);
    expect(decodeCellValue("TRUE")).toBe(true);
    expect(decodeCellValue("false")).toBe(false);
    expect(decodeCellValue("FALSE")).toBe(false);
  });

  it("parses MM/DD/YYYY dates with optional time", () => {
    const d = decodeCellValue("4/29/2026");
    expect(d).toBeInstanceOf(Date);
    const dt = decodeCellValue("4/29/2026 13:45");
    expect(dt).toBeInstanceOf(Date);
  });

  it("parses JSON object/array literals", () => {
    expect(decodeCellValue('{"a":1}')).toEqual({ a: 1 });
    expect(decodeCellValue("[1,2,3]")).toEqual([1, 2, 3]);
  });

  it("leaves plain strings, numbers, and empties alone", () => {
    expect(decodeCellValue("hello")).toBe("hello");
    expect(decodeCellValue(42)).toBe(42);
    expect(decodeCellValue("")).toBe("");
    expect(decodeCellValue(null)).toBe(null);
    expect(decodeCellValue(undefined)).toBe(undefined);
  });

  it("falls through gracefully on JSON-like strings that don't parse", () => {
    expect(decodeCellValue("{not json}")).toBe("{not json}");
  });
});

describe("encodeCellValue", () => {
  it("stringifies plain objects and arrays", () => {
    expect(encodeCellValue({ a: 1 })).toBe('{"a":1}');
    expect(encodeCellValue([1, 2])).toBe("[1,2]");
  });

  it("converts dates to locale strings", () => {
    const date = new Date("2026-04-29T00:00:00Z");
    expect(encodeCellValue(date)).toBe(date.toLocaleString());
  });

  it("passes primitives through unchanged", () => {
    expect(encodeCellValue("hello")).toBe("hello");
    expect(encodeCellValue(42)).toBe(42);
    expect(encodeCellValue(true)).toBe(true);
    expect(encodeCellValue(null)).toBe(null);
  });
});

describe("normalizeForSchema", () => {
  it("converts empty strings to undefined", () => {
    expect(normalizeForSchema({ a: "", b: "x", c: 0 })).toEqual({
      a: undefined,
      b: "x",
      c: 0,
    });
  });
});

describe("parseRows (single-pass)", () => {
  it("decodes booleans, dates, and JSON in one walk", () => {
    const rows = parseRows(
      ["Name", "Active", "When", "Tags"],
      [
        ["Ada", "true", "4/29/2026", '["a","b"]'],
        ["Lin", "false", "1/1/2020 09:00", '{"k":1}'],
      ],
    );
    expect(rows[0].Name).toBe("Ada");
    expect(rows[0].Active).toBe(true);
    expect(rows[0].When).toBeInstanceOf(Date);
    expect(rows[0].Tags).toEqual(["a", "b"]);
    expect(rows[1].Active).toBe(false);
    expect(rows[1].Tags).toEqual({ k: 1 });
  });

  it("preserves empty strings as empties (not the literal undefined)", () => {
    const rows = parseRows(["X", "Y"], [["", "v"]]);
    expect(rows[0].X).toBe("");
    expect(rows[0].Y).toBe("v");
  });

  it("attaches __meta with 1-based rowNum starting at row 2", () => {
    const rows = parseRows(["A"], [["x"], ["y"], ["z"]]);
    expect(rows[0].__meta.rowNum).toBe(2);
    expect(rows[2].__meta.rowNum).toBe(4);
    expect(rows[0].__meta.colLength).toBe(1);
  });
});

describe("columnLetter", () => {
  it("handles A-Z and ZZ-style multi-letter columns", () => {
    expect(columnLetter(0)).toBe("A");
    expect(columnLetter(25)).toBe("Z");
    expect(columnLetter(26)).toBe("AA");
    expect(columnLetter(701)).toBe("ZZ");
  });
});

describe("buildA1Range", () => {
  it("returns the bare sheet name when no offset/limit is set", () => {
    expect(buildA1Range("Sheet1")).toBe("Sheet1");
  });

  it("emits an A1 row range for offset+limit without lastColumn", () => {
    expect(buildA1Range("Sheet1", { offset: 10, limit: 20 })).toBe(
      "Sheet1!11:31",
    );
  });

  it("includes the last column letter when provided", () => {
    expect(
      buildA1Range("Sheet1", { offset: 0, limit: 10, lastColumn: 3 }),
    ).toBe("Sheet1!A1:C11");
  });

  it("produces a header-only range when limit is 0", () => {
    expect(buildA1Range("Sheet1", { offset: 0, limit: 0 })).toBe("Sheet1!1:1");
  });
});
