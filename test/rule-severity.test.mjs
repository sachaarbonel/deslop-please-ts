import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { analyzeProject } from "../dist/index.js";
import { fixture } from "./fixture.mjs";

function analyze(project) {
  const report = analyzeProject(project);
  assert.deepEqual(report.errors, []);
  assert.equal(report.compilerVersion, ts.version);
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("../dist/cli.js", import.meta.url)),
      "--project",
      project,
      "--format",
      "json",
    ],
    { encoding: "utf8" },
  );
  if (result.error) throw result.error;
  assert.deepEqual(JSON.parse(result.stdout).diagnostics, report.diagnostics);
  return { report, exitCode: result.status };
}

test("mutually referring type contracts stay visible as advisory tangles", (t) => {
  const { project } = fixture(t, {
    "user.ts": "import type { Org } from './org'; export interface User { org: Org; }",
    "org.ts": "import type { User } from './user'; export interface Org { owner: User; }",
  });
  const { report, exitCode } = analyze(project);
  assert.equal(exitCode, 0);
  assert.equal(report.dependencies.runtime, 0);
  assert.ok(
    report.diagnostics.some(
      (d) =>
        d.rule === "tangle" &&
        d.severity === "warning" &&
        d.evidence.dependencyKinds.every((kind) => kind === "type-only"),
    ),
  );
});

test("value-level mutual calls retain an error and a failing CLI exit", (t) => {
  const { project } = fixture(t, {
    "left.ts":
      "import { right } from './right'; export function left(n: number): number { return n ? right(n - 1) : 0; }",
    "right.ts":
      "import { left } from './left'; export function right(n: number): number { return n ? left(n - 1) : 0; }",
  });
  const { report, exitCode } = analyze(project);
  assert.equal(exitCode, 1);
  assert.ok(report.diagnostics.some((d) => d.rule === "tangle" && d.severity === "error"));
});

test("a horizontal function collection remains reported without becoming a hard CI failure", (t) => {
  const names = Array.from({ length: 9 }, (_, i) => `item${i}`);
  const { project } = fixture(t, {
    "ui/components.ts": names
      .map((name, i) => `export function ${name}(n: number) { return n + ${i}; }`)
      .join("\n"),
    "app.ts": `import { ${names.join(",")} } from './ui/components'; export const rendered = ${names.map((name) => `${name}(1)`).join("+")};`,
  });
  const { report, exitCode } = analyze(project);
  assert.equal(exitCode, 0);
  assert.ok(
    report.diagnostics.some(
      (d) => d.rule === "shallow-module" && d.severity === "warning" && d.evidence.shown === 9,
    ),
  );
});
