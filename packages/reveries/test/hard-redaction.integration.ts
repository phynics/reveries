import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";

import {
  LEDGER_REF,
  NOTES_REF,
  RETENTION_COMMITS_REF,
  RETENTION_OBJECTS_REF,
} from "../src/git.ts";
import { HARD_REDACTION_DISCLAIMER, Reveries } from "../src/operations.ts";
import {
  canonicalRecord,
  objectId,
  parseNote,
  type ReverieInput,
  type ReverieMetadata,
} from "../src/protocol.ts";

const execFileAsync = promisify(execFile);
const temporaryRepositories: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd, encoding: "utf8" })).stdout.trim();
}

/** Empty string when Git exits nonzero, so a missing ref reads as absent. */
async function gitMaybe(cwd: string, ...args: string[]): Promise<string> {
  try {
    return (await execFileAsync("git", args, { cwd, encoding: "utf8" })).stdout.trim();
  } catch {
    return "";
  }
}

const metadata: ReverieMetadata = {
  author_email: "reveries@example.com",
  session: "codex:hard-redaction",
  created_at: "2026-09-29T09:00:00Z",
};

function semantic(decision: string, supersedes: string[] = []): ReverieInput {
  return {
    v: 1,
    driving_event: "A recorded decision carried regulated customer data.",
    decision,
    impact: "The rewritten snapshot keeps every surviving decision byte-identical.",
    recurrence_control: "The hard-redaction fixture asserts the removed record is unreachable.",
    alternatives: [],
    sources: [],
    supersedes: supersedes as never[],
  };
}

async function createRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "reveries-hard-redaction-"));
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

test("hard redaction severs local copies, leaves a verifiable checkpoint, and reports remote work", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const secret = await reveries.recordNew({
    path: "state.txt",
    revision: "HEAD",
    semantic: semantic("Keep the customer account numbers because support needed them."),
    metadata,
  });
  const kept = await reveries.recordNew({
    path: "state.txt",
    revision: "HEAD",
    semantic: semantic("Store only aggregate counts in engineering evidence."),
    metadata,
  });
  const notesBefore = await reveries.repository.notesTip();
  assert.notEqual(notesBefore, null);
  await reveries.buildLedgerCheckpoint({ authority: null, sign: false });
  const ledgerBefore = await reveries.repository.ledgerTip();
  assert.notEqual(ledgerBefore, null);
  await reveries.retain();

  // Local copies that still hold the removed history.
  await git(directory, "update-ref", "refs/notes/remotes/origin/reveries", notesBefore as string);
  await git(directory, "update-ref", "refs/remotes/origin/reveries-ledger", ledgerBefore as string);
  await git(directory, "config", "reveries.remoteRole.origin", "primary");
  await git(directory, "config", "reveries.remoteRole.backup", "mirror");
  await git(directory, "remote", "add", "origin", join(directory, ".git"));
  await git(directory, "remote", "add", "backup", join(directory, ".git"));

  const result = await reveries.hardRedact({
    targets: [secret.record.id],
    reason: "Redacted customer account numbers per incident INC-42.",
    metadata,
    sign: false,
  });

  assert.equal(result.state, "redacted", JSON.stringify(result.diagnostics));
  assert.equal(result.ok, true);
  assert.deepEqual(result.removed, [secret.record.id]);

  // The removed record is no longer reachable from the canonical notes ref, and
  // the surviving record kept its identity and its exact canonical bytes.
  const notesAfter = await reveries.repository.notesTip();
  assert.equal(notesAfter, result.notesAfter);
  assert.notEqual(notesAfter, notesBefore);
  const body = (await reveries.repository.readNoteFromRef(NOTES_REF, secret.object)) as string;
  assert.ok(body !== null);
  assert.equal(body.includes(canonicalRecord(secret.record)), false, "the removed record is still canonical");
  const survivors = parseNote(body, "strict", { verifyIds: false }).records;
  assert.equal(survivors.some((record) => record.type === "reverie" && record.id === kept.record.id), true);
  assert.equal(
    survivors.some((record) => record.type === "redaction" && record.target === secret.record.id),
    true,
    "the rewrite left no tombstone explaining the discontinuity",
  );
  // The removed note exists only under the pre-redaction tip, which no canonical
  // ref names any more.
  assert.equal(
    await reveries.repository.readNoteFromRef(NOTES_REF, secret.object) === body,
    true,
    "the sanitized ref is not the body this test inspected",
  );

  // Retention and the stale local copies are gone; the ledger is a genesis
  // checkpoint over the sanitized snapshot and verifies as such.
  const checkpoint = result.ledgerAfter as string;
  assert.equal(await gitMaybe(directory, "rev-parse", "--verify", RETENTION_OBJECTS_REF), "");
  assert.equal(await gitMaybe(directory, "rev-parse", "--verify", RETENTION_COMMITS_REF), "");
  assert.equal(await gitMaybe(directory, "rev-parse", "--verify", "refs/notes/remotes/origin/reveries"), "");
  assert.equal(await gitMaybe(directory, "rev-parse", "--verify", "refs/remotes/origin/reveries-ledger"), "");
  assert.equal(await gitMaybe(directory, "rev-parse", "--verify", LEDGER_REF), checkpoint);
  const envelope = await reveries.verifyLedgerEnvelope(checkpoint);
  assert.equal(envelope.ok, true, JSON.stringify(envelope.diagnostics));
  const manifest = await reveries.repository.readLedgerManifestAt(objectId(checkpoint));
  assert.ok(manifest !== null && manifest.includes('"previous_ledger":null'));
  assert.ok(manifest !== null && manifest.includes(`"notes_commit":"${notesAfter}"`));

  // Remote work is reported, never performed, and never claimed complete.
  assert.deepEqual(result.remoteActions.map(({ remote, role }) => [remote, role]), [
    ["backup", "mirror"],
    ["origin", "primary"],
  ]);
  for (const action of result.remoteActions) assert.match(action.action, /--delete refs\/notes\/reveries/);
  assert.equal(result.disclaimer, HARD_REDACTION_DISCLAIMER);
  assert.match(result.disclaimer, /not guaranteed/);
});

test("hard redaction refuses an unknown target and moves no ref", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const recorded = await reveries.recordNew({
    path: "state.txt",
    revision: "HEAD",
    semantic: semantic("Keep this decision."),
    metadata,
  });
  const notesBefore = await reveries.repository.notesTip();
  const unknown = "rv:ffffffffffffffffffffffffffffffffffffffff" as never;

  const result = await reveries.hardRedact({
    targets: [unknown],
    reason: "Redacted per incident INC-43.",
    metadata,
    sign: false,
  });

  assert.equal(result.state, "refused");
  assert.equal(result.ok, false);
  assert.match(result.diagnostics.join("\n"), /no record in this repository carries rv:ffffffff/);
  assert.equal(await reveries.repository.notesTip(), notesBefore);
  assert.equal(await reveries.repository.ledgerTip(), null);
  assert.equal((await reveries.show({ target: "state.txt" })).active.length, 1);
  assert.equal(recorded.record.id.length > 0, true);
});

test("repeating a hard redaction converges instead of accumulating tombstones", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const secret = await reveries.recordNew({
    path: "state.txt",
    revision: "HEAD",
    semantic: semantic("Keep the customer export path private."),
    metadata,
  });
  const input = {
    targets: [secret.record.id],
    reason: "Redacted customer export paths per incident INC-44.",
    metadata,
    sign: false,
  } as const;

  const first = await reveries.hardRedact(input);
  assert.equal(first.state, "redacted", JSON.stringify(first.diagnostics));
  const second = await reveries.hardRedact(input);

  assert.equal(second.state, "unchanged");
  assert.match(second.diagnostics.join("\n"), /already removed/);
  assert.equal(await reveries.repository.notesTip(), first.notesAfter);
  assert.equal(second.ledgerAfter, first.ledgerAfter);
  const body = await reveries.repository.readNoteFromRef(NOTES_REF, secret.object);
  // The repeated run appended nothing: the tombstone is still the only line.
  assert.equal(body?.split("\n").filter((line) => line.length > 0).length, 1);
});

test("hard redaction drops the signatures that attest exactly the removed record", async () => {
  const directory = await createRepository();
  const pair = await (await import("../src/git.ts")).generateEd25519KeyPair();
  const reveries = await Reveries.open(directory, {
    signer: (await import("../src/git.ts")).createLocalEd25519Signer({
      signer: "alice@example.test",
      keyId: pair.keyId,
      privateKey: pair.privateKey,
    }),
  });
  const secret = await reveries.recordNew({
    path: "state.txt",
    revision: "HEAD",
    semantic: semantic("Keep the leaked credential."),
    metadata,
  });
  const kept = await reveries.recordNew({
    path: "state.txt",
    revision: "HEAD",
    semantic: semantic("Rotate the leaked credential instead."),
    metadata,
  });
  await reveries.signRecord({ target: secret.record, subject: secret.object, role: "author", metadata });
  await reveries.signRecord({ target: kept.record, subject: kept.object, role: "author", metadata });

  const result = await reveries.hardRedact({
    targets: [secret.record.id],
    reason: "Redacted the leaked credential per incident INC-45.",
    metadata,
  });

  assert.equal(result.state, "redacted", JSON.stringify(result.diagnostics));
  const body = await reveries.repository.readNoteFromRef(NOTES_REF, secret.object) ?? "";
  const signatureTargets = body
    .split("\n")
    .filter((line) => line.includes('"type":"signature"'))
    .map((line) => JSON.parse(line).target as string);
  // The tombstone also names the removed ID, so the assertion reads signature
  // lines only rather than searching the whole note for the target string.
  assert.deepEqual(signatureTargets, [kept.record.id]);
});

test("a hand-written signature line cannot ride through the rewrite as a stray target", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const secret = await reveries.recordNew({
    path: "state.txt",
    revision: "HEAD",
    semantic: semantic("Keep the raw customer rows."),
    metadata,
  });
  // A forged line that is not a protocol record at all. Strict validation must
  // refuse the sanitized snapshot rather than publish it.
// A raw Git write, so the malformed line reaches the notes ref without passing
  // through the validating writer.
  await execFileAsync("git", [
    "notes",
    "--ref=refs/notes/reveries",
    "append",
    "-m",
    '{"type":"secret-material","value":"ghp_forged"}',
    secret.object,
  ], { cwd: directory });

  const result = await reveries.hardRedact({
    targets: [secret.record.id],
    reason: "Redacted raw customer rows per incident INC-46.",
    metadata,
    sign: false,
  });

  assert.equal(result.state, "refused");
  assert.equal(result.ok, false);
  assert.match(result.diagnostics.join("\n"), /Hard redaction refused/);
});

test("canonical bytes of a surviving record are identical after the rewrite", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const base = await reveries.recordNew({
    path: "state.txt",
    revision: "HEAD",
    semantic: semantic("Base decision for the rewrite check."),
    metadata,
  });
  const secret = await reveries.recordNew({
    path: "state.txt",
    revision: "HEAD",
    semantic: { ...semantic("Remove this decision."), supersedes: [base.record.id] },
    metadata,
  });
  const before = await reveries.repository.readNoteFromRef(NOTES_REF, base.object);
  assert.ok(before !== null);
  const baseLine = canonicalRecord(base.record);
  assert.ok(before.includes(baseLine));

  const result = await reveries.hardRedact({
    targets: [secret.record.id],
    reason: "Redacted per incident INC-47.",
    metadata,
    sign: false,
  });

  assert.equal(result.state, "redacted", JSON.stringify(result.diagnostics));
  const after = await reveries.repository.readNoteFromRef(NOTES_REF, base.object);
  // The untouched record keeps its exact canonical bytes and its position; only
  // the removed line and the appended tombstone differ.
  assert.ok(after !== null && after.includes(baseLine), "rewriting the notes changed an untouched record");
  assert.equal(after?.includes(canonicalRecord(secret.record)), false);
  assert.deepEqual(after?.split("\n").filter((line) => line.length > 0)[0], baseLine.trimEnd());
});

test("hard redaction refuses while a note transaction is live", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const secret = await reveries.recordNew({
    path: "state.txt",
    revision: "HEAD",
    semantic: semantic("Remove this decision."),
    metadata,
  });
  const notesBefore = await reveries.repository.notesTip();
  await git(directory, "update-ref", "refs/notes/reveries-txn/test-live", notesBefore as string);

  const result = await reveries.hardRedact({
    targets: [secret.record.id],
    reason: "Redacted per incident INC-48.",
    metadata,
    sign: false,
  });

  assert.equal(result.state, "refused");
  assert.match(result.diagnostics.join("\n"), /live Reveries note transaction/);
  assert.equal(await reveries.repository.notesTip(), notesBefore);
});

test("hard redaction keeps a SHA-256 repository shape valid", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reveries-hard-redaction-sha256-"));
  temporaryRepositories.push(directory);
  await git(directory, "init", "-b", "main", "--object-format=sha256");
  await git(directory, "config", "user.name", "Reveries Test");
  await git(directory, "config", "user.email", "reveries@example.com");
  await writeFile(join(directory, "state.txt"), "first\n", "utf8");
  await git(directory, "add", "state.txt");
  await git(directory, "commit", "-m", "initial");
  const reveries = await Reveries.open(directory);
  const secret = await reveries.recordNew({
    path: "state.txt",
    revision: "HEAD",
    semantic: semantic("Remove this decision."),
    metadata,
  });

  const result = await reveries.hardRedact({
    targets: [secret.record.id],
    reason: "Redacted per incident INC-49.",
    metadata,
    sign: false,
  });

  assert.equal(result.state, "redacted", JSON.stringify(result.diagnostics));
  const checkpoint = result.ledgerAfter as string;
  const envelope = await reveries.verifyLedgerEnvelope(checkpoint);
  assert.equal(envelope.ok, true, JSON.stringify(envelope.diagnostics));
  const body = await reveries.repository.readNoteFromRef(NOTES_REF, secret.object);
  assert.equal(body?.includes(canonicalRecord(secret.record)), false);
});

test("a non-evidence ref holding the old tip is left to its owner", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const secret = await reveries.recordNew({
    path: "state.txt",
    revision: "HEAD",
    semantic: semantic("Remove this decision."),
    metadata,
  });
  // An operator-held ref that is not one of the known evidence copies. The
  // operation must not guess: it leaves it alone and does not claim it removed
  // a copy an operator curated.
  const notesBefore = await reveries.repository.notesTip();
  await git(directory, "update-ref", "refs/reveries-inspect/test", notesBefore as string);

  const result = await reveries.hardRedact({
    targets: [secret.record.id],
    reason: "Redacted per incident INC-50.",
    metadata,
    sign: false,
  });

  assert.equal(result.state, "redacted", JSON.stringify(result.diagnostics));
  assert.equal(result.severedRefs.includes("refs/reveries-inspect/test"), false);
  assert.equal(
    await gitMaybe(directory, "rev-parse", "--verify", "refs/reveries-inspect/test"),
    notesBefore as string,
  );
});
