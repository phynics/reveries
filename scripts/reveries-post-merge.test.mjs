import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  composeHostedSummary,
  gitClient,
  hasSessionSummary,
  parseScriptArgs,
  planHostedSummaries,
  resolveTargetDir,
} from "./reveries-post-merge.mjs";

const workflow = await readFile(new URL("../.github/workflows/reveries-post-merge.yml", import.meta.url), "utf8");

const a = (...args) => args;
const NO_NOTE = { stdout: "", stderr: "no note found", exitCode: 1 };
const PATCH_ID = "0123456789abcdef0123456789abcdef01234567 0000000000000000000000000000000000000000\n";

test("the post-merge workflow trusts the pushed default-branch revision and delegates writes to notes", () => {
  assert.match(workflow, /^on:\n  push:\n/m);
  assert.doesNotMatch(workflow, /pull_request/);
  assert.doesNotMatch(workflow, /merge_group/);

  const permissions = workflow.match(/^permissions:\n((?:  .+\n)+)/m)?.[1];
  assert.ok(permissions, "workflow permissions are explicit");
  assert.deepEqual(
    permissions.trim().split("\n").map((line) => line.trim()),
    ["contents: write"],
  );
  assert.match(workflow, /^concurrency:\n {2}group: reveries-post-merge-/m);
  assert.match(workflow, /cancel-in-progress: false/);

  assert.equal((workflow.match(/uses: actions\/checkout@/g) ?? []).length, 1);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
  assert.doesNotMatch(workflow, /ref:.*(?:pull_request|head\.sha)/);
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /persist-credentials: false/);

  // Install, build, and synthesis live in the reusable action, which the
  // caller pins to the protected default-branch revision.
  assert.match(workflow, /uses: \.\/\.github\/actions\/reveries-post-merge/);
  assert.doesNotMatch(workflow, /run: npm ci/);
  assert.doesNotMatch(workflow, /run: npm run build/);
  assert.doesNotMatch(workflow, /node scripts\/reveries-post-merge\.mjs/);

  const checkoutIndex = workflow.indexOf("actions/checkout@");
  const actionIndex = workflow.indexOf("./.github/actions/reveries-post-merge");
  assert.ok(checkoutIndex >= 0 && checkoutIndex < actionIndex);
});

const out = (text) => ({ stdout: text, stderr: "", exitCode: 0 });

function fakeGit(entries) {
  const values = new Map(entries.map(([args, value]) => [JSON.stringify(args), value]));
  const calls = [];
  const run = async (args, input = "") => {
    calls.push({ args, input });
    const value = values.get(JSON.stringify(args));
    if (value === undefined && args[0] === "fetch") return out("");
    if (value === undefined) return { stdout: "", stderr: `unexpected git ${args.join(" ")}`, exitCode: 1 };
    return typeof value === "function" ? value(input) : value;
  };
  return { git: gitClient(run), calls };
}

function pushEvent(overrides = {}) {
  return {
    repository: { full_name: "phynics/reveries", default_branch: "main" },
    push: {
      ref: "refs/heads/main",
      before: "1111111111111111111111111111111111111111",
      after: "4444444444444444444444444444444444444444",
      repository: { full_name: "phynics/reveries" },
      ...overrides,
    },
  };
}

function summaryNote(decision) {
  return {
    stdout: `${JSON.stringify({
      v: 1,
      type: "session-summary",
      author_email: "maintainer@example.com",
      session: "pi:manual",
      created_at: "2026-08-25T03:05:00Z",
      entries: [{
        driving_event: "A maintainer reviewed the merge.",
        decision,
        impact: "The commit carries a human account.",
        recurrence_control: "The workflow skips summarized commits.",
        alternatives: [],
        sources: [],
        reveries: [],
        retirements: [],
      }],
    })}\n`,
    stderr: "",
    exitCode: 0,
  };
}

const RANGE = a(
  "rev-list",
  "--first-parent",
  "--reverse",
  "1111111111111111111111111111111111111111..4444444444444444444444444444444444444444",
);
const MERGE = "5555555555555555555555555555555555555555";
const SQUASH = "6666666666666666666666666666666666666666";
const FIRST = "7777777777777777777777777777777777777777";
const SECOND = "8888888888888888888888888888888888888888";
const TIP = "9999999999999999999999999999999999999999";
const ONE_PARENT = "4444444444444444444444444444444444444444";
const TWO_PARENTS = "4444444444444444444444444444444444444444 3333333333333333333333333333333333333333";

function pullRequestApi(number, shas) {
  return async (path) => {
    if (path.endsWith("/pulls")) return [{ number }];
    if (path === `/repos/phynics/reveries/pulls/${number}/commits`) return shas.map((sha) => ({ sha }));
    throw new Error(`unexpected API path ${path}`);
  };
}

test("session summaries are detected in an existing commit note", () => {
  assert.equal(hasSessionSummary(summaryNote("a decision").stdout), true);
  assert.equal(hasSessionSummary('{"v":1,"type":"reveries-init"}\n'), false);
  assert.equal(hasSessionSummary("not json\n"), false);
  assert.equal(hasSessionSummary(""), false);
});

test("a merge commit is attributed to every commit of its pull request", async () => {
  const { git, calls } = fakeGit([
    [RANGE, out(MERGE)],
    [a("show", "-s", "--format=%P", MERGE), out(TWO_PARENTS)],
    [a("notes", "--ref=refs/notes/reveries", "show", MERGE), NO_NOTE],
  ]);

  const plan = await planHostedSummaries({
    event: pushEvent(),
    git,
    api: pullRequestApi(28, ["aaa1", "bbb2"]),
  });

  assert.deepEqual(plan.items, [{
    commit: MERGE,
    pullRequest: { owner: "phynics", name: "reveries", number: 28 },
    sourceCommits: ["aaa1", "bbb2"],
  }]);
  assert.deepEqual(plan.skipped, []);
  assert.deepEqual(plan.deferred, []);
  assert.deepEqual(plan.diagnostics, []);
  const fetch = calls.find((call) => call.args[0] === "fetch");
  assert.deepEqual(fetch.args, [
    "fetch",
    "--no-tags",
    "https://github.com/phynics/reveries.git",
    "+refs/pull/28/head:refs/reveries/pr/28/head",
  ]);
  assert.equal(calls.some((call) => call.args[0] === "patch-id"), false);
});

test("a squashed pull request contributes every commit summary in order", async () => {
  const { git } = fakeGit([
    [RANGE, out(SQUASH)],
    [a("show", "-s", "--format=%P", SQUASH), out(ONE_PARENT)],
    [a("notes", "--ref=refs/notes/reveries", "show", SQUASH), NO_NOTE],
  ]);

  const plan = await planHostedSummaries({
    event: pushEvent(),
    git,
    api: pullRequestApi(9, ["ccc3", "ddd4"]),
  });

  assert.equal(plan.items.length, 1);
  assert.deepEqual(plan.items[0].sourceCommits, ["ccc3", "ddd4"]);
});

test("a rebased pull request plans only the new tip commit and defers the intermediates", async () => {
  const { git } = fakeGit([
    [RANGE, out(`${FIRST}\n${SECOND}\n${TIP}`)],
    [a("show", "-s", "--format=%P", FIRST), out("1111111111111111111111111111111111111111")],
    [a("show", "-s", "--format=%P", SECOND), out(ONE_PARENT)],
    [a("show", "-s", "--format=%P", TIP), out(SECOND)],
    [a("notes", "--ref=refs/notes/reveries", "show", TIP), NO_NOTE],
    [a("diff", `${TIP}^!`), out("diff of the rebased tip\n")],
    [a("diff", "aaa1^!"), out("diff of the first pull request commit\n")],
    [a("diff", "bbb2^!"), out("diff of the second pull request commit\n")],
    [a("patch-id", "--stable"), (input) => out(
      input.includes("first") ? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 0000000000000000000000000000000000000000\n" : "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 0000000000000000000000000000000000000000\n",
    )],
  ]);

  const plan = await planHostedSummaries({
    event: pushEvent(),
    git,
    api: pullRequestApi(30, ["aaa1", "bbb2"]),
  });

  assert.deepEqual(plan.items, [{
    commit: TIP,
    pullRequest: { owner: "phynics", name: "reveries", number: 30 },
    sourceCommits: ["bbb2"],
  }]);
  assert.deepEqual(plan.deferred, [
    { commit: FIRST, reason: "rebase-intermediate" },
    { commit: SECOND, reason: "rebase-intermediate" },
  ]);
});

test("an ambiguous rebase mapping is reported and never planned", async () => {
  const { git } = fakeGit([
    [RANGE, out(`${FIRST}\n${TIP}`)],
    [a("show", "-s", "--format=%P", FIRST), out("1111111111111111111111111111111111111111")],
    [a("show", "-s", "--format=%P", TIP), out(SECOND)],
    [a("notes", "--ref=refs/notes/reveries", "show", TIP), NO_NOTE],
    [a("diff", `${TIP}^!`), out("same patch\n")],
    [a("diff", "aaa1^!"), out("same patch\n")],
    [a("diff", "bbb2^!"), out("same patch\n")],
    [a("patch-id", "--stable"), out(PATCH_ID)],
  ]);

  const plan = await planHostedSummaries({
    event: pushEvent(),
    git,
    api: pullRequestApi(31, ["aaa1", "bbb2"]),
  });

  assert.deepEqual(plan.items, []);
  assert.deepEqual(plan.skipped, [{ commit: TIP, reason: "ambiguous-rewrite-mapping" }]);
  assert.match(plan.diagnostics.join("\n"), /matches 2 pull request commits/);
});

test("a commit that already has a valid summary is skipped without an API call", async () => {
  const { git } = fakeGit([
    [RANGE, out(MERGE)],
    [a("show", "-s", "--format=%P", MERGE), out(TWO_PARENTS)],
    [a("notes", "--ref=refs/notes/reveries", "show", MERGE), summaryNote("a maintainer already summarized this merge")],
  ]);
  let calls = 0;
  const api = async () => { calls += 1; return []; };

  const plan = await planHostedSummaries({ event: pushEvent(), git, api });

  assert.deepEqual(plan.items, []);
  assert.deepEqual(plan.skipped, [{ commit: MERGE, reason: "already-summarized" }]);
  assert.equal(calls, 0);
});

test("a direct push without a pull request is reported instead of guessed", async () => {
  const { git } = fakeGit([
    [RANGE, out(MERGE)],
    [a("show", "-s", "--format=%P", MERGE), out(ONE_PARENT)],
    [a("notes", "--ref=refs/notes/reveries", "show", MERGE), NO_NOTE],
  ]);

  const plan = await planHostedSummaries({ event: pushEvent(), git, api: async () => [] });

  assert.deepEqual(plan.items, []);
  assert.deepEqual(plan.skipped, [{ commit: MERGE, reason: "no-pull-request" }]);
  assert.match(plan.diagnostics.join("\n"), /no associated pull request/);
});

test("pushes that are not the default branch or create it are not attributed", async () => {
  const branch = await planHostedSummaries({
    event: pushEvent({ ref: "refs/heads/side" }),
    git: fakeGit([]).git,
    api: async () => [],
  });
  assert.deepEqual(branch.items, []);
  assert.match(branch.diagnostics.join("\n"), /not the default branch/);

  const created = await planHostedSummaries({
    event: pushEvent({ before: "0000000000000000000000000000000000000000" }),
    git: fakeGit([]).git,
    api: async () => [],
  });
  assert.deepEqual(created.items, []);
  assert.match(created.diagnostics.join("\n"), /created the default branch/);
});

test("the workflow composes the host attestation and cites the pull request", () => {
  const composed = composeHostedSummary([{
    driving_event: "The pull request changed the transition boundary.",
    decision: "Add the pull request change.",
    impact: "Reviewers read the change beside its causal account.",
    recurrence_control: "The publication check requires one summary per descendant commit.",
    alternatives: [],
    sources: [{ relation: "derived-from", kind: "commit", ref: "a".repeat(40) }],
    reveries: [],
    retirements: [],
  }], {
    author_email: "41898282+github-actions[bot]@users.noreply.github.com",
    session: "github-actions:post-merge:1717171717",
    created_at: "2026-08-25T04:00:00Z",
  }, { owner: "phynics", name: "reveries", number: 28 });

  assert.equal(composed.type, "session-summary");
  assert.equal(composed.author_email, "41898282+github-actions[bot]@users.noreply.github.com");
  assert.equal(composed.session, "github-actions:post-merge:1717171717");
  assert.deepEqual(composed.entries[0].sources.map((source) => source.ref).sort(), [
    "a".repeat(40),
    "github:phynics/reveries#28",
  ]);
  assert.equal(composed.entries[0].sources[1].relation, "requested-by");
  assert.equal(composed.entries[0].sources[1].kind, "issue");
});

test("the post-merge script accepts a target directory with an environment fallback", () => {
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
