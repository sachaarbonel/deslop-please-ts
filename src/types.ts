export type Rule =
  | "module-cycle"
  | "tangle"
  | "field-leak"
  | "shallow-module"
  | "wide-directory"
  | "long-file";

export interface Location {
  file: string;
  line: number;
  column: number;
}

export interface Related {
  message: string;
  location: Location;
}

export interface Diagnostic {
  rule: Rule;
  key: string;
  severity: "error" | "warning";
  message: string;
  location: Location;
  related?: Related[];
  evidence?: Record<string, string | number | string[]>;
}

export interface AnalysisError {
  kind: "config" | "compiler" | "analysis";
  message: string;
  code?: number;
  location?: Location;
}

export interface Report {
  version: 1;
  compilerVersion: string;
  root: string;
  project: string;
  files: number;
  testFiles: number;
  ignored: { dependencies: number; declarations: number; generated: number; configured: number };
  diagnostics: Diagnostic[];
  errors: AnalysisError[];
  dependencies: { runtime: number; typeOnly: number };
}

export interface AnalyzeOptions {
  /** Analysis boundary and reporting root; defaults to the config directory. */
  root?: string;
  /** Additional path prefixes, relative to the configuration's directory. */
  exclude?: readonly string[];
  maxFiles?: number;
  maxReferences?: number;
}
