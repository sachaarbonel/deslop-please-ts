import path from "node:path";
import ts from "typescript";
import { buildModel, isTest, slash, within } from "./model";
import { check } from "./rules";
import type { AnalysisError, AnalyzeOptions, Report } from "./types";

export type {
  AnalysisError,
  AnalyzeOptions,
  Diagnostic,
  Location,
  Related,
  Report,
  Rule,
} from "./types";

/** Analyze one compiler project without writing files or building references. */
export function analyzeProject(projectPath: string, options: AnalyzeOptions = {}): Report {
  const requested = path.resolve(projectPath);
  const project = ts.sys.directoryExists(requested)
    ? path.join(requested, "tsconfig.json")
    : requested;
  const configRoot = path.dirname(project);
  const root = path.resolve(options.root ?? configRoot);
  const paths = new Map<string, string>();
  const physicalPath = (file: string): string => {
    const existing = paths.get(file);
    if (existing !== undefined) return existing;
    const resolved = ts.sys.realpath?.(file) ?? file;
    paths.set(file, resolved);
    return resolved;
  };
  const sourcePath = (file: ts.SourceFile): string => physicalPath(file.fileName);
  const report: Report = {
    version: 1,
    compilerVersion: ts.version,
    root,
    project,
    files: 0,
    testFiles: 0,
    ignored: { dependencies: 0, declarations: 0, generated: 0, configured: 0 },
    diagnostics: [],
    errors: [],
    dependencies: { runtime: 0, typeOnly: 0 },
  };
  const error = (diagnostic: ts.Diagnostic, kind: AnalysisError["kind"]): AnalysisError => {
    const result: AnalysisError = {
      kind,
      code: diagnostic.code,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    };
    if (diagnostic.file && diagnostic.start !== undefined) {
      const location = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
      result.location = {
        file: slash(path.relative(report.root, sourcePath(diagnostic.file))),
        line: location.line + 1,
        column: location.character + 1,
      };
    }
    return result;
  };
  try {
    if (!ts.sys.directoryExists(root))
      throw new Error(`Analysis root must be an existing directory: ${root}`);
    report.root = physicalPath(root);
    report.project = physicalPath(project);
    for (const [name, value] of [
      ["maxFiles", options.maxFiles],
      ["maxReferences", options.maxReferences],
    ] as const) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1))
        throw new Error(`${name} must be a positive safe integer`);
    }
    const config = ts.readConfigFile(project, ts.sys.readFile);
    if (config.error) {
      report.errors.push(error(config.error, "config"));
      return report;
    }
    const parsed = ts.parseJsonConfigFileContent(
      config.config,
      ts.sys,
      configRoot,
      undefined,
      project,
    );
    report.errors.push(...parsed.errors.map((diagnostic) => error(diagnostic, "config")));
    if (report.errors.length) return report;
    const maxFiles = options.maxFiles ?? 20_000;
    if (parsed.fileNames.length > maxFiles)
      throw new Error(`File work limit exceeded (${maxFiles}) before creating compiler program`);
    const program = ts.createProgram({
      rootNames: parsed.fileNames,
      options: parsed.options,
      ...(parsed.projectReferences ? { projectReferences: parsed.projectReferences } : {}),
    });
    report.errors.push(
      ...ts
        .getPreEmitDiagnostics(program)
        .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
        .map((diagnostic) => error(diagnostic, "compiler")),
    );
    const physicalRoot = report.root;
    const outputDirectories = [parsed.options.outDir, parsed.options.declarationDir]
      .filter((directory): directory is string => Boolean(directory))
      .map(physicalPath);
    const excluded = (options.exclude ?? []).map((prefix) =>
      physicalPath(path.resolve(configRoot, prefix)),
    );
    const files = program
      .getSourceFiles()
      .filter((file) => {
        // The compiler marks bare package imports external even for a linked
        // workspace's own source. Physical ownership is the boundary; retain
        // the original SourceFile so compiler symbol identity stays intact.
        const physicalFile = sourcePath(file);
        const name = slash(physicalFile);
        if (/(?:^|\/)node_modules\//.test(name) || !within(physicalFile, physicalRoot)) {
          report.ignored.dependencies++;
          return false;
        }
        if (file.isDeclarationFile) {
          report.ignored.declarations++;
          return false;
        }
        if (excluded.some((prefix) => within(physicalFile, prefix))) {
          report.ignored.configured++;
          return false;
        }
        const header = ts.getLeadingCommentRanges(file.text, 0) ?? [];
        const generatedHeader = header.some((range) =>
          /@generated\b/.test(file.text.slice(range.pos, range.end)),
        );
        if (
          outputDirectories.some((directory) => within(physicalFile, directory)) ||
          /(?:^|\/)(?:__generated__|generated|\.next|\.nuxt|\.turbo|coverage)\//.test(
            slash(path.relative(physicalRoot, physicalFile)),
          ) ||
          /\.generated\.[^.]+$/.test(name) ||
          generatedHeader
        ) {
          report.ignored.generated++;
          return false;
        }
        return true;
      })
      .sort((a, b) => (sourcePath(a) < sourcePath(b) ? -1 : sourcePath(a) > sourcePath(b) ? 1 : 0));
    report.files = files.length;
    report.testFiles = files.filter((file) =>
      isTest(path.relative(physicalRoot, sourcePath(file))),
    ).length;
    if (files.length > maxFiles)
      throw new Error(`File work limit exceeded (${maxFiles}) including imported sources`);
    const model = buildModel(program, files, options, physicalRoot, sourcePath);
    const runtime = new Set<string>();
    const typeOnly = new Set<string>();
    for (const edge of model.modules) {
      const from = sourcePath(edge.from);
      const to = sourcePath(edge.to);
      if (from !== to) (edge.typeOnly ? typeOnly : runtime).add(`${from}\0${to}`);
    }
    report.dependencies = { runtime: runtime.size, typeOnly: typeOnly.size };
    report.diagnostics = check(model);
  } catch (cause) {
    report.errors.push({
      kind: "analysis",
      message: cause instanceof Error ? cause.message : String(cause),
    });
  }
  report.errors.sort((a, b) => {
    const left = `${a.kind}:${a.location?.file ?? ""}:${a.location?.line ?? 0}:${a.code ?? 0}:${a.message}`;
    const right = `${b.kind}:${b.location?.file ?? ""}:${b.location?.line ?? 0}:${b.code ?? 0}:${b.message}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return report;
}
