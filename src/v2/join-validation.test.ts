import { describe, expect, it } from "vitest";
import { integer, text } from "./codecs";
import { createGQuery } from "./database";
import { belongsTo, defineDatabase, source, table } from "./schema";
import { InMemorySheetsTransport } from "./transport";

const schema = defineDatabase({
  version: 2,
  sources: { main: source.byId("join-book") },
  tables: {
    Assets: table({
      source: "main",
      sheet: "Assets",
      primaryKey: ["serial"],
      columns: {
        serial: text({ header: "Serial" }),
        modelId: text({ header: "Model ID" }),
      },
      relations: {
        model: belongsTo("Models", { local: "modelId", foreign: "id" }),
      },
    }),
    Models: table({
      source: "main",
      sheet: "Models",
      primaryKey: ["id"],
      columns: {
        id: text({ header: "ID" }),
        name: text({ header: "Name" }),
        cost: integer({ header: "Cost" }),
      },
    }),
  },
});

function setup() {
  const transport = new InMemorySheetsTransport([{
    spreadsheetId: "join-book",
    sheets: [
      {
        sheetId: 1,
        title: "Assets",
        values: [["Serial", "Model ID"], ["a1", "m1"]],
      },
      {
        sheetId: 2,
        title: "Models",
        values: [["ID", "Name", "Cost"], ["m1", "Laptop", 900]],
      },
    ],
  }]);
  return { transport, gq: createGQuery(schema, { transport }) };
}

function expectInvalid(operation: () => unknown): void {
  expect(operation).toThrowError(expect.objectContaining({ code: "INVALID_QUERY" }));
}

describe("join contract validation", () => {
  it("rejects ad-hoc base-column and prior-alias collisions", () => {
    const { transport, gq } = setup();
    expectInvalid(() =>
      gq.Assets.join(gq.Models, {
        as: "serial",
        on: { local: "modelId", foreign: "id" },
      }),
    );

    const first = gq.Assets.join(gq.Models, {
      as: "joinedModel",
      on: { local: "modelId", foreign: "id" },
    });
    expectInvalid(() =>
      first.join(gq.Models, {
        as: "joinedModel",
        on: { local: "modelId", foreign: "id" },
      }),
    );
    expect(transport.history).toHaveLength(0);
  });

  it("rejects include when its alias was already claimed by an ad-hoc join", () => {
    const { transport, gq } = setup();
    const first = gq.Assets.join(gq.Models, {
      as: "model",
      on: { local: "modelId", foreign: "id" },
    });
    expectInvalid(() => first.include("model"));
    expectInvalid(() => gq.Assets.include("model").include("model"));
    expect(transport.history).toHaveLength(0);
  });

  it("rejects missing local and foreign logical fields before reading", () => {
    const { transport, gq } = setup();
    expectInvalid(() =>
      gq.Assets.join(gq.Models, {
        as: "badLocal",
        on: { local: "missing", foreign: "id" },
      } as never),
    );
    expectInvalid(() =>
      gq.Assets.join(gq.Models, {
        as: "badForeign",
        // Physical headers are not schema property names.
        on: { local: "modelId", foreign: "ID" },
      } as never),
    );
    expect(transport.history).toHaveLength(0);
  });

  it("rejects missing selected fields and mismatched composite key arity", () => {
    const { transport, gq } = setup();
    expectInvalid(() =>
      gq.Assets.join(gq.Models, {
        as: "badSelect",
        on: { local: "modelId", foreign: "id" },
        select: ["missing"],
      } as never),
    );
    expectInvalid(() =>
      gq.Assets.join(gq.Models, {
        as: "badArity",
        on: { local: ["serial", "modelId"], foreign: ["id"] },
      } as never),
    );
    expect(transport.history).toHaveLength(0);
  });
});
