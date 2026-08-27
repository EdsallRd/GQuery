import type {
  AtomicCellUpdate,
  AtomicRowDelete,
  SheetCellInput,
} from "./contracts";
import { assertSheetCellInput } from "./raw-values";

/** One zero-based physical cell change prior to request compaction. */
export interface CellPatch {
  sheetId: number;
  rowIndex: number;
  columnIndex: number;
  value: SheetCellInput;
}

export interface RowPatch {
  sheetId: number;
  rowIndex: number;
}

interface HorizontalRun {
  sheetId: number;
  rowIndex: number;
  startColumnIndex: number;
  values: SheetCellInput[];
}

function assertIndex(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
}

/**
 * Compact adjacent cell patches into maximal rectangles without filling gaps.
 * Duplicate physical cells are rejected so planner mistakes cannot silently
 * overwrite an earlier change.
 */
export function compactCellUpdates(
  patches: readonly CellPatch[],
): AtomicCellUpdate[] {
  const sorted = patches.map((patch) => {
    assertIndex("sheetId", patch.sheetId);
    assertIndex("rowIndex", patch.rowIndex);
    assertIndex("columnIndex", patch.columnIndex);
    assertSheetCellInput(patch.value, "patch.value");
    return patch;
  }).sort(
    (left, right) =>
      left.sheetId - right.sheetId ||
      left.rowIndex - right.rowIndex ||
      left.columnIndex - right.columnIndex,
  );

  const runs: HorizontalRun[] = [];
  for (const patch of sorted) {
    const previous = runs[runs.length - 1];
    if (
      previous &&
      previous.sheetId === patch.sheetId &&
      previous.rowIndex === patch.rowIndex
    ) {
      const expectedColumn = previous.startColumnIndex + previous.values.length;
      if (patch.columnIndex < expectedColumn) {
        throw new Error(
          `Duplicate cell patch at sheet ${patch.sheetId}, row ${patch.rowIndex}, column ${patch.columnIndex}.`,
        );
      }
      if (patch.columnIndex === expectedColumn) {
        previous.values.push(patch.value);
        continue;
      }
    }
    runs.push({
      sheetId: patch.sheetId,
      rowIndex: patch.rowIndex,
      startColumnIndex: patch.columnIndex,
      values: [patch.value],
    });
  }

  const result: AtomicCellUpdate[] = [];
  for (const run of runs) {
    const previous = result[result.length - 1];
    const previousWidth = previous?.values[0]?.length ?? 0;
    if (
      previous &&
      previous.sheetId === run.sheetId &&
      previous.startColumnIndex === run.startColumnIndex &&
      previousWidth === run.values.length &&
      previous.startRowIndex + previous.values.length === run.rowIndex
    ) {
      previous.values = [...previous.values, [...run.values]];
      continue;
    }
    result.push({
      kind: "updateCells",
      sheetId: run.sheetId,
      startRowIndex: run.rowIndex,
      startColumnIndex: run.startColumnIndex,
      values: [[...run.values]],
    });
  }
  return result;
}

/** Group row indices and order every sheet's delete ranges from bottom to top. */
export function compactRowDeletes(
  rows: readonly RowPatch[],
): AtomicRowDelete[] {
  const bySheet = new Map<number, Set<number>>();
  for (const row of rows) {
    assertIndex("sheetId", row.sheetId);
    assertIndex("rowIndex", row.rowIndex);
    const indices = bySheet.get(row.sheetId) ?? new Set<number>();
    indices.add(row.rowIndex);
    bySheet.set(row.sheetId, indices);
  }

  const result: AtomicRowDelete[] = [];
  for (const sheetId of [...bySheet.keys()].sort((a, b) => a - b)) {
    const indices = [...(bySheet.get(sheetId) ?? [])].sort((a, b) => a - b);
    const ranges: AtomicRowDelete[] = [];
    let start = indices[0];
    let previous = indices[0];
    for (let index = 1; index < indices.length; index += 1) {
      const current = indices[index];
      if (current === previous + 1) {
        previous = current;
        continue;
      }
      ranges.push({
        kind: "deleteRows",
        sheetId,
        startRowIndex: start,
        endRowIndex: previous + 1,
      });
      start = current;
      previous = current;
    }
    if (start !== undefined && previous !== undefined) {
      ranges.push({
        kind: "deleteRows",
        sheetId,
        startRowIndex: start,
        endRowIndex: previous + 1,
      });
    }
    ranges.sort((left, right) => right.startRowIndex - left.startRowIndex);
    result.push(...ranges);
  }
  return result;
}
