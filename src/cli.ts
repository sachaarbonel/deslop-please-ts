#!/usr/bin/env node
import { analyzeProject } from "./index";
import type { Report } from "./types";

function main(args: string[]): number {
  const projects: string[] = [];
  let json = false;
  let reportOnly = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--project") {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error("--project requires a tsconfig path");
      projects.push(value);
    } else if (argument === "--format") {
      const value = args[++index];
      if (value !== "json" && value !== "text") throw new Error("--format must be json or text");
      json = value === "json";
    } else if (argument === "--report-only") reportOnly = true;
    else if (argument === "--help" || argument === "-h") {
      process.stdout.write(
        "Usage: deslop-please-ts --project <tsconfig> [--project <tsconfig> ...] [--format json|text] [--report-only]\n",
      );
      return 0;
    } else if (argument === "--version") {
      process.stdout.write("0.1.0\n");
      return 0;
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (projects.length === 0) throw new Error("Provide --project <tsconfig>");
  const reports = projects.map((project) => analyzeProject(project));
  if (json)
    process.stdout.write(
      `${JSON.stringify(reports.length === 1 ? reports[0] : { version: 1, projects: reports }, null, 2)}\n`,
    );
  else for (const report of reports) print(report);
  if (reports.some((report) => report.errors.length > 0)) return 2;
  return !reportOnly &&
    reports.some((report) =>
      report.diagnostics.some((diagnostic) => diagnostic.severity === "error"),
    )
    ? 1
    : 0;
}

function print(report: Report): void {
  process.stdout.write(
    `${report.project}: ${report.files} source files (${report.testFiles} test files)\n`,
  );
  for (const diagnostic of report.diagnostics) {
    const { file, line, column } = diagnostic.location;
    process.stdout.write(
      `${file}:${line}:${column}: ${diagnostic.severity}[${diagnostic.rule}] ${diagnostic.message}\n`,
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
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (cause) {
  process.stderr.write(
    `deslop-please-ts: ${cause instanceof Error ? cause.message : String(cause)}\n`,
  );
  process.exitCode = 2;
}
