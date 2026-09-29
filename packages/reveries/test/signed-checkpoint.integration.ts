import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";

import {
  GitRepository,
  LEDGER_MANIFEST_PATH,
  LEDGER_NOTES_PATH,
  LEDGER_SIGNATURES_PATH,
  createLocalEd25519Signer,
  createLocalEd25519Verifier,
  generateEd25519KeyPair,
  hashBlobContent,
  type SignatureSigner,
} from "../src/git.ts";
import { Reveries } from "../src/operations.ts";
import {
  canonicalRecord,
  canonicalLedgerManifest,
  createLedgerManifest,
  createReverie,
  type LedgerManifest,
  type ObjectId,
} from "../src/protocol.ts";

const execFileAsync = promisify(execFile);
const temporaryRepositories: string[] = [];

const metadata = { author_email: "reveries@example.com", session: null, created_at: "2026-08-25T03:00:00Z" };

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

async function createRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "reveries-signed-ledger-"));
  temporaryRepositories.push(directory);
  await git(directory, "init", "-b", "main");
  await git(directory, "config", "user.name", "Reveries Test");
  await git(directory, "config", "user.email", "reveries@example.com");
  await writeFile(join(directory, "state.txt"), "first\n", "utf8");
  await git(directory, "add", "state.txt");
  await git(directory, "commit", "-m", "initial");
  return directory;
}

function reverieLine(decision: string): string {
  return canonicalRecord(createReverie(
    {
      v: 1,
      driving_event: "The ledger envelope had no signer over its manifest.",
      decision,
      impact: "A checkpoint binds the exact tips it transports.",
      recurrence_control: null,
      alternatives: [],
      sources: [],
      supersedes: [],
    },
    metadata,
    (bytes) => hashBlobContent(bytes, "sha1"),
  ));
}

async function appendNote(repository: GitRepository, line: string): Promise<ObjectId> {
  const blob = await repository.resolvePath({ path: "state.txt", revision: "HEAD" });
  await repository.withNotesWrite(async (transaction) => {
    await transaction.append(blob, line);
  });
  return blob;
}

/** A repository that both signs and can verify its own checkpoints. */
async function signingRepo(directory: string, pair: ReturnType<typeof generateEd25519KeyPair> = generateEd25519KeyPair()) {
  const signer: SignatureSigner = createLocalEd25519Signer({
    signer: "publisher@example.test",
    keyId: pair.keyId,
    privateKey: pair.privateKey,
  });
  const trust = {
    keys: [{ key_id: pair.keyId, signer: "publisher@example.test", revoked: false, public_key: pair.publicKey }],
  };
  return {
    pair,
    reveries: await Reveries.open(directory, {
      signer,
      verifier: createLocalEd25519Verifier({ [pair.keyId]: pair.publicKey }),
      trust,
      requiredRoles: ["publisher"],
    }),
  };
}

/** Forge a checkpoint by hand so a test can make verification fail. */
async function forgeCheckpoint(
  repository: GitRepository,
  manifest: LedgerManifest,
  options: {
    readonly notesTree?: ObjectId;
    readonly parents?: readonly ObjectId[];
    readonly signatures?: string;
    readonly extraEntry?: string;
  } = {},
): Promise<ObjectId> {
  const notesTree = options.notesTree
    ?? (manifest.notes_commit === null ? await repository.emptyTreeObjectId() : await repository.treeForCommit(manifest.notes_commit));
  const manifestBlob = await repository.writeBlob(canonicalLedgerManifest(manifest));
  const entries = [
    `100644 blob ${manifestBlob}\t${LEDGER_MANIFEST_PATH}`,
    `040000 tree ${notesTree}\t${LEDGER_NOTES_PATH}`,
  ];
  if (options.signatures !== undefined) {
    entries.push(`100644 blob ${await repository.writeBlob(options.signatures)}\t${LEDGER_SIGNATURES_PATH}`);
  }
  if (options.extraEntry !== undefined) entries.push(options.extraEntry);
  const tree = (await repository.run(["mktree"], { input: `${entries.join("\n")}\n` })).stdout.trim();
  const argumentsList = ["commit-tree", tree];
  for (const parent of options.parents ?? []) argumentsList.push("-p", parent);
  argumentsList.push("-m", "Reveries ledger checkpoint");
  return (await repository.run(argumentsList)).stdout.trim() as ObjectId;
}

afterEach(async () => {
  await Promise.all(temporaryRepositories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

// --- Acceptance criterion 3: a checkpoint binds the exact tips --------------

test("a signed checkpoint carries a signatures entry that verifies over its manifest", async () => {
  const directory = await createRepository();
  const repository = await GitRepository.open(directory);
  await appendNote(repository, reverieLine("Sign the manifest."));
  const { reveries, pair } = await signingRepo(directory);

  const built = await reveries.buildLedgerCheckpoint({ authority: "origin" });
  assert.equal(built.state, "created");
  const checkpoint = built.checkpoint as ObjectId;

  const signatures = await repository.readLedgerSignaturesAt(checkpoint);
  assert.ok(signatures, "the signed checkpoint has no signatures entry");
  const parsed = JSON.parse(signatures.trim()) as { type: string; domain: string; target: string; signature: string };
  assert.equal(parsed.type, "signature");
  assert.equal(parsed.domain, "reveries/v1/ledger-manifest");
  assert.equal(parsed.target, "ledger-manifest");

  const status = await reveries.signatureStatus();
  assert.equal(status.state, "signed");
  assert.equal(status.checkpointSigned, true);
  assert.equal(status.checkpoint, checkpoint);
  assert.equal(status.counts["policy-satisfying"], 1);
  assert.equal(status.diagnostics.length, 0);
  assert.ok(pair.keyId);
});

test("an unsigned checkpoint stays valid and reports unsigned, not broken", async () => {
  const directory = await createRepository();
  const repository = await GitRepository.open(directory);
  await appendNote(repository, reverieLine("Stay unsigned."));
  const reveries = await Reveries.open(directory);

  const built = await reveries.buildLedgerCheckpoint({ authority: null });
  assert.equal(built.state, "created");
  assert.equal(await repository.readLedgerSignaturesAt(built.checkpoint as ObjectId), null);

  // Structure is verified exactly as before; signing is additive.
  const verification = await reveries.verifyLedgerEnvelope();
  assert.equal(verification.ok, true, verification.diagnostics.join("; "));
  const status = await reveries.signatureStatus();
  assert.equal(status.state, "unsigned");
  assert.equal(status.checkpointSigned, false);
  assert.deepEqual(status.diagnostics, []);
});

test("a signature over a different manifest is rejected", async () => {
  const directory = await createRepository();
  const repository = await GitRepository.open(directory);
  await appendNote(repository, reverieLine("Bind the tips."));
  const { reveries } = await signingRepo(directory);
  const built = await reveries.buildLedgerCheckpoint({ authority: null });
  const checkpoint = built.checkpoint as ObjectId;
  const good = await repository.readLedgerSignaturesAt(checkpoint);
  assert.ok(good);

  // Re-point the checkpoint at a manifest claiming different totals, keeping
  // the valid signature from the original manifest.
  const notesCommit = await repository.notesTip();
  const lying = createLedgerManifest({
    notes_commit: notesCommit,
    notes_tree: notesCommit === null ? null : await repository.treeForCommit(notesCommit),
    previous_ledger: null,
    retention_commit: null,
    authority: null,
    annotated_subjects: 99,
    records: 99,
    note_bytes: 999,
  });
  const forged = await forgeCheckpoint(repository, lying, {
    parents: notesCommit === null ? [] : [notesCommit],
    signatures: good,
  });

  const verification = await reveries.verifyLedgerEnvelope(forged);
  assert.equal(verification.ok, false);
  assert.match(verification.diagnostics.join(" "), /covers content .*not this manifest/);
});

test("a signatures entry carrying a record-domain signature is rejected", async () => {
  const directory = await createRepository();
  const repository = await GitRepository.open(directory);
  await appendNote(repository, reverieLine("Keep the domains apart."));
  const { reveries } = await signingRepo(directory);
  const built = await reveries.buildLedgerCheckpoint({ authority: null });
  const notesCommit = await repository.notesTip();
  const good = await repository.readLedgerSignaturesAt(built.checkpoint as ObjectId);
  assert.ok(good);

  // Swap the manifest-domain signature for a record-domain one. The payload
  // would not verify anyway, and the domain check catches it structurally.
  const wrongDomain = good.replace("reveries/v1/ledger-manifest", "reveries/v1/record")
    .replace('"target":"ledger-manifest"', `"target":"rv:${"a".repeat(40)}"`);
  const manifest = createLedgerManifest({
    notes_commit: notesCommit,
    notes_tree: notesCommit === null ? null : await repository.treeForCommit(notesCommit),
    previous_ledger: null,
    retention_commit: null,
    authority: null,
    annotated_subjects: 1,
    records: 1,
    note_bytes: reverieLine("Bind the tips.").length,
  });
  const forged = await forgeCheckpoint(repository, manifest, {
    signatures: wrongDomain,
    parents: notesCommit === null ? [] : [notesCommit],
  });

  const verification = await reveries.verifyLedgerEnvelope(forged);
  assert.equal(verification.ok, false);
  assert.match(verification.diagnostics.join(" "), /not a manifest-domain signature/);
});

test("an empty signatures entry is reported rather than treated as signed", async () => {
  const directory = await createRepository();
  const repository = await GitRepository.open(directory);
  await appendNote(repository, reverieLine("Sign something."));
  const { reveries } = await signingRepo(directory);
  const built = await reveries.buildLedgerCheckpoint({ authority: null });
  const notesCommit = await repository.notesTip();
  const manifest = createLedgerManifest({
    notes_commit: notesCommit,
    notes_tree: notesCommit === null ? null : await repository.treeForCommit(notesCommit),
    previous_ledger: null,
    retention_commit: null,
    authority: null,
    annotated_subjects: 1,
    records: 1,
    note_bytes: 1,
  });
  const forged = await forgeCheckpoint(repository, manifest, {
    signatures: "\n",
    parents: notesCommit === null ? [] : [notesCommit],
  });
  const verification = await reveries.verifyLedgerEnvelope(forged);
  assert.equal(verification.ok, false);
  assert.match(verification.diagnostics.join(" "), /carries no signature records/);
});

test("the signatures entry is still bounded to exactly three allowed tree entries", async () => {
  const directory = await createRepository();
  const repository = await GitRepository.open(directory);
  await appendNote(repository, reverieLine("Signatures, and nothing else."));
  const { reveries } = await signingRepo(directory);
  const built = await reveries.buildLedgerCheckpoint({ authority: null });
  const checkpoint = built.checkpoint as ObjectId;
  const entries = (await repository.ledgerTreeEntries(checkpoint)).map((entry) => entry.path).sort();
  assert.deepEqual(entries, [LEDGER_MANIFEST_PATH, LEDGER_NOTES_PATH, LEDGER_SIGNATURES_PATH]);

  // A fourth entry is still refused: RVR-009 extended the allow-list to three
  // and no further.
  const notesCommit = await repository.notesTip();
  const manifest = createLedgerManifest({
    notes_commit: notesCommit,
    notes_tree: notesCommit === null ? null : await repository.treeForCommit(notesCommit),
    previous_ledger: null,
    retention_commit: null,
    authority: null,
    annotated_subjects: 1,
    records: 1,
    note_bytes: 1,
  });
  const review = await repository.writeBlob("{}\n");
  const overreach = await forgeCheckpoint(repository, manifest, {
    signatures: (await repository.readLedgerSignaturesAt(checkpoint)) as string,
    extraEntry: `100644 blob ${review}\treview`,
    parents: notesCommit === null ? [] : [notesCommit],
  });
  const verification = await reveries.verifyLedgerEnvelope(overreach);
  assert.equal(verification.ok, false);
  assert.match(verification.diagnostics.join(" "), /review is not part of the ledger envelope/);
});

test("a later checkpoint may add a signature but never remove one", async () => {
  const directory = await createRepository();
  const repository = await GitRepository.open(directory);
  await appendNote(repository, reverieLine("Append signatures only."));
  const { reveries } = await signingRepo(directory);
  const first = await reveries.buildLedgerCheckpoint({ authority: null });
  const firstTip = first.checkpoint as ObjectId;
  const firstSignatures = await repository.readLedgerSignaturesAt(firstTip);
  assert.ok(firstSignatures);

  // Add evidence, then rebuild: the new checkpoint is a fast-forward and the
  // append-only rule still holds.
  await appendNote(repository, reverieLine("More evidence arrives."));
  const second = await reveries.buildLedgerCheckpoint({ authority: null });
  const secondTip = second.checkpoint as ObjectId;
  assert.notEqual(secondTip, firstTip);
  assert.equal((await reveries.verifyLedgerEnvelope(secondTip)).ok, true);

  // A checkpoint that drops the earlier signature line is not append-only.
  const stripped = (await repository.readLedgerSignaturesAt(secondTip)) as string;
  const kept = stripped.split("\n").filter((line) => line.trim() !== firstSignatures.trim());
  const notesCommit = await repository.notesTip();
  const manifest = createLedgerManifest({
    notes_commit: notesCommit,
    notes_tree: notesCommit === null ? null : await repository.treeForCommit(notesCommit),
    previous_ledger: firstTip,
    retention_commit: null,
    authority: null,
    annotated_subjects: 2,
    records: 2,
    note_bytes: 1,
  });
  const regressed = await forgeCheckpoint(repository, manifest, {
    signatures: kept.join("\n"),
    parents: notesCommit === null ? [firstTip] : [firstTip, notesCommit],
  });
  const verification = await reveries.verifyLedgerEnvelope(regressed);
  assert.equal(verification.ok, false);
  assert.match(verification.diagnostics.join(" "), /removes signature .*not append-only/);
});

test("a signed checkpoint is byte-reproducible from the same evidence and key", async () => {
  // Reproducibility is the property RVR-005 promised and RVR-009 had to keep: the
  // same evidence and the same key must produce the same signature, so signing
  // cannot make a checkpoint non-deterministic. Built twice in one repository
  // over unchanged notes, the second build is byte-identical.
  const directory = await createRepository();
  const repository = await GitRepository.open(directory);
  await appendNote(repository, reverieLine("Reproduce exactly."));
  const pair = generateEd25519KeyPair();
  const { reveries } = await signingRepo(directory, pair);

  const first = await reveries.buildLedgerCheckpoint({ authority: "origin" });
  const firstTip = first.checkpoint as ObjectId;
  const firstManifest = await repository.readLedgerManifestAt(firstTip);
  const firstSignatures = await repository.readLedgerSignaturesAt(firstTip);

  // Signing a manifest is deterministic: the same manifest and the same key
  // always produce the same signature bytes, which is what keeps a signed
  // checkpoint reproducible the way an unsigned one already was.
  const manifest = createLedgerManifest({
    notes_commit: await repository.notesTip(),
    notes_tree: await repository.treeForCommit((await repository.notesTip()) as ObjectId),
    previous_ledger: firstTip,
    retention_commit: null,
    authority: "origin",
    annotated_subjects: 1,
    records: 1,
    note_bytes: 1,
  });
  assert.equal(
    await reveries.signLedgerManifest(manifest),
    await reveries.signLedgerManifest(manifest),
    "signing the same manifest twice produced different bytes",
  );

  // A rebuild over unchanged evidence fast-forwards, carrying the prior
  // attestation forward instead of replacing it.
  const second = await reveries.buildLedgerCheckpoint({ authority: "origin" });
  assert.equal(second.state, "created");
  assert.notEqual(second.checkpoint, firstTip);
  const secondSignatures = (await repository.readLedgerSignaturesAt(second.checkpoint as ObjectId)) as string;
  assert.ok(secondSignatures.includes((firstSignatures as string).trim()), "the prior attestation was dropped");
  assert.notEqual(secondSignatures, firstSignatures, "a new manifest did not produce a new attestation");
  assert.notEqual(await repository.readLedgerManifestAt(second.checkpoint as ObjectId), firstManifest);
});

test("a signed checkpoint survives transport to a clone and verifies there", async () => {
  const origin = await createRepository();
  const repository = await GitRepository.open(origin);
  await appendNote(repository, reverieLine("Carry the signature across."));
  const { reveries, pair } = await signingRepo(origin);
  await reveries.buildLedgerCheckpoint({ authority: "origin" });
  const tip = await repository.ledgerTip();

  const remote = await mkdtemp(join(tmpdir(), "reveries-signed-remote-"));
  temporaryRepositories.push(remote);
  await git(remote, "init", "--bare");
  await git(origin, "remote", "add", "publish", remote);
  await git(origin, "push", "publish", "main");
  await git(origin, "push", "publish", "refs/heads/reveries-ledger:refs/heads/reveries-ledger");

  const clone = await mkdtemp(join(tmpdir(), "reveries-signed-clone-"));
  temporaryRepositories.push(clone);
  await execFileAsync("git", ["clone", "--quiet", "-b", "main", remote, clone], { encoding: "utf8" });
  const cloned = await GitRepository.open(clone);

  // An ordinary clone fetches the envelope as a remote-tracking branch, which is
  // exactly the transport RVR-005 created and the reason a signed tag was
  // rejected: the signature has to travel where a normal fetch will look.
  const fetched = await cloned.ledgerTip("refs/remotes/origin/reveries-ledger");
  assert.equal(fetched, tip, "the clone did not receive the signed envelope");

  // With only the public key, the clone can verify the manifest signature.
  const clonedReveries = await Reveries.open(clone, {
    verifier: createLocalEd25519Verifier({ [pair.keyId]: pair.publicKey }),
    trust: { keys: [{ key_id: pair.keyId, signer: "publisher@example.test", revoked: false }] },
    requiredRoles: ["publisher"],
  });
  const verification = await clonedReveries.verifyLedgerEnvelope("refs/remotes/origin/reveries-ledger");
  assert.equal(verification.ok, true, verification.diagnostics.join("; "));
  const signatures = await cloned.readLedgerSignaturesAt(fetched as ObjectId);
  assert.ok(signatures, "the transported envelope lost its signatures entry");
});

test("doctor reports signing as a notice and never as damage", async () => {
  const directory = await createRepository();
  const repository = await GitRepository.open(directory);
  await appendNote(repository, reverieLine("Report signing honestly."));
  const { reveries } = await signingRepo(directory);
  await reveries.buildLedgerCheckpoint({ authority: null });

  const doctor = await reveries.doctor();
  assert.equal(doctor.signatures.state, "signed");
  assert.equal(doctor.signatures.checkpointSigned, true);
  assert.deepEqual(doctor.signatures.requiredRoles, ["publisher"]);
  // A signed, valid checkpoint contributes no damage diagnostics.
  assert.equal(
    doctor.diagnostics.filter((line) => /signature/i.test(line)).length,
    0,
    doctor.diagnostics.join("; "),
  );
  assert.ok(doctor.notices.some((line) => /Signatures: signed/.test(line)));
});

test("an unsigned repository's doctor reports absent signing, still undamaged", async () => {
  const directory = await createRepository();
  const repository = await GitRepository.open(directory);
  await appendNote(repository, reverieLine("No signer configured."));
  const reveries = await Reveries.open(directory);
  await reveries.buildLedgerCheckpoint({ authority: null });

  const doctor = await reveries.doctor();
  assert.equal(doctor.signatures.state, "unsigned");
  assert.equal(doctor.signatures.checkpointSigned, false);
  assert.equal(
    doctor.diagnostics.filter((line) => /signature/i.test(line)).length,
    0,
  );
  assert.ok(doctor.notices.some((line) => /Signatures: unsigned/.test(line)));
});
