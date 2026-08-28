import { describe, expect, it } from "vitest";
import { nullable, optional, text, withDefault } from "./codecs";
import { createGQuery } from "./database";
import { defineDatabase, source, table } from "./schema";
import { InMemorySheetsTransport } from "./transport";

describe("physical blank-cell decoding", () => {
  it("normalizes Values API empty strings before applying declared blank policies", () => {
    const emptyTextColumn = text({ header: "Empty Text" });
    const encodedEmptyText = emptyTextColumn.encode("");
    expect(encodedEmptyText).not.toBe("");
    const definition = defineDatabase({
      version: 2,
      sources: { main: source.byId("book") },
      tables: {
        Rows: table({
          source: "main",
          sheet: "Rows",
          primaryKey: ["id"],
          columns: {
            id: text({ header: "ID" }),
            nullableValue: nullable(text({ header: "Nullable" })),
            optionalValue: optional(text({ header: "Optional" })),
            defaultedValue: withDefault(text({ header: "Defaulted" }), "fallback"),
            emptyText: emptyTextColumn,
          },
        }),
      },
    });
    const transport = new InMemorySheetsTransport([{
      spreadsheetId: "book",
      sheets: [{
        sheetId: 1,
        title: "Rows",
        values: [
          ["ID", "Nullable", "Optional", "Defaulted", "Empty Text"],
          ["one", "", "", "", encodedEmptyText as string],
        ],
      }],
    }]);
    const gq = createGQuery(definition, { transport });

    // Advanced Values normalizes physical blanks to empty strings in returned
    // row matrices. Canonical empty text uses a tagged, non-blank cell.
    expect(gq.Rows.find("one").rows[0]).toEqual({
      id: "one",
      nullableValue: null,
      optionalValue: undefined,
      defaultedValue: "fallback",
      emptyText: "",
    });
  });
});
