import { describe, expect, expectTypeOf, it } from "vitest";
import {
  BLANK_CELL,
  GQueryCodecError,
  LEGACY_NO_MATCH,
  booleanColumn,
  date,
  datetime,
  decimal,
  enumeration,
  formula,
  integer,
  json,
  nullable,
  number,
  optional,
  structured,
  text,
  withDefault,
} from "./index";

describe("v2 scalar codecs", () => {
  it("keeps literal text distinct from explicitly declared formulas", () => {
    expect(text().encode("=SUM(A1:A3)")).toBe("=SUM(A1:A3)");

    const calculation = formula({ header: "Calculated" });
    expect(calculation.encode("=SUM(A1:A3)")).toEqual({
      __gqueryFormulaCell: true,
      expression: "=SUM(A1:A3)",
    });
    expect(calculation.decode("=SUM(A1:A3)")).toBe("=SUM(A1:A3)");
    expect(() => calculation.encode("SUM(A1:A3)")).toThrowError(
      expect.objectContaining({ code: "CODEC_CONSTRAINT" }),
    );
    expect(() => calculation.decode(42)).toThrowError(GQueryCodecError);
  });

  it("keeps text, booleans, and numbers strict", () => {
    const serial = text();
    const active = booleanColumn();
    const quantity = number();

    expect(serial.decode("00042")).toBe("00042");
    expect(active.decode(true)).toBe(true);
    expect(quantity.decode(42.5)).toBe(42.5);
    expect(() => active.decode("true")).toThrowError(GQueryCodecError);
    expect(() => quantity.decode("42")).toThrowError(GQueryCodecError);
    expect(() => serial.decode(42)).toThrowError(GQueryCodecError);
    expect(() => quantity.encode(Number.POSITIVE_INFINITY)).toThrowError(
      expect.objectContaining({ code: "CODEC_CONSTRAINT", direction: "encode" }),
    );
  });

  it("enforces integer and canonical decimal constraints", () => {
    expect(integer().encode(4)).toBe(4);
    expect(() => integer().encode(4.2)).toThrowError(GQueryCodecError);
    expect(() => integer().decode(Number.MAX_SAFE_INTEGER + 1)).toThrowError(
      GQueryCodecError,
    );

    const money = decimal({ scale: 2, maxDigits: 8 });
    expect(money.encode("+00012.3")).toBe("12.30");
    expect(money.decode("-0.00")).toBe("0.00");
    expect(() => money.encode("1.234")).toThrowError(GQueryCodecError);
    expect(() => money.encode("1e3")).toThrowError(GQueryCodecError);
  });

  it("infers literal enumeration members", () => {
    const status = enumeration({ values: ["Available", "Repair"] });
    expectTypeOf(status.decode("Available")).toEqualTypeOf<
      "Available" | "Repair"
    >();
    expect(status.decode("Repair")).toBe("Repair");
    expect(() => status.decode("Assigned")).toThrowError(GQueryCodecError);
  });

  it("uses canonical UTC dates and datetimes", () => {
    const day = date();
    const instant = datetime();

    expect(day.encode(new Date("2026-08-26T00:00:00.000Z"))).toBe("2026-08-26");
    expect(day.decode("2024-02-29").toISOString()).toBe(
      "2024-02-29T00:00:00.000Z",
    );
    expect(() => day.decode("2023-02-29")).toThrowError(GQueryCodecError);
    expect(() => day.encode(new Date("2026-08-26T12:00:00.000Z"))).toThrowError(
      GQueryCodecError,
    );
    expect(instant.decode("2026-08-26T12:34:56.789Z").toISOString()).toBe(
      "2026-08-26T12:34:56.789Z",
    );
    expect(() => instant.decode("2026-08-26T12:34:56Z")).toThrowError(
      GQueryCodecError,
    );
  });

  it("does not collapse blank, empty string, null, and missing by default", () => {
    const strict = text();
    expect(strict.decode("")).toBe("");
    expect(() => strict.decode(BLANK_CELL)).toThrowError(
      expect.objectContaining({ code: "CODEC_BLANK" }),
    );
    expect(() => strict.decode(null)).toThrowError(
      expect.objectContaining({ code: "CODEC_NULL" }),
    );

    const maybe = nullable(strict);
    const absent = optional(strict);
    const defaulted = withDefault(strict, "unknown");
    expect(maybe.decode(BLANK_CELL)).toBeNull();
    expect(maybe.encode(null)).toBe(BLANK_CELL);
    expect(absent.decode(undefined)).toBeUndefined();
    expect(absent.encode(undefined)).toBe(BLANK_CELL);
    expect(defaulted.decode(BLANK_CELL)).toBe("unknown");
    expect(() => defaulted.encode(undefined as never)).toThrowError(
      expect.objectContaining({ code: "CODEC_BLANK" }),
    );

    const nullableWithDefault = withDefault(nullable(strict), "fallback");
    expect(nullableWithDefault.decode(BLANK_CELL)).toBe("fallback");
    expect(nullableWithDefault.decode(null)).toBeNull();
  });

  it("consults legacy decoders only after canonical decoding fails", () => {
    let legacyCalls = 0;
    const active = booleanColumn({
      legacyDecoders: [
        (value) => {
          legacyCalls += 1;
          return value === "TRUE" ? true : LEGACY_NO_MATCH;
        },
      ],
    });

    expect(active.decode(false)).toBe(false);
    expect(legacyCalls).toBe(0);
    expect(active.decode("TRUE")).toBe(true);
    expect(legacyCalls).toBe(1);
    expect(() => active.decode("yes")).toThrowError(GQueryCodecError);
  });
});

describe("v2 document codecs", () => {
  it("encodes plain JSON deterministically", () => {
    const metadata = json<{ a: number; z: string }>();
    const encoded = metadata.encode({ z: "last", a: 1 });
    expect(encoded).toBe('gq:json:v1:{"a":1,"z":"last"}');
    expect(metadata.decode(encoded)).toEqual({ a: 1, z: "last" });
  });

  it("rejects non-JSON objects, cycles, and oversized JSON", () => {
    const value: Record<string, unknown> = {};
    value.self = value;
    expect(() => json<any>().encode(value)).toThrowError(
      expect.objectContaining({ code: "STRUCTURED_CYCLE" }),
    );
    expect(() => json<any>().encode({ at: new Date() })).toThrowError(
      expect.objectContaining({ code: "STRUCTURED_UNSUPPORTED" }),
    );
    expect(() => json({ maxChars: 20 }).encode({ long: "abcdefghij" })).toThrowError(
      expect.objectContaining({ code: "JSON_TOO_LARGE" }),
    );
  });

  it("round-trips tagged Date and BigInt values without tag collisions", () => {
    type Payload = {
      id: bigint;
      at: Date;
      nested: { $gq: readonly [string, string]; values: bigint[] };
    };
    const document = structured<Payload>({ formatVersion: 3 });
    const input: Payload = {
      id: BigInt("9007199254740993"),
      at: new Date("2026-08-26T12:34:56.789Z"),
      nested: {
        $gq: ["date", "not-a-tag"],
        values: [BigInt(0), BigInt(-2)],
      },
    };
    const encoded = document.encode(input);
    const decoded = document.decode(encoded);

    expect(typeof encoded).toBe("string");
    expect(typeof encoded === "string" && encoded.startsWith("gq:structured:v3:"))
      .toBe(true);
    expect(decoded).toEqual(input);
    expect(decoded.at).toBeInstanceOf(Date);
    expect(typeof decoded.id).toBe("bigint");
  });

  it("rejects cycles, unsupported instances, corrupt data, versions, and size", () => {
    const document = structured<unknown>();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    class CustomValue {
      value = 1;
    }

    expect(() => document.encode(cyclic)).toThrowError(
      expect.objectContaining({ code: "STRUCTURED_CYCLE" }),
    );
    expect(() => document.encode(new CustomValue())).toThrowError(
      expect.objectContaining({ code: "STRUCTURED_UNSUPPORTED" }),
    );
    expect(() => document.decode("gq:structured:v2:null")).toThrowError(
      expect.objectContaining({ code: "STRUCTURED_VERSION" }),
    );
    expect(() => document.decode("gq:structured:v1:not-json")).toThrowError(
      expect.objectContaining({ code: "STRUCTURED_INVALID" }),
    );
    expect(() => structured<string>({ maxChars: 25 }).encode("a long payload"))
      .toThrowError(expect.objectContaining({ code: "STRUCTURED_TOO_LARGE" }));
  });
});
