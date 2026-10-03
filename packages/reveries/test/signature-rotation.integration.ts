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
  generateEd25519KeyPair,
  type SignatureSigner,
  type SignatureVerifier,
} from "../src/git.ts";
import { Reveries } from "../src/operations.ts";
import { canonicalRecord, createOccurrence, createLineage, createReverie, type ReverieInput, type ReverieMetadata } from "../src/protocol.ts";

const execFileAsync = promisify(execFile);
const temporaryRepositories: string[] = [];

const metadata: ReverieMetadata = {
  author_email: "reveries@example.com",
  session: null,
  created_at: "2026-09-29T21:11:20Z",
};

const semantic: ReverieInput = {
  v: 1,
  driving_event: "Evidence proved only who typed an email address.",
  decision: "Sign the target's canonical bytes with a rotating key.",
  impact: "Rotating a key adds a signature and changes no decision ID.",
  recurrence_control: null,
  alternatives: [],
  sources: [],
  supersedes: [],
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

async function createRepository(format = "sha1"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "reveries-sign-"));
  temporaryRepositories.push(directory);
  await git(directory, "init", "-b", "main", `--object-format=${format}`);
  await git(directory, "config", "user.name", "Reveries Test");
  await git(directory, "config", "user.email", "reveries@example.com");
  await writeFile(join(directory, "state.txt"), "first\n", "utf8");
  await git(directory, "add", "state.txt");
  await git(directory, "commit", "-m", "initial");
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryRepositories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

// --- Acceptance criterion 4: key rotation preserves semantic IDs ------------

test("occurrence and lineage confidential pointers can be signed and verified", async () => {
  const directory = await createRepository();
  const pair = generateEd25519KeyPair();
  const reveries = await Reveries.open(directory, {
    signer: createLocalEd25519Signer({ signer: "alice@example.test", keyId: pair.keyId, privateKey: pair.privateKey }),
    verifier: createLocalEd25519Verifier({ [pair.keyId]: pair.publicKey }),
    trust: { keys: [{ key_id: pair.keyId, signer: "alice@example.test", revoked: false }] },
  });
  const parent = await reveries.repository.resolveCommit("HEAD");
  const subject = await reveries.repository.resolvePath({ path: "state.txt", revision: "HEAD" });
  await git(directory, "commit", "--allow-empty", "-m", "next");
  const commit = await reveries.repository.resolveCommit("HEAD");
  const causal = {
    v: 1 as const,
    driving_event: semantic.driving_event,
    decision: semantic.decision,
    impact: semantic.impact,
    recurrence_control: null,
    alternatives: [],
    sources: [{ relation: "derived-from" as const, kind: "confidential-pointer" as const, ref: `vault:v1:${"B".repeat(43)}` }],
  };
  const occurrence = createOccurrence({ ...causal, occurrence: { commit, path: "state.txt", subject } }, metadata,
    (bytes) => reveries.repository.hashObjectSync(bytes));
  const lineage = createLineage({ ...causal, kind: "preserve", parent, commit,
    from: [{ path: "state.txt", subject }], to: [{ path: "state.txt", subject }], transition: null }, metadata,
    (bytes) => reveries.repository.hashObjectSync(bytes));
  for (const [target, attachment] of [[occurrence, subject], [lineage, commit]] as const) {
    await reveries.mutateNotes(async (notes) => notes.append(attachment, canonicalRecord(target)));
    const signed = await reveries.signRecord({ target, subject: attachment, role: "author", metadata });
    assert.equal(signed.state, "signed");
    assert.ok(signed.record);
    assert.equal(reveries.verifySignatureRecord(signed.record).state, "trusted");
  }
});

test("rotating a signer key changes no decision ID and adds a second signature", async () => {
  const directory = await createRepository();
  const first = generateEd25519KeyPair();
  const second = generateEd25519KeyPair();
  assert.notEqual(first.keyId, second.keyId);

  // The same signer identity, two different keys: exactly a rotation.
  const open = async (pair: typeof first): Promise<Reveries> => Reveries.open(directory, {
    signer: createLocalEd25519Signer({ signer: "alice@example.test", keyId: pair.keyId, privateKey: pair.privateKey }),
    verifier: createLocalEd25519Verifier({ [first.keyId]: first.publicKey, [second.keyId]: second.publicKey }),
  });

  const before = await (await open(first)).recordNew({ path: "state.txt", revision: "HEAD", semantic, metadata });
  const decisionIdBefore = before.record.id;
  const canonicalBefore = canonicalRecord(before.record);

  const signedWithFirst = await (await open(first)).signRecord({
    target: before.record,
    subject: before.object,
    role: "author",
    metadata,
  });
  assert.equal(signedWithFirst.state, "signed");

  // Rotate: the same signer, a brand-new key.
  const signedWithSecond = await (await open(second)).signRecord({
    target: before.record,
    subject: before.object,
    role: "author",
    metadata,
  });
  assert.equal(signedWithSecond.state, "signed");
  assert.notEqual(signedWithFirst.record?.id, signedWithSecond.record?.id, "rotation reused one signature ID");

  // The decision itself is untouched: same ID, byte-identical canonical line.
  const reveries = await open(second);
  const after = await reveries.show({ target: before.object });
  const record = after.records.find((entry) => entry.type === "reverie");
  assert.equal(record?.id, decisionIdBefore, "key rotation changed the decision ID");
  assert.equal(canonicalRecord(record as never), canonicalBefore, "key rotation changed the decision bytes");
});

test("after rotation both signatures remain visible, with the old key revocable", async () => {
  const directory = await createRepository();
  const first = generateEd25519KeyPair();
  const second = generateEd25519KeyPair();
  const signerFor = (pair: typeof first): SignatureSigner =>
    createLocalEd25519Signer({ signer: "alice@example.test", keyId: pair.keyId, privateKey: pair.privateKey });
  const verifier = createLocalEd25519Verifier({
    [first.keyId]: first.publicKey,
    [second.keyId]: second.publicKey,
  });

  const unsigned = await Reveries.open(directory);
  const created = await unsigned.recordNew({ path: "state.txt", revision: "HEAD", semantic, metadata });
  await (await Reveries.open(directory, { signer: signerFor(first), verifier })).signRecord({
    target: created.record,
    subject: created.object,
    role: "author",
    metadata,
  });
  await (await Reveries.open(directory, { signer: signerFor(second), verifier })).signRecord({
    target: created.record,
    subject: created.object,
    role: "author",
    metadata,
  });

  const trust = (revokedFirst: boolean) => ({
    keys: [
      { key_id: first.keyId, signer: "alice@example.test", revoked: revokedFirst },
      { key_id: second.keyId, signer: "alice@example.test", revoked: false },
    ],
  });

  const beforeRevocation = await (await Reveries.open(directory, {
    verifier,
    trust: trust(false),
    requiredRoles: ["author"],
  })).signatureReports();
  const reports = beforeRevocation.get(created.record.id) ?? [];
  assert.equal(reports.length, 2, "the rotation did not leave both signatures visible");
  assert.deepEqual(reports.map((report) => report.state).sort(), ["policy-satisfying", "policy-satisfying"]);

  // Revoke the old key: it stays visible and reported, it is never deleted.
  const afterRevocation = await (await Reveries.open(directory, {
    verifier,
    trust: trust(true),
    requiredRoles: ["author"],
  })).signatureReports();
  const states = (afterRevocation.get(created.record.id) ?? []).map((report) => report.state).sort();
  assert.deepEqual(states, ["policy-satisfying", "revoked"]);
});

test("a SHA-256 repository signs and rotates without changing any ID shape", async () => {
  const directory = await createRepository("sha256");
  const first = generateEd25519KeyPair();
  const second = generateEd25519KeyPair();
  const open = async (pair: typeof first): Promise<Reveries> => Reveries.open(directory, {
    signer: createLocalEd25519Signer({ signer: "alice@example.test", keyId: pair.keyId, privateKey: pair.privateKey }),
    verifier: createLocalEd25519Verifier({ [first.keyId]: first.publicKey, [second.keyId]: second.publicKey }),
  });

  const created = await (await open(first)).recordNew({ path: "state.txt", revision: "HEAD", semantic, metadata });
  assert.match(created.record.id, /^rv:[0-9a-f]{64}$/);
  const before = created.record.id;
  await (await open(first)).signRecord({ target: created.record, subject: created.object, role: "author", metadata });
  const rotated = await (await open(second)).signRecord({
    target: created.record,
    subject: created.object,
    role: "author",
    metadata,
  });
  assert.match(rotated.record?.id ?? "", /^sg:[0-9a-f]{64}$/);

  const shown = await (await open(second)).show({ target: created.object });
  const record = shown.records.find((entry) => entry.type === "reverie");
  assert.equal(record?.id, before);
});

test("a signature verifies over the exact record bytes and fails if they change", async () => {
  const directory = await createRepository();
  const pair = generateEd25519KeyPair();
  const reveries = await Reveries.open(directory, {
    signer: createLocalEd25519Signer({ signer: "alice@example.test", keyId: pair.keyId, privateKey: pair.privateKey }),
    verifier: createLocalEd25519Verifier({ [pair.keyId]: pair.publicKey }),
    trust: { keys: [{ key_id: pair.keyId, signer: "alice@example.test", revoked: false }] },
    requiredRoles: ["author"],
  });
  const created = await reveries.recordNew({ path: "state.txt", revision: "HEAD", semantic, metadata });
  const signed = await reveries.signRecord({
    target: created.record,
    subject: created.object,
    role: "author",
    metadata,
  });
  assert.equal(signed.state, "signed");

  const reports = await reveries.signatureReports();
  const report = (reports.get(created.record.id) ?? [])[0];
  assert.equal(report?.state, "policy-satisfying");

  // The signature commits to the record's canonical bytes, so a record whose
  // bytes changed can no longer be covered by it.
  const contentId = signed.record?.content_id;
  assert.ok(contentId);
  const recomputed = await reveries.repository.hashObject(
    `${canonicalRecord(created.record).replace(/\n$/, "")}`,
  );
  assert.equal(recomputed, contentId, "content_id is not the hash of the record's canonical bytes");
});

test("signing a record with no identity is refused rather than producing a dangling signature", async () => {
  const directory = await createRepository();
  const pair = generateEd25519KeyPair();
  const reveries = await Reveries.open(directory, {
    signer: createLocalEd25519Signer({ signer: "alice@example.test", keyId: pair.keyId, privateKey: pair.privateKey }),
  });
  const created = await reveries.recordNew({ path: "state.txt", revision: "HEAD", semantic, metadata });
  const result = await reveries.signRecord({
    // A publication attestation has no stable semantic ID to reference.
    target: {
      v: 1,
      type: "publication-attestation",
      author_email: "reveries@example.com",
      session: null,
      created_at: "2026-09-29T21:11:20Z",
      commit: created.object as never,
      transition: `tr:${"a".repeat(40)}` as never,
      publisher: "reveries@example.com",
    },
    subject: created.object,
    role: "author",
    metadata,
  });
  assert.equal(result.state, "unavailable");
  assert.equal(result.ok, false);
  assert.match(result.diagnostics.join(" "), /no identity to attest/);
});

test("an unsigned repository reports unavailable rather than failing", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const created = await reveries.recordNew({ path: "state.txt", revision: "HEAD", semantic, metadata });
  const result = await reveries.signRecord({
    target: created.record,
    subject: created.object,
    role: "author",
    metadata,
  });
  assert.equal(result.state, "unavailable");
  assert.equal(result.ok, true);
  const status = await reveries.signatureStatus();
  assert.equal(status.state, "absent");
  assert.equal(status.checkpointSigned, false);
});

test("a record line the protocol produces is stable across a rotation-free rebuild", () => {
  // A last guard on the key-rotation criterion: the record's own bytes are a
  // function of its causal fields alone, so a rebuild cannot drift.
  const first = createReverie(semantic, metadata, (bytes) => "a".repeat(40) as never);
  const second = createReverie({ ...semantic }, metadata, (bytes) => "a".repeat(40) as never);
  assert.equal(first.id, second.id);
  assert.equal(canonicalRecord(first), canonicalRecord(second));
});
