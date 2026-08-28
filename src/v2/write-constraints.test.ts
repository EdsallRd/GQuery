import { describe, expect, it } from "vitest";
import { nullable, text } from "./codecs";
import { createGQuery } from "./database";
import { belongsTo, defineDatabase, source, table } from "./schema";
import { InMemorySheetsTransport } from "./transport";

const schema = defineDatabase({
  version: 2,
  sources: { main: source.byId("constraints-book") },
  tables: {
    Accounts: table({
      source: "main",
      sheet: "Accounts",
      primaryKey: ["tenant", "id"],
      unique: [["email"], ["tenant", "code"]],
      versionColumn: "_gq_version",
      columns: {
        tenant: text({ header: "Tenant" }),
        id: text({ header: "ID" }),
        email: text({ header: "Email" }),
        code: text({ header: "Code" }),
        display: text({ header: "Display" }),
      },
    }),
    Parents: table({
      source: "main",
      sheet: "Parents",
      primaryKey: ["tenant", "id"],
      versionColumn: "_gq_version",
      columns: {
        tenant: text({ header: "Tenant" }),
        id: text({ header: "ID" }),
      },
    }),
    Children: table({
      source: "main",
      sheet: "Children",
      primaryKey: ["id"],
      versionColumn: "_gq_version",
      columns: {
        id: text({ header: "ID" }),
        tenant: text({ header: "Tenant" }),
        parentId: text({ header: "Parent ID" }),
        optionalParentId: nullable(text({ header: "Optional Parent ID" })),
      },
      relations: {
        parent: belongsTo("Parents", {
          local: ["tenant", "parentId"],
          foreign: ["tenant", "id"],
          required: true,
        }),
        optionalParent: belongsTo("Parents", {
          local: ["tenant", "optionalParentId"],
          foreign: ["tenant", "id"],
          required: false,
        }),
      },
    }),
  },
});

function setup() {
  const transport = new InMemorySheetsTransport([{
    spreadsheetId: "constraints-book",
    sheets: [
      {
        sheetId: 1,
        title: "Accounts",
        values: [
          ["Tenant", "ID", "Email", "Code", "Display", "_gq_version"],
          ["t1", "a1", "one@example.test", "C1", "One", 1],
          ["t1", "a2", "two@example.test", "C2", "Two", 1],
        ],
      },
      {
        sheetId: 2,
        title: "Parents",
        values: [
          ["Tenant", "ID", "_gq_version"],
          ["t1", "p1", 1],
        ],
      },
      {
        sheetId: 3,
        title: "Children",
        values: [
          ["ID", "Tenant", "Parent ID", "Optional Parent ID", "_gq_version"],
          ["c1", "t1", "p1", null, 1],
        ],
      },
    ],
  }]);
  return { transport, gq: createGQuery(schema, { transport }) };
}

describe("write-time key constraints", () => {
  it("rejects an immediate append that duplicates an existing composite primary key", () => {
    const { transport, gq } = setup();
    transport.clearHistory();

    const result = gq.Accounts.append({
      tenant: "t1",
      id: "a1",
      email: "other@example.test",
      code: "OTHER",
      display: "Duplicate primary",
    });

    expect(result.status).toBe("conflicted");
    expect(result.conflicts[0]).toMatchObject({
      code: "duplicate-key",
      table: "Accounts",
      expected: { constraint: "primary", fields: ["tenant", "id"] },
    });
    expect(transport.history.some(({ kind }) => kind === "atomicBatchUpdate"))
      .toBe(false);
  });

  it("rejects existing and within-batch unique-key duplicates", () => {
    const { transport, gq } = setup();
    const existing = gq.Accounts.append({
      tenant: "t2",
      id: "a3",
      email: "one@example.test",
      code: "C3",
      display: "Duplicate email",
    });
    expect(existing.conflicts[0]).toMatchObject({
      code: "duplicate-key",
      expected: { constraint: "unique", fields: ["email"] },
    });

    transport.clearHistory();
    const staged = gq.Accounts.appendMany([
      {
        tenant: "t2",
        id: "a4",
        email: "four@example.test",
        code: "SHARED",
        display: "Four",
      },
      {
        tenant: "t2",
        id: "a5",
        email: "five@example.test",
        code: "SHARED",
        display: "Five",
      },
    ]);
    expect(staged.conflicts.some((conflict) =>
      conflict.code === "duplicate-key" &&
      (conflict.expected as { fields?: readonly string[] }).fields?.join(",") === "tenant,code"
    )).toBe(true);
    expect(transport.history.some(({ kind }) => kind === "atomicBatchUpdate"))
      .toBe(false);
  });

  it("rejects a conflicting unique-key update but permits retaining its own keys", () => {
    const { transport, gq } = setup();
    const first = gq.Accounts.find({ tenant: "t1", id: "a1" });
    transport.clearHistory();

    const conflict = first.update({ email: "two@example.test" });
    expect(conflict.status).toBe("conflicted");
    expect(conflict.conflicts[0]).toMatchObject({
      code: "duplicate-key",
      expected: { constraint: "unique", fields: ["email"] },
    });
    expect(transport.history.some(({ kind }) => kind === "atomicBatchUpdate"))
      .toBe(false);

    transport.clearHistory();
    const retained = first.update((draft) => ({
      ...draft,
      display: "Renamed",
    }));
    expect(retained.status).toBe("committed");
    expect(transport.snapshot("constraints-book").sheets[0].values[1]).toEqual([
      "t1", "a1", "one@example.test", "C1", "Renamed", 2,
    ]);
  });

  it("rejects composite duplicates created entirely inside a unit of work", () => {
    const { transport, gq } = setup();
    transport.clearHistory();
    const result = gq.unitOfWork((tx) => {
      tx.Accounts.append({
        tenant: "t3",
        id: "shared",
        email: "six@example.test",
        code: "X1",
        display: "Six",
      });
      tx.Accounts.append({
        tenant: "t3",
        id: "shared",
        email: "seven@example.test",
        code: "X2",
        display: "Seven",
      });
    });

    expect(result.status).toBe("conflicted");
    expect(result.conflicts.some((conflict) =>
      conflict.code === "duplicate-key" &&
      (conflict.expected as { constraint?: string }).constraint === "primary"
    )).toBe(true);
    expect(transport.history.some(({ kind }) => kind === "atomicBatchUpdate"))
      .toBe(false);
  });

  it("rejects a unique-key collision created by staged unit-of-work updates", () => {
    const { transport, gq } = setup();
    transport.clearHistory();

    const result = gq.unitOfWork((tx) => {
      tx.Accounts.find({ tenant: "t1", id: "a1" })
        .update({ email: "shared@example.test" });
      tx.Accounts.find({ tenant: "t1", id: "a2" })
        .update({ email: "shared@example.test" });
    });

    expect(result.status).toBe("conflicted");
    expect(result.conflicts.some((conflict) =>
      conflict.code === "duplicate-key" &&
      (conflict.expected as { constraint?: string; fields?: readonly string[] }).constraint === "unique" &&
      (conflict.expected as { fields?: readonly string[] }).fields?.join(",") === "email"
    )).toBe(true);
    expect(transport.history.some(({ kind }) => kind === "atomicBatchUpdate"))
      .toBe(false);
  });
});

describe("sync and upsert key safety", () => {
  it("requires an exact declared key and forbids preserving key fields", () => {
    const { gq } = setup();
    const invalid = expect.objectContaining({ code: "INVALID_QUERY" });

    expect(() => gq.Accounts.upsertMany([], { keys: ["id"] }))
      .toThrowError(invalid);
    expect(() => gq.Accounts.sync([], { keys: ["display"] }))
      .toThrowError(invalid);
    expect(() => gq.Accounts.sync([], { keys: ["code", "tenant"] }))
      .toThrowError(invalid);
    expect(() => gq.Accounts.sync([], {
      keys: ["tenant", "id"],
      preserve: ["tenant"],
    })).toThrowError(invalid);
  });

  it("rejects duplicate existing fingerprints instead of silently overwriting", () => {
    const { transport, gq } = setup();
    transport.atomicBatchUpdate("constraints-book", [{
      kind: "appendRows",
      sheetId: 1,
      values: [[
        "t9",
        "a9",
        "one@example.test",
        "C9",
        "Dirty duplicate",
        1,
      ]],
    }]);

    expect(() => gq.Accounts.upsertMany([], { keys: ["email"] }))
      .toThrowError(expect.objectContaining({ code: "DUPLICATE_KEY" }));
  });
});

describe("write-time required foreign keys", () => {
  it("rejects missing composite parents on immediate append and update", () => {
    const { transport, gq } = setup();
    const append = gq.Children.append({
      id: "c2",
      tenant: "t9",
      parentId: "missing",
      optionalParentId: null,
    });
    expect(append.status).toBe("conflicted");
    expect(append.conflicts[0]).toMatchObject({
      code: "foreign-key-missing",
      table: "Children",
      expected: {
        relation: "parent",
        targetTable: "Parents",
        localFields: ["tenant", "parentId"],
      },
    });

    const child = gq.Children.find("c1");
    transport.clearHistory();
    const update = child.update({ parentId: "missing" });
    expect(update.status).toBe("conflicted");
    expect(update.conflicts[0].code).toBe("foreign-key-missing");
    expect(transport.history.some(({ kind }) => kind === "atomicBatchUpdate"))
      .toBe(false);
  });

  it("allows a blank optional relation when the required parent exists", () => {
    const { gq } = setup();
    const result = gq.Children.append({
      id: "c2",
      tenant: "t1",
      parentId: "p1",
      optionalParentId: null,
    });
    expect(result.status).toBe("committed");
  });

  it("rejects a populated optional relation whose target is missing", () => {
    const { transport, gq } = setup();
    transport.clearHistory();

    const result = gq.Children.append({
      id: "c2",
      tenant: "t1",
      parentId: "p1",
      optionalParentId: "missing",
    });

    expect(result.status).toBe("conflicted");
    expect(result.conflicts[0]).toMatchObject({
      code: "foreign-key-missing",
      expected: { relation: "optionalParent", targetTable: "Parents" },
    });
    expect(transport.history.some(({ kind }) => kind === "atomicBatchUpdate"))
      .toBe(false);
  });

  it("resolves a composite parent inserted later in the same unit of work", () => {
    const { transport, gq } = setup();
    transport.clearHistory();
    const result = gq.unitOfWork((tx) => {
      tx.Children.append({
        id: "c2",
        tenant: "t2",
        parentId: "p2",
        optionalParentId: null,
      });
      tx.Parents.append({ tenant: "t2", id: "p2" });
    });

    expect(result.status).toBe("committed");
    expect(result.conflicts).toEqual([]);
    expect(transport.history.filter(({ kind }) => kind === "atomicBatchUpdate"))
      .toHaveLength(1);
  });
});
