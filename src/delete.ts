import { GQueryTableFactory } from "./index";
import { callHandler } from "./ratelimit";
import { GQueryApiError } from "./types";
import { fetchSheetData } from "./utils";

export function deleteInternal(GQueryTableFactory: GQueryTableFactory<any>): {
  deletedRows: number;
} {
  const spreadsheetId = GQueryTableFactory.GQueryTable.spreadsheetId;
  const sheetName = GQueryTableFactory.GQueryTable.sheetName;
  const sheet = GQueryTableFactory.GQueryTable.sheet;
  const sheetId = sheet.getSheetId();
  const cache = GQueryTableFactory.GQueryTable.GQuery.cache;

  const { rows } = fetchSheetData(spreadsheetId, sheetName, cache);

  if (!GQueryTableFactory.filterOption || rows.length === 0) {
    return { deletedRows: 0 };
  }

  const rowsToDelete = rows.filter((row) => {
    try {
      return GQueryTableFactory.filterOption!(row);
    } catch (error) {
      console.error("Error filtering row:", error);
      return false;
    }
  });

  if (rowsToDelete.length === 0) {
    return { deletedRows: 0 };
  }

  // Sort in descending order to avoid row number shifting issues
  rowsToDelete.sort((a, b) => b.__meta.rowNum - a.__meta.rowNum);

  const batchUpdateRequest = {
    requests: rowsToDelete.map((row) => ({
      deleteDimension: {
        range: {
          sheetId,
          dimension: "ROWS",
          startIndex: row.__meta.rowNum - 1,
          endIndex: row.__meta.rowNum,
        },
      },
    })),
  };

  try {
    callHandler(
      () => Sheets!.Spreadsheets!.batchUpdate(batchUpdateRequest, spreadsheetId),
      20,
      { operation: `Spreadsheets.batchUpdate(delete:${sheetName})` },
    );
  } catch (error) {
    if (error instanceof GQueryApiError) throw error;
    throw new GQueryApiError(
      `Spreadsheets.batchUpdate(delete:${sheetName})`,
      null,
      `Failed to delete ${rowsToDelete.length} row(s) from "${sheetName}".`,
      error,
    );
  }

  cache?.invalidate(sheetName);

  return { deletedRows: rowsToDelete.length };
}
