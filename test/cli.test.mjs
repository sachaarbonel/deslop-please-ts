import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import { fixture } from "./fixture.mjs";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const require = createRequire(import.meta.url);
const recursivePair = {
  "left.ts": `import { right } from './right';
export function left(n: number): number { return n > 0 ? right(n - 1) : n; }`,
  "right.ts": `import { left } from './left';
export function right(n: number): number { return n > 0 ? left(n - 1) : n; }`,
};

function run(args, options = {}) {
  const env = { ...process.env };
  delete env.CI;
  Object.assign(env, options.env);
  const result = spawnSync(process.execPath, [options.cli ?? cliPath, ...args], {
    encoding: "utf8",
    env,
    ...(options.cwd ? { cwd: options.cwd } : {}),
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  return result;
}

function json(args, options) {
  const result = run([...args, "--format", "json"], options);
  assert.notEqual(result.stdout, "", result.stderr);
  return { ...result, report: JSON.parse(result.stdout) };
}

test("--version reads metadata beside a relocated real compiled CLI", (t) => {
  const { root } = fixture(t, {});
  const installed = join(root, "installed");
  cpSync(new URL("../dist/", import.meta.url), join(installed, "dist"), { recursive: true });
  const metadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  metadata.version = "91.7.3-review.9";
  writeFileSync(join(installed, "package.json"), JSON.stringify(metadata));
  mkdirSync(join(installed, "node_modules"));
  symlinkSync(
    dirname(require.resolve("typescript/package.json")),
    join(installed, "node_modules/typescript"),
    "dir",
  );
  const result = run(["--version"], { cli: join(installed, "dist/cli.js"), cwd: root });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "91.7.3-review.9");
});

test("--root and repeated --exclude change actual scope and report exclusions", (t) => {
  const files = { "inside/main.ts": "export const value = 1;" };
  for (const directory of ["outside", "inside/first", "inside/second"])
    for (const [name, source] of Object.entries(recursivePair))
      files[`${directory}/${name}`] = source;
  const { root, project } = fixture(t, files);
  const args = [
    "--project",
    project,
    "--root",
    "inside",
    "--exclude",
    "inside/first",
    "--exclude",
    "inside/second",
  ];
  const result = json(args, { cwd: root });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.root, join(root, "inside"));
  assert.equal(result.report.compilerVersion, ts.version);
  assert.equal(result.report.files, 1);
  assert.equal(result.report.ignored.configured, 4);
  assert.deepEqual(result.report.exclusions, ["inside/first", "inside/second"]);
  assert.deepEqual(result.report.diagnostics, []);
  const text = run(args, { cwd: root });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /4 source files excluded/);
  assert.ok(text.stdout.includes(`TypeScript ${ts.version}`));
  assert.ok(text.stdout.includes(join(root, "inside")));
});

test("explicit baseline adoption retains every finding and reports known debt", (t) => {
  const { root, project } = fixture(t, recursivePair);
  const file = join(root, "baseline.json");
  const created = json(["--project", project, "--write-baseline", file]);
  assert.equal(created.status, 0, created.stderr);
  assert.ok(created.report.diagnostics.some((item) => item.severity === "error"));
  assert.equal(created.report.baseline.new, created.report.diagnostics.length);
  assert.equal(created.report.baseline.written, true);
  const document = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(document.kind, "deslop-please-ts-baseline");
  assert.equal(document.version, 1);
  assert.ok(
    document.entries.every(
      (entry) =>
        entry.project === "tsconfig.json" &&
        entry.root === "." &&
        entry.compilerVersion === ts.version,
    ),
  );
  const checked = json(["--project", project, "--baseline", file]);
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(checked.report.diagnostics.length, created.report.diagnostics.length);
  assert.ok(checked.report.diagnostics.every((item) => item.baseline === "known"));
  assert.equal(checked.report.baseline.known, checked.report.diagnostics.length);
  assert.equal(checked.report.baseline.new, 0);
  const text = run(["--project", project, "--baseline", file]);
  for (const diagnostic of checked.report.diagnostics)
    assert.ok(text.stdout.includes(diagnostic.message));
  assert.match(text.stdout, /0 new, 0 resolved identities/);
});

test("a same-count replacement is new debt instead of passing a numeric baseline", (t) => {
  const { root, project } = fixture(t, recursivePair);
  const file = join(root, "baseline.json");
  const original = json(["--project", project, "--write-baseline", file]);
  assert.equal(original.status, 0, original.stderr);
  rmSync(join(root, "left.ts"));
  rmSync(join(root, "right.ts"));
  writeFileSync(
    join(root, "fresh-left.ts"),
    recursivePair["left.ts"].replace("'./right'", "'./fresh-right'"),
  );
  writeFileSync(
    join(root, "fresh-right.ts"),
    recursivePair["right.ts"].replace("'./left'", "'./fresh-left'"),
  );
  const result = json(["--project", project, "--baseline", file]);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.report.diagnostics.length, original.report.diagnostics.length);
  assert.equal(result.report.baseline.known, 0);
  assert.equal(result.report.baseline.new, original.report.diagnostics.length);
  assert.equal(result.report.baseline.resolved, original.report.diagnostics.length);
  assert.ok(result.report.diagnostics.every((item) => item.baseline === "new"));
  const advisory = json(["--project", project, "--baseline", file, "--report-only"]);
  assert.equal(advisory.status, 0, advisory.stderr);
  assert.deepEqual(advisory.report.diagnostics, result.report.diagnostics);
});

test("resolved baseline identities stay visible without automatically rewriting debt", (t) => {
  const { root, project } = fixture(t, recursivePair);
  const file = join(root, "baseline.json");
  const created = json(["--project", project, "--write-baseline", file]);
  assert.equal(created.status, 0, created.stderr);
  const before = readFileSync(file, "utf8");
  writeFileSync(join(root, "right.ts"), "export function right(n: number): number { return n; }");
  const result = json(["--project", project, "--baseline", file]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.report.diagnostics, []);
  assert.equal(result.report.baseline.resolved, created.report.diagnostics.length);
  assert.equal(result.report.baseline.resolvedEntries.length, created.report.diagnostics.length);
  assert.equal(readFileSync(file, "utf8"), before);
  const text = run(["--project", project, "--baseline", file]);
  assert.match(text.stdout, /resolved error\[module-cycle\]/);
});

test("baseline identities survive a relocated checkout", (t) => {
  const first = fixture(t, recursivePair);
  const file = join(first.root, "baseline.json");
  const created = json(["--project", first.project, "--write-baseline", file]);
  assert.equal(created.status, 0, created.stderr);
  const relocated = fixture(t, {});
  cpSync(first.root, relocated.root, { recursive: true });
  const result = json([
    "--project",
    relocated.project,
    "--baseline",
    join(relocated.root, "baseline.json"),
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.baseline.known, created.report.diagnostics.length);
  assert.equal(result.report.baseline.new, 0);
  assert.equal(result.report.baseline.resolved, 0);
  assert.ok(!readFileSync(join(relocated.root, "baseline.json"), "utf8").includes(first.root));
});

test("same-key projects remain independent and explicit writes preserve unselected scopes", (t) => {
  const first = fixture(t, recursivePair);
  const second = fixture(t, recursivePair);
  const file = join(first.root, "baseline.json");
  const initial = json(["--project", first.project, "--write-baseline", file]);
  assert.equal(initial.status, 0, initial.stderr);
  const mixed = json(["--project", first.project, "--project", second.project, "--baseline", file]);
  assert.equal(mixed.status, 1, mixed.stderr);
  const [known, fresh] = mixed.report.projects;
  assert.deepEqual(
    known.diagnostics.map((item) => item.key),
    fresh.diagnostics.map((item) => item.key),
  );
  assert.equal(known.baseline.new, 0);
  assert.equal(fresh.baseline.known, 0);
  assert.equal(fresh.baseline.new, fresh.diagnostics.length);
  assert.equal(fresh.baseline.resolved, 0);
  const extended = json(["--project", second.project, "--write-baseline", file]);
  assert.equal(extended.status, 0, extended.stderr);
  const accepted = json([
    "--project",
    first.project,
    "--project",
    second.project,
    "--baseline",
    file,
  ]);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(accepted.report.baseline.new, 0);
  assert.equal(accepted.report.baseline.known, initial.report.diagnostics.length * 2);
});

test("severity escalation cannot reuse a warning acceptance", (t) => {
  const { root, project } = fixture(t, recursivePair);
  const file = join(root, "baseline.json");
  const created = json(["--project", project, "--write-baseline", file]);
  assert.equal(created.status, 0, created.stderr);
  const document = JSON.parse(readFileSync(file, "utf8"));
  for (const entry of document.entries) entry.severity = "warning";
  writeFileSync(file, JSON.stringify(document));
  const result = json(["--project", project, "--baseline", file]);
  assert.equal(result.status, 1, result.stderr);
  assert.ok(
    result.report.diagnostics.some((item) => item.severity === "error" && item.baseline === "new"),
  );
  assert.equal(result.report.baseline.known, 0);
});

test("a changed compiler context is new acceptance work and current compiler stays explicit", (t) => {
  const { root, project } = fixture(t, recursivePair);
  const file = join(root, "baseline.json");
  const created = json(["--project", project, "--write-baseline", file]);
  assert.equal(created.status, 0, created.stderr);
  const document = JSON.parse(readFileSync(file, "utf8"));
  for (const entry of document.entries) entry.compilerVersion = "0.0.0-review";
  writeFileSync(file, JSON.stringify(document));
  const result = json(["--project", project, "--baseline", file]);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.report.compilerVersion, ts.version);
  assert.equal(result.report.baseline.known, 0);
  assert.equal(result.report.baseline.new, result.report.diagnostics.length);
  assert.ok(
    result.report.baseline.resolvedEntries.every(
      (entry) => entry.compilerVersion === "0.0.0-review",
    ),
  );
});

test("new warning findings remain visible and do not fail a baseline ratchet", (t) => {
  const { root, project } = fixture(t, { "main.ts": "export const value = 1;" });
  const file = join(root, "baseline.json");
  const created = json(["--project", project, "--write-baseline", file]);
  assert.equal(created.status, 0, created.stderr);
  writeFileSync(
    join(root, "long.ts"),
    "// advisory layout fixture\n".repeat(2001) + "export const value = 2;\n",
  );
  const result = json(["--project", project, "--baseline", file]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(
    result.report.diagnostics.some((item) => item.rule === "long-file" && item.baseline === "new"),
  );
  assert.ok(result.report.diagnostics.every((item) => item.severity === "warning"));
});

test("missing, malformed and nonportable baseline files fail visibly even in report-only mode", (t) => {
  const { root, project } = fixture(t, recursivePair);
  const file = join(root, "baseline.json");
  const missing = run(["--project", project, "--baseline", file, "--report-only"]);
  assert.equal(missing.status, 2);
  assert.ok(missing.stderr.includes(file));
  writeFileSync(file, "{not JSON");
  const malformed = run(["--project", project, "--baseline", file, "--report-only"]);
  assert.equal(malformed.status, 2);
  assert.match(malformed.stderr, /Invalid baseline/);
  rmSync(file);
  const created = json(["--project", project, "--write-baseline", file]);
  assert.equal(created.status, 0, created.stderr);
  const document = JSON.parse(readFileSync(file, "utf8"));
  document.entries[0].project = project;
  writeFileSync(file, JSON.stringify(document));
  const absolute = run(["--project", project, "--baseline", file, "--report-only"]);
  assert.equal(absolute.status, 2);
  assert.match(absolute.stderr, /normalized relative path/);
});

test("compiler errors stay fatal and cannot overwrite or manufacture a baseline", (t) => {
  const { root, project } = fixture(t, recursivePair);
  const file = join(root, "baseline.json");
  const created = json(["--project", project, "--write-baseline", file]);
  assert.equal(created.status, 0, created.stderr);
  const before = readFileSync(file, "utf8");
  writeFileSync(join(root, "broken.ts"), "export const number: number = 'wrong';");
  const read = json(["--project", project, "--baseline", file, "--report-only"]);
  assert.equal(read.status, 2, read.stderr);
  assert.ok(read.report.errors.some((error) => error.kind === "compiler"));
  assert.equal(read.report.baseline.resolved, 0);
  const rewrite = json(["--project", project, "--write-baseline", file, "--report-only"]);
  assert.equal(rewrite.status, 2, rewrite.stderr);
  assert.equal(rewrite.report.baseline.written, false);
  assert.equal(readFileSync(file, "utf8"), before);
  const absent = join(root, "new-baseline.json");
  const fresh = json(["--project", project, "--write-baseline", absent]);
  assert.equal(fresh.status, 2, fresh.stderr);
  assert.equal(existsSync(absent), false);
});

test("configuration errors cannot write an apparently clean baseline", (t) => {
  const { root, project } = fixture(t, { "main.ts": "export const value = 1;" });
  writeFileSync(project, JSON.stringify({ compilerOptions: { module: "not-a-module" } }));
  const file = join(root, "baseline.json");
  const result = json(["--project", project, "--write-baseline", file, "--report-only"]);
  assert.equal(result.status, 2, result.stderr);
  assert.ok(result.report.errors.some((error) => error.kind === "config"));
  assert.equal(existsSync(file), false);
});

test("CI presence prevents writes but still allows reading an explicit baseline", (t) => {
  const { root, project } = fixture(t, recursivePair);
  const file = join(root, "baseline.json");
  const refused = run(["--project", project, "--write-baseline", file], { env: { CI: "" } });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /CI is set/);
  assert.equal(existsSync(file), false);
  const created = json(["--project", project, "--write-baseline", file]);
  assert.equal(created.status, 0, created.stderr);
  const accepted = json(["--project", project, "--baseline", file], { env: { CI: "true" } });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(accepted.report.baseline.new, 0);
});

test("baseline writes refuse unrelated files and read/write modes are exclusive", (t) => {
  const { root, project } = fixture(t, { "main.ts": "export const value = 1;" });
  const file = join(root, "important.json");
  const original = '{"kind":"another-tool","entries":[]}';
  writeFileSync(file, original);
  const refused = run(["--project", project, "--write-baseline", file]);
  assert.equal(refused.status, 2);
  assert.equal(readFileSync(file, "utf8"), original);
  const conflicting = run([
    "--project",
    project,
    "--baseline",
    file,
    "--write-baseline",
    join(root, "new.json"),
  ]);
  assert.equal(conflicting.status, 2);
  assert.match(conflicting.stderr, /mutually exclusive/);
  assert.equal(existsSync(join(root, "new.json")), false);
});
