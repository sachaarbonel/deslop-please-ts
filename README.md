# deslop-please-ts

An architectural linter for TypeScript, built around **deep modules and narrow interfaces**. It uses the TypeScript compiler API to follow declarations, symbols, aliases, and project module resolution. It does not find dependencies by matching identifier text.

This is an independent TypeScript adaptation of [deterministic-machines/deslop-please](https://github.com/deterministic-machines/deslop-please), pinned to upstream commit [`f678d10d6e6860e70900ceae919e2d769b0a11ae`](https://github.com/deterministic-machines/deslop-please/tree/f678d10d6e6860e70900ceae919e2d769b0a11ae). It preserves the six rule names and their design motivation, with language-specific adaptations described below. It is not a claim of diagnostic parity with the Rust tool.

Upstream attribution: **Copyright (c) 2026 Deterministic Machines, Inc.** The complete MIT copyright, permission, and disclaimer notice is preserved in [LICENSE](LICENSE) and reproduced here:

```text
MIT License

Copyright (c) 2026 Deterministic Machines, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Requires Node.js **22.12 or newer**. The runtime compiler dependency is pinned to TypeScript **5.9.3**.

## Install and run

```sh
npm install --save-dev https://github.com/sachaarbonel/deslop-please-ts/releases/download/v0.1.0/deslop-please-ts-0.1.0.tgz
npx deslop-please-ts --project tsconfig.json
npx deslop-please-ts --project packages/api/tsconfig.json --project packages/web/tsconfig.json --format json
npx deslop-please-ts --project tsconfig.json --report-only
```

The initial release is distributed through the GitHub release tarball above. For a source checkout, clone this repository, run `npm ci` and `npm run build`, then run `node dist/cli.js --project /path/to/tsconfig.json`.

Run one analysis for each intended TypeScript project. The linter reads that project's compiler settings, including `extends`, source inclusion, `paths`, and module resolution. It never emits application JavaScript, installs dependencies, changes source, or builds project references. Dependencies and generated declarations must already be available when the project's compiler configuration requires them.

`--report-only` keeps findings visible while allowing architectural findings to pass. Configuration, compiler, and analysis errors still fail. This makes it useful for initially collecting architectural evidence without treating an incomplete analysis as success.

| Exit code | Meaning                                                                                                         |
| --------- | --------------------------------------------------------------------------------------------------------------- |
| `0`       | No error-severity findings, or `--report-only`; advisory findings can remain.                                   |
| `1`       | Architectural error-severity findings.                                                                          |
| `2`       | Invalid arguments, configuration/compiler errors, or incomplete/failed analysis, including in report-only mode. |

## Rules

| Rule             | Evidence                                                                                                                                                                                                                                                                      | Severity         |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `module-cycle`   | Runtime dependencies projected onto sibling files or directories form a coupling cycle. Value uses resolve through aliases and re-export relays; side-effect imports and runtime re-exports also participate.                                                                 | Error            |
| `tangle`         | Declaration-level references form a strongly connected group across modules, or a group larger than seven within one module. Classes and their members belong to one thing; functions and constants can be things. Type references participate as well as runtime references. | Error            |
| `field-leak`     | A class that works on its own state and keeps some state internal exposes another field's representation to outside code. Primitive value reads alone are excluded. Simple getters and forwarding bodies are followed where statically recognizable.                          | Error            |
| `shallow-module` | Actual outside consumers use more than seven working functions, shown functions are at least as numerous as hidden functions, and the interface has a list longer than seven. An unused export alone does not enlarge the consumed interface.                                 | Error            |
| `wide-directory` | More than fifteen analyzed source files or child directories share one directory.                                                                                                                                                                                             | Advisory warning |
| `long-file`      | An analyzed file has more than 2,000 physical lines, including comments and blank lines.                                                                                                                                                                                      | Advisory warning |

The numerical interface and layout heuristics come from upstream. They are prompts for investigation, not a quality score. In particular, the layout rules do not create a failing line-count gate. Moving code or adding a pass-through wrapper may change a diagram without improving the abstraction; diagnose what callers must know and what behavior should own that knowledge.

Ordinary imports contribute runtime dependency evidence when their imported values are referenced. Explicit `import type`, type-only named imports/exports, and references in type positions are distinguished from runtime dependencies. Inlined `const enum` references are compile-time coupling, counted in `dependencies.typeOnly`; `isolatedModules` and retained runtime imports can change that classification. `verbatimModuleSyntax` also retains ordinary non-type imports in the runtime graph, matching that compiler option's intent. Runtime re-exports retain their module dependency while resolved consumer references point to the original declaration.

Like upstream's sibling-module check, `module-cycle` projects a dependency onto the sibling children of its least common directory. A cycle between directories can therefore exist while the individual files or declarations form a chain. Diagnostic `evidence.graph` distinguishes `sibling-directory` from `source-file`. Both are source-coupling graphs, not JavaScript module-evaluation graphs: a member read on an injected object can refer to its declaration's module even when that declaration was imported with `import type`. This records representation coupling without establishing a circular runtime import or initialization failure. Under `verbatimModuleSyntax`, inline type-only specifiers in an otherwise ordinary export declaration can leave a runtime `export {} from ...` relay, and that retained dependency participates.

Source files are taken from the compiler program and filtered to the analysis root. Declaration files and dependency directories are omitted. Configured compiler output directories (`outDir` and `declarationDir`), generated/cache directories (`generated`, `__generated__`, `.next`, `.nuxt`, `.turbo`, `coverage`), generated filename markers, and a leading `@generated` comment header are omitted. A directory named `build` or `dist` is not automatically excluded when it is legitimate source. Filtering does not rewrite the project's compiler settings: compiler diagnostics can still reveal a broken imported or generated dependency.

Files named `*.test.*` or `*.spec.*`, and files under `test`, `tests`, `__tests__`, or `__mocks__`, remain in the analyzed file and layout counts. They do not contribute production coupling evidence. The report records their number in `testFiles` and separately counts ignored dependency, declaration, generated, and configured files in `ignored`.

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
