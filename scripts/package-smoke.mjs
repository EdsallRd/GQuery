import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import vm from "node:vm";

const esm = await import("../dist/bundle.js");
assert.equal(typeof esm.createGQuery, "function");
assert.equal(typeof esm.defineDatabase, "function");
assert.equal(typeof esm.structured, "function");

const globalCode = await readFile(new URL("../dist/bundle.global.js", import.meta.url), "utf8");
const sandbox = {};
vm.runInNewContext(globalCode, sandbox);
assert.equal(typeof sandbox.GQuery, "function");
assert.equal(typeof sandbox.GQuery.defineDatabase, "function");

for (const declaration of ["bundle.d.ts", "bundle.global.d.ts"]) {
  const contents = await readFile(new URL(`../dist/${declaration}`, import.meta.url), "utf8");
  assert.match(contents, /createGQuery/);
  assert.doesNotMatch(contents, /class GQueryTableFactory/);
}

const globalDeclaration = fileURLToPath(new URL("../dist/bundle.global.d.ts", import.meta.url));
const program = ts.createProgram([globalDeclaration], {
  noEmit: true,
  skipLibCheck: false,
  target: ts.ScriptTarget.ES2020,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ["lib.es2020.d.ts"],
  types: ["google-apps-script"],
});
const diagnostics = ts.getPreEmitDiagnostics(program);
assert.equal(
  diagnostics.length,
  0,
  ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => process.cwd(),
    getNewLine: () => "\n",
  }),
);

console.log("GQuery 2.0 ESM, IIFE, and declaration smoke tests passed.");
