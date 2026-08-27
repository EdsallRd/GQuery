import { describe, expect, it } from "vitest";
import {
  canonicalStringify,
  combinePredicates,
  evaluatePredicate,
  hashCanonical,
  normalizeWhere,
} from "./query";

describe("v2 object query DSL", () => {
  it("normalizes and evaluates nested operators", () => {
    const predicate = normalizeWhere({
      schoolYear: "26-27",
      grade: { $in: ["09", "10"] },
      $or: [{ active: true }, { withdrawnAt: { $isBlank: true } }],
    });

    expect(evaluatePredicate(predicate, {
      schoolYear: "26-27",
      grade: "10",
      active: false,
      withdrawnAt: "",
    })).toBe(true);
    expect(evaluatePredicate(predicate, {
      schoolYear: "25-26",
      grade: "10",
      active: true,
      withdrawnAt: "",
    })).toBe(false);
  });

  it("composes consecutive predicates with AND", () => {
    const predicate = combinePredicates(
      normalizeWhere({ active: true }),
      normalizeWhere({ grade: { $gte: 9 } }),
    );
    expect(evaluatePredicate(predicate, { active: true, grade: 10 })).toBe(true);
    expect(evaluatePredicate(predicate, { active: false, grade: 10 })).toBe(false);
  });

  it("fingerprints object key order deterministically", () => {
    expect(canonicalStringify({ b: 2, a: 1 })).toBe(canonicalStringify({ a: 1, b: 2 }));
    expect(hashCanonical({ b: 2, a: 1 })).toBe(hashCanonical({ a: 1, b: 2 }));
  });

  it("deep-freezes normalized predicate trees", () => {
    const grades = [9, 10];
    const predicate = normalizeWhere({
      active: true,
      $or: [{ grade: { $in: grades } }, { grade: { $lte: 4 } }],
    });
    grades.push(11);
    expect(Object.isFrozen(predicate)).toBe(true);
    if (predicate.kind !== "and") throw new Error("expected an and predicate");
    expect(Object.isFrozen(predicate.nodes)).toBe(true);
    expect(predicate.nodes.every((node) => Object.isFrozen(node))).toBe(true);
    expect(evaluatePredicate(predicate, { active: true, grade: 11 })).toBe(false);
  });
});
