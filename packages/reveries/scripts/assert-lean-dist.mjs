import { readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Fail the build when a module the lean core removed is present in `dist/`.
 *
 * The published package is `files: ["dist"]`, so a stale compiled module is a
 * shipped feature even after its source is gone. This guard is the structural
 * version of "delete the code": a reintroduced adapter, hook runner, receive
 * gate, continuity gate, or projection fails the build instead of leaking into
 * an npm release.
 */
const dist = fileURLToPath(new URL("../dist", import.meta.url));

const removedDirectories = ["adapters"];
const removedModules = ["receive", "hooks", "continuity", "projection", "install-adoption"];

const failures = [];

for (const directory of removedDirectories) {
  if (existsSync(`${dist}/${directory}`)) {
    failures.push(`dist/${directory}/ (removed host adapters)`);
  }
}

const sourceDirectory = `${dist}/src`;
if (existsSync(sourceDirectory)) {
  for (const name of readdirSync(sourceDirectory)) {
    const stem = name.replace(/\.(?:js|d\.ts|js\.map)$/, "");
    if (removedModules.includes(stem)) {
      failures.push(`dist/src/${name}`);
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(
    `Lean-core build guard failed: removed modules are present in dist:\n  ${failures.join("\n  ")}\n`,
  );
  process.exit(1);
}
