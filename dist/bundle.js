/**
 * Exponential backoff handler for Google Sheets API calls
 * Handles rate limiting (429) and quota exceeded errors
 * @param fn Function to execute with retry logic
 * @param retries Maximum number of retry attempts (default: 20)
 * @returns Result of the function execution
 */
function callHandler(fn, retries = 20) {
    let attempt = 0;
    while (attempt < retries) {
        try {
            return fn();
        }
        catch (error) {
            const errorMessage = (error === null || error === void 0 ? void 0 : error.message) || String(error);
            // Check if it's a rate limit or quota error
            const isRateLimitError = errorMessage.includes("429") ||
                errorMessage.includes("Quota exceeded") ||
                errorMessage.includes("Rate Limit Exceeded");
            if (isRateLimitError) {
                attempt++;
                if (attempt >= retries) {
                    throw new Error(`Max retries (${retries}) reached for Google Sheets API call. Last error: ${errorMessage}`);
                }
                // Exponential backoff with jitter, capped at 64 seconds
                const backoffDelay = Math.min(Math.pow(2, attempt) * 1000 + Math.random() * 1000, 64000);
                console.log(`Rate limit hit, retrying in ${Math.round(backoffDelay)}ms (attempt ${attempt}/${retries})`);
                Utilities.sleep(backoffDelay);
            }
            else {
                // Not a rate limit error, rethrow immediately
                throw error;
            }
        }
    }
    throw new Error("Unexpected state: Max retries reached without throwing error");
}

/**
 * How values should be rendered in the output
 * @see https://developers.google.com/sheets/api/reference/rest/v4/ValueRenderOption
 */
var ValueRenderOption;
(function (ValueRenderOption) {
    /** Values will be calculated and formatted according to cell formatting */
    ValueRenderOption["FORMATTED_VALUE"] = "FORMATTED_VALUE";
    /** Values will be calculated but not formatted */
    ValueRenderOption["UNFORMATTED_VALUE"] = "UNFORMATTED_VALUE";
    /** Values will not be calculated; formulas will be returned as-is */
    ValueRenderOption["FORMULA"] = "FORMULA";
})(ValueRenderOption || (ValueRenderOption = {}));
/**
 * How dates and times should be rendered in the output
 * @see https://developers.google.com/sheets/api/reference/rest/v4/DateTimeRenderOption
 */
var DateTimeRenderOption;
(function (DateTimeRenderOption) {
    /** Dates and times will be rendered as strings according to cell formatting */
    DateTimeRenderOption["FORMATTED_STRING"] = "FORMATTED_STRING";
    /** Dates and times will be rendered as serial numbers */
    DateTimeRenderOption["SERIAL_NUMBER"] = "SERIAL_NUMBER";
})(DateTimeRenderOption || (DateTimeRenderOption = {}));
/**
 * Thrown when a row fails schema validation.
 */
class GQuerySchemaError extends Error {
    constructor(issues, row) {
        super(`GQuery schema validation failed:\n${issues
            .map((i) => {
            var _a;
            const pathStr = ((_a = i.path) === null || _a === void 0 ? void 0 : _a.length)
                ? i.path.map((p) => (typeof p === "object" ? p.key : p)).join(".")
                : "(root)";
            return `  [${pathStr}] ${i.message}`;
        })
            .join("\n")}\nRow data: ${JSON.stringify(row)}`);
        this.issues = issues;
        this.row = row;
        this.name = "GQuerySchemaError";
    }
}

/**
 * Try to parse a string as a JSON object or array. Returns the original
 * value if it is not valid JSON or not an object/array literal.
 */
function tryParseJson(value) {
    const trimmed = value.trim();
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) ||
        (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
        try {
            return JSON.parse(trimmed);
        }
        catch {
            // not valid JSON – fall through
        }
    }
    return value;
}
/**
 * Encode a value for writing to a sheet cell.
 * - Dates are converted to locale strings.
 * - Plain objects/arrays are JSON-stringified.
 * - All other values are returned as-is.
 */
function encodeCellValue(value) {
    if (value instanceof Date) {
        return value.toLocaleString();
    }
    if (value !== null && typeof value === "object") {
        return JSON.stringify(value);
    }
    return value;
}
/**
 * Normalize a data object for schema validation:
 * empty strings are treated as undefined (equivalent to a blank cell).
 */
function normalizeForSchema(data) {
    const normalized = {};
    for (const key of Object.keys(data)) {
        normalized[key] = data[key] === "" ? undefined : data[key];
    }
    return normalized;
}
/**
 * Parse raw sheet values into GQueryRow objects with metadata
 * @param headers Column headers from the sheet
 * @param values Raw values from the sheet (without header row)
 * @returns Array of GQueryRow objects
 */
function parseRows(headers, values) {
    return values.map((row, rowIndex) => {
        const obj = {
            __meta: {
                rowNum: rowIndex + 2, // +2 because header is row 1, data starts at row 2
                colLength: headers.length,
            },
        };
        headers.forEach((header, i) => {
            const raw = row[i] !== undefined ? row[i] : "";
            obj[header] = typeof raw === "string" ? tryParseJson(raw) : raw;
        });
        return obj;
    });
}
/**
 * Fetch all data from a sheet including headers
 * @param spreadsheetId The ID of the spreadsheet
 * @param sheetName The name of the sheet to fetch
 * @returns Object containing headers and rows
 */
function fetchSheetData(spreadsheetId, sheetName) {
    const response = callHandler(() => Sheets.Spreadsheets.Values.get(spreadsheetId, sheetName));
    const values = response.values || [];
    if (values.length === 0) {
        return { headers: [], rows: [] };
    }
    const headers = values[0].map((h) => String(h));
    const rows = parseRows(headers, values.slice(1));
    return { headers, rows };
}

/**
 * Apply offset and limit to a row array. Returns a new array (or the original if both are absent).
 */
function paginateRows(rows, offset, limit) {
    if (typeof offset === "number" && offset > 0) {
        rows = rows.slice(offset);
    }
    if (typeof limit === "number" && limit >= 0) {
        rows = rows.slice(0, limit);
    }
    return rows;
}
/**
 * Sort rows by a single field. Returns the input array unchanged if no orderBy is provided.
 * The comparator uses `<`/`>` so it works for both numbers and lexically-comparable strings.
 */
function sortRows(rows, orderBy) {
    if (!orderBy)
        return rows;
    return [...rows].sort((a, b) => {
        const av = a[orderBy.field];
        const bv = b[orderBy.field];
        const cmp = av < bv ? -1 : av > bv ? 1 : 0;
        return orderBy.direction === "desc" ? -cmp : cmp;
    });
}
/**
 * Validate a single row through a Standard Schema.
 * Throws GQuerySchemaError if validation fails.
 * Throws a plain Error if the schema returns a Promise (async schemas are not
 * supported in Google Apps Script).
 */
function applySchema$2(schema, row) {
    const result = schema["~standard"].validate(row);
    if (result instanceof Promise) {
        throw new Error("GQuery does not support async schema validation. " +
            "Google Apps Script is a synchronous runtime. " +
            "Use a schema library that validates synchronously (e.g. Zod, Valibot).");
    }
    if (result.issues) {
        throw new GQuerySchemaError(result.issues, row);
    }
    return result.value;
}
/**
 * Apply a schema to an array of raw rows, returning typed rows with __meta preserved.
 */
function applySchemaToRows(schema, rows) {
    return rows.map((row) => {
        const { __meta, ...data } = row;
        const validated = applySchema$2(schema, normalizeForSchema(data));
        return { ...validated, __meta };
    });
}
/**
 * Convert row values to appropriate types (boolean, date, number)
 * Optimized to reduce redundant type checking
 */
function convertRowTypes(row, headers) {
    const newRow = { __meta: row.__meta };
    headers.forEach((header) => {
        let value = row[header];
        // Skip empty values
        if (value === undefined || value === null || value === "") {
            newRow[header] = value;
            return;
        }
        // Only process string values for type conversion
        if (typeof value === "string") {
            const lowerValue = value.toLowerCase();
            // Check for boolean
            if (lowerValue === "true" || lowerValue === "false") {
                newRow[header] = lowerValue === "true";
                return;
            }
            // Check for date pattern (MM/DD/YYYY or MM/DD/YYYY HH:MM:SS)
            if (/^\d{1,2}\/\d{1,2}\/\d{4}(\s\d{1,2}:\d{1,2}(:\d{1,2})?)?$/.test(value)) {
                const dateValue = new Date(value);
                if (!isNaN(dateValue.getTime())) {
                    newRow[header] = dateValue;
                    return;
                }
            }
            // Try to parse JSON objects/arrays
            const trimmed = value.trim();
            if ((trimmed.startsWith("{") && trimmed.endsWith("}")) ||
                (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
                try {
                    newRow[header] = JSON.parse(trimmed);
                    return;
                }
                catch {
                    // not valid JSON
                }
            }
        }
        // Keep original value if no conversion applied
        newRow[header] = value;
    });
    return newRow;
}
function getManyInternal(GQuery, sheetNames, options) {
    if (!sheetNames || sheetNames.length === 0) {
        return {};
    }
    const valueRenderOption = (options === null || options === void 0 ? void 0 : options.valueRenderOption) || ValueRenderOption.FORMATTED_VALUE;
    const dateTimeRenderOption = (options === null || options === void 0 ? void 0 : options.dateTimeRenderOption) || DateTimeRenderOption.FORMATTED_STRING;
    const result = {};
    // Fetch data using batchGet for better performance
    const dataResponse = callHandler(() => Sheets.Spreadsheets.Values.batchGet(GQuery.spreadsheetId, {
        ranges: sheetNames,
        valueRenderOption,
        dateTimeRenderOption,
    }));
    if (!dataResponse || !dataResponse.valueRanges) {
        sheetNames.forEach((sheet) => {
            result[sheet] = { headers: [], rows: [] };
        });
        return result;
    }
    dataResponse.valueRanges.forEach((valueRange, index) => {
        const sheetName = sheetNames[index];
        if (!valueRange.values || valueRange.values.length === 0) {
            result[sheetName] = { headers: [], rows: [] };
            return;
        }
        const headers = valueRange.values[0].map((h) => String(h));
        let rows = parseRows(headers, valueRange.values.slice(1));
        // Apply type conversion to rows
        rows = rows.map((row) => convertRowTypes(row, headers));
        result[sheetName] = { headers, rows };
    });
    return result;
}
function getInternal(GQueryTableFactory, options, orderBy, limit, offset) {
    const GQueryTable = GQueryTableFactory.GQueryTable;
    const GQuery = GQueryTable.GQuery;
    // Determine which sheets we need to read from
    const sheetsToRead = [GQueryTable.sheetName];
    // Add all join sheets
    if (GQueryTableFactory.joinOption.length > 0) {
        GQueryTableFactory.joinOption.forEach((join) => {
            if (!sheetsToRead.includes(join.sheetName)) {
                sheetsToRead.push(join.sheetName);
            }
        });
    }
    // Read data from all required sheets at once
    const results = GQuery.getMany(sheetsToRead, options);
    // If the main sheet doesn't exist or has no data
    if (!results[GQueryTable.sheetName] ||
        results[GQueryTable.sheetName].rows.length === 0) {
        return { headers: [], rows: [] };
    }
    // Get data for the primary table
    let result = results[GQueryTable.sheetName];
    let rows = result.rows;
    let headers = result.headers;
    // Process each join sequentially
    if (GQueryTableFactory.joinOption.length > 0) {
        GQueryTableFactory.joinOption.forEach((joinConfig) => {
            const { sheetName, sheetColumn, joinColumn, columnsToReturn } = joinConfig;
            const joinData = results[sheetName];
            if (!joinData || !joinData.rows || joinData.rows.length === 0) {
                return; // Skip this join
            }
            // Create join lookup table
            const joinMap = {};
            // Check if the join column exists in the join table
            const joinHeaders = joinData.headers;
            if (!joinHeaders.includes(sheetColumn)) {
                return; // Skip this join
            }
            joinData.rows.forEach((joinRow) => {
                const joinKey = String(joinRow[sheetColumn]);
                if (!joinMap[joinKey]) {
                    joinMap[joinKey] = [];
                }
                joinMap[joinKey].push(joinRow);
            });
            // Perform the join operation
            rows = rows.map((row) => {
                const localJoinValue = row[joinColumn];
                const joinedRows = joinMap[String(localJoinValue)] || [];
                // Create joined row with all join table fields
                const joinedRow = { ...row };
                joinedRows.forEach((joinRow, index) => {
                    // Determine which columns to include from join
                    const columnsToInclude = columnsToReturn ||
                        Object.keys(joinRow).filter((key) => key !== "__meta" && key !== sheetColumn);
                    columnsToInclude.forEach((key) => {
                        if (joinRow.hasOwnProperty(key) && key !== "__meta") {
                            // For multiple joined rows, add suffix _1, _2, etc.
                            const suffix = joinedRows.length > 1 ? `_${index + 1}` : "";
                            const targetKey = key === sheetColumn ? key : `${key}${suffix}`;
                            joinedRow[targetKey] = joinRow[key];
                        }
                    });
                });
                return joinedRow;
            });
        });
    }
    // Apply filter if specified
    if (GQueryTableFactory.filterOption) {
        rows = rows.filter(GQueryTableFactory.filterOption);
    }
    // Apply select if specified — narrows columns and shifts the effective `headers`
    // we return. Sort/paginate/validate run once below regardless of branch.
    let outputHeaders = headers;
    if (GQueryTableFactory.selectOption &&
        GQueryTableFactory.selectOption.length > 0) {
        // Create a map to track columns from joined tables
        const joinedColumns = new Set();
        // Collect all columns from joined tables
        rows.forEach((row) => {
            Object.keys(row).forEach((key) => {
                // If the column is not in the original headers, it's from a join
                if (!headers.includes(key) && key !== "__meta") {
                    joinedColumns.add(key);
                }
            });
        });
        // If we have a select option, determine which columns to keep
        let selectedHeaders;
        // Check if any of the selected headers is "Model" or "Model_Name"
        // If we're selecting the join columns, we want to include all related joined fields
        if (GQueryTableFactory.selectOption.some((header) => header === "Model" ||
            header === "Model_Name" ||
            GQueryTableFactory.joinOption.some((j) => j.joinColumn === header || j.sheetColumn === header))) {
            // Include all join-related columns and the selected columns
            selectedHeaders = [...GQueryTableFactory.selectOption];
            joinedColumns.forEach((joinCol) => {
                selectedHeaders.push(joinCol);
            });
        }
        else {
            // Otherwise only include explicitly selected columns
            selectedHeaders = [...GQueryTableFactory.selectOption];
        }
        // Remove duplicates
        selectedHeaders = [...new Set(selectedHeaders)];
        // Filter rows to only include selected columns
        rows = rows.map((row) => {
            const selectedRow = {
                __meta: row.__meta,
            };
            selectedHeaders.forEach((header) => {
                if (row.hasOwnProperty(header)) {
                    selectedRow[header] = row[header];
                }
            });
            return selectedRow;
        });
        outputHeaders = selectedHeaders;
    }
    // Apply sort then pagination if specified — single call site for both branches
    rows = sortRows(rows, orderBy);
    rows = paginateRows(rows, offset, limit);
    // Apply schema validation if requested
    const typedRows = GQueryTable.schema && (options === null || options === void 0 ? void 0 : options.validate)
        ? applySchemaToRows(GQueryTable.schema, rows)
        : rows;
    return {
        headers: outputHeaders,
        rows: typedRows,
    };
}
function queryInternal(GQueryTable, query) {
    var _a;
    const sheet = GQueryTable.sheet;
    const range = sheet.getDataRange();
    // Build column name to letter mapping
    let replaced = query;
    const lastColumn = range.getLastColumn();
    for (let i = 0; i < lastColumn; i++) {
        const rng = sheet.getRange(1, i + 1);
        const name = rng.getValue();
        const letter = (_a = rng.getA1Notation().match(/([A-Z]+)/)) === null || _a === void 0 ? void 0 : _a[0];
        if (letter && name) {
            replaced = replaced.replaceAll(name, letter);
        }
    }
    // Build query URL
    const url = Utilities.formatString("https://docs.google.com/spreadsheets/d/%s/gviz/tq?tq=%s&sheet=%s%s&headers=1", sheet.getParent().getId(), encodeURIComponent(replaced), sheet.getName(), typeof range === "string" ? "&range=" + range : "");
    // Fetch with authorization
    const response = UrlFetchApp.fetch(url, {
        headers: {
            Authorization: "Bearer " + ScriptApp.getOAuthToken(),
        },
    });
    // Parse response
    const jsonResponse = JSON.parse(response
        .getContentText()
        .replace("/*O_o*/\n", "")
        .replace(/(google\.visualization\.Query\.setResponse\()|(\);)/gm, ""));
    const table = jsonResponse.table;
    // Extract column headers
    const headers = table.cols.map((col) => col.label);
    // Map rows to proper GQueryRow format
    const rows = table.rows.map((row) => {
        const rowObj = {
            __meta: {
                rowNum: -1, // Query results don't have reliable row numbers
                colLength: row.c.length,
            },
        };
        // Populate row data
        table.cols.forEach((col, colIndex) => {
            const cellData = row.c[colIndex];
            let value = "";
            if (cellData) {
                // Use formatted value if available, otherwise use raw value
                value =
                    cellData.f !== null && cellData.f !== undefined
                        ? cellData.f
                        : cellData.v;
                // Convert date strings if needed
                if (typeof value === "string" &&
                    /^\d{1,2}\/\d{1,2}\/\d{4}(\s\d{1,2}:\d{1,2}(:\d{1,2})?)?$/.test(value)) {
                    const dateValue = new Date(value);
                    if (!isNaN(dateValue.getTime())) {
                        value = dateValue;
                    }
                }
            }
            rowObj[col.label] = value;
        });
        return rowObj;
    });
    return {
        headers,
        rows,
    };
}

/**
 * Validate a single row through a Standard Schema, preserving __meta.
 * Throws GQuerySchemaError if validation fails.
 */
function applySchema$1(schema, row) {
    const { __meta, ...data } = row;
    const result = schema["~standard"].validate(normalizeForSchema(data));
    if (result instanceof Promise) {
        throw new Error("GQuery does not support async schema validation. " +
            "Google Apps Script is a synchronous runtime.");
    }
    if (result.issues) {
        throw new GQuerySchemaError(result.issues, data);
    }
    return { ...result.value, __meta };
}
function updateInternal(GQueryTableFactory, updateFn) {
    const spreadsheetId = GQueryTableFactory.GQueryTable.spreadsheetId;
    const sheetName = GQueryTableFactory.GQueryTable.sheetName;
    const schema = GQueryTableFactory.GQueryTable.schema;
    const range = sheetName;
    const { headers, rows } = fetchSheetData(spreadsheetId, range);
    if (headers.length === 0) {
        return { rows: [], headers: [] };
    }
    // Filter rows if filter is specified
    const filteredRows = GQueryTableFactory.filterOption
        ? rows.filter((row) => {
            try {
                return GQueryTableFactory.filterOption(row);
            }
            catch (error) {
                console.error("Error filtering row:", error);
                return false;
            }
        })
        : rows;
    // Apply updates to filtered rows
    const updatedRows = filteredRows.map((row) => {
        const updatedRow = { ...row };
        try {
            const result = updateFn(updatedRow);
            if (result && typeof result === "object") {
                Object.assign(updatedRow, result);
            }
        }
        catch (error) {
            console.error("Error updating row:", error);
        }
        return updatedRow;
    });
    // Collect changed cells
    const changedCells = new Map();
    updatedRows.forEach((updatedRow) => {
        const rowIndex = updatedRow.__meta.rowNum - 2;
        const originalRow = rows[rowIndex];
        headers.forEach((header, columnIndex) => {
            const originalValue = encodeCellValue(originalRow[header]);
            let updatedValue = encodeCellValue(updatedRow[header]);
            // Skip if values are the same
            if (originalValue === updatedValue)
                return;
            // Only update if value changed or is being set/cleared
            if (updatedValue !== undefined && updatedValue !== null) {
                const columnLetter = getColumnLetter(columnIndex);
                const cellRange = `${sheetName}!${columnLetter}${updatedRow.__meta.rowNum}`;
                changedCells.set(cellRange, [[updatedValue]]);
            }
            else if (originalValue !== undefined && originalValue !== null) {
                const columnLetter = getColumnLetter(columnIndex);
                const cellRange = `${sheetName}!${columnLetter}${updatedRow.__meta.rowNum}`;
                changedCells.set(cellRange, [[updatedValue || ""]]);
            }
        });
    });
    // Perform batch update if there are changes
    if (changedCells.size > 0) {
        const optimizedUpdates = optimizeRanges(changedCells);
        const batchUpdateRequest = {
            data: optimizedUpdates,
            valueInputOption: "USER_ENTERED",
        };
        callHandler(() => Sheets.Spreadsheets.Values.batchUpdate(batchUpdateRequest, spreadsheetId));
    }
    // Apply schema validation if a schema is attached
    const typedRows = schema
        ? updatedRows.map((row) => applySchema$1(schema, row))
        : updatedRows;
    return {
        rows: filteredRows.length > 0 ? typedRows : [],
        headers,
    };
}
/**
 * Convert column index to column letter (0 -> A, 1 -> B, etc.)
 */
function getColumnLetter(columnIndex) {
    let columnLetter = "";
    let index = columnIndex;
    while (index >= 0) {
        columnLetter = String.fromCharCode(65 + (index % 26)) + columnLetter;
        index = Math.floor(index / 26) - 1;
    }
    return columnLetter;
}
/**
 * Optimize update ranges by combining adjacent cells in the same column
 * into contiguous row segments.
 */
function optimizeRanges(changedCells) {
    const columnGroups = new Map();
    for (const [cellRange, value] of changedCells.entries()) {
        const matches = cellRange.match(/([^!]+)!([A-Z]+)(\d+)$/);
        if (!matches)
            continue;
        const sheet = matches[1];
        const columnLetter = matches[2];
        const rowNumber = parseInt(matches[3], 10);
        const columnKey = `${sheet}!${columnLetter}`;
        if (!columnGroups.has(columnKey)) {
            columnGroups.set(columnKey, new Map());
        }
        columnGroups.get(columnKey).set(rowNumber, value[0][0]);
    }
    const optimizedUpdates = [];
    for (const [columnKey, rowsMap] of columnGroups.entries()) {
        const rowNumbers = Array.from(rowsMap.keys()).sort((a, b) => a - b);
        if (rowNumbers.length === 0)
            continue;
        const [sheet, column] = columnKey.split("!");
        let start = rowNumbers[0];
        let groupValues = [[rowsMap.get(start)]];
        for (let i = 1; i < rowNumbers.length; i++) {
            const rowNum = rowNumbers[i];
            const prev = rowNumbers[i - 1];
            if (rowNum === prev + 1) {
                groupValues.push([rowsMap.get(rowNum)]);
            }
            else {
                const end = prev;
                const rangeKey = start === end
                    ? `${sheet}!${column}${start}`
                    : `${sheet}!${column}${start}:${column}${end}`;
                optimizedUpdates.push({ range: rangeKey, values: groupValues });
                start = rowNum;
                groupValues = [[rowsMap.get(rowNum)]];
            }
        }
        const last = rowNumbers[rowNumbers.length - 1];
        const rangeKey = start === last
            ? `${sheet}!${column}${start}`
            : `${sheet}!${column}${start}:${column}${last}`;
        optimizedUpdates.push({ range: rangeKey, values: groupValues });
    }
    return optimizedUpdates;
}

/**
 * Validate a single value through a Standard Schema.
 * Throws GQuerySchemaError if validation fails.
 */
function applySchema(schema, value) {
    const result = schema["~standard"].validate(value);
    if (result instanceof Promise) {
        throw new Error("GQuery does not support async schema validation. " +
            "Google Apps Script is a synchronous runtime.");
    }
    if (result.issues) {
        throw new GQuerySchemaError(result.issues, value);
    }
    return result.value;
}
function appendInternal(table, data, options) {
    // Validate input data
    if (!data || data.length === 0) {
        return { rows: [], headers: [] };
    }
    const spreadsheetId = table.spreadsheetId;
    const sheetName = table.sheetName;
    const schema = table.schema;
    // Validate each item through the schema before writing, if requested
    const validatedData = schema && (options === null || options === void 0 ? void 0 : options.validate)
        ? data.map((item) => applySchema(schema, normalizeForSchema(item)))
        : data;
    // Fetch headers from the first row
    const response = callHandler(() => Sheets.Spreadsheets.Values.get(spreadsheetId, `${sheetName}!1:1`));
    // Validate sheet exists and has headers
    if (!response || !response.values || response.values.length === 0) {
        throw new Error(`Sheet "${sheetName}" not found or has no headers`);
    }
    const headers = response.values[0].map((header) => String(header));
    // Map data to rows according to header order
    const rowsToAppend = validatedData.map((item) => {
        const record = item;
        return headers.map((header) => {
            const value = record[header];
            return value !== undefined ? encodeCellValue(value) : "";
        });
    });
    // Append data using Sheets API
    const appendResponse = callHandler(() => Sheets.Spreadsheets.Values.append({ values: rowsToAppend }, spreadsheetId, sheetName, {
        valueInputOption: "USER_ENTERED",
        insertDataOption: "OVERWRITE",
        responseValueRenderOption: "FORMATTED_VALUE",
        responseDateTimeRenderOption: "FORMATTED_STRING",
        includeValuesInResponse: true,
    }));
    // Validate append was successful
    if (!appendResponse ||
        !appendResponse.updates ||
        !appendResponse.updates.updatedRange) {
        throw new Error("Failed to append data to sheet");
    }
    // Parse the updated range to get row numbers
    const updatedRange = appendResponse.updates.updatedRange;
    const rangeMatch = updatedRange.match(/([^!]+)!([A-Z]+)(\d+):([A-Z]+)(\d+)/);
    if (!rangeMatch) {
        throw new Error(`Could not parse updated range: ${updatedRange}`);
    }
    const startRow = parseInt(rangeMatch[3], 10);
    const endRow = parseInt(rangeMatch[5], 10);
    // Validate that all rows were appended
    const expectedRowCount = data.length;
    const actualRowCount = endRow - startRow + 1;
    if (actualRowCount !== expectedRowCount) {
        console.warn(`Expected to append ${expectedRowCount} rows but ${actualRowCount} were appended`);
    }
    // Create result rows with metadata, typed to T
    const resultRows = rowsToAppend.map((row, index) => {
        const rowObj = {
            __meta: {
                rowNum: startRow + index,
                colLength: headers.length,
            },
        };
        // Map values back to header names
        headers.forEach((header, colIndex) => {
            rowObj[header] = row[colIndex];
        });
        return rowObj;
    });
    return {
        rows: resultRows,
        headers,
    };
}
/**
 * Append a single row and return it directly (not wrapped in a GQueryResult).
 * @param table The GQueryTable to append to
 * @param row Object to append
 * @param options Optional validation flag
 * @returns The inserted row with __meta populated
 */
function appendOneInternal(table, row, options) {
    const result = appendInternal(table, [row], options);
    if (result.rows.length === 0) {
        throw new Error(`appendOne: append succeeded but returned no rows`);
    }
    return result.rows[0];
}

function deleteInternal(GQueryTableFactory) {
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
            return GQueryTableFactory.filterOption(row);
        }
        catch (error) {
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
        callHandler(() => Sheets.Spreadsheets.batchUpdate(batchUpdateRequest, spreadsheetId));
        return { deletedRows: rowsToDelete.length };
    }
    catch (error) {
        console.error("Error deleting rows:", error);
        throw new Error(`Failed to delete rows: ${error}`);
    }
}

const KEY_INDEX_KEY = "gq:__keys__";
function defaultKey(sheetName) {
    return `gq:${sheetName}:list`;
}
function readThrough(opts, sheetName, producer) {
    var _a, _b;
    const cache = CacheService.getScriptCache();
    const key = (_a = opts === null || opts === void 0 ? void 0 : opts.key) !== null && _a !== void 0 ? _a : defaultKey(sheetName);
    if (!(opts === null || opts === void 0 ? void 0 : opts.bypass)) {
        const hit = cache.get(key);
        if (hit !== null) {
            try {
                return JSON.parse(hit);
            }
            catch { /* fall through to producer */ }
        }
    }
    const value = producer();
    try {
        const serialized = JSON.stringify(value);
        if (serialized.length <= 100000) {
            cache.put(key, serialized, (_b = opts === null || opts === void 0 ? void 0 : opts.ttl) !== null && _b !== void 0 ? _b : 300);
            trackKey(key);
        }
    }
    catch {
        /* serialization failure — return value but don't cache */
    }
    return value;
}
function invalidateSheet(sheetName) {
    const cache = CacheService.getScriptCache();
    // Default key
    cache.remove(defaultKey(sheetName));
    // Any tracked custom keys for this sheet
    const tracked = readKeyIndex();
    const prefix = `gq:${sheetName}:`;
    const toRemove = tracked.filter((k) => k.startsWith(prefix));
    if (toRemove.length > 0) {
        cache.removeAll(toRemove);
        writeKeyIndex(tracked.filter((k) => !toRemove.includes(k)));
    }
}
function trackKey(key) {
    const existing = readKeyIndex();
    if (!existing.includes(key)) {
        writeKeyIndex([...existing, key]);
    }
}
function readKeyIndex() {
    const raw = CacheService.getScriptCache().get(KEY_INDEX_KEY);
    if (!raw)
        return [];
    try {
        return JSON.parse(raw);
    }
    catch {
        return [];
    }
}
function writeKeyIndex(keys) {
    CacheService.getScriptCache().put(KEY_INDEX_KEY, JSON.stringify(keys), 21600);
}

/**
 * Main GQuery class for interacting with Google Sheets
 * Provides a query-like interface for reading and writing spreadsheet data
 */
class GQuery {
    /**
     * Create a new GQuery instance
     * @param spreadsheetId Optional spreadsheet ID. If not provided, uses the active spreadsheet
     */
    constructor(spreadsheetId) {
        this.spreadsheetId = spreadsheetId
            ? spreadsheetId
            : SpreadsheetApp.getActiveSpreadsheet().getId();
    }
    from(sheetName, schema) {
        return new GQueryTable(this, this.spreadsheetId, sheetName, schema);
    }
    /**
     * Efficiently fetch data from multiple sheets at once.
     * For typed results per-sheet, use `from()` individually.
     *
     * @param sheetNames Array of sheet names to fetch
     * @param options Optional rendering options
     * @returns Object mapping sheet names to their data
     */
    getMany(sheetNames, options) {
        return getManyInternal(this, sheetNames, options);
    }
}
/**
 * Represents a single sheet table for query operations.
 * @typeParam T - The shape of each data row. Inferred from a Standard Schema if provided.
 */
class GQueryTable {
    constructor(GQuery, spreadsheetId, sheetName, schema) {
        this.spreadsheetId = spreadsheetId;
        this.sheetName = sheetName;
        this.spreadsheet = SpreadsheetApp.openById(spreadsheetId);
        this.sheet = this.spreadsheet.getSheetByName(sheetName);
        this.GQuery = GQuery;
        this.schema = schema;
    }
    /**
     * Select specific columns to return
     * @param headers Array of column names to select
     * @returns GQueryTableFactory for chaining
     */
    select(headers) {
        return new GQueryTableFactory(this).select(headers);
    }
    /**
     * Filter rows based on a condition
     * @param filterFn Function that receives a typed row and returns true for rows to include
     * @returns GQueryTableFactory for chaining
     */
    where(filterFn) {
        return new GQueryTableFactory(this).where(filterFn);
    }
    /**
     * Sort rows by a field before returning
     * @param field Column name to sort by
     * @param direction Sort direction: "asc" (default) or "desc"
     * @returns GQueryTableFactory for chaining
     */
    orderBy(field, direction = "asc") {
        return new GQueryTableFactory(this).orderBy(field, direction);
    }
    /**
     * Limit the number of rows returned.
     * @param n Maximum number of rows
     * @returns GQueryTableFactory for chaining
     */
    limit(n) {
        return new GQueryTableFactory(this).limit(n);
    }
    /**
     * Skip the first N rows before returning.
     * @param n Number of rows to skip
     * @returns GQueryTableFactory for chaining
     */
    offset(n) {
        return new GQueryTableFactory(this).offset(n);
    }
    /**
     * Join with another sheet.
     * Note: joined columns are typed as additional `any` fields alongside T.
     *
     * @param sheetName Name of sheet to join with
     * @param sheetColumn Column in the joined sheet to match on
     * @param joinColumn Column in this sheet to match on
     * @param columnsToReturn Optional array of columns to return from joined sheet
     * @returns GQueryTableFactory for chaining
     */
    join(sheetName, sheetColumn, joinColumn, columnsToReturn) {
        return new GQueryTableFactory(this).join(sheetName, sheetColumn, joinColumn, columnsToReturn);
    }
    /**
     * Enable server-side caching for this read via CacheService.
     * Subsequent `.get()` calls will serve from cache on hit and populate the cache
     * on miss. Writes (append/appendOne/update/delete) on the same sheet
     * automatically invalidate the cache — no manual `.invalidate()` needed.
     *
     * @param opts Optional cache configuration (key, ttl, bypass)
     * @returns this (for chaining)
     */
    cached(opts) {
        this.cacheOpts = opts !== null && opts !== void 0 ? opts : {};
        return this;
    }
    /**
     * Update rows in the sheet
     * @param updateFn Function that receives a typed row and returns updated values
     * @returns GQueryResult with updated rows
     */
    update(updateFn) {
        const result = new GQueryTableFactory(this).update(updateFn);
        invalidateSheet(this.sheetName);
        return result;
    }
    /**
     * Append new rows to the sheet.
     * If a schema is attached, input data is validated before writing (when validate is true).
     *
     * @param data Single object or array of objects to append
     * @param options Optional rendering options (set validate: true to run schema validation)
     * @returns GQueryResult with appended rows
     */
    append(data, options) {
        const dataArray = Array.isArray(data) ? data : [data];
        const result = appendInternal(this, dataArray, options);
        invalidateSheet(this.sheetName);
        return result;
    }
    /**
     * Append a single row and return the inserted row directly (not wrapped in a result).
     * @param row Object to append
     * @param options Optional validation flag
     * @returns The inserted row with __meta populated
     */
    appendOne(row, options) {
        const result = appendOneInternal(this, row, options);
        invalidateSheet(this.sheetName);
        return result;
    }
    /**
     * Get data from the sheet
     * @param options Optional rendering and validation options
     * @returns GQueryResult with rows typed to T
     */
    get(options) {
        const factory = new GQueryTableFactory(this);
        if (this.cacheOpts !== undefined) {
            factory.cacheOpts = this.cacheOpts;
        }
        return factory.get(options);
    }
    /**
     * Get a single row by its `id` field.
     * @param id Value of the row's `id` field
     * @returns The matching row, or undefined if no row matches
     */
    getById(id) {
        const result = this.where((row) => row.id === id).get();
        return result.rows[0];
    }
    /**
     * Update a single row identified by its `id` field.
     * The mutator may either mutate the row in place or return a Partial<T> — both styles are handled.
     * @param id Value of the row's `id` field
     * @param mutator Function that mutates the row in place or returns updated field values
     */
    updateById(id, mutator) {
        this.where((row) => row.id === id).update((row) => {
            const copy = { ...row };
            const returned = mutator(copy);
            return returned !== undefined ? returned : copy;
        });
    }
    /**
     * Delete a single row identified by its `id` field.
     * @param id Value of the row's `id` field
     */
    deleteById(id) {
        this.where((row) => row.id === id).delete();
    }
    /**
     * Execute a Google Visualization API query
     * @param query Query string in Google Query Language
     * @returns GQueryResult with query results
     */
    query(query) {
        return queryInternal(this, query);
    }
    /**
     * Delete rows from the sheet
     * @returns Object with count of deleted rows
     */
    delete() {
        const result = new GQueryTableFactory(this).delete();
        invalidateSheet(this.sheetName);
        return result;
    }
}
/**
 * Factory class for building and executing queries with filters and joins.
 * @typeParam T - The shape of each data row, inherited from GQueryTable<T>.
 */
class GQueryTableFactory {
    constructor(GQueryTable) {
        this.joinOption = [];
        this.GQueryTable = GQueryTable;
    }
    select(headers) {
        this.selectOption = headers;
        return this;
    }
    where(filterFn) {
        this.filterOption = filterFn;
        return this;
    }
    orderBy(field, direction = "asc") {
        this.orderByState = { field, direction };
        return this;
    }
    limit(n) {
        this.limitState = n;
        return this;
    }
    offset(n) {
        this.offsetState = n;
        return this;
    }
    join(sheetName, sheetColumn, joinColumn, columnsToReturn) {
        this.joinOption.push({
            sheetName,
            sheetColumn,
            joinColumn,
            columnsToReturn,
        });
        return this;
    }
    /**
     * Enable server-side caching for this read via CacheService.
     * @param opts Optional cache configuration (key, ttl, bypass)
     * @returns this (for chaining)
     */
    cached(opts) {
        this.cacheOpts = opts !== null && opts !== void 0 ? opts : {};
        return this;
    }
    uncachedGet(options) {
        return getInternal(this, options, this.orderByState, this.limitState, this.offsetState);
    }
    get(options) {
        if (this.cacheOpts !== undefined) {
            return readThrough(this.cacheOpts, this.GQueryTable.sheetName, () => this.uncachedGet(options));
        }
        return this.uncachedGet(options);
    }
    update(updateFn) {
        const result = updateInternal(this, updateFn);
        invalidateSheet(this.GQueryTable.sheetName);
        return result;
    }
    append(data, options) {
        const dataArray = Array.isArray(data) ? data : [data];
        const result = appendInternal(this.GQueryTable, dataArray, options);
        invalidateSheet(this.GQueryTable.sheetName);
        return result;
    }
    delete() {
        const result = deleteInternal(this);
        invalidateSheet(this.GQueryTable.sheetName);
        return result;
    }
}

export { DateTimeRenderOption, GQuery, GQuerySchemaError, GQueryTable, GQueryTableFactory, ValueRenderOption };
