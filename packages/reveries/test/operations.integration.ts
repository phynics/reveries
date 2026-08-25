import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";

import { Reveries } from "../src/operations.ts";
import { blobId, type ReverieInput, type ReverieMetadata, type ReveriesInit, type SessionSummary } from "../src/protocol.ts";

const execFileAsync = promisify(execFile);
const temporaryRepositories: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

async function createRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "reveries-ops-"));
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
  session: "codex:test",
  created_at: "2026-08-25T03:00:00Z",
};

function summary(reveries: SessionSummary["entries"][number]["reveries"] = []): SessionSummary {
  return {
    v: 1,
    type: "session-summary",
    author_email: "reveries@example.com",
    session: "codex:test",
    created_at: "2026-08-25T03:05:00Z",
    entries: [{
      driving_event: "The implementation needed one transition owner.",
      decision: "Publish the guarded-boundary change because it removes competing transition authority.",
      impact: "Callers now write through one boundary.",
      recurrence_control: "The concurrency test covers stale predecessors.",
      alternatives: [],
      sources: [],
      reveries: [...reveries],
      retirements: [],
    }],
  };
}

afterEach(async () => {
  await Promise.all(temporaryRepositories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("records, shows, and continues a decision onto a staged successor blob", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const first = await reveries.recordNew({ path: "state.txt", revision: "HEAD", semantic, metadata });

  const shown = await reveries.show({ target: "state.txt", revision: "HEAD" });
  assert.equal(shown.active.length, 1);
  assert.equal(shown.active[0]?.id, first.record.id);
  assert.deepEqual(shown.paths, ["state.txt"]);

  await writeFile(join(directory, "state.txt"), "second\n", "utf8");
  await git(directory, "add", "state.txt");
  const stagedBefore = await reveries.show({ target: "state.txt", revision: "index" });
  assert.equal(stagedBefore.active.length, 0);

  const continued = await reveries.recordContinue({
    fromBlob: first.object,
    toPath: "state.txt",
    toRevision: "index",
    id: first.record.id,
  });
  assert.equal(continued.record.id, first.record.id);
  const check = await reveries.checkStaged();
  assert.equal(check.ok, true, JSON.stringify(check.diagnostics));
});

test("repository-backed semantic IDs use SHA-256 when the repository does", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reveries-ops-sha256-"));
  temporaryRepositories.push(directory);
  await git(directory, "init", "-b", "main", "--object-format=sha256");
  await git(directory, "config", "user.name", "Reveries Test");
  await git(directory, "config", "user.email", "reveries@example.com");
  await writeFile(join(directory, "state.txt"), "sha256\n", "utf8");
  await git(directory, "add", "state.txt");
  await git(directory, "commit", "-m", "initial");
  const reveries = await Reveries.open(directory);

  const result = await reveries.recordNew({ path: "state.txt", revision: "HEAD", semantic, metadata });
  const shown = await reveries.show({ target: "state.txt", revision: "HEAD" });

  assert.match(result.record.id, /^rv:[0-9a-f]{64}$/);
  assert.equal(shown.active[0]?.id, result.record.id);
});

test("requires one summary for every descendant of the initialization commit", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const adoption = await git(directory, "rev-parse", "HEAD");
  await reveries.summarize({ commit: adoption, summary: summary() });
  const init: ReveriesInit = {
    v: 1,
    type: "reveries-init",
    protocol: 1,
    notes_ref: "refs/notes/reveries",
    publishing_remotes: ["origin"],
    hosts: ["codex"],
    author_email: "reveries@example.com",
    created_at: "2026-08-25T03:05:00Z",
  };
  await reveries.attachInitialization({ commit: adoption, record: init });

  await writeFile(join(directory, "state.txt"), "second\n", "utf8");
  await git(directory, "add", "state.txt");
  await git(directory, "commit", "-m", "unsummarized");
  const commit = await git(directory, "rev-parse", "HEAD");
  const missing = await reveries.checkCommit(commit);
  assert.equal(missing.ok, false);
  assert.match(missing.diagnostics.join("\n"), /session summary/i);

  await reveries.summarize({ commit, summary: summary() });
  const complete = await reveries.checkCommit(commit);
  assert.equal(complete.ok, true, JSON.stringify(complete.diagnostics));
});

test("summary replacement keeps the initialization record and rejects concurrent duplicates", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const commit = await git(directory, "rev-parse", "HEAD");
  await reveries.summarize({ commit, summary: summary() });
  await reveries.attachInitialization({
    commit,
    record: {
      v: 1,
      type: "reveries-init",
      protocol: 1,
      notes_ref: "refs/notes/reveries",
      publishing_remotes: ["origin"],
      hosts: ["codex"],
      author_email: "reveries@example.com",
      created_at: "2026-08-25T03:05:00Z",
    },
  });
  await assert.rejects(reveries.summarize({ commit, summary: summary() }), /more than one session summary/i);

  await reveries.summarize({
    commit,
    summary: { ...summary(), correction_reason: "The first summary omitted the compatibility constraint." },
    replace: true,
  });
  const shown = await reveries.show({ target: commit });
  assert.equal(shown.records.filter((record) => record.type === "session-summary").length, 1);
  assert.equal(shown.records.filter((record) => record.type === "reveries-init").length, 1);
});

test("search defaults to current blobs and supports historical notes", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  await reveries.recordNew({ path: "state.txt", revision: "HEAD", semantic, metadata });

  const current = await reveries.search({ query: "guarded mutation", all: false });
  assert.equal(current.length, 1);
  assert.deepEqual(current[0]?.paths, ["state.txt"]);

  await writeFile(join(directory, "state.txt"), "replacement\n", "utf8");
  await git(directory, "add", "state.txt");
  await git(directory, "commit", "-m", "replace");
  const noLongerCurrent = await reveries.search({ query: "guarded mutation", all: false });
  assert.equal(noLongerCurrent.length, 0);
  const historical = await reveries.search({ query: "guarded mutation", all: true });
  assert.equal(historical.length, 1);
});

test("deleting one path does not retire a blob that remains at another path", async () => {
  const directory = await createRepository();
  await writeFile(join(directory, "copy.txt"), "first\n", "utf8");
  await git(directory, "add", "copy.txt");
  await git(directory, "commit", "-m", "copy identical blob");
  const reveries = await Reveries.open(directory);
  await reveries.recordNew({ path: "state.txt", revision: "HEAD", semantic, metadata });

  await rm(join(directory, "copy.txt"));
  await git(directory, "add", "copy.txt");
  const check = await reveries.checkStaged();

  assert.equal(check.ok, true, JSON.stringify(check.diagnostics));
});

test("continuity refuses an arbitrary unstaged object", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const first = await reveries.recordNew({ path: "state.txt", revision: "HEAD", semantic, metadata });
  await writeFile(join(directory, "orphan.txt"), "orphan\n", "utf8");
  const orphan = await git(directory, "hash-object", "-w", "orphan.txt");

  await assert.rejects(
    reveries.recordContinueToBlob({
      fromBlob: first.object,
      toBlob: blobId(orphan),
      id: first.record.id,
    }),
    /neither staged nor reachable/i,
  );
});

test("an explicit successor resolves a rename-plus-edit that Git cannot map", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const first = await reveries.recordNew({ path: "state.txt", revision: "HEAD", semantic, metadata });
  await rename(join(directory, "state.txt"), join(directory, "renamed.txt"));
  await writeFile(join(directory, "renamed.txt"), "entirely different successor content\n", "utf8");
  await git(directory, "add", "-A");
  await reveries.recordContinue({
    fromBlob: first.object,
    toPath: "renamed.txt",
    toRevision: "index",
    id: first.record.id,
  });

  assert.equal((await reveries.checkStaged()).ok, false);
  const explicit = await reveries.checkStaged(new Map([["state.txt", "renamed.txt"]]));
  assert.equal(explicit.ok, true, JSON.stringify(explicit.diagnostics));
});

test("merge continuity is checked independently from every parent", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const base = await git(directory, "rev-parse", "HEAD");
  const first = await reveries.recordNew({ path: "state.txt", revision: "HEAD", semantic, metadata });
  await reveries.summarize({ commit: base, summary: summary([first.record.id]) });
  await reveries.attachInitialization({
    commit: base,
    record: {
      v: 1,
      type: "reveries-init",
      protocol: 1,
      notes_ref: "refs/notes/reveries",
      publishing_remotes: ["origin"],
      hosts: ["codex"],
      author_email: "reveries@example.com",
      created_at: "2026-08-25T03:05:00Z",
    },
  });

  await git(directory, "checkout", "-b", "left");
  await writeFile(join(directory, "state.txt"), "left parent\n", "utf8");
  await git(directory, "add", "state.txt");
  const replacement = await reveries.recordSupersede({
    path: "state.txt",
    revision: "index",
    semantic: {
      ...semantic,
      decision: "Use the left-parent guard because it owns the migrated transition format.",
    },
    metadata,
    old: first.record.id,
  });
  await git(directory, "commit", "-m", "left decision");
  const leftCommit = await git(directory, "rev-parse", "HEAD");
  await reveries.summarize({ commit: leftCommit, summary: summary([replacement.record.id]) });

  await git(directory, "checkout", "main");
  await writeFile(join(directory, "state.txt"), "right parent\n", "utf8");
  await git(directory, "add", "state.txt");
  await reveries.recordContinue({
    fromBlob: first.object,
    toPath: "state.txt",
    toRevision: "index",
    id: first.record.id,
  });
  await git(directory, "commit", "-m", "right continuation");
  const rightCommit = await git(directory, "rev-parse", "HEAD");
  await reveries.summarize({ commit: rightCommit, summary: summary() });

  try {
    await git(directory, "merge", "--no-commit", "left");
  } catch {
    // The fixture intentionally creates a content conflict.
  }
  await writeFile(join(directory, "state.txt"), "merged result\n", "utf8");
  await git(directory, "add", "state.txt");
  const mergedBlob = blobId(await git(directory, "rev-parse", ":state.txt"));
  const rightBlob = blobId(await git(directory, "rev-parse", `${rightCommit}:state.txt`));
  await reveries.recordContinueToBlob({ fromBlob: rightBlob, toBlob: mergedBlob, id: first.record.id });
  await git(directory, "commit", "-m", "merge histories");
  const mergeCommit = await git(directory, "rev-parse", "HEAD");
  await reveries.summarize({ commit: mergeCommit, summary: summary() });

  const missingLeft = await reveries.checkCommit(mergeCommit);
  assert.equal(missingLeft.ok, false);
  assert.match(missingLeft.diagnostics.join("\n"), new RegExp(replacement.record.id));

  const leftBlob = blobId(await git(directory, "rev-parse", `${leftCommit}:state.txt`));
  await reveries.recordContinueToBlob({
    fromBlob: leftBlob,
    toBlob: mergedBlob,
    id: replacement.record.id,
  });
  const reconciled = await reveries.checkCommit(mergeCommit);
  assert.equal(reconciled.ok, true, JSON.stringify(reconciled.diagnostics));
});
