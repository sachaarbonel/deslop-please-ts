import assert from "node:assert/strict";
import test from "node:test";
import { analyzeProject } from "../dist/index.js";
import { fixture } from "./fixture.mjs";

function report(t, files) {
  const { project } = fixture(t, files);
  const result = analyzeProject(project);
  assert.deepEqual(result.errors, []);
  return result;
}

function findings(result, rule) {
  return result.diagnostics.filter((diagnostic) => diagnostic.rule === rule);
}

for (const heritage of ["interface extends", "class implements", "class extends"]) {
  test(`${heritage} dependencies retain their type or runtime meaning through aliases and qualification`, (t) => {
    for (const qualified of [false, true]) {
      const imported = qualified
        ? "import * as Contract from './parent';"
        : "import { Parent as Contract } from './parent';";
      const parentName = qualified ? "Contract.Parent" : "Contract";
      const declaration =
        heritage === "interface extends"
          ? `export interface Child extends ${parentName} { name: string; }`
          : heritage === "class implements"
            ? `export class Child implements ${parentName} { id = 1; }`
            : `export class Child extends ${parentName} {}`;
      const parent =
        heritage === "class extends"
          ? "export class Parent { id = childTag.length; }"
          : "export interface Parent { id: number; }";
      const result = report(t, {
        "child.ts": `${imported}\n${declaration}\nexport const childTag = 'child';`,
        "parent.ts": `import { childTag } from './child';\n${parent}\nexport const parentSize = childTag.length;`,
      });
      const runtime = heritage === "class extends";
      assert.equal(result.dependencies.runtime, runtime ? 2 : 1, `qualified=${qualified}`);
      assert.equal(result.dependencies.typeOnly, runtime ? 0 : 1, `qualified=${qualified}`);
      assert.equal(findings(result, "module-cycle").length, runtime ? 1 : 0);
    }
  });
}

function accessors(t, getter, setter, app) {
  return [false, true].map((setterFirst) =>
    report(t, {
      "store.ts": `export class Store {
  private readStorage: number[] = [];
  private writtenStorage: number[] = [];
  private limit = 4;
  ${setterFirst ? `${setter}\n${getter}` : `${getter}\n${setter}`}
}`,
      "app.ts": `import { Store } from './store';\n${app}`,
    }),
  );
}

test("a trivial getter leaks only its read field while a transforming setter keeps its own state", (t) => {
  const results = accessors(
    t,
    "get values() { return this.readStorage; }",
    "set values(value: number[]) { if (value.length <= this.limit) this.writtenStorage = value.slice(); }",
    `export function inspect(store: Store) { store.values.push(7); }
export function update(store: Store) { store.values = [2]; }`,
  );
  for (const result of results) {
    const leaks = findings(result, "field-leak");
    assert.equal(leaks.length, 1);
    assert.equal(leaks[0].key, "store.ts#Store#readStorage");
    assert.equal(leaks[0].evidence.references, 1);
    assert.equal(leaks[0].related[0].location.line, 2);
  }
});

test("a trivial setter leaks only its written field while a computed getter returns an independent value", (t) => {
  const results = accessors(
    t,
    "get values() { return this.readStorage.slice(0, this.limit); }",
    "set values(value: number[]) { this.writtenStorage = value; }",
    `export function inspect(store: Store) { store.values.push(7); }
export function update(store: Store) { store.values = [2]; }`,
  );
  for (const result of results) {
    const leaks = findings(result, "field-leak");
    assert.equal(leaks.length, 1);
    assert.equal(leaks[0].key, "store.ts#Store#writtenStorage");
    assert.equal(leaks[0].evidence.references, 1);
    assert.equal(leaks[0].related[0].location.line, 3);
  }
});

test("computed getters and transforming setters preserve their boundary in either declaration order", (t) => {
  const results = accessors(
    t,
    "get values() { return this.readStorage.slice(0, this.limit); }",
    "set values(value: number[]) { if (value.length <= this.limit) this.writtenStorage = value.slice(); }",
    `export function use(store: Store) { store.values.push(7); store.values = [2]; }`,
  );
  for (const result of results) assert.deepEqual(findings(result, "field-leak"), []);
});

test("compound property updates read a copied getter value and invoke the selected setter", (t) => {
  for (const setterFirst of [false, true]) {
    for (const setterWraps of [false, true]) {
      const getter = "get score() { return this.value; }";
      const setter = setterWraps
        ? "set score(value: number) { this.value = value; }"
        : "set score(value: number) { this.value = Math.min(value, this.limit); }";
      const result = report(t, {
        "meter.ts": `export class Meter {
  private value = 0;
  private limit = 4;
  advance() { if (this.value < this.limit) this.value += 1; }
  ${setterFirst ? `${setter}\n${getter}` : `${getter}\n${setter}`}
}`,
        "app.ts": `import { Meter } from './meter';
export function edit(meter: Meter) { meter.score++; }`,
      });
      const leaks = findings(result, "field-leak");
      assert.equal(
        leaks.length,
        setterWraps ? 1 : 0,
        `setterFirst=${setterFirst}, setterWraps=${setterWraps}`,
      );
      if (setterWraps) assert.equal(leaks[0].evidence.references, 1);
    }
  }
});
