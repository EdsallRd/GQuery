import { GQueryTableFactory } from "./index";
import { callHandler } from "./ratelimit";
import { fetchSheetData } from "./utils";

export function deleteInternal(GQueryTableFactory: GQueryTableFactory<any>): {
  deletedRows: number;
} {
  const spreadsheetId = GQueryTableFactory.GQueryTable.spreadsheetId;
  const sheetName = GQueryTableFactory.GQueryTable.sheetName;
  const sheet = GQueryTableFactory.GQueryTable.sheet;
  const sheetId = sheet.getSheetId();

  const { rows } = fetchSheetData(spreadsheetId, sheetName);

  // Check if filter is specified and rows exist
  if (!GQueryTableFactory.filterOption || rows.length === 0) {
    return { deletedRows: 0 };
  }

  // Find rows matching the filter condition
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

  // Build batch delete request
  const batchUpdateRequest = {
    requests: rowsToDelete.map((row) => ({
      deleteDimension: {
        range: {
          sheetId,
          dimension: "ROWS",
          startIndex: row.__meta.rowNum - 1, // Convert to 0-based index
          endIndex: row.__meta.rowNum, // End-exclusive range
        },
      },
    })),
  };

  // Execute batch delete
  try {
    callHandler(() =>
      Sheets!.Spreadsheets!.batchUpdate(batchUpdateRequest, spreadsheetId),
    );
    return { deletedRows: rowsToDelete.length };
  } catch (error) {
    console.error("Error deleting rows:", error);
    throw new Error(`Failed to delete rows: ${error}`);
  }
}
