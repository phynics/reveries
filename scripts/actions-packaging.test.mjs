// RVR-027 packaging contract: the reusable actions build the checker from the
// action source and never execute pull-request code. Checkout stays in the
// caller workflow; every tool step resolves through github.action_path and
// every script invocation passes an explicit --target-dir.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";

const root = new URL("..", import.meta.url);

async function action(name) {
  return readFile(new URL(`.github/actions/${name}/action.yml`, root), "utf8");
}

for (const name of ["reveries-receive-check", "reveries-post-merge", "reveries-evidence-import"]) {
  test(`${name} is a composite action that builds from its own source`, async () => {
    const text = await action(name);
    assert.match(text, /using:\s*["']?composite["']?/);
    // Every tool step resolves through the action source, never the target,
    // and every hosted script runs against an explicit target directory.
    assert.match(text, /github\.action_path/);
    assert.match(text, /--target-dir/);
    if (name !== "reveries-evidence-import") {
      // The evidence import is dependency-free (Node.js builtins only), so
      // it needs no install or build step; the built checker and synthesis
      // library do.
      assert.match(text, /actions\/setup-node@/);
      assert.match(text, /node-version:\s*["']?\$\{\{\s*inputs\.node-version\s*\}\}/);
      assert.match(text, /npm ci/);
      assert.match(text, /npm run build/);
    }
  });

  test(`${name} never checks out code and never runs target code`, async () => {
    const text = await action(name);
    assert.doesNotMatch(text, /actions\/checkout@/);
    assert.doesNotMatch(text, /checkout.*pull_request/i);
    assert.doesNotMatch(text, /npm (start|run\s+(?!build\b|test\b)\S*[a-z])/);
  });
}

test("the receive-check action fetches proposals as objects and keeps the trust order", async () => {
  const text = await action("reveries-receive-check");
  assert.match(text, /target-directory/);
  assert.match(text, /github\.event\.pull_request\.head\.sha/);
  assert.match(text, /github\.event\.pull_request\.head\.repo\.full_name/);
  assert.match(text, /refs\/reveries\/proposed-head/);
  assert.match(text, /refs\/notes\/reveries/);
  assert.doesNotMatch(text, /merge_group/);
  const installIndex = text.indexOf("npm ci");
  const buildIndex = text.indexOf("npm run build");
  const fetchIndex = text.indexOf("proposed-head");
  const checkIndex = text.indexOf("github-receive-check.mjs");
  assert.ok(installIndex >= 0 && installIndex < buildIndex);
  assert.ok(buildIndex < fetchIndex && fetchIndex < checkIndex);
});

test("the post-merge action documents its write scope and concurrency contract", async () => {
  const text = await action("reveries-post-merge");
  assert.match(text, /reveries-post-merge\.mjs/);
  assert.match(text, /REVERIES_POST_MERGE_REMOTE/);
  assert.match(text, /contents:\s*write/);
  assert.match(text, /concurrency/);
  assert.match(text, /persist-credentials:\s*false/);
});

test("the evidence-import action publishes an artifact without executing fork code", async () => {
  const text = await action("reveries-evidence-import");
  assert.match(text, /import-fork-evidence\.mjs/);
  assert.match(text, /actions\/upload-artifact@/);
  assert.match(text, /REVERIES_EVIDENCE_OUTPUT/);
});

test("this repository dogfoods the local actions from its caller workflows", async () => {
  const callers = {
    "reveries-receive-check.yml": "reveries-receive-check",
    "reveries-post-merge.yml": "reveries-post-merge",
    "reveries-evidence-import.yml": "reveries-evidence-import",
  };
  for (const [workflowFile, actionName] of Object.entries(callers)) {
    const text = await readFile(new URL(`./.github/workflows/${workflowFile}`, root), "utf8");
    assert.match(text, new RegExp(`uses: \\./\\.github/actions/${actionName}`));
    // The caller owns triggers, permissions, and checkout; tool steps live
    // in the action it pins.
    assert.doesNotMatch(text, /run: npm ci/);
    assert.doesNotMatch(text, /run: npm run build/);
  }
});

test("the evidence-import caller stays on pull_request_target with read-only permissions", async () => {
  const text = await readFile(new URL("./.github/workflows/reveries-evidence-import.yml", root), "utf8");
  assert.match(text, /pull_request_target:/);
  assert.match(text, /contents: read/);
  assert.match(text, /pull-requests: read/);
  assert.doesNotMatch(text, /node scripts\/import-fork-evidence\.mjs/);
});

test("the evidence-import action resolves its script path to an existing repository file", async () => {
  const actionDir = new URL("./.github/actions/reveries-evidence-import/", root);
  const text = await readFile(new URL("action.yml", actionDir), "utf8");
  const match = text.match(/github\.action_path\s*\}\}\s*\/(\.\.\/)+scripts\/import-fork-evidence\.mjs/);
  assert.ok(match, "action must reference the repo-root scripts directory");
  const resolved = new URL("../../../scripts/import-fork-evidence.mjs", actionDir);
  const { stat } = await import("node:fs/promises");
  await stat(resolved);
});

// RVR-027 portability guard: the runner evaluates `${{ }}` expressions
// anywhere in an action manifest, including the top-level `name` and
// `description`. The `github` context is not available at manifest-load time,
// so an expression there fails the whole action with "Unrecognized
// named-value: 'github'" before any step runs. Keep load-time metadata to
// plain text; expressions belong in inputs, env, and run steps.
for (const name of ["reveries-receive-check", "reveries-post-merge", "reveries-evidence-import"]) {
  test(`${name} keeps load-time metadata free of Actions expressions`, async () => {
    const manifest = parseYaml(await action(name));
    for (const field of ["name", "description"]) {
      const value = manifest[field];
      if (value === undefined) continue;
      assert.doesNotMatch(
        String(value),
        /\$\{\{/,
        `${name} action.yml ${field} must not contain a ${{ }} expression: the github context is unavailable when GitHub loads the manifest`,
      );
    }
  });
}
