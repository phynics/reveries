import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createReceiveProposal } from "./github-receive-check.mjs";

const workflow = await readFile(new URL("../.github/workflows/reveries-receive-check.yml", import.meta.url), "utf8");

test("the receive check uses a trusted pull_request_target workflow and leaves merge queues disabled", () => {
  assert.match(workflow, /^  pull_request_target:\n/m);
  assert.doesNotMatch(workflow, /^  merge_group:\n/m);
  assert.doesNotMatch(workflow, /^  pull_request:\n/m);
});

test("the workflow uses read-only permissions and does not execute proposed code", () => {
  const permissions = workflow.match(/^permissions:\n((?:  .+\n)+)/m)?.[1];
  assert.ok(permissions, "workflow permissions are explicit");
  assert.deepEqual(
    permissions.trim().split("\n").map((line) => line.trim()),
    ["contents: read", "pull-requests: read"],
  );

  assert.match(
    workflow,
    /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/,
  );
  assert.doesNotMatch(workflow, /ref:.*(?:pull_request\.head\.sha|github\.sha)/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(workflow, /HEAD_REPOSITORY: \$\{\{ github\.event\.pull_request\.head\.repo\.full_name \}\}/);
  assert.doesNotMatch(workflow, /checkout.*(?:pull_request\.head\.sha|HEAD_SHA)/);

  const checkoutIndex = workflow.indexOf("Check out the trusted base revision");
  const installIndex = workflow.indexOf("run: npm ci");
  const buildIndex = workflow.indexOf("run: npm run build");
  const fetchIndex = workflow.indexOf("Fetch proposed code and evidence objects");
  const checkIndex = workflow.indexOf("node scripts/github-receive-check.mjs");
  assert.ok(checkoutIndex >= 0 && checkoutIndex < installIndex);
  assert.ok(installIndex < buildIndex && buildIndex < fetchIndex && fetchIndex < checkIndex);
  assert.equal((workflow.match(/uses: actions\/checkout@/g) ?? []).length, 1);
  assert.match(workflow, /git fetch --no-tags .*HEAD_SHA.*refs\/reveries\/proposed-head/);
});

function gitFor(values) {
  const calls = [];
  const git = async (...args) => {
    calls.push(args);
    const value = values.get(JSON.stringify(args));
    assert.ok(value, `unexpected Git call: ${args.join(" ")}`);
    return value;
  };
  return { git, calls };
}

test("pull request events map proposed code and evidence to the base-tree-bound proposal", async () => {
  const baseSha = "base-commit";
  const headSha = "proposed-commit";
  const mergeBaseSha = "transition-base";
  const baseTree = "base-tree";
  const notesTip = "proposed-notes-tip";
  const { git, calls } = gitFor(new Map([
    [JSON.stringify(["rev-parse", "refs/notes/reveries"]), notesTip],
    [JSON.stringify(["rev-parse", `${baseSha}^{tree}`]), baseTree],
    [JSON.stringify(["merge-base", baseSha, headSha]), mergeBaseSha],
  ]));

  const proposal = await createReceiveProposal({
    pull_request: {
      number: 27,
      base: { sha: baseSha },
      head: { sha: headSha },
    },
  }, git);

  assert.deepEqual(proposal, {
    updates: [
      { ref: "refs/pull/27/head", old: mergeBaseSha, new: headSha },
      { ref: "refs/notes/reveries", old: notesTip, new: notesTip },
    ],
    base_tree: baseTree,
    evidence: [
      { object: headSha, base_tree: baseTree },
      { object: notesTip },
    ],
  });
  assert.deepEqual(calls, [
    ["rev-parse", "refs/notes/reveries"],
    ["rev-parse", `${baseSha}^{tree}`],
    ["merge-base", baseSha, headSha],
  ]);
});

test("merge-group payloads remain supported by the script proposal adapter", async () => {
  const baseSha = "queue-base";
  const headSha = "queue-candidate";
  const baseTree = "queue-base-tree";
  const notesTip = "queue-notes-tip";
  const { git, calls } = gitFor(new Map([
    [JSON.stringify(["rev-parse", "refs/notes/reveries"]), notesTip],
    [JSON.stringify(["rev-parse", `${baseSha}^{tree}`]), baseTree],
  ]));

  const proposal = await createReceiveProposal({
    merge_group: {
      base_sha: baseSha,
      head_sha: headSha,
      base_ref: "refs/heads/main",
    },
  }, git);

  assert.deepEqual(proposal, {
    updates: [
      { ref: "refs/heads/main", old: baseSha, new: headSha },
      { ref: "refs/notes/reveries", old: notesTip, new: notesTip },
    ],
    base_tree: baseTree,
    evidence: [
      { object: headSha, base_tree: baseTree },
      { object: notesTip },
    ],
  });
  assert.deepEqual(calls, [
    ["rev-parse", "refs/notes/reveries"],
    ["rev-parse", `${baseSha}^{tree}`],
  ]);
});
