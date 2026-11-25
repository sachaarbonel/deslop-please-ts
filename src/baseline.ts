import { closeSync, ftruncateSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import path from "node:path";
import type { Diagnostic, Report } from "./types";

interface BaselineEntry {
  project: string;
  root: string;
  compilerVersion: string;
  rule: string;
  key: string;
  severity: Diagnostic["severity"];
}

export interface BaselineDocument {
  kind: "deslop-please-ts-baseline";
  version: 1;
  entries: BaselineEntry[];
}

export interface BaselineSummary {
  file: string;
  mode: "read" | "write";
  known: number;
  new: number;
  resolved: number;
  resolvedEntries: BaselineEntry[];
  written?: boolean;
}

export type BaselineReport = Omit<Report, "diagnostics"> & {
  diagnostics: (Diagnostic & { baseline: "known" | "new" })[];
  baseline: BaselineSummary;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`${name} must be a nonempty string`);
  return value;
}

function relativePath(value: unknown, name: string): string {
  const result = text(value, name);
  if (
    result.includes("\\") ||
    path.posix.isAbsolute(result) ||
    path.win32.isAbsolute(result) ||
    /^[a-z]:/i.test(result) ||
    path.posix.normalize(result) !== result
  )
    throw new Error(`${name} must be a normalized relative path`);
  return result;
}

function keys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && actual.every((key) => expected.includes(key));
}

function identity(entry: BaselineEntry): string {
  return JSON.stringify([
    entry.project,
    entry.root,
    entry.compilerVersion,
    entry.rule,
    entry.key,
    entry.severity,
  ]);
}

function scope(entry: Pick<BaselineEntry, "project" | "root">): string {
  return JSON.stringify([entry.project, entry.root]);
}

function sorted(entries: BaselineEntry[]): BaselineEntry[] {
  return entries.sort((left, right) => {
    const a = identity(left);
    const b = identity(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

function parseBaseline(source: string, file: string): BaselineDocument {
  try {
    const value: unknown = JSON.parse(source);
    if (
      !record(value) ||
      !keys(value, ["kind", "version", "entries"]) ||
      value.kind !== "deslop-please-ts-baseline" ||
      value.version !== 1 ||
      !Array.isArray(value.entries)
    )
      throw new Error("expected a deslop-please-ts-baseline version 1 document");
    const entries: BaselineEntry[] = [];
    const seen = new Set<string>();
    for (const valueEntry of value.entries) {
      const entry: unknown = valueEntry;
      if (
        !record(entry) ||
        !keys(entry, ["project", "root", "compilerVersion", "rule", "key", "severity"])
      )
        throw new Error("invalid baseline entry fields");
      if (entry.severity !== "error" && entry.severity !== "warning")
        throw new Error("baseline entry severity must be error or warning");
      const parsed: BaselineEntry = {
        project: relativePath(entry.project, "entry.project"),
        root: relativePath(entry.root, "entry.root"),
        compilerVersion: text(entry.compilerVersion, "entry.compilerVersion"),
        rule: text(entry.rule, "entry.rule"),
        key: text(entry.key, "entry.key"),
        severity: entry.severity,
      };
      const key = identity(parsed);
      if (seen.has(key)) throw new Error("duplicate baseline entry identity");
      seen.add(key);
      entries.push(parsed);
    }
    return { kind: "deslop-please-ts-baseline", version: 1, entries: sorted(entries) };
  } catch (cause) {
    throw new Error(
      `Invalid baseline ${file}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

export function readBaseline(file: string): BaselineDocument {
  return parseBaseline(readFileSync(file, "utf8"), file);
}

function context(report: Report, file: string) {
  const directory = path.dirname(file);
  return {
    project: path.relative(directory, report.project).split(path.sep).join("/") || ".",
    root: path.relative(directory, report.root).split(path.sep).join("/") || ".",
    compilerVersion: text(report.compilerVersion, "report.compilerVersion"),
  };
}

function entryFor(report: Report, diagnostic: Diagnostic, file: string): BaselineEntry {
  return {
    ...context(report, file),
    rule: diagnostic.rule,
    key: diagnostic.key,
    severity: diagnostic.severity,
  };
}

function currentEntries(reports: Report[], file: string): BaselineEntry[] {
  const unique = new Map<string, BaselineEntry>();
  for (const report of reports)
    for (const diagnostic of report.diagnostics) {
      const entry = entryFor(report, diagnostic, file);
      unique.set(identity(entry), entry);
    }
  return sorted([...unique.values()]);
}

export function assessBaseline(
  file: string,
  reports: Report[],
  previous: BaselineDocument | undefined,
  mode: "read" | "write",
): { reports: BaselineReport[]; summary: BaselineSummary } {
  const entries = previous?.entries ?? [];
  const accepted = new Set(entries.map(identity));
  const current = new Set(currentEntries(reports, file).map(identity));
  const selected = new Set(
    reports
      .filter((report) => report.errors.length === 0)
      .map((report) => scope(context(report, file))),
  );
  const resolvedEntries = entries.filter(
    (entry) => selected.has(scope(entry)) && !current.has(identity(entry)),
  );
  const annotated = reports.map((report): BaselineReport => {
    const diagnostics = report.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      baseline: accepted.has(identity(entryFor(report, diagnostic, file)))
        ? ("known" as const)
        : ("new" as const),
    }));
    const resolved = resolvedEntries.filter(
      (entry) => scope(entry) === scope(context(report, file)),
    );
    return {
      ...report,
      diagnostics,
      baseline: {
        file,
        mode,
        known: diagnostics.filter((diagnostic) => diagnostic.baseline === "known").length,
        new: diagnostics.filter((diagnostic) => diagnostic.baseline === "new").length,
        resolved: resolved.length,
        resolvedEntries: resolved,
        ...(mode === "write" ? { written: false } : {}),
      },
    };
  });
  return {
    reports: annotated,
    summary: {
      file,
      mode,
      known: annotated.reduce((total, report) => total + report.baseline.known, 0),
      new: annotated.reduce((total, report) => total + report.baseline.new, 0),
      resolved: resolvedEntries.length,
      resolvedEntries,
      ...(mode === "write" ? { written: false } : {}),
    },
  };
}

export function writeBaseline(file: string, reports: Report[]): void {
  if (process.env.CI !== undefined) throw new Error("Baseline writes are disabled when CI is set");
  if (reports.some((report) => report.errors.length > 0))
    throw new Error("Cannot write a baseline from incomplete analysis");
  const current = currentEntries(reports, file);
  const selected = new Set(reports.map((report) => scope(context(report, file))));
  mkdirSync(path.dirname(file), { recursive: true });
  let descriptor: number;
  let created = false;
  try {
    descriptor = openSync(file, "r+");
  } catch (cause) {
    if (!record(cause) || cause.code !== "ENOENT") throw cause;
    descriptor = openSync(file, "wx");
    created = true;
  }
  try {
    // Validate and update the same opened file, even if its pathname is replaced.
    const previous = created ? [] : parseBaseline(readFileSync(descriptor, "utf8"), file).entries;
    const entries = sorted([
      ...previous.filter((entry) => !selected.has(scope(entry))),
      ...current,
    ]);
    const document: BaselineDocument = { kind: "deslop-please-ts-baseline", version: 1, entries };
    const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (written === 0) throw new Error(`Could not finish writing baseline ${file}`);
      offset += written;
    }
    ftruncateSync(descriptor, bytes.length);
  } finally {
    closeSync(descriptor);
  }
}
