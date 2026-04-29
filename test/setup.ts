import { vi } from "vitest";

/**
 * In-memory fakes for the Google Apps Script globals used by GQuery.
 * Tests reach into these via `gasFakes` to set up sheet contents and
 * inspect outgoing API calls.
 */

interface SheetContents {
  values: any[][];
  sheetId: number;
}

interface FakeState {
  sheets: Map<string, SheetContents>;
  cache: Map<string, string>;
  batchUpdateCalls: any[];
  appendCalls: any[];
  fetchCalls: { url: string; opts: any }[];
  fetchHandler:
    | ((url: string, opts: any) => { code: number; body: string })
    | null;
  sleepCalls: number[];
}

export const gasFakes: FakeState = {
  sheets: new Map(),
  cache: new Map(),
  batchUpdateCalls: [],
  appendCalls: [],
  fetchCalls: [],
  fetchHandler: null,
  sleepCalls: [],
};

export function resetGasFakes(): void {
  gasFakes.sheets.clear();
  gasFakes.cache.clear();
  gasFakes.batchUpdateCalls.length = 0;
  gasFakes.appendCalls.length = 0;
  gasFakes.fetchCalls.length = 0;
  gasFakes.fetchHandler = null;
  gasFakes.sleepCalls.length = 0;
}

function parseRange(range: string): { sheet: string; a1?: string } {
  const bang = range.indexOf("!");
  if (bang === -1) return { sheet: range };
  return { sheet: range.slice(0, bang), a1: range.slice(bang + 1) };
}

function valuesForRange(range: string): any[][] {
  const { sheet, a1 } = parseRange(range);
  const contents = gasFakes.sheets.get(sheet);
  if (!contents) return [];
  if (!a1) return contents.values;

  // Support `1:1` (header-only) and `A2:C100` style ranges minimally —
  // we only need what GQuery actually requests.
  if (a1 === "1:1") {
    return contents.values.length > 0 ? [contents.values[0]] : [];
  }
  const rangeMatch = a1.match(/^([A-Z]*)(\d+):([A-Z]*)(\d*)$/);
  if (rangeMatch) {
    const startRow = parseInt(rangeMatch[2], 10);
    const endRowStr = rangeMatch[4];
    const endRow = endRowStr
      ? parseInt(endRowStr, 10)
      : contents.values.length;
    return contents.values.slice(startRow - 1, endRow);
  }
  return contents.values;
}

(globalThis as any).Sheets = {
  Spreadsheets: {
    Values: {
      get: vi.fn((_id: string, range: string) => ({
        values: valuesForRange(range),
      })),
      batchGet: vi.fn((_id: string, opts: { ranges: string[] }) => ({
        valueRanges: opts.ranges.map((r) => ({ values: valuesForRange(r) })),
      })),
      batchUpdate: vi.fn((req: any, _id: string) => {
        gasFakes.batchUpdateCalls.push(req);
        return { totalUpdatedCells: req.data.length };
      }),
      append: vi.fn((req: any, _id: string, sheetName: string) => {
        gasFakes.appendCalls.push({ req, sheetName });
        const sheet = gasFakes.sheets.get(sheetName);
        const startRow = sheet ? sheet.values.length + 1 : 1;
        const endRow = startRow + req.values.length - 1;
        if (sheet) {
          for (const row of req.values) sheet.values.push(row);
        }
        const headerCount = sheet ? sheet.values[0].length : req.values[0].length;
        const lastCol = String.fromCharCode(64 + headerCount);
        return {
          updates: {
            updatedRange: `${sheetName}!A${startRow}:${lastCol}${endRow}`,
            updatedRows: req.values.length,
          },
        };
      }),
    },
    batchUpdate: vi.fn((req: any, _id: string) => {
      gasFakes.batchUpdateCalls.push(req);
      return { replies: [] };
    }),
  },
};

(globalThis as any).SpreadsheetApp = {
  getActiveSpreadsheet: vi.fn(() => ({
    getId: () => "fake-spreadsheet-id",
  })),
  openById: vi.fn((id: string) => ({
    getId: () => id,
    getSheetByName: vi.fn((name: string) => ({
      getSheetId: () => gasFakes.sheets.get(name)?.sheetId ?? 0,
      getName: () => name,
      getParent: () => ({ getId: () => id }),
      getDataRange: () => ({ getLastColumn: () => 0 }),
      getRange: () => ({
        getValue: () => "",
        getA1Notation: () => "A1",
      }),
    })),
  })),
};

(globalThis as any).CacheService = {
  getDocumentCache: () => makeFakeCache(),
  getScriptCache: () => makeFakeCache(),
  getUserCache: () => makeFakeCache(),
};

function makeFakeCache(): GoogleAppsScript.Cache.Cache {
  return {
    get: (key: string) => gasFakes.cache.get(key) ?? null,
    put: (key: string, value: string, _ttl?: number) => {
      gasFakes.cache.set(key, value);
    },
    putAll: (values: { [k: string]: string }, _ttl?: number) => {
      for (const [k, v] of Object.entries(values)) gasFakes.cache.set(k, v);
    },
    getAll: (keys: string[]) => {
      const out: { [k: string]: string } = {};
      for (const k of keys) {
        const v = gasFakes.cache.get(k);
        if (v !== undefined) out[k] = v;
      }
      return out;
    },
    remove: (key: string) => gasFakes.cache.delete(key),
    removeAll: (keys: string[]) => {
      for (const k of keys) gasFakes.cache.delete(k);
    },
  } as unknown as GoogleAppsScript.Cache.Cache;
}

(globalThis as any).Utilities = {
  sleep: vi.fn((ms: number) => {
    gasFakes.sleepCalls.push(ms);
  }),
  formatString: (fmt: string, ...args: any[]) => {
    let i = 0;
    return fmt.replace(/%s/g, () => String(args[i++]));
  },
  // Skip real gzip in tests — produce a passthrough blob so the cache layer
  // exercises both branches of encode() but the round-trip is verifiable.
  gzip: (blob: any) => ({
    getBytes: () => blob.getBytes(),
  }),
  ungzip: (blob: any) => ({
    getDataAsString: () => blob.getDataAsString(),
  }),
  newBlob: (input: string | number[]) => {
    if (typeof input === "string") {
      const bytes = Array.from(new TextEncoder().encode(input));
      return {
        getBytes: () => bytes,
        getDataAsString: () => input,
      };
    }
    const text = new TextDecoder().decode(new Uint8Array(input));
    return {
      getBytes: () => input,
      getDataAsString: () => text,
    };
  },
  base64Encode: (bytes: number[]) =>
    Buffer.from(Uint8Array.from(bytes)).toString("base64"),
  base64Decode: (str: string) => Array.from(Buffer.from(str, "base64")),
};

(globalThis as any).UrlFetchApp = {
  fetch: vi.fn((url: string, opts: any) => {
    gasFakes.fetchCalls.push({ url, opts });
    const handler =
      gasFakes.fetchHandler ?? (() => ({ code: 200, body: "{}" }));
    const result = handler(url, opts);
    return {
      getResponseCode: () => result.code,
      getContentText: () => result.body,
    };
  }),
};

(globalThis as any).ScriptApp = {
  getOAuthToken: () => "fake-oauth-token",
};

(globalThis as any).console = console;
