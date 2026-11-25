import path from "node:path";
import ts from "typescript";
import { components } from "./graph";
import { functionBody, rootItem, slash } from "./model";
import type { Item, Model, ModuleEdge, Reference } from "./model";
import type { Diagnostic, Related } from "./types";

const SHOWN = 7;
const MAX_EVIDENCE = 20;

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function graph<T>(nodes: readonly T[], ties: readonly (readonly [T, T])[]): number[][] {
  const index = new Map(nodes.map((node, at) => [node, at]));
  const edges = nodes.map(() => new Set<number>());
  for (const [from, to] of ties) {
    const a = index.get(from);
    const b = index.get(to);
    if (a !== undefined && b !== undefined && a !== b) edges[a]?.add(b);
  }
  return components(edges.map((edge) => [...edge].sort((a, b) => a - b)));
}

function evidence(model: Model, references: readonly Reference[]): Related[] {
  const seen = new Set<string>();
  const related: Related[] = [];
  for (const reference of references) {
    const location = model.location(reference.node);
    const message = `${reference.holder?.key ?? location.file} uses ${reference.item.key}${reference.through ? ` through ${reference.through.key}` : ""}${reference.typeOnly ? " (type only)" : ""}`;
    const key = `${location.file}:${location.line}:${location.column}:${message}`;
    if (!seen.has(key)) {
      seen.add(key);
      related.push({ location, message });
    }
  }
  return related
    .sort(
      (a, b) =>
        compare(a.location.file, b.location.file) ||
        a.location.line - b.location.line ||
        a.location.column - b.location.column ||
        compare(a.message, b.message),
    )
    .slice(0, MAX_EVIDENCE);
}

function moduleCycles(model: Model): Diagnostic[] {
  // Project a file dependency onto the two children of its least common
  // directory. This detects directory-level cycles even when its individual
  // declarations form a chain, as in upstream's sibling-module algorithm.
  const groups = new Map<string, Map<string, { from: string; to: string; edge: ModuleEdge }>>();
  for (const edge of model.modules) {
    if (edge.typeOnly || edge.from === edge.to) continue;
    const from = model.location(edge.from).file.split("/");
    const to = model.location(edge.to).file.split("/");
    let common = 0;
    while (common < from.length - 1 && common < to.length - 1 && from[common] === to[common])
      common++;
    const parent = from.slice(0, common).join("/") || ".";
    const a = from.slice(0, common + 1).join("/");
    const b = to.slice(0, common + 1).join("/");
    if (a === b) continue;
    let group = groups.get(parent);
    if (!group) {
      group = new Map();
      groups.set(parent, group);
    }
    const key = `${a}\0${b}`;
    if (!group.has(key)) group.set(key, { from: a, to: b, edge });
  }
  const diagnostics: Diagnostic[] = [];
  for (const [parent, grouped] of [...groups].sort(([a], [b]) => compare(a, b))) {
    const ties = [...grouped.values()];
    const nodes = [...new Set(ties.flatMap((tie) => [tie.from, tie.to]))].sort(compare);
    for (const component of graph(
      nodes,
      ties.map((tie) => [tie.from, tie.to]),
    )) {
      const members = component.flatMap((index) => nodes[index] ?? []);
      const set = new Set(members);
      const inside = ties
        .filter((tie) => set.has(tie.from) && set.has(tie.to))
        .sort((a, b) => compare(a.from, b.from) || compare(a.to, b.to));
      const first = inside[0];
      if (!first) continue;
      const structural = inside.some(
        (tie) =>
          model.location(tie.edge.from).file !== tie.from ||
          model.location(tie.edge.to).file !== tie.to,
      );
      diagnostics.push({
        rule: "module-cycle",
        key: members.join(","),
        severity: "error",
        message: `${members.length} sibling modules in ${parent} form a ${structural ? "directory coupling" : "source dependency"} cycle through runtime references`,
        location: model.location(first.edge.node),
        related: inside.slice(0, MAX_EVIDENCE).map((tie) => ({
          location: model.location(tie.edge.node),
          message: `${tie.from} uses ${tie.to} via ${tie.edge.name}`,
        })),
        evidence: {
          members,
          edges: inside.length,
          dependencyKinds: ["runtime"],
          graph: structural ? "sibling-directory" : "source-file",
        },
      });
    }
  }
  return diagnostics;
}

function thingGraph(model: Model): { tangles: Item[][]; tangleOf: Map<Item, number> } {
  const things = model.items.filter((item) => !item.owner);
  const ties: [Item, Item][] = [];
  for (const reference of model.references)
    if (reference.holder) ties.push([rootItem(reference.holder), rootItem(reference.item)]);
  const tangles = graph(things, ties).map((component) =>
    component.flatMap((index) => things[index] ?? []),
  );
  const tangleOf = new Map<Item, number>();
  tangles.forEach((members, index) => members.forEach((item) => tangleOf.set(item, index)));
  return { tangles, tangleOf };
}

function fieldLeaks(model: Model, tangleOf: Map<Item, number>): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const owned = new Map<Item, Item[]>();
  for (const item of model.items)
    if (item.kind === "field" && item.owner && ts.isClassDeclaration(rootItem(item).node)) {
      const owner = rootItem(item);
      const fields = owned.get(owner) ?? [];
      fields.push(item);
      owned.set(owner, fields);
    }
  const usedFields = new Map<Item, Reference[]>();
  const workingOwners = new Set<Item>();
  for (const reference of model.references)
    if (reference.item.kind === "field" && !reference.typeOnly) {
      const owner = rootItem(reference.item);
      const uses = usedFields.get(owner) ?? [];
      uses.push(reference);
      usedFields.set(owner, uses);
    }
  for (const reference of model.rawReferences)
    if (
      reference.item.kind === "field" &&
      reference.item.owner &&
      reference.holder?.owner === reference.item.owner &&
      reference.holder.kind === "function" &&
      !model.wrappers.has(reference.holder) &&
      !reference.typeOnly
    )
      workingOwners.add(rootItem(reference.item));
  for (const [owner, fields] of owned) {
    const outside = (reference: Reference): boolean => {
      if (!reference.holder) return true;
      const user = rootItem(reference.holder);
      return (
        user !== owner &&
        (tangleOf.get(owner) === undefined || tangleOf.get(user) !== tangleOf.get(owner))
      );
    };
    const uses = usedFields.get(owner) ?? [];
    // A record or injected readonly options bag with no state behavior is not
    // a state-owning abstraction. Constructors and wrappers alone do not count.
    const working = workingOwners.has(owner);
    const kept = fields.filter(
      (field) => !uses.some((reference) => reference.item === field && outside(reference)),
    );
    if (!working || kept.length === 0) continue;
    for (const field of fields) {
      const leaked = uses.filter(
        (reference) => reference.item === field && outside(reference) && reference.exposes,
      );
      if (!leaked.length) continue;
      const related = evidence(model, leaked);
      diagnostics.push({
        rule: "field-leak",
        key: field.key,
        severity: "error",
        message: `${field.key} exposes representation outside ${owner.name} in ${leaked.length} reference${leaked.length === 1 ? "" : "s"}`,
        location: related[0]?.location ?? model.location(field.node),
        related,
        evidence: {
          owner: owner.key,
          field: field.name,
          references: leaked.length,
          kept: kept.map((item) => item.name).sort(compare),
        },
      });
    }
  }
  return diagnostics;
}

function shallowModules(model: Model): Diagnostic[] {
  const functions = model.items.filter(
    (item) =>
      item.kind === "function" && !model.wrappers.has(item) && Boolean(functionBody(item.node)),
  );
  const functionSet = new Set(functions);
  const byFile = new Map<ts.SourceFile, Item[]>();
  const incoming = new Map<ts.SourceFile, Reference[]>();
  const typesKnown = new Map<Item, Set<Item>>();
  for (const item of functions) {
    const list = byFile.get(item.file) ?? [];
    list.push(item);
    byFile.set(item.file, list);
  }
  for (const reference of model.references) {
    if (!reference.typeOnly && functionSet.has(reference.item)) {
      const list = incoming.get(reference.item.file) ?? [];
      list.push(reference);
      incoming.set(reference.item.file, list);
    }
    if (
      reference.holder &&
      functionSet.has(reference.holder) &&
      rootItem(reference.item).kind === "type"
    ) {
      const types = typesKnown.get(reference.holder) ?? new Set();
      types.add(rootItem(reference.item));
      typesKnown.set(reference.holder, types);
    }
  }
  const boundaries = new Map<string, Set<ts.SourceFile>>();
  for (const file of model.files) {
    if (model.tests.has(file)) continue;
    const name = model.location(file).file;
    boundaries.set(name, new Set([file]));
    const segments = name.split("/");
    for (let count = 1; count < segments.length; count++) {
      const directory = `${segments.slice(0, count).join("/")}/`;
      const files = boundaries.get(directory) ?? new Set();
      files.add(file);
      boundaries.set(directory, files);
    }
  }
  const diagnostics: Diagnostic[] = [];
  const reported = new Set<string>();
  // Narrowest boundary first; suppress identical lists at ancestor boundaries.
  for (const [boundary, files] of [...boundaries].sort(
    ([a], [b]) => b.split("/").length - a.split("/").length || compare(a, b),
  )) {
    const total = [...files].flatMap((file) => byFile.get(file) ?? []);
    const consumed = [...files]
      .flatMap((file) => incoming.get(file) ?? [])
      .filter(
        (reference) =>
          !files.has(
            reference.holder ? rootItem(reference.holder).file : reference.node.getSourceFile(),
          ),
      );
    const shown = [...new Set(consumed.map((reference) => reference.item))];
    const hidden = total.length - shown.length;
    if (shown.length <= SHOWN || hidden > shown.length) continue;
    const lists = new Map<Item, Set<Item>>();
    for (const item of shown) {
      let owners = [rootItem(item)];
      if (!item.owner) {
        const known = new Set(
          [...(typesKnown.get(item) ?? [])].filter((type) => files.has(type.file)),
        );
        if (known.size) owners = [...known];
      }
      for (const owner of owners) {
        const functions = lists.get(owner) ?? new Set();
        functions.add(item);
        lists.set(owner, functions);
      }
    }
    if (lists.size <= SHOWN && [...lists.values()].every((functions) => functions.size <= SHOWN))
      continue;
    const signature = shown
      .map((item) => item.key)
      .sort(compare)
      .join(",");
    if (reported.has(signature)) continue;
    reported.add(signature);
    const first = total[0];
    if (!first) continue;
    diagnostics.push({
      rule: "shallow-module",
      key: boundary,
      severity: "warning",
      message: `${boundary} shows ${shown.length} of its ${total.length} working functions to outside consumers`,
      location: model.location(first.node),
      related: evidence(model, consumed),
      evidence: {
        shown: shown.length,
        hidden,
        total: total.length,
        interface: shown.map((item) => item.key).sort(compare),
        lists: lists.size,
      },
    });
  }
  return diagnostics;
}

function layout(model: Model): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const directories = new Map<string, { members: Set<string>; file: ts.SourceFile }>();
  for (const file of model.files) {
    const name = model.location(file).file;
    const lines =
      file.text === "" ? 0 : file.getLineStarts().length - (file.text.endsWith("\n") ? 1 : 0);
    if (lines > 2000)
      diagnostics.push({
        rule: "long-file",
        key: name,
        severity: "warning",
        message: `${name} has ${lines} lines, more than 2000 (advisory)`,
        location: { file: name, line: 1, column: 1 },
        evidence: { lines, threshold: 2000 },
      });
    const segments = name.split("/");
    for (let index = 0; index < segments.length; index++) {
      const directory = segments.slice(0, index).join("/") || ".";
      const member = segments[index];
      if (!member) continue;
      const entry = directories.get(directory) ?? { members: new Set(), file };
      entry.members.add(member + (index < segments.length - 1 ? "/" : ""));
      directories.set(directory, entry);
    }
  }
  for (const [directory, entry] of directories)
    if (entry.members.size > 15) {
      const name = directory === "." ? "./" : `${slash(path.normalize(directory))}/`;
      diagnostics.push({
        rule: "wide-directory",
        key: name,
        severity: "warning",
        message: `${name} holds ${entry.members.size} files and directories, more than 15 (advisory)`,
        location: { file: model.location(entry.file).file, line: 1, column: 1 },
        evidence: {
          members: [...entry.members].sort(compare),
          count: entry.members.size,
          threshold: 15,
        },
      });
    }
  return diagnostics;
}

export function check(model: Model): Diagnostic[] {
  const { tangles, tangleOf } = thingGraph(model);
  const diagnostics = moduleCycles(model);
  const tangleReferences = new Map<number, Reference[]>();
  for (const reference of model.references) {
    if (!reference.holder) continue;
    const user = rootItem(reference.holder);
    const target = rootItem(reference.item);
    const tangle = tangleOf.get(user);
    if (user === target || tangle === undefined || tangle !== tangleOf.get(target)) continue;
    const ties = tangleReferences.get(tangle) ?? [];
    ties.push(reference);
    tangleReferences.set(tangle, ties);
  }
  for (const [index, members] of tangles.entries()) {
    if (new Set(members.map((item) => item.file)).size <= 1 && members.length <= SHOWN) continue;
    const ties = tangleReferences.get(index) ?? [];
    const related = evidence(model, ties);
    const first = members[0];
    if (!first) continue;
    const names = members.map((item) => item.key).sort(compare);
    const typeOnly = ties.length > 0 && ties.every((reference) => reference.typeOnly);
    diagnostics.push({
      rule: "tangle",
      key: names.join(","),
      severity: typeOnly ? "warning" : "error",
      message: `${members.length} things know each other in a circle across ${new Set(members.map((item) => item.file)).size} source modules`,
      location: related[0]?.location ?? model.location(first.node),
      related,
      evidence: {
        members: names,
        references: ties.length,
        dependencyKinds: [
          ...new Set(ties.map((reference) => (reference.typeOnly ? "type-only" : "runtime"))),
        ].sort(compare),
      },
    });
  }
  diagnostics.push(...fieldLeaks(model, tangleOf), ...shallowModules(model), ...layout(model));
  return diagnostics.sort((a, b) => compare(a.rule, b.rule) || compare(a.key, b.key));
}
