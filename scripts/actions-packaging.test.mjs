// RVR-027 packaging contract: the reusable actions build the checker from the
// action source and never execute pull-request code. Checkout stays in the
// caller workflow; every tool step resolves through github.action_path and
// every script invocation passes an explicit --target-dir.
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";

const root = new URL("..", import.meta.url);

const compositeActions = ["reveries-receive-check", "reveries-post-merge", "reveries-evidence-import"];

// Files the composite actions address, relative to the repository root. A
// composite `run:` step with no `working-directory` starts at the caller's
// checkout, which is that root.
const repoRootFiles = [
  "package-lock.json",
  "scripts/import-fork-evidence.mjs",
  "scripts/reveries-post-merge.mjs",
  "scripts/github-receive-check.mjs",
];

async function action(name) {
  return readFile(new URL(`.github/actions/${name}/action.yml`, root), "utf8");
}

for (const name of compositeActions) {
  test(`${name} is a composite action that builds from its own source`, async () => {
    const text = await action(name);
    assert.match(text, /using:\s*["']?composite["']?/);
    // Every hosted script runs against an explicit target directory. Steps
    // must not address their own source through `github.action_path`; the
    // no-relative-pathing test below enforces the repository-root form.
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
  assert.match(text, /scripts\/import-fork-evidence\.mjs/);
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

test("no composite action addresses its source with relative path segments", async () => {
  // `actions/setup-node` rejects a `cache-dependency-path` that still contains
  // "." or ".." segments, which failed the post-merge workflow on main with
  // "Relative pathing '.' and '..' is not allowed" before any build step ran.
  // A composite `run:` step already starts at the caller's checkout, so the
  // plain repository-root form is simpler and accepted by every tool.
  const offenders = [];
  for (const name of compositeActions) {
    for (const [index, line] of (await action(name)).split("\n").entries()) {
      const code = line.split("#")[0];
      if (/github\.action_path/.test(code) || /(?:^|[\s"'=:(])\.\.\//.test(code) || /\/\.\//.test(code)) {
        offenders.push(`${name}/action.yml:${index + 1}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `actions must not address their source through github.action_path or ../ segments:\n${offenders.join("\n")}`);
});

for (const name of compositeActions) {
  test(`${name} references only repository files that exist`, async () => {
    const manifest = parseYaml(await action(name));
    const references = new Set();
    for (const step of manifest.runs.steps) {
      const fields = [step.run, step["working-directory"], step.with?.["cache-dependency-path"]];
      for (const value of fields) {
        if (typeof value !== "string") continue;
        for (const token of value.matchAll(/(?:^|[\s"'])((?:[\w.-]+\/)*[\w.-]+\.(?:json|mjs|cjs|js))\b/g)) {
          references.add(token[1]);
        }
      }
    }
    // No false positives and no cross-action over-reach: every literal each
    // action names must be one this repository owns at the root.
    assert.deepEqual([...references].filter((path) => !repoRootFiles.includes(path)), []);
    // The actions collectively cover every repository file the guard knows,
    // so removing a reference cannot silently shrink the check.
    const covered = new Set();
    for (const other of compositeActions) {
      for (const step of parseYaml(await action(other)).runs.steps) {
        for (const value of [step.run, step["working-directory"], step.with?.["cache-dependency-path"]]) {
          if (typeof value !== "string") continue;
          for (const token of value.matchAll(/(?:^|[\s"'])((?:[\w.-]+\/)*[\w.-]+\.(?:json|mjs|cjs|js))\b/g)) covered.add(token[1]);
        }
      }
    }
    assert.deepEqual([...repoRootFiles].filter((path) => !covered.has(path)), []);
    for (const path of references) await stat(new URL(path, root));
  });
}

// RVR-027 portability guard: the runner evaluates `${{ }}` expressions
// anywhere in an action manifest, including the top-level `name` and
// `description`. The `github` context is not available at manifest-load time,
// so an expression there fails the whole action with "Unrecognized
// named-value: 'github'" before any step runs. Keep load-time metadata to
// plain text; expressions belong in inputs, env, and run steps.
for (const name of compositeActions) {
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
