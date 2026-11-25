import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { analyzeProject } from "../dist/index.js";
import { fixture } from "./fixture.mjs";

function linkedWorkspace(t, directory = "packages/library", alias = "fixture-library") {
  const { root, project } = fixture(t, {
    "apps/main.ts": `import { b } from '${alias}';
export function a(n: number): number { return n > 0 ? b(n - 1) : n; }`,
    [`${directory}/package.json`]: JSON.stringify({ name: alias, exports: "./index.ts" }),
    [`${directory}/index.ts`]: `import { a } from '../../apps/main';
export function b(n: number): number { return n > 0 ? a(n - 1) : n; }`,
  });
  mkdirSync(join(root, "node_modules"));
  symlinkSync(
    relative(join(root, "node_modules"), join(root, directory)),
    join(root, "node_modules", alias),
    "dir",
  );
  const config = JSON.parse(readFileSync(project, "utf8"));
  config.include = ["apps/*.ts"];
  writeFileSync(project, JSON.stringify(config));
  return { root, project, directory };
}

function analyze(
  project,
  preserveSymlinks,
  includeRealPackage = false,
  directory = "packages/library",
) {
  const config = JSON.parse(readFileSync(project, "utf8"));
  config.compilerOptions.preserveSymlinks = preserveSymlinks;
  config.include = ["apps/*.ts", ...(includeRealPackage ? [`${directory}/*.ts`] : [])];
  writeFileSync(project, JSON.stringify(config));
  const report = analyzeProject(project);
  assert.deepEqual(report.errors, [], JSON.stringify(report.errors));
  return report;
}

function assertPhysicalEvidence(report, directory = "packages/library") {
  const cycle = report.diagnostics.find((diagnostic) => diagnostic.rule === "module-cycle");
  assert.ok(cycle, JSON.stringify(report.diagnostics));
  assert.equal(cycle.key, "apps,packages");
  assert.deepEqual(cycle.evidence.members, ["apps", "packages"]);
  assert.ok(
    report.diagnostics.some(
      (diagnostic) =>
        diagnostic.rule === "tangle" && diagnostic.key.includes(`${directory}/index.ts#b`),
    ),
  );
  const locations = report.diagnostics.flatMap((diagnostic) => [
    diagnostic.location,
    ...(diagnostic.related ?? []).map((related) => related.location),
  ]);
  assert.ok(locations.some((location) => location.file === `${directory}/index.ts`));
  for (const diagnostic of report.diagnostics) assert.ok(!diagnostic.key.includes("node_modules/"));
  for (const location of locations) {
    assert.ok(!location.file.includes("node_modules/"), location.file);
    assert.ok(!location.file.startsWith("../"), location.file);
  }
}

test("linked workspace findings use physical keys, locations and cycle directories in both resolution modes", (t) => {
  const { project } = linkedWorkspace(t);
  const physical = analyze(project, false);
  const preserved = analyze(project, true);
  assert.equal(preserved.files, 2);
  assertPhysicalEvidence(preserved);
  assert.deepEqual(preserved, physical);
});

test("a symlinked analysis root keeps evidence relative to its physical workspace", (t) => {
  const workspace = linkedWorkspace(t);
  analyze(workspace.project, true);
  const container = fixture(t, {});
  const alias = join(container.root, "linked-root");
  symlinkSync(workspace.root, alias, "dir");
  const physical = analyzeProject(workspace.project, { root: workspace.root });
  const linked = analyzeProject(join(alias, "tsconfig.json"), { root: alias });
  assert.deepEqual(linked.errors, [], JSON.stringify(linked.errors));
  assert.equal(linked.root, workspace.root);
  assert.equal(linked.project, workspace.project);
  assertPhysicalEvidence(linked);
  assert.deepEqual(linked.diagnostics, physical.diagnostics);
  assert.deepEqual(linked.dependencies, physical.dependencies);
});

test("test classification follows physical package paths rather than package aliases", (t) => {
  const physicalTest = linkedWorkspace(t, "tests/library", "fixture-library");
  const testByRealPath = analyze(physicalTest.project, false);
  const testByAlias = analyze(physicalTest.project, true);
  assert.equal(testByAlias.files, 2);
  assert.equal(testByAlias.testFiles, 1);
  assert.deepEqual(testByAlias.diagnostics, []);
  assert.deepEqual(testByAlias, testByRealPath);

  const production = linkedWorkspace(t, "packages/library", "test");
  const productionByRealPath = analyze(production.project, false);
  const productionByAlias = analyze(production.project, true);
  assert.equal(productionByAlias.testFiles, 0);
  assertPhysicalEvidence(productionByAlias);
  assert.deepEqual(productionByAlias, productionByRealPath);
});

test("real and linked compiler views retain references without inventing alias identities", (t) => {
  const { project } = linkedWorkspace(t);
  const physical = analyze(project, false, true);
  const preserved = analyze(project, true, true);
  // TypeScript can keep separate SourceFiles for the two views. Preserve their
  // symbol identities while reporting the same physical dependency pairs.
  assert.ok(preserved.files >= 2);
  assert.equal(preserved.dependencies.runtime, 2);
  assertPhysicalEvidence(preserved);
  const identities = (report) =>
    [
      ...new Set(report.diagnostics.map((diagnostic) => `${diagnostic.rule}:${diagnostic.key}`)),
    ].sort();
  assert.deepEqual(identities(preserved), identities(physical));
});
