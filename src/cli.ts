#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { analyzeProject } from "./index";
import { assessBaseline, readBaseline, writeBaseline } from "./baseline";
import type { BaselineReport, BaselineSummary } from "./baseline";
import type { Report } from "./types";

function main(args: string[]): number {
  const projects: string[] = [];
  const exclude: string[] = [];
  let root: string | undefined;
  let baselineFile: string | undefined;
  let baselineOutput: string | undefined;
  let json = false;
  let reportOnly = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (
      argument === "--project" ||
      argument === "--root" ||
      argument === "--exclude" ||
      argument === "--baseline" ||
      argument === "--write-baseline"
    ) {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a path`);
      if (argument === "--project") projects.push(value);
      else if (argument === "--exclude") exclude.push(value);
      else if (argument === "--root") {
        if (root !== undefined) throw new Error("Provide --root only once");
        root = value;
      } else if (argument === "--baseline") {
        if (baselineFile !== undefined) throw new Error("Provide --baseline only once");
        baselineFile = path.resolve(value);
      } else {
        if (baselineOutput !== undefined) throw new Error("Provide --write-baseline only once");
        baselineOutput = path.resolve(value);
      }
    } else if (argument === "--format") {
      const value = args[++index];
      if (value !== "json" && value !== "text") throw new Error("--format must be json or text");
      json = value === "json";
    } else if (argument === "--report-only") reportOnly = true;
    else if (argument === "--help" || argument === "-h") {
      process.stdout.write(
        "Usage: deslop-please-ts --project <tsconfig> [--project <tsconfig> ...] [--root <path>] [--exclude <path> ...] [--format json|text] [--report-only] [--baseline <file> | --write-baseline <file>]\n",
      );
      return 0;
    } else if (argument === "--version") {
      const metadata: unknown = JSON.parse(
        readFileSync(path.join(__dirname, "../package.json"), "utf8"),
      );
      if (
        typeof metadata !== "object" ||
        metadata === null ||
        !("version" in metadata) ||
        typeof metadata.version !== "string" ||
        !metadata.version
      )
        throw new Error("Installed package metadata has no version");
      process.stdout.write(`${metadata.version}\n`);
      return 0;
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (projects.length === 0) throw new Error("Provide --project <tsconfig>");
  if (baselineFile && baselineOutput)
    throw new Error("--baseline and --write-baseline are mutually exclusive");
  if (baselineOutput && process.env.CI !== undefined)
    throw new Error("Baseline writes are disabled when CI is set");
  const file = baselineFile ?? baselineOutput;
  const previous =
    file && (baselineFile !== undefined || existsSync(file)) ? readBaseline(file) : undefined;
  const reports = projects.map((project) =>
    analyzeProject(project, { ...(root === undefined ? {} : { root }), exclude }),
  );
  const assessment = file
    ? assessBaseline(file, reports, previous, baselineOutput ? "write" : "read")
    : undefined;
  const output = assessment?.reports ?? reports;
  const incomplete = reports.some((report) => report.errors.length > 0);
  if (baselineOutput && !incomplete) {
    try {
      writeBaseline(baselineOutput, reports);
      if (assessment) {
        assessment.summary.written = true;
        for (const report of assessment.reports) report.baseline.written = true;
      }
    } catch (cause) {
      emit(output, json, exclude, assessment?.summary);
      throw cause;
    }
  }
  emit(output, json, exclude, assessment?.summary);
  if (incomplete) return 2;
  if (baselineOutput || reportOnly) return 0;
  return output.some((report) =>
    report.diagnostics.some(
      (diagnostic) =>
        diagnostic.severity === "error" &&
        !("baseline" in diagnostic && diagnostic.baseline === "known"),
    ),
  )
    ? 1
    : 0;
}

function emit(
  reports: (Report | BaselineReport)[],
  json: boolean,
  exclude: string[],
  baseline?: BaselineSummary,
): void {
  const output = reports.map((report) => ({
    ...report,
    ...(exclude.length ? { exclusions: exclude } : {}),
  }));
  if (json)
    process.stdout.write(
      `${JSON.stringify(output.length === 1 ? output[0] : { version: 1, projects: output, ...(baseline ? { baseline } : {}) }, null, 2)}\n`,
    );
  else for (const report of reports) print(report, exclude);
}

function print(report: Report | BaselineReport, exclude: string[]): void {
  process.stdout.write(
    `${report.project}: ${report.files} source files (${report.testFiles} test files)\n`,
  );
  process.stdout.write(`  root: ${report.root}; TypeScript ${report.compilerVersion}\n`);
  if (exclude.length)
    process.stdout.write(
      `  excluded paths (relative to project config): ${exclude.join(", ")}; ${report.ignored.configured} source files excluded\n`,
    );
  for (const diagnostic of report.diagnostics) {
    const { file, line, column } = diagnostic.location;
    const status = "baseline" in diagnostic ? ` ${diagnostic.baseline}` : "";
    process.stdout.write(
      `${file}:${line}:${column}: ${diagnostic.severity}[${diagnostic.rule}]${status} ${diagnostic.message}\n`,
    );
    for (const related of diagnostic.related ?? [])
      process.stdout.write(
        `  ${related.location.file}:${related.location.line}:${related.location.column}: ${related.message}\n`,
      );
  }
  for (const error of report.errors) {
    const at = error.location
      ? `${error.location.file}:${error.location.line}:${error.location.column}: `
      : "";
    process.stdout.write(
      `${at}${error.kind} error${error.code === undefined ? "" : ` TS${error.code}`}: ${error.message}\n`,
    );
  }
  process.stdout.write(
    `${report.diagnostics.length} findings, ${report.errors.length} analysis errors\n`,
  );
  if ("baseline" in report) {
    const baseline = report.baseline;
    process.stdout.write(
      `  baseline ${baseline.file}: ${baseline.known} known, ${baseline.new} new, ${baseline.resolved} resolved identities${baseline.mode === "write" ? (baseline.written ? "; written" : "; not written") : ""}\n`,
    );
    for (const entry of baseline.resolvedEntries)
      process.stdout.write(
        `  resolved ${entry.severity}[${entry.rule}] ${entry.key} (TypeScript ${entry.compilerVersion})\n`,
      );
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (cause) {
  process.stderr.write(
    `deslop-please-ts: ${cause instanceof Error ? cause.message : String(cause)}\n`,
  );
  process.exitCode = 2;
}
