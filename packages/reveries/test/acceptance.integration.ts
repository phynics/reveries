import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";

import { GitRepository } from "../src/git.ts";
import { Reveries, type PushUpdate } from "../src/operations.ts";
import {
  canonicalRecord,
  type ReverieInput,
  type ReverieMetadata,
  type ReveriesInit,
  type SessionSummary,
} from "../src/protocol.ts";

const execFileAsync = promisify(execFile);
const temporaryRepositories: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

async function quarantinedNote(cwd: string, ref: string, object: string): Promise<string> {
  const tree = await git(cwd, "ls-tree", "-r", ref);
  const line = tree.split("\n").find((candidate) => {
    const path = candidate.slice(candidate.indexOf("\t") + 1).replaceAll("/", "");
    return path === object;
  });
  assert.ok(line, `quarantine candidate does not contain a note for ${object}`);
  const path = line.slice(line.indexOf("\t") + 1);
  return git(cwd, "cat-file", "blob", `${ref}:${path}`);
}

async function createRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "reveries-acceptance-"));
  temporaryRepositories.push(directory);
  await git(directory, "init", "-b", "main");
  await git(directory, "config", "user.name", "Reveries Test");
  await git(directory, "config", "user.email", "reveries@example.com");
  await writeFile(join(directory, "state.txt"), "first\n", "utf8");
  await git(directory, "add", "state.txt");
  await git(directory, "commit", "-m", "initial");
  return directory;
}

const semantic: ReverieInput = {
  v: 1,
  driving_event: "Two writers could accept incompatible state transitions.",
  decision: "Use one guarded mutation boundary because transition validity needs one owner.",
  impact: "Every transition writer must use the guarded boundary.",
  recurrence_control: "The concurrency test rejects a stale predecessor.",
  alternatives: ["Reconcile two transition histories after each write"],
  sources: [],
  supersedes: [],
};

const metadata: ReverieMetadata = {
  author_email: "reveries@example.com",
  session: "codex:acceptance",
  created_at: "2026-08-25T03:00:00Z",
};

function summary(): SessionSummary {
  return {
    v: 1,
    type: "session-summary",
    author_email: "reveries@example.com",
    session: "codex:acceptance",
    created_at: "2026-08-25T03:05:00Z",
    entries: [{
      driving_event: "The repository needed a durable engineering account.",
      decision: "Publish this commit with a causal session summary.",
      impact: "Future reviewers can trace the engineering reason for the change.",
      recurrence_control: "The publication checker requires one summary per descendant commit.",
      alternatives: [],
      sources: [],
      reveries: [],
      retirements: [],
    }],
  };
}

function initialization(): ReveriesInit {
  return {
    v: 1,
    type: "reveries-init",
    protocol: 1,
    notes_ref: "refs/notes/reveries",
    publishing_remotes: ["origin"],
    hosts: ["codex"],
    author_email: "reveries@example.com",
    created_at: "2026-08-25T03:05:00Z",
  };
}

async function adopt(directory: string): Promise<string> {
  const reveries = await Reveries.open(directory);
  const commit = await git(directory, "rev-parse", "HEAD");
  await reveries.summarize({ commit, summary: summary() });
  await reveries.attachInitialization({ commit, record: initialization() });
  return commit;
}

async function commitChange(directory: string, path: string, content: string, message: string): Promise<string> {
  await writeFile(join(directory, path), content, "utf8");
  await git(directory, "add", path);
  await git(directory, "commit", "-m", message);
  return git(directory, "rev-parse", "HEAD");
}

function assertFreshSummaryAfterRewrite(
  label: string,
  rewrite: (directory: string, original: string) => Promise<string>,
): void {
  test(label, async () => {
    const directory = await createRepository();
    const reveries = await Reveries.open(directory);
    const adoption = await adopt(directory);
    const original = await commitChange(directory, "change.txt", "change\n", "summarized change");
    await reveries.summarize({ commit: original, summary: summary() });
    assert.equal((await reveries.checkCommit(original)).ok, true);

    const rewritten = await rewrite(directory, original);
    assert.notEqual(rewritten, original);
    const check = await reveries.checkCommit(rewritten);
    assert.equal(check.ok, false, `${label} unexpectedly inherited a summary from ${original}`);
    assert.match(check.diagnostics.join("\n"), /session summary/i);
    assert.notEqual(adoption, rewritten);
  });
}

afterEach(async () => {
  await Promise.all(temporaryRepositories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("unchanged rename retains the blob reverie", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const original = await reveries.recordNew({ path: "state.txt", revision: "HEAD", semantic, metadata });

  await git(directory, "mv", "state.txt", "renamed.txt");
  const check = await reveries.checkStaged();
  const shown = await reveries.show({ target: "renamed.txt", revision: "index" });

  assert.equal(check.ok, true, JSON.stringify(check.diagnostics));
  assert.equal(shown.active[0]?.id, original.record.id);
});

test("identical copy resolves the same blob reverie", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const original = await reveries.recordNew({ path: "state.txt", revision: "HEAD", semantic, metadata });

  await cp(join(directory, "state.txt"), join(directory, "copy.txt"));
  await git(directory, "add", "copy.txt");
  await git(directory, "commit", "-m", "copy identical blob");
  const shown = await reveries.show({ target: "copy.txt", revision: "HEAD" });

  assert.equal(shown.active[0]?.id, original.record.id);
  assert.deepEqual([...shown.paths].sort(), ["copy.txt", "state.txt"]);
});

test("conflicting duplicate semantic IDs are surfaced as damaged evidence", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const original = await reveries.recordNew({ path: "state.txt", revision: "HEAD", semantic, metadata });
  const repository = await GitRepository.open(directory);
  const conflicting = { ...original.record, decision: "A different decision under the same ID." };
  await repository.withNotesWrite((notes) => notes.append(original.object, canonicalRecord(conflicting)));

  const shown = await reveries.show({ target: "state.txt", revision: "HEAD" });
  assert.match(shown.diagnostics.join("\n"), /semantic ID mismatch|conflicting duplicate/i);
});

test("pre-initialization history is grandfathered", async () => {
  const directory = await createRepository();
  await commitChange(directory, "pre-init.txt", "historical\n", "pre-init work");
  const adoption = await adopt(directory);
  const reveries = await Reveries.open(directory);
  const repository = await GitRepository.open(directory);
  const notes = await repository.notesTip();
  assert.notEqual(notes, null);
  const check = await reveries.checkOutgoingUpdates("origin", [{
    localRef: "refs/heads/main",
    localObject: await repository.resolveCommit(adoption),
    remoteRef: "refs/heads/main",
    remoteObject: null,
  }, {
    localRef: "refs/notes/reveries",
    localObject: notes,
    remoteRef: "refs/notes/reveries",
    remoteObject: null,
  }]);
  assert.equal(check.ok, true, JSON.stringify(check.diagnostics));
});

test("a branch omitting the initialization boundary is rejected for publication", async () => {
  const directory = await createRepository();
  const preInit = await git(directory, "rev-parse", "HEAD");
  await git(directory, "checkout", "-b", "topic");
  const topic = await commitChange(directory, "topic.txt", "topic\n", "topic without adoption");
  await git(directory, "checkout", "main");
  await commitChange(directory, "adoption.txt", "adopt\n", "adoption commit");
  await adopt(directory);
  const reveries = await Reveries.open(directory);
  const update: PushUpdate = {
    localRef: "refs/heads/topic",
    localObject: await GitRepository.open(directory).then((repository) => repository.resolveCommit(topic)),
    remoteRef: "refs/heads/topic",
    remoteObject: null,
  };

  const check = await reveries.checkOutgoingUpdates("origin", [update]);
  assert.equal(preInit.length, 40);
  assert.equal(check.ok, false);
  assert.match(check.diagnostics.join("\n"), /initialization boundary/i);
});

assertFreshSummaryAfterRewrite("amend requires a fresh session summary", async (directory) => {
  await git(directory, "commit", "--amend", "-m", "amended change");
  return git(directory, "rev-parse", "HEAD");
});

assertFreshSummaryAfterRewrite("rebase requires fresh session summaries", async (directory, original) => {
  const parent = await git(directory, "rev-parse", `${original}^`);
  await git(directory, "checkout", "-B", "rebase-base", parent);
  await commitChange(directory, "base.txt", "base\n", "rebase base");
  await git(directory, "checkout", "-B", "topic", original);
  await git(directory, "rebase", "rebase-base");
  return git(directory, "rev-parse", "HEAD");
});

assertFreshSummaryAfterRewrite("squash requires a fresh session summary", async (directory, original) => {
  await commitChange(directory, "second.txt", "second\n", "second change");
  const parent = await git(directory, "rev-parse", `${original}^`);
  await git(directory, "reset", "--soft", parent);
  await git(directory, "commit", "-m", "squashed change");
  return git(directory, "rev-parse", "HEAD");
});

assertFreshSummaryAfterRewrite("cherry-pick requires a fresh session summary", async (directory, original) => {
  await git(directory, "checkout", "-b", "source");
  await git(directory, "config", "user.name", "Source Test");
  const source = await commitChange(directory, "cherry.txt", "cherry\n", "source change");
  await git(directory, "config", "user.name", "Reveries Test");
  const sourceReveries = await Reveries.open(directory);
  await sourceReveries.summarize({ commit: source, summary: summary() });
  await git(directory, "checkout", "-B", "main", original);
  await git(directory, "cherry-pick", source);
  return git(directory, "rev-parse", "HEAD");
});

test("a stale non-fast-forward notes push fails safely", async () => {
  const source = await createRepository();
  const bare = await mkdtemp(join(tmpdir(), "reveries-acceptance-bare-"));
  const stale = await mkdtemp(join(tmpdir(), "reveries-acceptance-stale-"));
  temporaryRepositories.push(bare, stale);
  await git(bare, "init", "--bare");
  await git(source, "remote", "add", "origin", bare);
  await git(source, "push", "origin", "main");
  await git(stale, "clone", source, ".");
  await git(stale, "remote", "set-url", "origin", bare);
  await git(stale, "config", "user.name", "Reveries Test");
  await git(stale, "config", "user.email", "reveries@example.com");

  const current = await GitRepository.open(source);
  const oldClone = await GitRepository.open(stale);
  const currentBlob = await current.resolvePath({ path: "state.txt", revision: "HEAD" });
  const staleBlob = await oldClone.resolvePath({ path: "state.txt", revision: "HEAD" });
  await current.withNotesWrite((notes) => notes.append(currentBlob, "{\"writer\":\"current\"}\n"));
  await current.pushAtomically("origin");
  const remoteTipBefore = await git(bare, "rev-parse", "refs/notes/reveries");
  await oldClone.withNotesWrite((notes) => notes.append(staleBlob, "{\"writer\":\"stale\"}\n"));

  await assert.rejects(() => oldClone.pushAtomically("origin"), /rejected|non-fast-forward|failed/i);
  assert.equal(await git(bare, "rev-parse", "refs/notes/reveries"), remoteTipBefore);
});

test("publication fails closed when the receiving end lacks atomic support", async () => {
  const source = await createRepository();
  const bare = await mkdtemp(join(tmpdir(), "reveries-acceptance-atomic-bare-"));
  temporaryRepositories.push(bare);
  await git(bare, "init", "--bare");
  await git(source, "remote", "add", "origin", bare);
  await git(source, "push", "origin", "main");

  const reveries = await Reveries.open(source);
  await adopt(source);
  await git(bare, "config", "receive.advertiseAtomic", "false");
  const branchBefore = await git(bare, "rev-parse", "refs/heads/main");

  await assert.rejects(() => reveries.push("origin"), /does not support atomic/i);
  assert.equal(await git(bare, "rev-parse", "refs/heads/main"), branchBefore);
  await assert.rejects(() => git(bare, "rev-parse", "refs/notes/reveries"), /exit code|unknown revision|needed a single revision/i);
});

test("a rejected atomic publication advances neither branch nor notes", async () => {
  const source = await createRepository();
  const bare = await mkdtemp(join(tmpdir(), "reveries-acceptance-atomic-reject-bare-"));
  temporaryRepositories.push(bare);
  await git(bare, "init", "--bare");
  await git(source, "remote", "add", "origin", bare);
  await git(source, "push", "origin", "main");

  const reveries = await Reveries.open(source);
  await adopt(source);
  await reveries.repository.pushAtomically("origin");
  await writeFile(join(source, "state.txt"), "second\n", "utf8");
  await git(source, "add", "state.txt");
  await git(source, "commit", "-m", "published change");
  const commit = await git(source, "rev-parse", "HEAD");
  await reveries.summarize({ commit, summary: summary() });

  await writeFile(
    join(bare, "hooks", "update"),
    "#!/bin/sh\nif [ \"$1\" = \"refs/notes/reveries\" ]; then exit 1; fi\nexit 0\n",
    { encoding: "utf8", mode: 0o755 },
  );
  const branchBefore = await git(bare, "rev-parse", "refs/heads/main");
  const notesBefore = await git(bare, "rev-parse", "refs/notes/reveries");

  await assert.rejects(() => reveries.push("origin"), /rejected|failed|atomic/i);
  assert.equal(await git(bare, "rev-parse", "refs/heads/main"), branchBefore);
  assert.equal(await git(bare, "rev-parse", "refs/notes/reveries"), notesBefore);
});

test("atomic publication marks the real push as helper-owned", async () => {
  const source = await createRepository();
  const bare = await mkdtemp(join(tmpdir(), "reveries-acceptance-helper-marker-bare-"));
  temporaryRepositories.push(bare);
  await git(bare, "init", "--bare");
  await git(source, "remote", "add", "origin", bare);
  await writeFile(
    join(source, ".git", "hooks", "pre-push"),
    "#!/bin/sh\ntest \"$REVERIES_INTERNAL_ATOMIC_PUSH\" = \"1\"\n",
    { encoding: "utf8", mode: 0o755 },
  );

  const repository = await GitRepository.open(source);
  const commit = await repository.resolveCommit("HEAD");
  await repository.withNotesWrite((notes) => notes.append(commit, "{\"marker\":true}\n"));
  await repository.pushAtomically("origin");

  assert.equal(await git(bare, "rev-parse", "refs/heads/main"), await git(source, "rev-parse", "HEAD"));
});

test("sync quarantines an invalid fetched union without promoting or losing records", async () => {
  const source = await createRepository();
  const bare = await mkdtemp(join(tmpdir(), "reveries-acceptance-quarantine-bare-"));
  const local = await mkdtemp(join(tmpdir(), "reveries-acceptance-quarantine-local-"));
  const remote = await mkdtemp(join(tmpdir(), "reveries-acceptance-quarantine-remote-"));
  temporaryRepositories.push(bare, local, remote);
  await git(bare, "init", "--bare");
  await git(source, "remote", "add", "origin", bare);
  await git(source, "push", "origin", "main");
  await git(local, "clone", source, ".");
  await git(remote, "clone", source, ".");
  for (const clone of [local, remote]) {
    await git(clone, "remote", "set-url", "origin", bare);
    await git(clone, "config", "user.name", "Reveries Test");
    await git(clone, "config", "user.email", "reveries@example.com");
  }

  const localReveries = await Reveries.open(local);
  const remoteReveries = await Reveries.open(remote);
  const localRepository = await GitRepository.open(local);
  const remoteRepository = await GitRepository.open(remote);
  const commit = await localRepository.resolveCommit("HEAD");
  const blob = await localRepository.resolvePath({ path: "state.txt", revision: "HEAD" });
  const localRecord = await localReveries.recordNew({ path: "state.txt", revision: "HEAD", semantic, metadata });
  const remoteRecord = await remoteReveries.recordNew({
    path: "state.txt",
    revision: "HEAD",
    semantic: { ...semantic, decision: "Use the remote guarded boundary because it owns the merged transition format." },
    metadata,
  });
  await localRepository.withNotesWrite((notes) => notes.append(commit, canonicalRecord({
    ...summary(),
    entries: [{ ...summary().entries[0]!, decision: "Keep the local summary while the union is unresolved." }],
  })));
  await remoteRepository.withNotesWrite((notes) => notes.append(commit, canonicalRecord({
    ...summary(),
    entries: [{ ...summary().entries[0]!, decision: "Keep the remote summary while the union is unresolved." }],
  })));
  await git(remote, "push", "origin", "refs/notes/reveries:refs/notes/reveries");

  const canonicalBefore = await localRepository.notesTip();
  const result = await localReveries.syncPull("origin");

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.match(result.diagnostics.join("\n"), /more than one session summary/i);
  assert.match(result.diagnostics.join("\n"), /quarantined at refs\/reveries\/quarantine\/origin\//i);
  assert.equal(result.conflicts.length, 1);
  const conflict = result.conflicts[0]!;
  assert.equal(conflict.kind, "invalid-notes-union");
  assert.equal(conflict.conflictType, "duplicate-session-summary");
  assert.equal(conflict.annotatedObject, commit);
  assert.equal(conflict.provenance.localNotes, canonicalBefore);
  assert.match(conflict.provenance.remoteNotes, /^[0-9a-f]{40}$/);
  assert.match(conflict.provenance.candidate, /^[0-9a-f]{40}$/);
  assert.match(conflict.provenance.quarantineRef, /^refs\/reveries\/quarantine\/origin\/[0-9a-f]{40}$/);
  assert.deepEqual(
    conflict.records.map((record) => record.origins),
    [["local"], ["remote"]],
  );
  assert.match(conflict.records[0]!.canonicalLine, /Keep the local summary/);
  assert.match(conflict.records[1]!.canonicalLine, /Keep the remote summary/);
  assert.ok(conflict.resolutionActions.some((action) => action.kind === "construct-replacement-candidate"));
  assert.equal(await localRepository.notesTip(), canonicalBefore);

  const quarantine = await git(local, "for-each-ref", "--format=%(refname)", "refs/reveries/quarantine/origin");
  assert.match(quarantine, /^refs\/reveries\/quarantine\/origin\/[0-9a-f]{40}$/);
  const quarantinedBlobNote = await quarantinedNote(local, quarantine, blob);
  assert.match(quarantinedBlobNote, new RegExp(localRecord.record.id));
  assert.match(quarantinedBlobNote, new RegExp(remoteRecord.record.id));
  const quarantinedSummaryNote = await quarantinedNote(local, quarantine, commit);
  assert.match(quarantinedSummaryNote, /Keep the local summary/);
  assert.match(quarantinedSummaryNote, /Keep the remote summary/);
});
