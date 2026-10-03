import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";

import { GitRepository, LEDGER_MESSAGE, LEDGER_REF } from "../src/git.ts";
import {
  canonicalLedgerManifest,
  createLedgerManifest,
  readLedgerManifest,
  type LedgerManifest,
  type ObjectId,
} from "../src/protocol.ts";

const execFileAsync = promisify(execFile);
const temporaryRepositories: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

async function createRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "reveries-ledger-git-"));
  temporaryRepositories.push(directory);
  await git(directory, "init", "-b", "main");
  await git(directory, "config", "user.name", "Reveries Test");
  await git(directory, "config", "user.email", "reveries@example.com");
  await writeFile(join(directory, "state.txt"), "first\n", "utf8");
  await git(directory, "add", "state.txt");
  await git(directory, "commit", "-m", "initial");
  return directory;
}

/** Annotate the committed blob with one canonical reverie line. */
async function annotate(repository: GitRepository, line: string): Promise<ObjectId> {
  const blob = await repository.resolvePath({ path: "state.txt", revision: "HEAD" });
  await repository.withNotesWrite(async (transaction) => {
    await transaction.append(blob, line);
  });
  return blob;
}

async function manifestFor(
  repository: GitRepository,
  overrides: Partial<Parameters<typeof createLedgerManifest>[0]> = {},
): Promise<LedgerManifest> {
  const notesCommit = await repository.notesTip();
  return createLedgerManifest({
    notes_commit: notesCommit,
    notes_tree: notesCommit === null ? null : await repository.treeForCommit(notesCommit),
    previous_ledger: null,
    retention_commit: null,
    authority: null,
    annotated_subjects: 0,
    records: 0,
    note_bytes: 0,
    ...overrides,
  });
}

afterEach(async () => {
  await Promise.all(temporaryRepositories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("ledgerTip is null before a checkpoint exists", async () => {
  const directory = await createRepository();
  const repository = await GitRepository.open(directory);
  assert.equal(await repository.ledgerTip(), null);
});

test("a ledger checkpoint grafts the exact notes tree and stores the canonical manifest", async () => {
  const directory = await createRepository();
  const repository = await GitRepository.open(directory);
  await annotate(repository, '{"v":1,"type":"reverie","id":"rv:one"}\n');
  const manifest = await manifestFor(repository, { annotated_subjects: 1 });

  const checkpoint = await repository.commitLedgerCheckpoint({ manifest });
  await repository.updateLedgerRef({ next: checkpoint });

  assert.equal(await repository.ledgerTip(), checkpoint);
  assert.equal(await repository.notesTreeAt(checkpoint), manifest.notes_tree);
  const stored = await repository.readLedgerManifestAt(checkpoint);
  assert.equal(stored, canonicalLedgerManifest(manifest));
  assert.deepEqual(readLedgerManifest(stored!), manifest);
});

test("a ledger checkpoint is byte-deterministic for the same manifest", async () => {
  const directory = await createRepository();
  const repository = await GitRepository.open(directory);
  await annotate(repository, '{"v":1,"type":"reverie","id":"rv:one"}\n');
  const manifest = await manifestFor(repository, { annotated_subjects: 1 });
  const first = await repository.commitLedgerCheckpoint({ manifest });
  const second = await repository.commitLedgerCheckpoint({ manifest });
  assert.equal(first, second);
});

test("a ledger checkpoint carries the previous ledger, notes, and retention parents in order", async () => {
  const directory = await createRepository();
  const repository = await GitRepository.open(directory);
  await annotate(repository, '{"v":1,"type":"reverie","id":"rv:one"}\n');

  const firstManifest = await manifestFor(repository, { annotated_subjects: 1 });
  const first = await repository.commitLedgerCheckpoint({ manifest: firstManifest });
  await repository.updateLedgerRef({ next: first });

  await annotate(repository, '{"v":1,"type":"reverie","id":"rv:two"}\n');
  const notesCommit = await repository.notesTip();
  const secondManifest = await manifestFor(repository, {
    previous_ledger: first,
    notes_commit: notesCommit,
    notes_tree: await repository.treeForCommit(notesCommit!),
    annotated_subjects: 1,
  });
  const second = await repository.commitLedgerCheckpoint({ manifest: secondManifest });

  assert.deepEqual(await repository.ledgerParents(second), [first, notesCommit]);
  assert.equal(await repository.isLedgerCheckpoint(second), true);
  assert.equal(await repository.isLedgerCheckpoint(await repository.resolveCommit("HEAD")), false);
});

test("an optional retention checkpoint becomes the third parent", async () => {
  const directory = await createRepository();
  const repository = await GitRepository.open(directory);
  await annotate(repository, '{"v":1,"type":"reverie","id":"rv:one"}\n');
  const retention = await repository.writeRetentionCommits([await repository.resolveCommit("HEAD")], null);
  assert.notEqual(retention, null);

  const manifest = await manifestFor(repository, { retention_commit: retention, annotated_subjects: 1 });
  const checkpoint = await repository.commitLedgerCheckpoint({ manifest });
  assert.deepEqual(await repository.ledgerParents(checkpoint), [manifest.notes_commit, retention]);
  assert.equal(await repository.isRetentionCheckpoint(retention!), true);
});

test("a genesis checkpoint with no notes and no previous ledger has no parents", async () => {
  const directory = await createRepository();
  const repository = await GitRepository.open(directory);
  const manifest = createLedgerManifest({
    notes_commit: null,
    notes_tree: null,
    previous_ledger: null,
    retention_commit: null,
    authority: null,
    annotated_subjects: 0,
    records: 0,
    note_bytes: 0,
  });
  const checkpoint = await repository.commitLedgerCheckpoint({ manifest });
  assert.deepEqual(await repository.ledgerParents(checkpoint), []);
  assert.equal(await repository.notesTreeAt(checkpoint), await repository.emptyTreeObjectId());
});

test("updateLedgerRef refuses to move the branch from an unexpected tip", async () => {
  const directory = await createRepository();
  const repository = await GitRepository.open(directory);
  await annotate(repository, '{"v":1,"type":"reverie","id":"rv:one"}\n');
  const manifest = await manifestFor(repository, { annotated_subjects: 1 });
  const checkpoint = await repository.commitLedgerCheckpoint({ manifest });
  await repository.updateLedgerRef({ next: checkpoint, expected: null });
  assert.equal(await repository.ledgerTip(), checkpoint);

  await assert.rejects(
    () => repository.updateLedgerRef({ next: checkpoint, expected: null }),
    /changed concurrently/,
  );
  assert.equal(await repository.ledgerTip(), checkpoint);
});

test("ledgerNotesLines reports every canonical line in the grafted notes tree", async () => {
  const directory = await createRepository();
  const repository = await GitRepository.open(directory);
  const blob = await repository.resolvePath({ path: "state.txt", revision: "HEAD" });
  await repository.withNotesWrite(async (transaction) => {
    await transaction.append(blob, '{"v":1,"type":"reverie","id":"rv:one"}\n');
    await transaction.append(blob, '{"v":1,"type":"reverie","id":"rv:two"}\n');
  });
  const manifest = await manifestFor(repository, { annotated_subjects: 1 });
  const checkpoint = await repository.commitLedgerCheckpoint({ manifest });

  const lines = await repository.ledgerNotesLines(checkpoint);
  assert.deepEqual([...lines.keys()], [blob]);
  assert.deepEqual([...(lines.get(blob) ?? [])].sort(), [
    '{"v":1,"type":"reverie","id":"rv:one"}',
    '{"v":1,"type":"reverie","id":"rv:two"}',
  ]);
});

test("a ledger commit carries the fixed checkpoint message", async () => {
  const directory = await createRepository();
  const repository = await GitRepository.open(directory);
  const checkpoint = await repository.commitLedgerCheckpoint({
    manifest: createLedgerManifest({
      notes_commit: null,
      notes_tree: null,
      previous_ledger: null,
      retention_commit: null,
      authority: null,
      annotated_subjects: 0,
      records: 0,
      note_bytes: 0,
    }),
  });
  assert.equal(await git(directory, "show", "-s", "--format=%s", checkpoint), LEDGER_MESSAGE.trimEnd());
  assert.equal(
    await git(directory, "show", "-s", "--format=%an <%ae>", checkpoint),
    "Reveries Ledger <ledger@reveries.local>",
  );
});

test("an unknown ledger tree entry is reported rather than silently accepted", async () => {
  const directory = await createRepository();
  const repository = await GitRepository.open(directory);
  const manifest = createLedgerManifest({
    notes_commit: null,
    notes_tree: null,
    previous_ledger: null,
    retention_commit: null,
    authority: null,
    annotated_subjects: 0,
    records: 0,
    note_bytes: 0,
  });
  const checkpoint = await repository.commitLedgerCheckpoint({ manifest });
  const tree = await repository.treeForCommit(checkpoint);
  assert.deepEqual((await repository.ledgerTreeEntries(checkpoint)).map((entry) => entry.path).sort(), [
    "manifest.json",
    "notes",
  ]);
  assert.equal(await repository.treeEntryAt(tree, "review"), null);
});
