import type { GQuery } from "./index";
import { sheetRange } from "./a1";
import { convertRowTypes, parseRows } from "./utils";
import type { GQueryReadOptions, GQueryResult } from "./types";

function columnLetter(index: number): string {
  let result = "";
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) {
    result = String.fromCharCode(65 + (value - 1) % 26) + result;
  }
  return result;
}

/** Explicit projection, including dependencies needed by caller-side filters/joins. */
export function getManyProjectedInternal(
  client: GQuery, selections: Record<string, readonly string[]>, options: GQueryReadOptions = {},
): Record<string, GQueryResult> {
  const sheets = Object.keys(selections);
  if (sheets.length === 0) return {};
  const render = { valueRenderOption: options.valueRenderOption ?? "FORMATTED_VALUE" as const,
    dateTimeRenderOption: options.dateTimeRenderOption ?? "FORMATTED_STRING" as const };
  const headers = client.batchGetValues(sheets.map((sheet) => sheetRange(sheet, "1:1")), render);
  const plans = sheets.map((sheet, index) => {
    const available = (headers[index].values[0] ?? []).map(String);
    const selected = [...new Set(selections[sheet])];
    const indexes = selected.map((column) => {
      const matches = available.flatMap((header, position) => header === column ? [position] : []);
      if (matches.length !== 1) throw new Error(`Projected column must exist exactly once: ${sheet}.${column}`);
      return matches[0];
    });
    return { sheet, selected, indexes };
  });
  const ranges = plans.flatMap((plan) => plan.indexes.map((index) => {
    const letter = columnLetter(index);
    return sheetRange(plan.sheet, `${letter}2:${letter}`);
  }));
  const values = client.batchGetValues(ranges, render);
  let cursor = 0;
  return Object.fromEntries(plans.map(({ sheet, selected, indexes }) => {
    const columns = indexes.map(() => values[cursor++].values);
    const count = Math.max(0, ...columns.map((column) => column.length));
    const matrix = Array.from({ length: count }, (_, row) => columns.map((column) => column[row]?.[0] ?? ""));
    return [sheet, { headers: selected,
      rows: parseRows(selected, matrix).map((row) => convertRowTypes(row, selected)) }];
  }));
}
