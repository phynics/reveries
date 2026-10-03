import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { parseScriptArgs, resolveTargetDir } from "./import-fork-evidence.mjs";

test("the fork evidence import accepts a target directory with an environment fallback", () => {
  assert.deepEqual(parseScriptArgs([]), { targetDir: null });
  assert.deepEqual(parseScriptArgs(["--target-dir", "/tmp/adopter"]), { targetDir: "/tmp/adopter" });
  assert.throws(() => parseScriptArgs(["--target-dir"]), /requires a value/);
  assert.throws(() => parseScriptArgs(["--unknown-flag"]), /unknown option/);

  const sourceRoot = resolve(new URL(".", import.meta.url).pathname, "..");
  const previous = process.env.REVERIES_TARGET_DIR;
  try {
    delete process.env.REVERIES_TARGET_DIR;
    assert.equal(resolveTargetDir({ targetDir: null }), sourceRoot);
    process.env.REVERIES_TARGET_DIR = "/tmp/from-env";
    assert.equal(resolveTargetDir({ targetDir: null }), resolve("/tmp/from-env"));
    assert.equal(resolveTargetDir({ targetDir: "relative/flag-wins" }), resolve("relative/flag-wins"));
  } finally {
    if (previous === undefined) delete process.env.REVERIES_TARGET_DIR;
    else process.env.REVERIES_TARGET_DIR = previous;
  }
});
