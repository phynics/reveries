import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";

import {
  createLocalEd25519Signer,
  createLocalEd25519Verifier,
  ed25519KeyId,
  generateEd25519KeyPair,
  hashBlobContent,
  type Ed25519KeyPair,
  type SignatureSigner,
  type SignatureVerifier,
} from "../src/git.ts";
import { Reveries } from "../src/operations.ts";
import {
  canonicalRecord,
  createReverie,
  readLedgerManifest,
  type ObjectId,
} from "../src/protocol.ts";

const execFileAsync = promisify(execFile);
const temporaryRepositories: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

function reverieLine(decision: string): string {
  return canonicalRecord(createReverie(
    {
      v: 1,
      driving_event: "Publishing remotes had no declared relationship to each other.",
      decision,
      impact: "A mirror is verified against the primary checkpoint instead of trusted by name.",
      recurrence_control: null,
      alternatives: [],
      sources: [],
      supersedes: [],
    },
    { author_email: "reveries@example.com", session: null, created_at: "2026-09-29T12:00:00Z" },
    (bytes) => hashBlobContent(bytes, "sha1"),
  ));
}

async function createRepository(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryRepositories.push(directory);
  await git(directory, "init", "-b", "main");
  await git(directory, "config", "user.name", "Reveries Test");
  await git(directory, "config", "user.email", "reveries@example.com");
  await writeFile(join(directory, "state.txt"), "first\n", "utf8");
  await git(directory, "add", "state.txt");
  await git(directory, "commit", "-m", "initial");
  return directory;
}

/** A `Reveries` handle wired to one key pair, as `signed-checkpoint.integration.ts` does. */
async function signingRepository(directory: string, pair: Ed25519KeyPair): Promise<Reveries> {
  const keyId = ed25519KeyId(pair.publicKey);
  const signer: SignatureSigner = createLocalEd25519Signer({
    signer: "reveries@example.com",
    keyId,
    privateKey: pair.privateKey,
  });
  const verifier: SignatureVerifier = createLocalEd25519Verifier({ [keyId]: pair.publicKey });
  return Reveries.open(directory, {
    signer,
    verifier,
    trust: { keys: [{ key_id: keyId, signer: "reveries@example.com", revoked: false }] },
  });
}

function open(directory: string, pair: Ed25519KeyPair | null): Promise<Reveries> {
  return pair === null ? Reveries.open(directory) : signingRepository(directory, pair);
}

async function annotate(reveries: Reveries, decision: string): Promise<void> {
  const blob = await reveries.repository.resolvePath({ path: "state.txt", revision: "HEAD" });
  await reveries.repository.withNotesWrite(async (notes) => {
    await notes.append(blob, reverieLine(decision));
  });
}

/**
 * Point this repository's canonical notes ref at a source repository's notes
 * state. Two independent repositories that each author the same decision text
 * still get different notes commit IDs, because a notes commit carries its own
 * identity. Adopting the real object is what lets a fixture compare a manifest
 * field for field instead of comparing content that merely looks similar.
 */
async function adoptNotes(reveries: Reveries, source: string): Promise<void> {
  const tip = await (await Reveries.open(source)).repository.notesTip();
  assert.notEqual(tip, null, "the source must have notes to adopt");
  await reveries.repository.run(["fetch", source, `+refs/notes/reveries:refs/notes/adopted/reveries`]);
  await reveries.repository.run(["update-ref", "refs/notes/reveries", tip as string]);
}

async function checkpoint(reveries: Reveries, authority: string | null = "alpha"): Promise<ObjectId> {
  const built = await reveries.buildLedgerCheckpoint({ authority });
  assert.equal(built.ok, true, built.diagnostics.join(" "));
  return built.checkpoint as ObjectId;
}

/**
 * A repository with `alpha` as its primary and `backup` as its mirror, where
 * `backup` is a real local repository whose envelope is fetched into the
 * remote-tracking ref the check reads.
 */
async function consumer(
  prefix: string,
  backup: string | null,
  pair: Ed25519KeyPair | null = null,
): Promise<{ directory: string; reveries: Reveries }> {
  const directory = await createRepository(prefix);
  await git(directory, "remote", "add", "alpha", backup ?? "https://example.invalid/alpha.git");
  await git(directory, "remote", "add", "backup", backup ?? "https://example.invalid/backup.git");
  await git(directory, "config", "reveries.publishingRemote", "alpha");
  await git(directory, "config", "reveries.remoteRole.alpha", "primary");
  await git(directory, "config", "reveries.remoteRole.backup", "mirror");
  const reveries = await open(directory, pair);
  if (backup !== null) {
    await git(
      directory,
      "fetch",
      "backup",
      "+refs/heads/reveries-ledger:refs/remotes/backup/reveries-ledger",
    );
  }
  return { directory, reveries };
}

afterEach(async () => {
  await Promise.all(temporaryRepositories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/**
 * A mirror is a replica, so what matters is agreement with the local primary
 * checkpoint, not the mirror's own correctness. These fixtures publish and fetch
 * real envelopes, so the comparison cannot pass on a shape actual Git objects
 * would never produce.
 */

test("a mirror that has not been fetched is unavailable, not divergent", async () => {
  const { reveries } = await consumer("reveries-mirror-unfetched-", null);
  const mirrors = await reveries.verifyMirrorEnvelopes();
  assert.equal(mirrors.length, 1);
  assert.equal(mirrors[0]?.state, "unavailable");
  assert.equal(mirrors[0]?.checkpoint, null);
});

test("a mirror carrying the same checkpoint as an unsigned primary matches", async () => {
  // One checkpoint, two repositories: the mirror is a faithful replica.
  const source = await createRepository("reveries-mirror-shared-");
  const shared = await checkpoint(await open(source, null));
  const { reveries } = await consumer("reveries-mirror-match-", source);
  // Point the consumer's own primary at the very checkpoint the mirror holds, so
  // authority, notes commit, and signature all agree by construction.
  await reveries.repository.run(["fetch", source, `+${shared}:refs/heads/reveries-ledger`]);

  const mirrors = await reveries.verifyMirrorEnvelopes();
  assert.equal(mirrors[0]?.state, "unsigned");
  // The local checkpoint is unsigned, so the signature comparison could not run.
  // Reporting that honestly is the point: an unrunnable check is not agreement.
  assert.equal(mirrors[0]?.signature, null);
  assert.deepEqual(mirrors[0]?.diagnostics, []);
});

test("a mirror naming a different authority is a mismatch", async () => {
  const source = await createRepository("reveries-mirror-wrong-authority-");
  const sourceReveries = await open(source, null);
  await annotate(sourceReveries, "The source published on behalf of another remote.");
  const published = await checkpoint(sourceReveries, "beta");
  const { reveries } = await consumer("reveries-mirror-authority-", source);
  await adoptNotes(reveries, source);
  await reveries.repository.run(["fetch", source, `+${published}:refs/heads/reveries-ledger`]);
  await checkpoint(reveries, "alpha");

  const mirrors = await reveries.verifyMirrorEnvelopes();
  // The mirror says it was published on behalf of `beta` while the local primary
  // is `alpha`. One of the two is wrong about where authoritative publication
  // happens, and that is damage rather than a state.
  assert.equal(mirrors[0]?.state, "authority-mismatch");
  assert.match(mirrors[0]?.diagnostics.join(" ") ?? "", /names authority beta/);
});

test("a mirror carrying notes the primary does not contain is divergent", async () => {
  const source = await createRepository("reveries-mirror-divergent-source-");
  await annotate(await open(source, null), "The source published this decision.");
  const published = await checkpoint(await open(source, null));
  const { directory, reveries } = await consumer("reveries-mirror-divergent-", source);

  // The consumer goes its own way: a decision the source never saw, so the two
  // checkpoints transport unrelated notes commits. That is what an independently
  // written replica looks like from the primary's side.
  await annotate(reveries, "The consumer published a decision the source never saw.");
  await checkpoint(reveries, "alpha");
  await git(directory, "update-ref", "refs/remotes/backup/reveries-ledger", published);

  const mirrors = await reveries.verifyMirrorEnvelopes();
  assert.equal(mirrors[0]?.state, "divergent");
  assert.match(mirrors[0]?.diagnostics.join(" ") ?? "", /does not contain/);
});

test("a mirror that is an ancestor of the primary is not divergent", async () => {
  // The mirror is simply behind. A replica lagging its primary is ordinary, and
  // reporting it as damage would make every lagging mirror look broken.
  const source = await createRepository("reveries-mirror-behind-source-");
  const sourceReveries = await open(source, null);
  await annotate(sourceReveries, "The first decision.");
  const older = await checkpoint(sourceReveries);
  await annotate(sourceReveries, "The second decision.");
  await checkpoint(sourceReveries);

  const { directory, reveries } = await consumer("reveries-mirror-behind-", source);
  // The consumer adopts the source's *current* notes, so the local primary
  // checkpoint transports the newer notes commit and the mirror's older
  // checkpoint is a genuine ancestor of it rather than an unrelated history.
  await adoptNotes(reveries, source);
  await checkpoint(reveries);
  await git(directory, "update-ref", "refs/remotes/backup/reveries-ledger", older);

  const local = readLedgerManifest(
    (await reveries.repository.readLedgerManifestAt(
      (await reveries.repository.ledgerTip()) as ObjectId,
    )) as string,
  );
  const behind = readLedgerManifest(
    (await reveries.repository.readLedgerManifestAt(older)) as string,
  );
  assert.notEqual(local.notes_commit, behind.notes_commit, "the fixture must actually be behind");

  const mirrors = await reveries.verifyMirrorEnvelopes();
  assert.equal(mirrors[0]?.state, "unsigned");
  assert.deepEqual(mirrors[0]?.diagnostics, []);
});

test("a signed primary makes an unsigned mirror a diagnostic", async () => {
  const keyPair = generateEd25519KeyPair();
  const source = await createRepository("reveries-mirror-sign-source-");
  // The source deliberately holds no signing material: its checkpoint is
  // structurally valid and entirely unsigned.
  const sourceReveries = await open(source, null);
  await annotate(sourceReveries, "A decision the mirror will not attest to.");
  const unsigned = await checkpoint(sourceReveries);

  const { directory, reveries } = await consumer("reveries-mirror-sign-consumer-", source, keyPair);
  // The consumer adopts the identical notes object and signs its own manifest,
  // so the local primary checkpoint is signed while the mirror's is not. Same
  // notes commit means the signature check is isolated from every other
  // comparison the check makes.
  await adoptNotes(reveries, source);
  const signed = await checkpoint(reveries);
  const status = await reveries.signatureStatus();
  assert.equal(status.checkpointSigned, true, "the local primary checkpoint must be signed for this check to apply");
  await git(directory, "update-ref", "refs/remotes/backup/reveries-ledger", unsigned);

  // The two checkpoints must describe the same notes commit, or the test would
  // pass for the wrong reason.
  const localManifest = readLedgerManifest(
    (await reveries.repository.readLedgerManifestAt(signed)) as string,
  );
  const mirrorManifest = readLedgerManifest(
    (await reveries.repository.readLedgerManifestAt(unsigned)) as string,
  );
  assert.equal(localManifest.notes_commit, mirrorManifest.notes_commit);

  const mirrors = await reveries.verifyMirrorEnvelopes();
  assert.equal(mirrors[0]?.state, "divergent");
  assert.match(mirrors[0]?.diagnostics.join(" ") ?? "", /carries no signature over its own manifest/);
});

test("a mirror that signs the same manifest as a signed primary matches", async () => {
  const keyPair = generateEd25519KeyPair();
  const source = await createRepository("reveries-mirror-trusted-source-");
  const sourceReveries = await open(source, keyPair);
  await annotate(sourceReveries, "A decision both sides attest to.");
  const published = await checkpoint(sourceReveries);

  const { reveries } = await consumer("reveries-mirror-trusted-consumer-", source, keyPair);
  await adoptNotes(reveries, source);
  // The consumer republishes the same notes state, signs its own manifest, and
  // that signed checkpoint becomes what the mirror is seen to be carrying. This
  // is what a faithful replica looks like: same notes commit, same authority,
  // and its own attesting signature.
  const local = await checkpoint(reveries);
  const replica = await checkpoint(reveries);
  await reveries.repository.run(["update-ref", "refs/remotes/backup/reveries-ledger", replica]);
  const mirrorManifest = readLedgerManifest(
    (await reveries.repository.readLedgerManifestAt(replica)) as string,
  );
  const mirrorSigned = await reveries.repository.readLedgerSignaturesAt(replica);
  assert.notEqual(mirrorSigned, null, "a faithful replica signs its own checkpoint");
  assert.equal(mirrorManifest.notes_commit, readLedgerManifest(
    (await reveries.repository.readLedgerManifestAt(published)) as string,
  ).notes_commit, "the replica must transport the same notes as the source");
  assert.notEqual(local, replica);

  const mirrors = await reveries.verifyMirrorEnvelopes();
  assert.equal(mirrors[0]?.state, "matching");
  assert.equal(mirrors[0]?.signature, "trusted");
  assert.deepEqual(mirrors[0]?.diagnostics, []);
});
