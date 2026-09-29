import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";

import { checkReceive, classifyReceiveDiagnostic } from "../src/receive.ts";
import { Reveries } from "../src/operations.ts";
import { NOTES_REF } from "../src/git.ts";
import { objectId, type TransitionCausal, type TransitionMetadata } from "../src/protocol.ts";

const execFileAsync = promisify(execFile);
const temporary: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd, encoding: "utf8" })).stdout.trim();
}

const causal: TransitionCausal = {
  driving_event: "The merge queue creates final commit IDs after review.",
  decision: "Anchor causality to tree transitions because commit IDs change during publication.",
  impact: "Evidence stays stable across amends and squash merges.",
  recurrence_control: "The receive fixture rejects missing transition evidence.",
  alternatives: [],
  sources: [],
  reveries: [],
  retirements: [],
};

const metadata: TransitionMetadata = {
  author_email: "receive@example.com",
  session: "receive:transition",
  created_at: "2026-09-29T07:00:00Z",
};

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function setup(): Promise<{ source: string; bare: string }> {
  const root = await mkdtemp(join(tmpdir(), "reveries-transition-receive-"));
  temporary.push(root);
  const source = join(root, "source");
  const bare = join(root, "remote.git");
  await execFileAsync("mkdir", [source]);
  await execFileAsync("git", ["init", "--bare", bare]);
  await git(source, "init", "-b", "main");
  await git(source, "config", "user.name", "Receive Test");
  await git(source, "config", "user.email", "receive@example.com");
  await git(source, "remote", "add", "origin", bare);
  await writeFile(join(source, "state.txt"), "first\n", "utf8");
  await git(source, "add", "state.txt");
  await git(source, "commit", "-m", "initial");
  return { source, bare };
}

test("transition diagnostics classify with remediation", () => {
  const finding = classifyReceiveDiagnostic(
    "transition: Transition tr:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa has no evidence on result tree bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  );
  assert.equal(finding.code, "missing-transition-evidence");
  assert.equal(finding.grade, "strict");
  assert.match(finding.remediation, /refs\/notes\/reveries/);
});

test("receive validates a merge-group candidate before a final commit exists", async () => {
  const { source, bare } = await setup();
  const reveries = await Reveries.open(source);
  await git(source, "checkout", "-b", "side");
  await writeFile(join(source, "side.txt"), "side\n", "utf8");
  await git(source, "add", "side.txt");
  await git(source, "commit", "-m", "side work");
  await git(source, "checkout", "main");
  await writeFile(join(source, "main.txt"), "main\n", "utf8");
  await git(source, "add", "main.txt");
  await git(source, "commit", "-m", "main work");

  const candidate = await reveries.repository.mergeCandidateTree(["main", "side"]);
  const parents = [
    objectId(await git(source, "rev-parse", "main^{tree}")),
    objectId(await git(source, "rev-parse", "side^{tree}")),
  ];
  const { record } = await reveries.recordTransition({ parents, result: candidate, causal, metadata });
  await git(source, "merge", "--no-ff", "side", "-m", "merge side");
  const mergedTree = objectId(await git(source, "rev-parse", "HEAD^{tree}"));
  assert.equal(mergedTree, candidate);
  await git(source, "push", "origin", "main", "side");
  await git(source, "push", "origin", "refs/notes/reveries:refs/notes/proposed");
  const proposedNotes = objectId(await git(bare, "rev-parse", "refs/notes/proposed"));

  const accepted = await checkReceive(bare, {
    updates: [{ ref: NOTES_REF, oldObject: null, newObject: proposedNotes }],
    transitions: [{ parents: [...parents], result: candidate, transition: record.id }],
  });
  assert.equal(accepted.ok, true, JSON.stringify(accepted.diagnostics));
});

test("receive fails closed when transition evidence is missing or stale", async () => {
  const { source, bare } = await setup();
  const reveries = await Reveries.open(source);
  const head = await reveries.repository.resolveCommit("HEAD");
  const trees = await reveries.transitionTreesForCommit(head);
  const { record } = await reveries.recordTransition({ ...trees, causal, metadata });
  await git(source, "push", "origin", "main");
  await git(source, "push", "origin", "refs/notes/reveries:refs/notes/proposed");
  const proposedNotes = objectId(await git(bare, "rev-parse", "refs/notes/proposed"));

  const missing = await checkReceive(bare, {
    updates: [{ ref: NOTES_REF, oldObject: null, newObject: proposedNotes }],
    transitions: [{
      parents: [...trees.parents],
      result: trees.result,
      transition: `tr:${"0".repeat(40)}`,
    }],
  });
  assert.equal(missing.ok, false);
  assert.match(missing.diagnostics.join("\n"), /carries no tr:0+/);
  assert.ok(missing.findings.some((finding) => finding.code === "missing-transition-evidence"));

  const staleParents = await checkReceive(bare, {
    updates: [{ ref: NOTES_REF, oldObject: null, newObject: proposedNotes }],
    transitions: [{
      parents: [objectId(await git(source, "rev-parse", "HEAD^{tree}")), trees.result],
      result: trees.result,
      transition: record.id,
    }],
  });
  assert.equal(staleParents.ok, false);
  assert.match(staleParents.diagnostics.join("\n"), /does not match the claimed trees/);

  const withoutNotes = await checkReceive(bare, {
    updates: [],
    transitions: [{ parents: [...trees.parents], result: trees.result, transition: record.id }],
  });
  assert.equal(withoutNotes.ok, false);
  assert.match(withoutNotes.diagnostics.join("\n"), /requires a proposed refs\/notes\/reveries update/);
});
