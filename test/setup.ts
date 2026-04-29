import { vi } from "vitest";

// Minimal GAS global stubs. Individual tests override with vi.spyOn or vi.stubGlobal as needed.
vi.stubGlobal("SpreadsheetApp", {
  getActiveSpreadsheet: () => ({ getId: () => "test-spreadsheet" }),
  openById: () => ({ getId: () => "test-spreadsheet" }),
});

vi.stubGlobal("Sheets", {
  Spreadsheets: {
    Values: {
      get: vi.fn(),
      batchGet: vi.fn(),
      append: vi.fn(),
      batchUpdate: vi.fn(),
    },
    batchUpdate: vi.fn(),
  },
});

vi.stubGlobal("CacheService", {
  getScriptCache: () => ({
    get: vi.fn().mockReturnValue(null),
    put: vi.fn(),
    remove: vi.fn(),
    removeAll: vi.fn(),
  }),
});

vi.stubGlobal("Utilities", {
  sleep: vi.fn(),
});
