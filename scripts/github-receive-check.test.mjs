import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { createReceiveProposal, formatFinding, formatReport, parseScriptArgs, resolveTargetDir } from "./github-receive-check.mjs";

const workflow = await readFile(new URL("../.github/workflows/reveries-receive-check.yml", import.meta.url), "utf8");

test("the receive check uses a trusted pull_request_target workflow and leaves merge queues disabled", () => {
  assert.match(workflow, /^  pull_request_target:\n/m);
  assert.doesNotMatch(workflow, /^  merge_group:\n/m);
  assert.doesNotMatch(workflow, /^  pull_request:\n/m);
});

test("the workflow uses read-only permissions and delegates to the pinned action", () => {
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
  assert.doesNotMatch(workflow, /pull_request\.head\.sha/);

  // Install, build, fetch, and check live in the reusable action, which the
  // caller pins to its own base revision. The caller only checks out the
  // trusted base revision and delegates.
  assert.match(workflow, /uses: \.\/\.github\/actions\/reveries-receive-check/);
  assert.equal((workflow.match(/uses: actions\/checkout@/g) ?? []).length, 1);
  assert.doesNotMatch(workflow, /run: npm ci/);
  assert.doesNotMatch(workflow, /run: npm run build/);
  assert.doesNotMatch(workflow, /node scripts\/github-receive-check\.mjs/);

  const checkoutIndex = workflow.indexOf("Check out the trusted base revision");
  const actionIndex = workflow.indexOf("./.github/actions/reveries-receive-check");
  assert.ok(checkoutIndex >= 0 && checkoutIndex < actionIndex);
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
    allow_pr_description_summary: false,
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
    allow_pr_description_summary: false,
  });
  assert.deepEqual(calls, [
    ["rev-parse", "refs/notes/reveries"],
    ["rev-parse", `${baseSha}^{tree}`],
  ]);
});

test("script arguments default to a disabled PR-description fallback", () => {
  assert.deepEqual(parseScriptArgs([]), { allowPrDescriptionSummary: false, forkEvidenceManifestPath: null, targetDir: null });
  assert.deepEqual(parseScriptArgs(["--allow-pr-description-summary"]), {
    allowPrDescriptionSummary: true,
    forkEvidenceManifestPath: null,
    targetDir: null,
  });
  assert.deepEqual(parseScriptArgs(["--fork-evidence-manifest", "/tmp/evidence.json"]), {
    allowPrDescriptionSummary: false,
    forkEvidenceManifestPath: "/tmp/evidence.json",
    targetDir: null,
  });
  assert.deepEqual(parseScriptArgs(["--target-dir", "/tmp/adopter"]), {
    allowPrDescriptionSummary: false,
    forkEvidenceManifestPath: null,
    targetDir: "/tmp/adopter",
  });
  assert.throws(() => parseScriptArgs(["--unknown-flag"]), /unknown option/);
  assert.throws(() => parseScriptArgs(["--fork-evidence-manifest"]), /requires a value/);
  assert.throws(() => parseScriptArgs(["--target-dir"]), /requires a value/);
});

test("the target directory resolves from the flag, the environment, then the script source", () => {
  const sourceRoot = resolve(new URL(".", import.meta.url).pathname, "..");
  const previous = process.env.REVERIES_TARGET_DIR;
  try {
    delete process.env.REVERIES_TARGET_DIR;
    assert.equal(resolveTargetDir({ targetDir: null }), sourceRoot);
    process.env.REVERIES_TARGET_DIR = "/tmp/from-env";
    assert.equal(resolveTargetDir({ targetDir: null }), resolve("/tmp/from-env"));
    assert.equal(
      resolveTargetDir({ targetDir: "relative/flag-wins" }),
      resolve("relative/flag-wins"),
    );
  } finally {
    if (previous === undefined) delete process.env.REVERIES_TARGET_DIR;
    else process.env.REVERIES_TARGET_DIR = previous;
  }
});

test("the PR-description fallback stays off unless explicitly allowed", async () => {
  const { git } = gitFor(new Map([
    [JSON.stringify(["rev-parse", "refs/notes/reveries"]), "notes-tip"],
    [JSON.stringify(["rev-parse", "base-commit^{tree}"]), "base-tree"],
    [JSON.stringify(["merge-base", "base-commit", "proposed-commit"]), "transition-base"],
  ]));
  const event = {
    pull_request: {
      number: 27,
      body: "A description that must not be used by default.",
      base: { sha: "base-commit" },
      head: { sha: "proposed-commit" },
    },
  };
  const proposal = await createReceiveProposal(event, git);
  assert.equal(proposal.allow_pr_description_summary, false);
  assert.ok(!("pr_description" in proposal));
});

test("an explicitly allowed fallback forwards description text only", async () => {
  const { git } = gitFor(new Map([
    [JSON.stringify(["rev-parse", "refs/notes/reveries"]), "notes-tip"],
    [JSON.stringify(["rev-parse", "base-commit^{tree}"]), "base-tree"],
    [JSON.stringify(["merge-base", "base-commit", "proposed-commit"]), "transition-base"],
  ]));
  const body = "Describe the transition for reviewers.";
  const proposal = await createReceiveProposal({
    pull_request: {
      number: 27,
      body,
      base: { sha: "base-commit" },
      head: { sha: "proposed-commit" },
    },
  }, git, { allowPrDescriptionSummary: true });
  assert.equal(proposal.allow_pr_description_summary, true);
  assert.equal(proposal.pr_description, body);

  const { git: emptyGit } = gitFor(new Map([
    [JSON.stringify(["rev-parse", "refs/notes/reveries"]), "notes-tip"],
    [JSON.stringify(["rev-parse", "base-commit^{tree}"]), "base-tree"],
    [JSON.stringify(["merge-base", "base-commit", "proposed-commit"]), "transition-base"],
  ]));
  const withoutBody = await createReceiveProposal({
    pull_request: {
      number: 27,
      body: "   ",
      base: { sha: "base-commit" },
      head: { sha: "proposed-commit" },
    },
  }, emptyGit, { allowPrDescriptionSummary: true });
  assert.equal(withoutBody.allow_pr_description_summary, true);
  assert.ok(!("pr_description" in withoutBody));
});

test("imported fork evidence proposes the manifest tip without executing fork code", async () => {
  const { git } = gitFor(new Map([
    [JSON.stringify(["rev-parse", "refs/notes/reveries"]), "base-notes-tip"],
    [JSON.stringify(["rev-parse", "base-commit^{tree}"]), "base-tree"],
    [JSON.stringify(["merge-base", "base-commit", "proposed-commit"]), "transition-base"],
  ]));
  const proposal = await createReceiveProposal({
    pull_request: {
      number: 27,
      base: { sha: "base-commit" },
      head: { sha: "proposed-commit" },
    },
  }, git, {
    forkEvidence: {
      v: 1,
      state: "imported",
      pull_request: 27,
      source_repository: "fork/reveries",
      notes_tip: "fork-notes-tip",
      evidence_objects: ["fork-notes-tip"],
    },
  });
  assert.deepEqual(proposal.updates, [
    { ref: "refs/pull/27/head", old: "transition-base", new: "proposed-commit" },
    { ref: "refs/notes/reveries", old: "base-notes-tip", new: "fork-notes-tip" },
  ]);
  assert.ok(proposal.evidence.some((item) => item.object === "fork-notes-tip"));
});

test("fork evidence for another pull request or without evidence fails closed", async () => {
  const { git } = gitFor(new Map([
    [JSON.stringify(["rev-parse", "refs/notes/reveries"]), "base-notes-tip"],
    [JSON.stringify(["rev-parse", "base-commit^{tree}"]), "base-tree"],
    [JSON.stringify(["merge-base", "base-commit", "proposed-commit"]), "transition-base"],
  ]));
  const event = {
    pull_request: {
      number: 27,
      base: { sha: "base-commit" },
      head: { sha: "proposed-commit" },
    },
  };
  await assert.rejects(
    createReceiveProposal(event, git, {
      forkEvidence: { v: 1, state: "imported", pull_request: 28, notes_tip: "fork-notes-tip" },
    }),
    /different pull request/,
  );
  await assert.rejects(
    createReceiveProposal(event, git, { forkEvidence: { v: 1, state: "absent", pull_request: 27 } }),
    /no imported evidence/,
  );
});

test("findings render as stable blocks with copy-paste remediation", () => {
  const block = formatFinding({
    code: "missing-session-summary",
    grade: "strict",
    ref: "refs/pull/27/head",
    commit: "a".repeat(40),
    detail: "missing summary detail",
    remediation: "run this command",
  });
  assert.match(block, /\[missing-session-summary\]/);
  assert.match(block, /refs\/pull\/27\/head/);
  assert.match(block, new RegExp("a".repeat(40)));
  assert.match(block, /missing summary detail/);
  assert.match(block, /run this command/);
  assert.doesNotMatch(block, /lower-grade/);

  const lower = formatFinding({
    code: "summary-from-pr-description",
    grade: "lower",
    detail: "covered detail",
    remediation: "attach a real summary",
  });
  assert.match(lower, /\[summary-from-pr-description\] \(lower-grade\)/);
});

test("reports render failures, lower-grade warnings, and silent passes", () => {
  const failed = formatReport({
    ok: false,
    result: {
      findings: [{
        code: "missing-notes-publication",
        grade: "strict",
        detail: "missing notes",
        remediation: "push notes first",
      }],
    },
  });
  assert.match(failed, /\[missing-notes-publication\]/);
  assert.match(failed, /push notes first/);

  const lowerGradePass = formatReport({
    ok: true,
    result: {
      findings: [{
        code: "summary-from-pr-description",
        grade: "lower",
        detail: "covered",
        remediation: "attach a real summary",
      }],
    },
  });
  assert.match(lowerGradePass, /lower-grade/);

  assert.equal(formatReport({ ok: true, result: { findings: [] } }), "");
  assert.equal(formatReport({ ok: true, result: {} }), "");
  assert.equal(formatReport(null), "");
});
