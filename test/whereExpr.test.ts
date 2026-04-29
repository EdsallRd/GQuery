import { describe, expect, it } from "vitest";
import { compileWhereExpr } from "../src/get";

describe("compileWhereExpr", () => {
  it("compiles a simple comparison", () => {
    expect(
      compileWhereExpr({ col: "Age", op: ">", value: 18 }),
    ).toBe("select * where `Age` > 18");
  });

  it("emits backtick-quoted column names so subsequent letter substitution works", () => {
    expect(
      compileWhereExpr({ col: "First Name", op: "=", value: "Ada" }),
    ).toBe('select * where `First Name` = "Ada"');
  });

  it("compiles AND/OR/NOT trees with parens", () => {
    const out = compileWhereExpr({
      and: [
        { col: "Age", op: ">=", value: 18 },
        { or: [{ col: "Country", op: "=", value: "US" }, { not: { col: "Banned", op: "=", value: true } }] },
      ],
    });
    expect(out).toContain("(`Age` >= 18 and (`Country` = \"US\" or (not `Banned` = true)))");
  });

  it("formats date values as gviz date literals", () => {
    expect(
      compileWhereExpr({
        col: "Created",
        op: ">",
        value: new Date("2026-04-29T00:00:00Z"),
      }),
    ).toBe("select * where `Created` > date '2026-04-29'");
  });

  it("includes select / limit / offset clauses when provided", () => {
    expect(
      compileWhereExpr(
        { col: "X", op: ">", value: 0 },
        ["X", "Y"],
        10,
        5,
      ),
    ).toBe("select `X`, `Y` where `X` > 0 limit 10 offset 5");
  });
});
