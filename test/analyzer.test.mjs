import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { analyzeProject } from "../dist/index.js";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function fixture(t, files, compilerOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "deslop-please-ts-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        noEmit: true,
        types: [],
        lib: ["ES2022"],
        ...compilerOptions,
      },
      include: ["**/*.ts"],
    }),
  );
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), source);
  }
  return { root, project: join(root, "tsconfig.json") };
}

function check(project, options) {
  const report = analyzeProject(project, options);
  assert.equal(report.version, 1);
  assert.deepEqual(report.errors, [], JSON.stringify(report.errors));
  return report;
}

const rule = (report, name) => report.diagnostics.filter((d) => d.rule === name);
const recursivePair = {
  "left.ts": `import { right } from './right';
export function left(n: number): number { return n > 0 ? right(n - 1) : n; }
`,
  "right.ts": `import { left } from './left';
export function right(n: number): number { return n > 0 ? left(n - 1) : n; }
`,
};

test("symlinked workspace source inside the selected root participates in cycles", (t) => {
  for (const preserveSymlinks of [false, true]) {
    const { root, project } = fixture(
      t,
      {
        "apps/main.ts": `import { libStep, libValue } from 'fixture-library';
export const appValue = libValue;
export function step(n: number): number { return n > 0 ? libStep(n - 1) : appValue; }`,
        "packages/library/index.ts": `import { step } from '../../apps/main';
export const libValue = 1;
export function libStep(n: number): number { return n > 0 ? step(n - 1) : libValue; }`,
        "packages/library/package.json": JSON.stringify({
          name: "fixture-library",
          types: "./index.ts",
        }),
      },
      { preserveSymlinks },
    );
    const config = JSON.parse(readFileSync(project, "utf8"));
    config.include = ["apps/*.ts"];
    writeFileSync(project, JSON.stringify(config));
    mkdirSync(join(root, "node_modules"));
    symlinkSync(join(root, "packages/library"), join(root, "node_modules/fixture-library"), "dir");
    const report = check(project, { root });
    assert.equal(report.files, 2, `preserveSymlinks=${preserveSymlinks}`);
    assert.equal(rule(report, "module-cycle").length, 1);
    assert.equal(rule(report, "tangle").length, 1);
    assert.ok(report.dependencies.runtime >= 2);
  }
});

test("packages physically outside the selected root or inside node_modules stay excluded", (t) => {
  const { root, project } = fixture(t, {
    "apps/main.ts": `import { outsideRead } from 'fixture-outside';
import { vendorRead } from 'fixture-vendor';
export function appRead(n: number): number { return n > 0 ? outsideRead(n - 1) + vendorRead(n - 1) : 1; }`,
    "node_modules/fixture-vendor/package.json": JSON.stringify({
      name: "fixture-vendor",
      types: "./index.ts",
    }),
    "node_modules/fixture-vendor/index.ts": `import { appRead } from '../../apps/main';
export function vendorRead(n: number): number { return n > 0 ? appRead(n - 1) : 1; }`,
  });
  const outside = mkdtempSync(join(tmpdir(), "deslop-please-external-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(
    join(outside, "package.json"),
    JSON.stringify({ name: "fixture-outside", types: "./index.ts" }),
  );
  const main = relative(outside, join(root, "apps/main")).split("\\").join("/");
  writeFileSync(
    join(outside, "index.ts"),
    `import { appRead } from '${main}';
export function outsideRead(n: number): number { return n > 0 ? appRead(n - 1) : 1; }`,
  );
  symlinkSync(outside, join(root, "node_modules/fixture-outside"), "dir");
  const report = check(project, { root });
  assert.equal(report.files, 1);
  assert.deepEqual(report.diagnostics, []);
});

test("a consumed barrel relay preserves a runtime cycle even when declarations form a chain", (t) => {
  const { project } = fixture(t, {
    "left.ts": `import { right } from './relay';
export function left(n: number) { return right(n) + 1; }`,
    "right.ts": `export function right(n: number) { return n + 1; }`,
    "relay.ts": `export { left } from './left'; export { right } from './right';`,
  });
  const report = check(project);
  assert.equal(rule(report, "module-cycle").length, 1);
  assert.equal(rule(report, "tangle").length, 0);
  assert.ok(rule(report, "module-cycle")[0].evidence.members.includes("relay.ts"));
});

test("actual mutually recursive references produce located, deterministic cycles and tangles", (t) => {
  const { project, root } = fixture(t, recursivePair);
  const report = check(project);
  assert.equal(report.root, root);
  assert.equal(report.project, project);
  assert.equal(report.files, 2);
  assert.equal(rule(report, "module-cycle").length, 1);
  assert.equal(rule(report, "tangle").length, 1);
  assert.ok(report.dependencies.runtime >= 2);
  for (const diagnostic of report.diagnostics) {
    assert.ok(diagnostic.key.length > 0);
    assert.ok(diagnostic.message.length > 0);
    assert.ok(diagnostic.location.file.endsWith(".ts"));
    assert.ok(diagnostic.location.line >= 1);
    assert.ok(diagnostic.location.column >= 1);
    assert.equal(diagnostic.severity, "error");
  }
  assert.deepEqual(analyzeProject(project), report);
});

test("tsconfig paths, renamed imports, and re-export relays resolve to original declarations", (t) => {
  const { project } = fixture(
    t,
    {
      "left.ts": `import { right as callRight } from '@api';
export function left(n: number): number { return n > 0 ? callRight(n - 1) : n; }
`,
      "relay.ts": `export { right } from './right';`,
      "right.ts": recursivePair["right.ts"],
    },
    { baseUrl: ".", paths: { "@api": ["./relay.ts"] } },
  );
  const report = check(project);
  assert.equal(rule(report, "module-cycle").length, 1);
  assert.equal(rule(report, "tangle").length, 1);
});

test("directory coupling cycles are labeled even when individual files form a chain", (t) => {
  const { project } = fixture(t, {
    "left/run.ts": `import { count } from '../right/count';
export function run(n: number) { return n + count; }`,
    "left/limit.ts": `export const limit = 4;`,
    "right/check.ts": `import { limit } from '../left/limit';
export function fits(n: number) { return n <= limit; }`,
    "right/count.ts": `export const count = 2;`,
  });
  const report = check(project);
  const cycles = rule(report, "module-cycle");
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].evidence.graph, "sibling-directory");
  assert.equal(rule(report, "tangle").length, 0);
});

test("anonymous default functions retain declaration identity through default imports", (t) => {
  const { project } = fixture(t, {
    "left.ts": `import right from './right';
export default function(n: number): number { return n > 0 ? right(n - 1) : n; }`,
    "right.ts": `import left from './left';
export default function(n: number): number { return n > 0 ? left(n - 1) : n; }`,
  });
  const report = check(project);
  assert.equal(rule(report, "module-cycle").length, 1);
  assert.equal(rule(report, "tangle").length, 1);
});

test("anonymous default arrows retain declaration identity through default imports", (t) => {
  const { project } = fixture(t, {
    "left.ts": `import right from './right';
export default (n: number): number => n > 0 ? right(n - 1) : n;`,
    "right.ts": `import left from './left';
export default (n: number): number => n > 0 ? left(n - 1) : n;`,
  });
  const report = check(project);
  assert.equal(rule(report, "module-cycle").length, 1);
  assert.equal(rule(report, "tangle").length, 1);
});

test("type-only dependencies do not masquerade as runtime module cycles", (t) => {
  const { project } = fixture(t, {
    "left.ts": `import type { Right } from './right';
export interface Left { right?: Right; }
`,
    "right.ts": `import type { Left } from './left';
export interface Right { left?: Left; }
`,
  });
  const report = check(project);
  assert.equal(rule(report, "module-cycle").length, 0);
  assert.equal(report.dependencies.runtime, 0);
  assert.ok(report.dependencies.typeOnly >= 2);
});

test("inlined const-enum references are compile-time dependencies unless isolatedModules retains them", (t) => {
  const files = {
    "left.ts": `import { right } from './right';
export const enum Left { Value = 1 }
export function left(n: number) { return n + right; }`,
    "right.ts": `import { Left } from './left';
export const right = Left.Value;`,
  };
  const inlined = check(fixture(t, files).project);
  assert.equal(rule(inlined, "module-cycle").length, 0);
  assert.equal(inlined.dependencies.runtime, 1);
  assert.ok(inlined.dependencies.typeOnly >= 1);
  const retained = check(fixture(t, files, { isolatedModules: true }).project);
  assert.equal(rule(retained, "module-cycle").length, 1);
});

test("inline type re-exports retain their runtime relay only under verbatimModuleSyntax", (t) => {
  const files = {
    "left.ts": `export { type Right } from './right'; export const left = 1;`,
    "right.ts": `import { left } from './left';
export interface Right { value: number; }
export const right = left + 1;`,
  };
  const erased = fixture(t, files);
  assert.equal(rule(check(erased.project), "module-cycle").length, 0);
  const retained = fixture(t, files, { verbatimModuleSyntax: true });
  assert.equal(rule(check(retained.project), "module-cycle").length, 1);
});

test("side-effect import cycles are still runtime module cycles", (t) => {
  const { project } = fixture(t, {
    "left.ts": `import './right'; export const left = 1;`,
    "right.ts": `import './left'; export const right = 2;`,
  });
  const report = check(project);
  assert.equal(rule(report, "module-cycle").length, 1);
});

test("unused imported names do not create a consumer interface", (t) => {
  const functions = Array.from(
    { length: 9 },
    (_, i) => `export function item${i}(n: number) { return n + ${i}; }`,
  ).join("\n");
  const { project } = fixture(t, {
    "store/index.ts": functions,
    "app.ts": `import { ${Array.from({ length: 9 }, (_, i) => `item${i}`).join(", ")} } from './store';
export const answer = 42;`,
  });
  const report = check(project);
  assert.equal(rule(report, "shallow-module").length, 0);
});

test("field leak uses declaration identity and reports mutation of a guarded class field", (t) => {
  const { project } = fixture(t, {
    "queue.ts": `export class Queue {
  items: number[] = [];
  private capacity = 4;
  add(n: number) {
    if (this.items.length < this.capacity) this.items.push(n);
  }
}
export class Other { items: number[] = []; }
`,
    "app.ts": `import { Queue, Other } from './queue';
export function edit(queue: Queue, other: Other) {
  queue.items.push(1);
  other.items.push(2);
}
`,
  });
  const leaks = rule(check(project), "field-leak");
  assert.equal(leaks.length, 1);
  assert.match(leaks[0].key, /Queue/);
  assert.match(leaks[0].key, /items/);
  assert.doesNotMatch(leaks[0].key, /Other/);
  assert.equal(leaks[0].location.file, "app.ts");
  assert.ok(leaks[0].related?.length > 0);
});

test("trivial getters and forwarding methods cannot hide a mutable field leak", (t) => {
  const { project } = fixture(t, {
    "queue.ts": `export class Queue {
  private storage: number[] = [];
  private capacity = 4;
  get items() { return this.storage; }
  raw() { return this.items; }
  add(n: number) {
    if (this.storage.length < this.capacity) this.storage.push(n);
  }
}
`,
    "app.ts": `import { Queue } from './queue';
export function edit(queue: Queue) { queue.raw().push(1); }
`,
  });
  const leaks = rule(check(project), "field-leak");
  assert.equal(leaks.length, 1);
  assert.match(leaks[0].key, /storage/);
  assert.equal(leaks[0].location.file, "app.ts");
});

test("reading primitive fields and calling their value methods is not a field leak", (t) => {
  const { project } = fixture(t, {
    "meter.ts": `export class Meter {
  value = 0;
  label = 'count';
  private limit = 4;
  increase() { if (this.value < this.limit) this.value += 1; }
}
`,
    "app.ts": `import { Meter } from './meter';
export function display(meter: Meter) {
  return meter.value + meter.value.toFixed(2).length + meter.label.length;
}
`,
  });
  assert.equal(rule(check(project), "field-leak").length, 0);
});

test("class arrow methods own state and unchanged setters expose their actual field writes", (t) => {
  const { project } = fixture(t, {
    "queue.ts": `export class Queue {
  items: number[] = [];
  private total = 0;
  private limit = 4;
  add = (value: number) => {
    if (this.items.length < this.limit) {
      this.items.push(value);
      this.total += 1;
    }
  };
  set count(value: number) { this.total = value; }
}
`,
    "app.ts": `import { Queue } from './queue';
export function edit(queue: Queue) { queue.count = 3; queue.items.push(4); }
`,
  });
  const leaks = rule(check(project), "field-leak");
  assert.equal(leaks.length, 2);
  assert.ok(leaks.some((d) => d.key.endsWith("#items")));
  assert.ok(leaks.some((d) => d.key.endsWith("#total")));
  assert.ok(leaks.every((d) => d.location.file === "app.ts"));
});

test("primitive getter and accessor-method results remain copied values", (t) => {
  const { project } = fixture(t, {
    "meter.ts": `export class Meter {
  private current = 0;
  private limit = 4;
  get reading() { return this.current; }
  read() { return this.current; }
  increase() { if (this.current < this.limit) this.current += 1; }
}
`,
    "app.ts": `import { Meter } from './meter';
export function display(meter: Meter) { return meter.reading + meter.read() + 1; }
`,
  });
  assert.equal(rule(check(project), "field-leak").length, 0);
});

test("a wide actual consumer interface is shallow; unused exports alone are not", (t) => {
  const functions = Array.from(
    { length: 9 },
    (_, i) => `export function item${i}(n: number) { return n + ${i}; }`,
  ).join("\n");
  const calls = Array.from({ length: 8 }, (_, i) => `item${i}(n)`).join(" + ");
  const names = Array.from({ length: 8 }, (_, i) => `item${i}`).join(", ");
  const { project } = fixture(t, {
    "store/index.ts": functions,
    "app.ts": `import { ${names} } from './store';
export function useStore(n: number) { return ${calls}; }
`,
  });
  assert.ok(rule(check(project), "shallow-module").length >= 1);
});

test("generated files, dependency files, and declarations do not enter findings", (t) => {
  const { project } = fixture(t, {
    "app.ts": `export const answer = 42;`,
    "generated/left.ts": recursivePair["left.ts"],
    "generated/right.ts": recursivePair["right.ts"],
    "types.d.ts": `declare const omitted: string;`,
    "node_modules/dep/index.ts": `export const ignored = 1;`,
  });
  const report = check(project);
  assert.equal(report.files, 1);
  assert.deepEqual(report.diagnostics, []);
});

test("an ordinary generated-marker string does not silently exclude source", (t) => {
  const { project } = fixture(t, {
    ...recursivePair,
    "left.ts": `export const label = '@generated';\n${recursivePair["left.ts"]}`,
  });
  const report = check(project);
  assert.equal(report.files, 2);
  assert.equal(rule(report, "module-cycle").length, 1);
});

test("explicit directory exclusion is relative to the project root", (t) => {
  const { project } = fixture(t, {
    "app.ts": `export const answer = 42;`,
    "legacy/left.ts": recursivePair["left.ts"],
    "legacy/right.ts": recursivePair["right.ts"],
  });
  const report = check(project, { exclude: ["legacy"] });
  assert.equal(report.files, 1);
  assert.deepEqual(report.diagnostics, []);
});

test("test-only cycles are counted for layout but do not become production coupling", (t) => {
  const { project } = fixture(t, {
    "app.ts": `export const answer = 42;`,
    "tests/left.ts": recursivePair["left.ts"],
    "tests/right.ts": recursivePair["right.ts"],
  });
  const report = check(project);
  assert.equal(report.files, 3);
  assert.equal(report.testFiles, 2);
  assert.equal(rule(report, "module-cycle").length, 0);
  assert.equal(rule(report, "tangle").length, 0);
});

test("build is a valid source directory unless it is the configured output", (t) => {
  const { project } = fixture(t, {
    "build/left.ts": recursivePair["left.ts"],
    "build/right.ts": recursivePair["right.ts"],
  });
  const report = check(project);
  assert.equal(report.files, 2);
  assert.equal(rule(report, "module-cycle").length, 1);
});

test("layout findings are advisory and count only analyzed source files", (t) => {
  const files = Object.fromEntries(
    Array.from({ length: 16 }, (_, i) => [`wide/file${i}.ts`, `export const item${i} = ${i};`]),
  );
  files["long.ts"] = `${"// an intentionally long source fixture\n".repeat(2001)}export {};\n`;
  const { project } = fixture(t, files);
  const report = check(project);
  assert.equal(rule(report, "wide-directory").length, 1);
  assert.equal(rule(report, "long-file").length, 1);
  assert.ok(report.diagnostics.every((d) => d.severity === "warning"));
  const result = spawnSync(process.execPath, [cliPath, "--project", project, "--format", "json"], {
    encoding: "utf8",
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});

test("CLI report-only preserves findings, and repeated projects preserve individual roots", (t) => {
  const first = fixture(t, recursivePair);
  const second = fixture(t, { "clean.ts": `export const answer = 42;` });
  const normal = spawnSync(
    process.execPath,
    [cliPath, "--project", first.project, "--format", "json"],
    { encoding: "utf8" },
  );
  assert.equal(normal.error, undefined);
  assert.equal(normal.status, 1, normal.stderr);
  assert.equal(JSON.parse(normal.stdout).version, 1);
  const reportOnly = spawnSync(
    process.execPath,
    [cliPath, "--project", first.project, "--report-only", "--format", "json"],
    { encoding: "utf8" },
  );
  assert.equal(reportOnly.error, undefined);
  assert.equal(reportOnly.status, 0, reportOnly.stderr);
  assert.deepEqual(
    JSON.parse(reportOnly.stdout).diagnostics,
    JSON.parse(normal.stdout).diagnostics,
  );
  const multiple = spawnSync(
    process.execPath,
    [
      cliPath,
      "--project",
      first.project,
      "--project",
      second.project,
      "--format",
      "json",
      "--report-only",
    ],
    { encoding: "utf8" },
  );
  assert.equal(multiple.error, undefined);
  assert.equal(multiple.status, 0, multiple.stderr);
  const report = JSON.parse(multiple.stdout);
  assert.equal(report.version, 1);
  assert.deepEqual(
    report.projects.map((p) => p.root),
    [first.root, second.root],
  );
});

test("configuration and source errors remain errors in report-only mode", (t) => {
  const { project, root } = fixture(t, { "broken.ts": `export const value: number = 'wrong';` });
  const sourceError = analyzeProject(project);
  assert.ok(sourceError.errors.length > 0);
  const invalid = spawnSync(
    process.execPath,
    [cliPath, "--project", project, "--report-only", "--format", "json"],
    { encoding: "utf8" },
  );
  assert.equal(invalid.error, undefined);
  assert.equal(invalid.status, 2, invalid.stderr);
  assert.ok(JSON.parse(invalid.stdout).errors.length > 0);
  const missing = spawnSync(
    process.execPath,
    [cliPath, "--project", join(root, "missing.json"), "--report-only", "--format", "json"],
    { encoding: "utf8" },
  );
  assert.equal(missing.error, undefined);
  assert.equal(missing.status, 2, missing.stderr);
  assert.ok(JSON.parse(missing.stdout).errors.length > 0);
});

test("bounded analysis fails visibly instead of returning an apparently clean report", (t) => {
  const { project } = fixture(t, recursivePair);
  assert.ok(analyzeProject(project, { maxFiles: 1 }).errors.length > 0);
});
