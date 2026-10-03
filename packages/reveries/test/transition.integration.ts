import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";

import { Reveries } from "../src/operations.ts";
import type {
  SessionSummary,
  TransitionCausal,
  TransitionMetadata,
} from "../src/protocol.ts";

const execFileAsync = promisify(execFile);
const temporaryRepositories: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

async function createRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "reveries-transition-ops-"));
  temporaryRepositories.push(directory);
  await git(directory, "init", "-b", "main");
  await git(directory, "config", "user.name", "Reveries Test");
  await git(directory, "config", "user.email", "reveries@example.com");
  await writeFile(join(directory, "state.txt"), "first\n", "utf8");
  await git(directory, "add", "state.txt");
  await git(directory, "commit", "-m", "initial");
  return directory;
}

afterEach(async () => {
  while (temporaryRepositories.length > 0) {
    const directory = temporaryRepositories.pop();
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  }
});

const causal: TransitionCausal = {
  driving_event: "The merge queue creates final commit IDs after review.",
  decision: "Anchor causality to tree transitions because commit IDs change during publication.",
  impact: "Evidence stays stable across amends and squash merges.",
  recurrence_control: "Transition fixtures fail when the identity changes unexpectedly.",
  alternatives: ["Anchor evidence to commit IDs"],
  sources: [],
  reveries: [],
  retirements: [],
};

const metadata: TransitionMetadata = {
  author_email: "reveries@example.com",
  session: "codex:transition",
  created_at: "2026-09-29T07:00:00Z",
};

function summary(): SessionSummary {
  return {
    v: 1,
    type: "session-summary",
    author_email: "reveries@example.com",
    session: "codex:transition",
    created_at: "2026-09-29T07:05:00Z",
    entries: [{
      driving_event: "The pull request changed the transition boundary.",
      decision: "Record the transition because reviewers need its causal account.",
      impact: "Reviewers read the change beside its causal account.",
      recurrence_control: "The publication check requires one summary per descendant commit.",
      alternatives: [],
      sources: [],
      reveries: [],
      retirements: [],
    }],
  };
}

test("a metadata-only amend reuses the transition identity", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const before = await reveries.transitionIdentityForCommit(
    await reveries.repository.resolveCommit("HEAD"),
    causal,
  );
  await git(directory, "commit", "--amend", "-m", "initial (amended message only)");
  const after = await reveries.transitionIdentityForCommit(
    await reveries.repository.resolveCommit("HEAD"),
    causal,
  );
  assert.equal(before.transition, after.transition);
});

test("a rebase onto a changed tree requires new or adapted evidence", async () => {
  const directory = await createRepository();
  await writeFile(join(directory, "feature.txt"), "feature\n", "utf8");
  await git(directory, "add", "feature.txt");
  await git(directory, "commit", "-m", "feature work");
  const reveries = await Reveries.open(directory);
  const original = await reveries.repository.resolveCommit("HEAD");
  const originalTrees = await reveries.transitionTreesForCommit(original);
  await reveries.recordTransition({ ...originalTrees, causal, metadata });
  const recorded = await reveries.checkCandidateTransition(originalTrees);
  assert.equal(recorded.ok, true);

  const mainTip = await git(directory, "rev-parse", "HEAD");
  await git(directory, "checkout", "-b", "newbase", `${mainTip}~1`);
  await writeFile(join(directory, "base.txt"), "changed base\n", "utf8");
  await git(directory, "add", "base.txt");
  await git(directory, "commit", "-m", "changed base");
  await git(directory, "checkout", "-B", "main", mainTip);
  await git(directory, "rebase", "newbase");

  const rebased = await reveries.repository.resolveCommit("HEAD");
  const rebasedTrees = await reveries.transitionTreesForCommit(rebased);
  const withoutEvidence = await reveries.checkCandidateTransition(rebasedTrees);
  assert.equal(withoutEvidence.ok, false);
  assert.match(withoutEvidence.diagnostics.join("; "), /No transition evidence/);

  const adapted: TransitionCausal = {
    ...causal,
    decision: "Re-anchor the transition to the changed base because the parent tree moved.",
    sources: [{ relation: "derived-from", kind: "commit", ref: original }],
  };
  await reveries.recordTransition({ ...rebasedTrees, causal: adapted, metadata });
  const withEvidence = await reveries.checkCandidateTransition(rebasedTrees);
  assert.equal(withEvidence.ok, true);
  assert.notEqual(withEvidence.transition, recorded.transition);
});

test("root transitions use an empty parent list", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const root = await reveries.repository.resolveCommit("HEAD");
  const trees = await reveries.transitionTreesForCommit(root);
  assert.deepEqual([...trees.parents], []);
  const missing = await reveries.checkCandidateTransition(trees);
  assert.equal(missing.ok, false);
  await reveries.recordTransition({ ...trees, causal, metadata });
  const covered = await reveries.checkCandidateTransition(trees);
  assert.equal(covered.ok, true);
});

test("squash and merge-group candidates validate before a final commit exists", async () => {
  const directory = await createRepository();
  await git(directory, "checkout", "-b", "side");
  await writeFile(join(directory, "side.txt"), "side\n", "utf8");
  await git(directory, "add", "side.txt");
  await git(directory, "commit", "-m", "side work");
  await git(directory, "checkout", "main");
  await writeFile(join(directory, "main.txt"), "main\n", "utf8");
  await git(directory, "add", "main.txt");
  await git(directory, "commit", "-m", "main work");

  const reveries = await Reveries.open(directory);
  const tipBefore = await git(directory, "rev-parse", "HEAD");
  const candidate = await reveries.repository.mergeCandidateTree(["main", "side"]);
  const parents = await Promise.all([
    reveries.repository.treeForCommit("main"),
    reveries.repository.treeForCommit("side"),
  ]);
  const trees = { parents, result: candidate };
  assert.equal((await reveries.checkCandidateTransition(trees)).ok, false);
  await reveries.recordTransition({ ...trees, causal, metadata });
  const covered = await reveries.checkCandidateTransition(trees);
  assert.equal(covered.ok, true);
  assert.equal(await git(directory, "rev-parse", "HEAD"), tipBefore);
});

test("V1 session summaries remain readable as transition coverage", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  await reveries.summarize({ commit: "HEAD", summary: summary() });
  const check = await reveries.checkCommitTransition("HEAD");
  assert.equal(check.ok, true);
  assert.equal(check.coverage, "v1-summary");
  const bridge = await reveries.projectV1SummaryForTransition(
    await reveries.repository.resolveCommit("HEAD"),
  );
  assert.ok(bridge !== null);
  assert.equal(bridge.summary.entries.length, 1);
  assert.equal(bridge.result, await reveries.repository.resultTreeForCommit(
    await reveries.repository.resolveCommit("HEAD"),
  ));
});

test("an attested transition resolves for its published commit", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const head = await reveries.repository.resolveCommit("HEAD");
  const trees = await reveries.transitionTreesForCommit(head);
  const { record } = await reveries.recordTransition({ ...trees, causal, metadata });
  await reveries.recordAttestation({
    commit: "HEAD",
    transition: record.id,
    publisher: "reveries@example.com",
    metadata,
  });
  const check = await reveries.checkCommitTransition("HEAD");
  assert.equal(check.ok, true);
  assert.equal(check.coverage, "transition");
  assert.equal(check.transition, record.id);
});

test("a commit without any evidence fails the transition check", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const check = await reveries.checkCommitTransition("HEAD");
  assert.equal(check.ok, false);
  assert.equal(check.coverage, "none");
});
