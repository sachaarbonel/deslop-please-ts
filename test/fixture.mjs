import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export function fixture(t, files, compilerOptions = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "deslop-please-ts-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        noEmit: true,
        types: [],
        lib: ["ES2022"],
        ...compilerOptions,
      },
      include: ["**/*.ts"],
    }),
  );
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), source);
  }
  return { root, project: join(root, "tsconfig.json") };
}
