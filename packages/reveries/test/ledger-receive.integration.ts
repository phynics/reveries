import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";

import {
  GitRepository,
  hashBlobContent,
  LEDGER_MANIFEST_PATH,
  LEDGER_NOTES_PATH,
  LEDGER_REF,
} from "../src/git.ts";
import { Reveries } from "../src/operations.ts";
import {
  canonicalLedgerManifest,
  canonicalRecord,
  createLedgerManifest,
  createReverie,
  objectId,
  type ObjectId,
} from "../src/protocol.ts";
import { checkReceive } from "../src/receive.ts";

const execFileAsync = promisify(execFile);
const temporary: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd, encoding: "utf8" })).stdout.trim();
}

function reverieLine(decision: string): string {
  return canonicalRecord(createReverie(
    {
      v: 1,
      driving_event: "The envelope had no owner for the notes boundary.",
      decision,
      impact: "A clone receives the evidence through an ordinary branch fetch.",
      recurrence_control: null,
      alternatives: [],
      sources: [],
      supersedes: [],
    },
    { author_email: "receive@example.com", session: null, created_at: "2026-08-25T03:00:00Z" },
    (bytes) => hashBlobContent(bytes, "sha1"),
  ));
}

interface Fixture {
  readonly bare: string;
  readonly source: string;
  /** The checkpoint already published as the bare repository's ledger branch. */
  readonly published: ObjectId;
}

/** A publisher whose first ledger envelope is already on a bare receive target. */
async function publishEnvelope(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "reveries-ledger-receive-"));
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
  await appendEvidence(source, "Transport notes in a ledger envelope.");

  const checkpoint = (await (await Reveries.open(source)).buildLedgerCheckpoint({ authority: null })).checkpoint;
  assert.notEqual(checkpoint, null);
  await git(source, "push", "origin", `${LEDGER_REF}:${LEDGER_REF}`);
  return { bare, source, published: checkpoint as ObjectId };
}

/** Record one more reverie, so the next checkpoint is a real fast-forward. */
async function appendEvidence(source: string, decision: string): Promise<void> {
  const repository = await GitRepository.open(source);
  const blob = await repository.resolvePath({ path: "state.txt", revision: "HEAD" });
  await repository.withNotesWrite(async (transaction) => {
    await transaction.append(blob, reverieLine(decision));
  });
}

/**
 * Build the next checkpoint and land its objects on the bare target under a
 * staging ref. A receive proposal names objects the server already holds, so
 * the objects must be present before the checker runs.
 */
async function stageCheckpoint(source: string, bare: string): Promise<ObjectId> {
  const next = (await (await Reveries.open(source)).buildLedgerCheckpoint({ authority: null })).checkpoint;
  assert.notEqual(next, null);
  await git(source, "push", "origin", `${next as string}:refs/heads/staging`);
  return next as ObjectId;
}

/**
 * Build a checkpoint envelope by hand so a test can state a manifest that lies
 * about its own tree. This is the adversarial path: nothing goes through the
 * writer, so verification is the only thing that can catch it.
 */
async function forgeEnvelope(source: string, bare: string, previousLedger: ObjectId): Promise<ObjectId> {
  const repository = await GitRepository.open(source);
  const notesCommit = await repository.notesTip();
  const notesTree = await repository.emptyTreeObjectId();
  const manifest = createLedgerManifest({
    notes_commit: notesCommit,
    notes_tree: notesTree,
    previous_ledger: previousLedger,
    retention_commit: null,
    authority: null,
    annotated_subjects: 0,
    records: 0,
    note_bytes: 0,
  });
  const manifestBlob = await repository.writeBlob(canonicalLedgerManifest(manifest));
  const tree = (await repository.run(["mktree"], {
    input: `100644 blob ${manifestBlob}\t${LEDGER_MANIFEST_PATH}\n040000 tree ${notesTree}\t${LEDGER_NOTES_PATH}\n`,
  })).stdout.trim();
  const forged = (await repository.run([
    "commit-tree", tree,
    "-p", previousLedger,
    "-p", notesCommit as string,
    "-m", "Reveries ledger checkpoint",
  ])).stdout.trim() as ObjectId;
  await git(source, "push", "origin", `${forged}:refs/heads/staging`);
  return forged;
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("a ledger-only proposal is not held to authored-commit coverage", async () => {
  const { bare, source, published } = await publishEnvelope();
  await appendEvidence(source, "Fast-forward the envelope over newer notes.");
  const checkpoint = await stageCheckpoint(source, bare);

  const result = await checkReceive(bare, {
    updates: [{ ref: LEDGER_REF, oldObject: published, newObject: checkpoint }],
  });

  // The envelope carries the notes inside itself, so demanding a separate
  // notes-ref update would reject every legitimate ledger publication.
  assert.equal(
    result.diagnostics.some((diagnostic) => /must include a proposed refs\/notes\/reveries update/.test(diagnostic)),
    false,
    `a ledger-only proposal was asked for a notes update: ${result.diagnostics.join("; ")}`,
  );
  // The checkpoint is synthesized with a fixed identity and a fixed epoch date,
  // so it can never carry a session summary. It must not be asked for one.
  assert.equal(
    result.diagnostics.some((diagnostic) => /session summary/i.test(diagnostic)),
    false,
    `the ledger was held to session-summary coverage: ${result.diagnostics.join("; ")}`,
  );
  assert.deepEqual(result.findings, []);
  assert.equal(result.ok, true, result.diagnostics.join("; "));
});

test("a forged ledger envelope is still rejected on receive", async () => {
  const { bare, source, published } = await publishEnvelope();
  await appendEvidence(source, "Then lie about the envelope contents.");
  const forged = await forgeEnvelope(source, bare, published);

  const result = await checkReceive(bare, {
    updates: [{ ref: LEDGER_REF, oldObject: published, newObject: forged }],
  });

  // Withdrawing code coverage must not withdraw the envelope check itself.
  assert.equal(result.ok, false, "a manifest that lies about its own tree was accepted");
  assert.match(result.diagnostics.join("\n"), /notes tree|notes_tree|subtree/i);
});

test("a real code branch in the same proposal keeps full coverage", async () => {
  const { bare, source, published } = await publishEnvelope();
  await appendEvidence(source, "Publish the envelope beside real code.");
  const checkpoint = await stageCheckpoint(source, bare);

  const result = await checkReceive(bare, {
    updates: [
      { ref: LEDGER_REF, oldObject: published, newObject: checkpoint },
      { ref: "refs/heads/main", oldObject: null, newObject: checkpoint },
    ],
  });

  assert.equal(result.ok, false);
  assert.ok(
    result.findings.some((finding) => finding.code === "missing-notes-publication"),
    `the code branch escaped notes coverage: ${JSON.stringify(result.findings)}`,
  );
});

test("the ledger remote-tracking mirror is evidence, not code", async () => {
  const { bare, source, published } = await publishEnvelope();
  await appendEvidence(source, "Mirror the envelope for a second clone.");
  const checkpoint = await stageCheckpoint(source, bare);

  const result = await checkReceive(bare, {
    updates: [
      { ref: "refs/remotes/origin/reveries-ledger", oldObject: published, newObject: checkpoint },
      { ref: LEDGER_REF, oldObject: published, newObject: checkpoint },
    ],
  });

  assert.equal(result.ok, true, result.diagnostics.join("; "));
});
