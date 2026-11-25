# Contributing

Run `npm ci` and `npm run check` on Node.js 22.12 or newer. Use `npm run build` to regenerate the published JavaScript and declaration files before testing the CLI or packing the package.

Keep compiler symbol resolution authoritative. Avoid identifier-name matching, parallel module-resolution implementations, and dependencies that merely wrap the TypeScript compiler. Preserve the distinction between architectural findings and analysis failures, including under `--report-only`.

For a behavior change, add or extend a minimal original fixture in the Node test suite. State the defect it would catch and use an independently justified expected result. Useful regression cases include duplicate property names on unrelated declarations, aliases and barrel exports, type-only boundaries, and wrappers that should not hide coupling. Test the published JavaScript entry points as well as analysis results.

Report limitations plainly. A static analyzer should not imply that unresolved, excluded, generated, dynamic, or external code has been proven clean. Preserve deterministic diagnostic ordering, useful source locations, bounded work, and the versioned JSON contract.

Retain the upstream MIT copyright and license when adapting code from [deterministic-machines/deslop-please](https://github.com/deterministic-machines/deslop-please). Update the pinned upstream revision in README only when intentionally reviewing a newer version. Contributions must contain no private repository code, credentials, customer information, or organization-specific fixtures.
