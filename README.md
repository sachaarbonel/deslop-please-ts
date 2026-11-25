# deslop-please-ts

An architectural linter for TypeScript, built around **deep modules and narrow interfaces**. It uses the TypeScript compiler API to follow declarations, symbols, aliases, and project module resolution. It does not find dependencies by matching identifier text.

This is an independent TypeScript adaptation of [deterministic-machines/deslop-please](https://github.com/deterministic-machines/deslop-please), pinned to upstream commit [`f678d10d6e6860e70900ceae919e2d769b0a11ae`](https://github.com/deterministic-machines/deslop-please/tree/f678d10d6e6860e70900ceae919e2d769b0a11ae). It preserves the six rule names and their design motivation, with language-specific adaptations described below. It is not a claim of diagnostic parity with the Rust tool.

Upstream attribution: **Copyright (c) 2026 Deterministic Machines, Inc.** The complete MIT copyright, permission, and disclaimer notice is preserved in [LICENSE](LICENSE).

Requires Node.js **22.12 or newer**. TypeScript is a peer dependency; supported compiler families are **5.9.x (from 5.9.3)** and **6.0.x (from 6.0.3)**. CI tests both starting versions on Node 22.12 and 24.

## Install and run

```sh
npm install --save-dev https://github.com/sachaarbonel/deslop-please-ts/releases/download/v0.2.0/deslop-please-ts-0.2.0.tgz
npx deslop-please-ts --project tsconfig.json
npx deslop-please-ts --project packages/api/tsconfig.json --project packages/web/tsconfig.json --format json
npx deslop-please-ts --project tsconfig.json --report-only
npx deslop-please-ts --project packages/api/tsconfig.json --root . --exclude fixtures --exclude legacy
```

Releases are distributed through GitHub release tarballs. Install locally alongside your project's supported TypeScript version and commit the lockfile. The tool uses the peer compiler resolved by its installation, reported as `compilerVersion`; selecting `--project` does not switch compiler versions. Global or temporary installations can resolve a different compiler. For a source checkout, run `npm ci` and `npm run build`, then run `node dist/cli.js --project /path/to/tsconfig.json`.

Run one analysis for each intended TypeScript project. The linter reads that project's compiler settings, including `extends`, source inclusion, `paths`, and module resolution. It never emits application JavaScript, installs dependencies, changes source, or builds project references. Dependencies and generated declarations must already be available when the project's compiler configuration requires them.

`--report-only` keeps findings visible while allowing architectural findings to pass. Configuration, compiler, and analysis errors still fail. This makes it useful for initially collecting architectural evidence without treating an incomplete analysis as success.

`--root` sets one analysis boundary relative to the working directory. Each repeated `--exclude` is a file or directory prefix relative to each project's configuration directory. Explicit exclusions and their file count appear in the CLI report; compiler errors in excluded imports still fail analysis.

| Exit code | Meaning                                                                                                                 |
| --------- | ----------------------------------------------------------------------------------------------------------------------- |
| `0`       | No new error-severity findings, `--report-only`, or a successful explicit baseline write; advisory findings can remain. |
| `1`       | Architectural error-severity findings, or new error-severity findings with a baseline.                                  |
| `2`       | Invalid arguments, configuration/compiler errors, or incomplete/failed analysis, including in report-only mode.         |

## Rules

| Rule             | Evidence                                                                                                                                                                                                                                                                      | Severity                                                                     |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `module-cycle`   | Runtime dependencies projected onto sibling files or directories form a coupling cycle. Value uses resolve through aliases and re-export relays; side-effect imports and runtime re-exports also participate.                                                                 | Error                                                                        |
| `tangle`         | Declaration-level references form a strongly connected group across modules, or a group larger than seven within one module. Classes and their members belong to one thing; functions and constants can be things. Type references participate as well as runtime references. | Error for value coupling; warning when all internal references are type-only |
| `field-leak`     | A class that works on its own state and keeps some state internal exposes another field's representation to outside code. Primitive value reads alone are excluded. Simple getters and forwarding bodies are followed where statically recognizable.                          | Error                                                                        |
| `shallow-module` | Actual outside consumers use more than seven working functions, shown functions are at least as numerous as hidden functions, and the interface has a list longer than seven. An unused export alone does not enlarge the consumed interface.                                 | Advisory warning                                                             |
| `wide-directory` | More than fifteen analyzed source files or child directories share one directory.                                                                                                                                                                                             | Advisory warning                                                             |
| `long-file`      | An analyzed file has more than 2,000 physical lines, including comments and blank lines.                                                                                                                                                                                      | Advisory warning                                                             |

The numerical interface and layout heuristics come from upstream. They are prompts for investigation, not a quality score. In particular, the layout rules do not create a failing line-count gate. Moving code or adding a pass-through wrapper may change a diagram without improving the abstraction; diagnose what callers must know and what behavior should own that knowledge.

Horizontal folders such as components, routes, and hooks can naturally have broad consumed interfaces. `shallow-module` remains visible as advice without making that layout alone fail CI. Type-only tangles likewise remain visible without treating mutually referring contracts as runtime failures.

Ordinary imports contribute runtime dependency evidence when their imported values are referenced. Explicit `import type`, type-only named imports/exports, and references in type positions are distinguished from runtime dependencies. Inlined `const enum` references are compile-time coupling, counted in `dependencies.typeOnly`; `isolatedModules` and retained runtime imports can change that classification. `verbatimModuleSyntax` also retains ordinary non-type imports in the runtime graph, matching that compiler option's intent. Runtime re-exports retain their module dependency while resolved consumer references point to the original declaration.

Like upstream's sibling-module check, `module-cycle` projects a dependency onto the sibling children of its least common directory. A cycle between directories can therefore exist while the individual files or declarations form a chain. Diagnostic `evidence.graph` distinguishes `sibling-directory` from `source-file`. Both are source-coupling graphs, not JavaScript module-evaluation graphs: a member read on an injected object can refer to its declaration's module even when that declaration was imported with `import type`. This records representation coupling without establishing a circular runtime import or initialization failure. Under `verbatimModuleSyntax`, inline type-only specifiers in an otherwise ordinary export declaration can leave a runtime `export {} from ...` relay, and that retained dependency participates.

Source files are taken from the compiler program and filtered to the analysis root. Declaration files and dependency directories are omitted. Configured compiler output directories (`outDir` and `declarationDir`), generated/cache directories (`generated`, `__generated__`, `.next`, `.nuxt`, `.turbo`, `coverage`), generated filename markers, and a leading `@generated` comment header are omitted. A directory named `build` or `dist` is not automatically excluded when it is legitimate source. Filtering does not rewrite the project's compiler settings: compiler diagnostics can still reveal a broken imported or generated dependency.

Files named `*.test.*` or `*.spec.*`, and files under `test`, `tests`, `__tests__`, or `__mocks__`, remain in the analyzed file and layout counts. They do not contribute production coupling evidence. The report records their number in `testFiles` and separately counts ignored dependency, declaration, generated, and configured files in `ignored`.

## Optional baseline

For repositories that choose to ratchet existing findings, explicitly create and review a baseline locally:

```sh
npx deslop-please-ts --project tsconfig.json --write-baseline architecture-baseline.json
npx deslop-please-ts --project tsconfig.json --baseline architecture-baseline.json --format json
```

Both commands retain every finding. With `--baseline`, diagnostics are annotated `known` or `new`; only new error-severity findings cause exit 1. Reports also list resolved identities: previous entries absent in a successfully analyzed scope, including identities replaced by compiler or severity changes. This does not by itself establish that a defect was fixed. Compiler, configuration, analysis, and baseline errors still cause exit 2, including with `--report-only`.

Baseline version 1 stores `{ kind: "deslop-please-ts-baseline", version: 1, entries: [...] }`. Each entry identifies a project, analysis root, compiler version, rule, stable key, and severity. Project and root paths are relative to the baseline file so the checkout can move. Changed keys, compiler versions, or severities are new findings even when the total count stays unchanged. Diagnostic keys identify architectural groups rather than every edge; this is a ratchet on finding identities, not proof that a known group has not grown.

Reads never update the baseline. `--write-baseline` is mutually exclusive with `--baseline`, refuses writes whenever the `CI` environment variable is present, and cannot write incomplete analysis or replace an unrelated file. When updating selected projects, it preserves entries for other project/root scopes. Use consistent roots and exclusions when comparing runs, and review baseline changes as accepted debt rather than automatically regenerating them in CI.

## Programmatic API

```ts
import { analyzeProject } from "deslop-please-ts";

const report = analyzeProject("./tsconfig.json", {
  exclude: ["legacy", "fixtures"],
});

for (const finding of report.diagnostics) {
  console.log(finding.rule, finding.location, finding.message);
}
if (report.errors.length > 0) {
  // Handle configuration, compiler, or analysis failure separately.
}
```

`analyzeProject(projectPath, options?)` is synchronous and returns a report. `projectPath` identifies a `tsconfig.json`. The small options object supports:

| Option          | Default                                 | Meaning                                                                                                          |
| --------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `root`          | Directory containing the project config | Analysis boundary and base for reported source locations.                                                        |
| `exclude`       | `[]`                                    | Additional path prefixes relative to the project config directory; excludes complete files or directories.       |
| `maxFiles`      | `20000`                                 | Maximum configured root source files and analyzed imported sources. Exceeding either bound is an analysis error. |
| `maxReferences` | `1000000`                               | Maximum collected references. Exceeding the bound is an analysis error.                                          |

The package includes compiled CommonJS JavaScript and TypeScript declarations. Its exports support both ESM `import` and CommonJS `require`. Source imports in this repository are extensionless TypeScript imports; published entry points resolve to compiled JavaScript.

## JSON contract

`--format json` emits one report for one `--project`. Repeating `--project` emits `{ "version": 1, "projects": [/* reports in argument order */] }`.

Each report has this stable versioned shape:

```json
{
  "version": 1,
  "compilerVersion": "5.9.3",
  "root": "/absolute/project/root",
  "project": "/absolute/project/root/tsconfig.json",
  "files": 2,
  "testFiles": 0,
  "ignored": { "dependencies": 0, "declarations": 0, "generated": 0, "configured": 0 },
  "dependencies": { "runtime": 2, "typeOnly": 0 },
  "diagnostics": [
    {
      "rule": "module-cycle",
      "key": "stable rule-specific identifier",
      "message": "Human-readable explanation",
      "severity": "error",
      "location": { "file": "src/left.ts", "line": 2, "column": 31 },
      "related": [
        {
          "message": "Related dependency evidence",
          "location": { "file": "src/right.ts", "line": 2, "column": 31 }
        }
      ]
    }
  ],
  "errors": []
}
```

Locations use slash-separated paths relative to `root` and one-based lines and columns. Diagnostics are sorted deterministically and carry rule-specific stable keys. `related` and additional `evidence` may be present. `dependencies` counts unique directed source-file pairs for each kind; one pair can have both runtime and type-only/compile-time evidence. Error records contain `kind` (`config`, `compiler`, or `analysis`), `message`, and optional diagnostic `code` and `location`. Consumers should key decisions on the version, rule, severity, and key rather than parsing prose. Source changes can legitimately change a key when they change the participating declarations.

## Scope and limitations

This is source architecture analysis, not proof of runtime behavior or encapsulation. It follows compiler-resolved declarations within the selected project boundary. It does not execute code, trace values across arbitrary assignments, or model every dynamic language feature.

- Computed property names with nonliteral values, reflection, `any`, runtime prototype changes, and unresolved dynamic imports can hide dependencies. Structural TypeScript types can describe several implementations; symbol resolution is not whole-program points-to analysis.
- The declaration model covers top-level declared classes, interfaces, type aliases, enums, functions, and variables, plus their directly declared members. Anonymous default function declarations, default arrow/function-expression exports, and class arrow/function-expression methods are supported. Direct property accesses follow compiler property symbols. Arbitrary object literals, local declarations, anonymous class expressions, and runtime prototype extensions are not fully modeled as independent architectural things.
- Wrappers must have one expression: a direct same-owner property return, a single assignment of an unchanged parameter to an owned field (including setters), or a recognized forwarding call that passes its parameters unchanged with a simple receiver. Arbitrary wrappers, transformed arguments, closures, container aliases, decorators, and mutable values passed through locals require dataflow analysis and may hide coupling. This tool does not perform dataflow alias analysis.
- JavaScript does not have Rust's copy/borrow rules. Field leakage uses a conservative distinction between primitive reads and mutable representation exposure; it cannot establish ownership or prove that a callee mutates an object.
- Readonly types do not prove deep immutability: a readonly array can contain mutable objects, `Readonly<T>` is shallow, and `Date` has mutating methods. Such representations may still be reported. Closure/factory state is not modeled as class-owned state, so a `createStore()` closure can also hide leaks. The tool does not claim comprehensive encapsulation coverage for functional TypeScript.
- The TypeScript module/file and directory structure replaces Rust's module/crate hierarchy. Class ownership, declaration groups, and consumed interfaces are adaptations. Interface declarations and type aliases participate in type coupling; their presence does not mean a runtime cycle exists.
- Only code available inside the analyzed boundary supplies consumer evidence. Public library users outside the project are unknown, so a small consumed interface does not prove an exported API is narrow. Repeated projects are independent reports, not a merged cross-project architecture graph.
- Compiler errors are reported separately because unresolved or invalid source can make architectural findings incomplete. The tool performs analysis without emitting or rebuilding referenced projects.
- Work bounds cover input/analyzed files, collected references, and model traversal (two million AST nodes). TypeScript still parses and resolves the configured program before model traversal; limits do not constitute a process memory or wall-clock sandbox.

Treat findings as evidence to review with the code's actual security, concurrency, recovery, and deployment boundaries in mind. The right fix changes ownership or the abstraction; it need not minimize file sizes.

## Develop

```sh
npm ci
npm run check
npm run build
node dist/cli.js --project tsconfig.json --report-only
npm pack
```

Tests create original minimal TypeScript projects in temporary directories and check resolved dependencies, type/runtime separation, field identity, wrappers, consumed interfaces, advisory layout findings, deterministic reports, and failure exit codes.

## Attribution and license

MIT. The upstream algorithms, design, and examples informed this adaptation. Upstream copyright: **Copyright (c) 2026 Deterministic Machines, Inc.** The complete upstream notice and MIT permission/disclaimer are preserved in [LICENSE](LICENSE). Upstream remains the source of the Rust implementation; this package has its own compiler frontend and TypeScript-specific behavior.
