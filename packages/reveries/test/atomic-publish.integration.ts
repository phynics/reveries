import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";

import { runCli, type CliIo } from "../src/cli.ts";
import {
  AtomicPushUnavailableError,
  GitRepository,
  createLocalEd25519Signer,
  createLocalEd25519Verifier,
  ed25519KeyId,
  generateEd25519KeyPair,
  hashBlobContent,
  LEDGER_REF,
  NOTES_REF,
  type Ed25519KeyPair,
  type SignatureSigner,
  type SignatureVerifier,
} from "../src/git.ts";
import { Reveries } from "../src/operations.ts";
import {
  canonicalRecord,
  createReverie,
  objectId,
  type ObjectId,
  type ReveriesInit,
  type SessionSummary,
} from "../src/protocol.ts";

const execFileAsync = promisify(execFile);
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })));
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd, encoding: "utf8" })).stdout.trim();
}

async function runCliAt(cwd: string, argv: readonly string[]): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  let stdout = "";
  let stderr = "";
  const io: CliIo = {
    cwd,
    stdin: async () => "",
    stdout: (text) => { stdout += text; },
    stderr: (text) => { stderr += text; },
    environment: {},
  };
  return { code: await runCli(argv, io), stdout, stderr };
}

function summary(decision: string): SessionSummary {
  return {
    v: 1,
    type: "session-summary",
    author_email: "reveries@example.com",
    session: "codex:atomic",
    created_at: "2026-09-30T10:00:00Z",
    entries: [{
      driving_event: "The publication boundary moved.",
      decision,
      impact: "Code, notes, and the ledger envelope publish together or not at all.",
      recurrence_control: "The atomic publication check requires all three refs in one transaction.",
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
    created_at: "2026-09-30T10:00:00Z",
  };
}

function reverieLine(decision: string, createdAt: string): string {
  return canonicalRecord(createReverie(
    {
      v: 1,
      driving_event: "Evidence must publish atomically.",
      decision,
      impact: "A partial publication would leave the remote in a mixed state.",
      recurrence_control: null,
      alternatives: [],
      sources: [],
      supersedes: [],
    },
    { author_email: "reveries@example.com", session: null, created_at: createdAt },
    (bytes) => hashBlobContent(bytes, "sha1"),
  ));
}

async function createRepository(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(directory);
  await git(directory, "init", "-b", "main");
  await git(directory, "config", "user.name", "Reveries Test");
  await git(directory, "config", "user.email", "reveries@example.com");
  await writeFile(join(directory, "state.txt"), "first\n", "utf8");
  await git(directory, "add", "state.txt");
  await git(directory, "commit", "-m", "initial");
  return directory;
}

async function adopt(directory: string): Promise<void> {
  const reveries = await Reveries.open(directory);
  const commit = await git(directory, "rev-parse", "HEAD");
  await reveries.summarize({ commit, summary: summary("Adopt Reveries so publication is atomic.") });
  await reveries.attachInitialization({ commit, record: initialization() });
}

async function annotate(directory: string, path: string, decision: string, createdAt: string): Promise<ObjectId> {
  const repository = await GitRepository.open(directory);
  const blob = await repository.resolvePath({ path, revision: "HEAD" });
  await repository.withNotesWrite(async (notes) => {
    await notes.append(blob, reverieLine(decision, createdAt));
  });
  return blob;
}

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

async function bareRemote(root: string): Promise<string> {
  const bare = join(root, "remote.git");
  await execFileAsync("git", ["init", "--bare", "-b", "main", bare]);
  return bare;
}

async function bareRef(bare: string, ref: string): Promise<ObjectId | null> {
  try {
    return objectId(await git(bare, "rev-parse", "--verify", ref));
  } catch {
    return null;
  }
}

/**
 * A publisher carrying both evidence routes over the same notes tip, plus the
 * first notes commit preserved under a fixture ref so a consumer can be placed
 * in the strict-ancestor state.
 */
async function publisherWithEnvelope(prefix: string): Promise<{ source: string; bare: string; firstNotes: ObjectId }> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(root);
  const source = join(root, "source");
  const bare = await bareRemote(root);
  await createRepositoryAt(source);
  await git(source, "remote", "add", "origin", bare);
  await annotate(source, "state.txt", "The publisher recorded the first decision.", "2026-09-30T10:00:00Z");
  const firstNotes = (await git(source, "rev-parse", NOTES_REF)) as ObjectId;
  await git(source, "push", "origin", "main", `${NOTES_REF}:${NOTES_REF}`);
  await git(source, "update-ref", "refs/published/first-notes", firstNotes);
  await git(source, "push", "origin", "refs/published/first-notes:refs/published/first-notes");
  await writeFile(join(source, "state.txt"), "second\n", "utf8");
  await git(source, "add", "state.txt");
  await git(source, "commit", "-m", "second");
  await annotate(source, "state.txt", "The publisher recorded the second decision.", "2026-09-30T11:00:00Z");
  const built = await (await Reveries.open(source)).buildLedgerCheckpoint({});
  assert.equal(built.ok, true, JSON.stringify(built.diagnostics));
  await git(source, "push", "origin", "main", `${NOTES_REF}:${NOTES_REF}`, `${LEDGER_REF}:${LEDGER_REF}`);
  return { source, bare, firstNotes };
}

async function createRepositoryAt(directory: string): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(directory, { recursive: true });
  await git(directory, "init", "-b", "main");
  await git(directory, "config", "user.name", "Reveries Test");
  await git(directory, "config", "user.email", "reveries@example.com");
  await writeFile(join(directory, "state.txt"), "first\n", "utf8");
  await git(directory, "add", "state.txt");
  await git(directory, "commit", "-m", "initial");
}

// --- Atomic publication -----------------------------------------------------

test("push publishes branch, notes, and ledger in one atomic transaction", async () => {
  const directory = await createRepository("reveries-atomic-push-");
  const bare = await bareRemote(directory);
  await git(directory, "remote", "add", "origin", bare);
  await adopt(directory);
  await annotate(directory, "state.txt", "The repository recorded its decision.", "2026-09-30T10:05:00Z");
  const built = await (await Reveries.open(directory)).buildLedgerCheckpoint({});
  assert.equal(built.ok, true, JSON.stringify(built.diagnostics));

  const result = await (await Reveries.open(directory)).push("origin");

  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(await bareRef(bare, "refs/heads/main"), await git(directory, "rev-parse", "HEAD"));
  assert.equal(await bareRef(bare, NOTES_REF), await git(directory, "rev-parse", NOTES_REF));
  assert.equal(await bareRef(bare, LEDGER_REF), built.checkpoint);
});

test("republishing unchanged refs succeeds without moving them", async () => {
  const directory = await createRepository("reveries-atomic-noop-");
  const bare = await bareRemote(directory);
  await git(directory, "remote", "add", "origin", bare);
  await adopt(directory);
  await annotate(directory, "state.txt", "The repository recorded its decision.", "2026-09-30T10:05:00Z");
  const pair = generateEd25519KeyPair();
  const signed = await (await signingRepository(directory, pair)).buildLedgerCheckpoint({});
  assert.equal(signed.ok, true, JSON.stringify(signed.diagnostics));
  const first = await (await Reveries.open(directory)).push("origin");
  assert.equal(first.ok, true, JSON.stringify(first.diagnostics));

  const before = {
    main: await bareRef(bare, "refs/heads/main"),
    notes: await bareRef(bare, NOTES_REF),
    ledger: await bareRef(bare, LEDGER_REF),
  };
  const second = await (await Reveries.open(directory)).push("origin");

  assert.equal(second.ok, true, JSON.stringify(second.diagnostics));
  assert.deepEqual(
    { main: await bareRef(bare, "refs/heads/main"), notes: await bareRef(bare, NOTES_REF), ledger: await bareRef(bare, LEDGER_REF) },
    before,
    "republishing unchanged refs must move nothing, including the signed envelope",
  );
});

test("fresh clone sync builds on the fetched primary ledger and pushes atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "reveries-atomic-fresh-clone-"));
  temporary.push(root);
  const publisher = join(root, "publisher");
  const bare = await bareRemote(root);
  await createRepositoryAt(publisher);
  await git(publisher, "remote", "add", "origin", bare);
  await adopt(publisher);
  await git(publisher, "config", "reveries.remoteRole.origin", "primary");
  await annotate(publisher, "state.txt", "The publisher recorded its decision.", "2026-09-30T10:05:00Z");
  const pair = generateEd25519KeyPair();
  const publisherReveries = await signingRepository(publisher, pair);
  const firstBuild = await publisherReveries.buildLedgerCheckpoint({});
  assert.equal(firstBuild.ok, true, JSON.stringify(firstBuild.diagnostics));
  assert.equal((await publisherReveries.push("origin")).ok, true);
  const remoteBase = firstBuild.checkpoint!;
  const remoteSignatures = await publisherReveries.repository.readLedgerSignaturesAt(remoteBase);
  assert.notEqual(remoteSignatures, null, "publisher fixture needs a signed base");

  const clone = join(root, "clone");
  await execFileAsync("git", ["clone", "--quiet", bare, clone]);
  await git(clone, "config", "user.name", "Collaborator");
  await git(clone, "config", "user.email", "collaborator@example.com");
  await git(clone, "config", "reveries.publishingRemote", "origin");
  // The publisher's envelope is signed, so the collaborator must configure
  // that trusted signer too; otherwise it could not append without dropping
  // the existing signature log.
  const trust = await import("../src/install.ts");
  const cloneRepository = await GitRepository.open(clone);
  await trust.writeLocalTrustStore(cloneRepository, {
    keys: [{
      key_id: ed25519KeyId(pair.publicKey),
      signer: "reveries@example.com",
      revoked: false,
      public_key: pair.publicKey,
    }],
  });
  await git(clone, "config", "reveries.signingKey", join(root, "collaborator-key.pem"));
  await writeFile(join(root, "collaborator-key.pem"), pair.privateKey, { encoding: "utf8", mode: 0o600 });
  const beforeSync = await (await GitRepository.open(clone)).ledgerTip();
  assert.equal(beforeSync, null, "a normal clone has only the remote-tracking ledger ref");

  const sync = await runCliAt(clone, ["sync", "origin", "--pull", "--json"]);
  assert.equal(sync.code, 0, sync.stderr);
  const syncResult = JSON.parse(sync.stdout) as { ok: boolean; result: { quarantineRef?: string | null } };
  assert.equal(syncResult.ok, true);
  assert.equal(syncResult.result.quarantineRef, null);
  const notesAfterSync = await (await GitRepository.open(clone)).notesTip();
  assert.notEqual(notesAfterSync, null, "sync materializes the primary's canonical notes");
  assert.equal(await (await GitRepository.open(clone)).ledgerTip(), null, "sync retains the fetched ledger only as tracking state");

  // Add a new code+notes transition, then build. The manifest predecessor must
  // be the verified remote-tracking checkpoint while local CAS still expects
  // null and creates the local ledger ref exactly once.
  await writeFile(join(clone, "second.txt"), "second\n", "utf8");
  await git(clone, "add", "second.txt");
  await git(clone, "commit", "-m", "collaborator change");
  const commit = await git(clone, "rev-parse", "HEAD");
  await (await Reveries.open(clone)).summarize({ commit, summary: summary("Record the collaborator transition.") });
  await annotate(clone, "second.txt", "The collaborator recorded a decision.", "2026-09-30T11:00:00Z");

  const build = await runCliAt(clone, ["ledger", "build", "--json"]);
  assert.equal(build.code, 0, build.stderr || build.stdout);
  const report = JSON.parse(build.stdout) as { ok: boolean; result: { checkpoint: ObjectId } };
  assert.equal(report.ok, true);
  const localLedger = await (await GitRepository.open(clone)).ledgerTip();
  assert.equal(localLedger, report.result.checkpoint);
  const manifest = await (await GitRepository.open(clone)).readLedgerManifestAt(localLedger!);
  assert.notEqual(manifest, null);
  assert.equal(JSON.parse(manifest!).previous_ledger, remoteBase, "the new checkpoint must extend the remote tip");
  const carried = await (await GitRepository.open(clone)).readLedgerSignaturesAt(localLedger!);
  assert.ok(carried?.startsWith(remoteSignatures!), "the base signature log must remain append-only");

  const push = await runCliAt(clone, ["push", "origin", "--json"]);
  assert.equal(push.code, 0, push.stderr || push.stdout);
  assert.equal(await bareRef(bare, "refs/heads/main"), await git(clone, "rev-parse", "HEAD"));
  assert.equal(await bareRef(bare, NOTES_REF), await git(clone, "rev-parse", NOTES_REF));
  assert.equal(await bareRef(bare, LEDGER_REF), localLedger);
});

test("a local divergent ledger refuses push before moving any remote ref", async () => {
  const directory = await createRepository("reveries-atomic-ledger-diverged-");
  const bare = await bareRemote(directory);
  await git(directory, "remote", "add", "origin", bare);
  await adopt(directory);
  await annotate(directory, "state.txt", "The repository recorded its decision.", "2026-09-30T10:05:00Z");
  const base = await (await Reveries.open(directory)).buildLedgerCheckpoint({});
  assert.equal(base.ok, true, JSON.stringify(base.diagnostics));
  assert.equal((await (await Reveries.open(directory)).push("origin")).ok, true);
  const before = {
    main: await bareRef(bare, "refs/heads/main"),
    notes: await bareRef(bare, NOTES_REF),
    ledger: await bareRef(bare, LEDGER_REF),
  };
  const remoteLedger = before.ledger!;

  // Create a competing remote child first from the exact shared base.
  const competitorRoot = await mkdtemp(join(tmpdir(), "reveries-atomic-ledger-competitor-"));
  temporary.push(competitorRoot);
  const competitor = join(competitorRoot, "clone");
  await execFileAsync("git", ["clone", "--quiet", bare, competitor]);
  await git(competitor, "config", "user.name", "Competitor");
  await git(competitor, "config", "user.email", "competitor@example.com");
  const competitorRepository = await GitRepository.open(competitor);
  const annotatedObject = await competitorRepository.resolvePath({ path: "state.txt", revision: "HEAD" });
  await competitorRepository.withNotesWrite(async (notes) => {
    await notes.append(annotatedObject, reverieLine(
      "The competing publisher recorded another decision.",
      "2026-09-30T12:00:00Z",
    ));
  });
  const competitorSync = await (await Reveries.open(competitor)).syncPull("origin");
  assert.equal(competitorSync.ok, true, JSON.stringify(competitorSync.diagnostics));
  const notesPublish = await (await Reveries.open(competitor)).publishNotes({ remote: "origin" });
  assert.equal(notesPublish.ok, true, JSON.stringify(notesPublish.diagnostics));
  const competitorBuilt = await (await Reveries.open(competitor)).buildLedgerCheckpoint({});
  assert.equal(competitorBuilt.ok, true, JSON.stringify(competitorBuilt.diagnostics));
  await git(competitor, "push", "origin", `${LEDGER_REF}:${LEDGER_REF}`);
  const advancedRemote = await bareRef(bare, LEDGER_REF);
  assert.notEqual(advancedRemote, remoteLedger);
  assert.equal(
    await (await GitRepository.open(directory)).objectExists("commit", advancedRemote!),
    false,
    "the stale advertised remote ledger must not have been fetched into the local object database",
  );
  const remoteAfterCompetitor = {
    main: await bareRef(bare, "refs/heads/main"),
    notes: await bareRef(bare, NOTES_REF),
    ledger: advancedRemote,
  };

  // Now build a local sibling of the same base with a different note/manifest.
  await writeFile(join(directory, "local.txt"), "local\n", "utf8");
  await git(directory, "add", "local.txt");
  await git(directory, "commit", "-m", "local branch change");
  const localCommit = await git(directory, "rev-parse", "HEAD");
  await (await Reveries.open(directory)).summarize({ commit: localCommit, summary: summary("Record the local transition.") });
  await annotate(directory, "local.txt", "The local branch recorded its decision.", "2026-09-30T11:00:00Z");
  const localLedger = await (await Reveries.open(directory)).buildLedgerCheckpoint({});
  assert.equal(localLedger.ok, true, JSON.stringify(localLedger.diagnostics));

  const result = await (await Reveries.open(directory)).push("origin");

  assert.equal(result.ok, false);
  assert.match(result.diagnostics.join(" "), /Remote ledger .* unavailable locally; fetch it and rebuild/);
  assert.deepEqual(
    { main: await bareRef(bare, "refs/heads/main"), notes: await bareRef(bare, NOTES_REF), ledger: await bareRef(bare, LEDGER_REF) },
    remoteAfterCompetitor,
    "a divergent local checkpoint must move none of branch, notes, or the advanced ledger",
  );
});

test("a stale per-ref lease rejects the whole transaction with all remote refs unchanged", async () => {
  const directory = await createRepository("reveries-atomic-stale-");
  const bare = await bareRemote(directory);
  await git(directory, "remote", "add", "origin", bare);
  await adopt(directory);
  await annotate(directory, "state.txt", "The repository recorded its decision.", "2026-09-30T10:05:00Z");
  const built = await (await Reveries.open(directory)).buildLedgerCheckpoint({});
  assert.equal(built.ok, true, JSON.stringify(built.diagnostics));
  assert.equal((await (await Reveries.open(directory)).push("origin")).ok, true);
  const before = {
    main: await bareRef(bare, "refs/heads/main"),
    notes: await bareRef(bare, NOTES_REF),
    ledger: await bareRef(bare, LEDGER_REF),
  };
  // Local work advances all three refs past the remote state. The ledger is
  // rebuilt so its update is really attempted: a ref that is already
  // up-to-date would not evaluate its lease at all.
  await writeFile(join(directory, "state.txt"), "second\n", "utf8");
  await git(directory, "add", "state.txt");
  await git(directory, "commit", "-m", "second");
  await annotate(directory, "state.txt", "The repository recorded a second decision.", "2026-09-30T11:00:00Z");
  const rebuilt = await (await Reveries.open(directory)).buildLedgerCheckpoint({});
  assert.equal(rebuilt.ok, true, JSON.stringify(rebuilt.diagnostics));
  assert.notEqual(rebuilt.checkpoint, before.ledger);

  // A wellformed but wrong expectation for one ref: the remote holds the
  // pre-push ledger while the lease claims an unrelated OID.
  const wrong = await (await GitRepository.open(directory)).notesTip();
  assert.notEqual(wrong, null);
  await assert.rejects(
    (await GitRepository.open(directory)).pushAtomically("origin", {
      branchRef: "refs/heads/main",
      expectedBranch: before.main,
      expectedNotes: before.notes,
      includeLedger: true,
      expectedLedger: wrong,
    }),
    "a stale ledger lease must reject the push",
  );
  assert.deepEqual(
    { main: await bareRef(bare, "refs/heads/main"), notes: await bareRef(bare, NOTES_REF), ledger: await bareRef(bare, LEDGER_REF) },
    before,
    "one stale lease must leave every remote ref exactly as it was",
  );
});

test("an invalid local checkpoint refuses publication with all remote refs unchanged", async () => {
  const directory = await createRepository("reveries-atomic-invalid-");
  const bare = await bareRemote(directory);
  await git(directory, "remote", "add", "origin", bare);
  await adopt(directory);
  await annotate(directory, "state.txt", "The repository recorded its decision.", "2026-09-30T10:05:00Z");
  const built = await (await Reveries.open(directory)).buildLedgerCheckpoint({});
  assert.equal(built.ok, true, JSON.stringify(built.diagnostics));
  assert.equal((await (await Reveries.open(directory)).push("origin")).ok, true);
  const before = {
    main: await bareRef(bare, "refs/heads/main"),
    notes: await bareRef(bare, NOTES_REF),
    ledger: await bareRef(bare, LEDGER_REF),
  };
  // Branch and notes advance, so the push would move refs if the envelope did
  // not gate it first.
  await writeFile(join(directory, "second.txt"), "second\n", "utf8");
  await git(directory, "add", "second.txt");
  await git(directory, "commit", "-m", "second");
  const secondCommit = await git(directory, "rev-parse", "HEAD");
  await (await Reveries.open(directory)).summarize({ commit: secondCommit, summary: summary("Record the second transition.") });
  // A structurally invalid local checkpoint: the ledger message over an empty
  // tree, so the envelope carries no manifest at all.
  const emptyTree = await git(directory, "hash-object", "-t", "tree", "/dev/null");
  const forged = await git(directory, "commit-tree", emptyTree, "-p", built.checkpoint!, "-m", "Reveries ledger checkpoint");
  await git(directory, "update-ref", LEDGER_REF, forged);

  const result = await (await Reveries.open(directory)).push("origin");

  assert.equal(result.ok, false, "an invalid local envelope must fail the publication check");
  assert.match(result.diagnostics.join(" "), /manifest|not a Reveries ledger checkpoint/);
  assert.deepEqual(
    { main: await bareRef(bare, "refs/heads/main"), notes: await bareRef(bare, NOTES_REF), ledger: await bareRef(bare, LEDGER_REF) },
    before,
    "a refused envelope must leave every remote ref exactly as it was",
  );
});

test("a receiver that rejects the ledger ref rejects branch and notes too", async () => {
  const directory = await createRepository("reveries-atomic-reject-");
  const bare = await bareRemote(directory);
  await git(directory, "remote", "add", "origin", bare);
  await adopt(directory);
  await annotate(directory, "state.txt", "The repository recorded its decision.", "2026-09-30T10:05:00Z");
  const built = await (await Reveries.open(directory)).buildLedgerCheckpoint({});
  assert.equal(built.ok, true, JSON.stringify(built.diagnostics));
  const beforeMain = await git(directory, "rev-parse", "HEAD");
  // The receiver accepts code and notes but refuses the envelope.
  await writeFile(
    join(bare, "hooks", "pre-receive"),
    "#!/bin/sh\nwhile read old new ref; do\n  if [ \"$ref\" = \"refs/heads/reveries-ledger\" ]; then echo \"ledger refused\" 1>&2; exit 1; fi\ndone\nexit 0\n",
    "utf8",
  );
  await chmod(join(bare, "hooks", "pre-receive"), 0o755);

  await assert.rejects(
    (await Reveries.open(directory)).push("origin"),
    "a refused ledger must fail the publication",
  );
  assert.equal(await bareRef(bare, "refs/heads/main"), null, "atomicity must hold back the branch too");
  assert.equal(await bareRef(bare, NOTES_REF), null, "atomicity must hold back the notes too");
  assert.equal(await bareRef(bare, LEDGER_REF), null);
  assert.equal(beforeMain, await git(directory, "rev-parse", "HEAD"), "local state is untouched");
});

test("a receiver that rejects everything fails closed with all remote refs unchanged", async () => {  const directory = await createRepository("reveries-atomic-reject-all-");
  const bare = await bareRemote(directory);
  await git(directory, "remote", "add", "origin", bare);
  await adopt(directory);
  await annotate(directory, "state.txt", "The repository recorded its decision.", "2026-09-30T10:05:00Z");
  await (await Reveries.open(directory)).buildLedgerCheckpoint({});
  assert.equal((await (await Reveries.open(directory)).push("origin")).ok, true);
  const before = {
    main: await bareRef(bare, "refs/heads/main"),
    notes: await bareRef(bare, NOTES_REF),
    ledger: await bareRef(bare, LEDGER_REF),
  };
  await writeFile(join(bare, "hooks", "pre-receive"), "#!/bin/sh\necho refused 1>&2\nexit 1\n", "utf8");
  await chmod(join(bare, "hooks", "pre-receive"), 0o755);
  // A new file keeps the transition check satisfied with a plain summary,
  // exactly as the hosted publication fixtures do.
  await writeFile(join(directory, "second.txt"), "second\n", "utf8");
  await git(directory, "add", "second.txt");
  await git(directory, "commit", "-m", "second");
  const secondCommit = await git(directory, "rev-parse", "HEAD");
  await (await Reveries.open(directory)).summarize({ commit: secondCommit, summary: summary("Record the second transition.") });

  await assert.rejects((await Reveries.open(directory)).push("origin"), "a refusing receiver must fail the push");
  assert.deepEqual(
    { main: await bareRef(bare, "refs/heads/main"), notes: await bareRef(bare, NOTES_REF), ledger: await bareRef(bare, LEDGER_REF) },
    before,
    "a refused transaction must leave every remote ref exactly as it was",
  );
});

// --- Structural envelope promotion policy (direct API callers) ---------------

async function consumer(bare: string, remote: string, role: string | null, firstNotes: ObjectId | null): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "reveries-atomic-consumer-"));
  temporary.push(root);
  const directory = join(root, "consumer");
  await execFileAsync("git", ["clone", "--quiet", bare, directory]);
  await git(directory, "config", "user.name", "Consumer");
  await git(directory, "config", "user.email", "consumer@example.com");
  if (firstNotes !== null) {
    // The publisher's first notes commit is preserved under a fixture ref:
    // fetching the live notes ref would deliver the second revision instead.
    await git(directory, "fetch", "--quiet", "origin", `+refs/published/first-notes:${NOTES_REF}`);
    assert.equal(await git(directory, "rev-parse", NOTES_REF), firstNotes);
  }
  await git(directory, "fetch", "--quiet", "origin", `refs/heads/reveries-ledger:refs/remotes/${remote}/reveries-ledger`);
  await git(directory, "remote", "add", remote, bare);
  await git(directory, "config", "--add", "reveries.publishingRemote", remote);
  if (role !== null) await git(directory, "config", `reveries.remoteRole.${remote}`, role);
  return directory;
}

for (const role of ["import-only", "mirror"]) {
  test(`direct materialize from a ${role} envelope is refused with notes absent`, async () => {
    const published = await publisherWithEnvelope(`reveries-atomic-${role}-absent-`);
    const directory = await consumer(published.bare, "vendor", role, null);
    const repository = await GitRepository.open(directory);
    assert.equal(await repository.notesTip(), null);

    const result = await (await Reveries.open(directory)).materializeNotesFromLedger({
      revision: "refs/remotes/vendor/reveries-ledger",
      expectedNotes: null,
    });

    assert.equal(result.ok, false);
    assert.match(result.diagnostics.join(" "), new RegExp(`${role}.*quarantined|quarantined.*${role}`));
    assert.equal(await repository.notesTip(), null, "the refused envelope must not create the canonical ref");
  });

  test(`direct materialize from a ${role} envelope leaves an ancestor tip unchanged`, async () => {
    const published = await publisherWithEnvelope(`reveries-atomic-${role}-ancestor-`);
    const directory = await consumer(published.bare, "vendor", role, published.firstNotes);

    const result = await (await Reveries.open(directory)).materializeNotesFromLedger({
      revision: "refs/remotes/vendor/reveries-ledger",
      expectedNotes: published.firstNotes,
    });

    assert.equal(result.ok, false);
    assert.equal(
      await (await GitRepository.open(directory)).notesTip(),
      published.firstNotes,
      "an ancestor tip the envelope would have fast-forwarded must be left exactly as it was",
    );
  });
}

test("direct materialize from a primary envelope still promotes", async () => {
  const published = await publisherWithEnvelope("reveries-atomic-primary-");
  const directory = await consumer(published.bare, "vendor", "primary", published.firstNotes);

  const result = await (await Reveries.open(directory)).materializeNotesFromLedger({
    revision: "refs/remotes/vendor/reveries-ledger",
    expectedNotes: published.firstNotes,
  });

  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(result.state, "materialized");
  assert.notEqual(await (await GitRepository.open(directory)).notesTip(), published.firstNotes);
});

test("an undeclared remote keeps its pre-role promotion behaviour", async () => {
  const published = await publisherWithEnvelope("reveries-atomic-undeclared-");
  const directory = await consumer(published.bare, "vendor", null, null);

  const result = await (await Reveries.open(directory)).materializeNotesFromLedger({
    revision: "refs/remotes/vendor/reveries-ledger",
    expectedNotes: null,
  });

  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(result.state, "materialized");
});

test("a raw checkpoint OID from a mirror tip is refused when roles exist", async () => {
  const published = await publisherWithEnvelope("reveries-atomic-oid-");
  const directory = await consumer(published.bare, "vendor", "mirror", null);
  const tracking = "refs/remotes/vendor/reveries-ledger";
  const checkpoint = objectId(await git(directory, "rev-parse", tracking));

  const result = await (await Reveries.open(directory)).materializeNotesFromLedger({
    revision: checkpoint,
    expectedNotes: null,
  });

  assert.equal(result.ok, false, "a raw OID must not bypass the mirror role");
  assert.match(result.diagnostics.join(" "), /no configured remote|unknown source/);
  assert.equal(await (await GitRepository.open(directory)).notesTip(), null);
});

test("a raw checkpoint OID stays allowed in a legacy repository without roles", async () => {
  const published = await publisherWithEnvelope("reveries-atomic-oid-legacy-");
  const root = await mkdtemp(join(tmpdir(), "reveries-atomic-oid-legacy-consumer-"));
  temporary.push(root);
  const directory = join(root, "consumer");
  await execFileAsync("git", ["clone", "--quiet", published.bare, directory]);
  await git(directory, "config", "user.name", "Consumer");
  await git(directory, "config", "user.email", "consumer@example.com");
  await git(directory, "fetch", "--quiet", "origin", "refs/heads/reveries-ledger:refs/remotes/origin/reveries-ledger");
  const checkpoint = objectId(await git(directory, "rev-parse", "refs/remotes/origin/reveries-ledger"));

  const result = await (await Reveries.open(directory)).materializeNotesFromLedger({
    revision: checkpoint,
    expectedNotes: null,
  });

  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(result.state, "materialized");
});

test("the local-tip envelope stays allowed when roles are configured", async () => {
  const directory = await createRepository("reveries-atomic-local-tip-");
  const bare = await bareRemote(directory);
  await git(directory, "remote", "add", "origin", bare);
  await adopt(directory);
  await git(directory, "config", "reveries.remoteRole.origin", "primary");
  const adoptedNotes = objectId(await git(directory, "rev-parse", NOTES_REF));
  await annotate(directory, "state.txt", "The repository recorded its decision.", "2026-09-30T10:05:00Z");
  const built = await (await Reveries.open(directory)).buildLedgerCheckpoint({});
  assert.equal(built.ok, true, JSON.stringify(built.diagnostics));
  await git(directory, "update-ref", NOTES_REF, adoptedNotes);

  const result = await (await Reveries.open(directory)).materializeNotesFromLedger({ expectedNotes: adoptedNotes });

  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(result.state, "materialized", "an omitted revision is local provenance, not an unknown source");
});

test("an invalid authority refuses even the local-tip envelope", async () => {
  const published = await publisherWithEnvelope("reveries-atomic-invalid-");
  const directory = await consumer(published.bare, "vendor", "primary", null);
  await git(directory, "config", "reveries.remoteRole.origin", "primary");

  const result = await (await Reveries.open(directory)).materializeNotesFromLedger({
    expectedNotes: null,
  });

  assert.equal(result.ok, false);
  assert.match(result.diagnostics.join(" "), /Authority configuration is invalid/);
  assert.equal(await (await GitRepository.open(directory)).notesTip(), null);
});

test("a diverged local tip is refused rather than replaced", async () => {  const published = await publisherWithEnvelope("reveries-atomic-diverged-");
  const directory = await consumer(published.bare, "vendor", "primary", published.firstNotes);
  // Local evidence the envelope does not contain: the tip is neither absent,
  // equal, nor an ancestor of the transported notes commit.
  await annotate(directory, "state.txt", "The consumer recorded its own decision.", "2026-09-30T12:00:00Z");
  const diverged = await (await GitRepository.open(directory)).notesTip();
  assert.notEqual(diverged, published.firstNotes);

  const result = await (await Reveries.open(directory)).materializeNotesFromLedger({
    revision: "refs/remotes/vendor/reveries-ledger",
    expectedNotes: diverged,
  });

  assert.equal(result.ok, false);
  assert.match(result.diagnostics.join(" "), /does not contain/);
  assert.equal(await (await GitRepository.open(directory)).notesTip(), diverged);
});

// --- Signed-checkpoint no-ops -------------------------------------------------

test("a signed envelope materializes once, then reports unchanged", async () => {
  const directory = await createRepository("reveries-atomic-signed-");
  const pair = generateEd25519KeyPair();
  const reveries = await signingRepository(directory, pair);
  await adopt(directory);
  const adoptedNotes = objectId(await git(directory, "rev-parse", NOTES_REF));
  await annotate(directory, "state.txt", "The repository recorded its decision.", "2026-09-30T10:05:00Z");
  const built = await reveries.buildLedgerCheckpoint({});
  assert.equal(built.ok, true, JSON.stringify(built.diagnostics));
  assert.notEqual(
    await reveries.repository.readLedgerSignaturesAt(built.checkpoint!),
    null,
    "the fixture must carry a manifest signature",
  );
  // Rewind the canonical ref to the adopted tip so the envelope has something
  // to restore; it is a strict ancestor of the transported notes commit.
  const notesTip = objectId(await git(directory, "rev-parse", NOTES_REF));
  await git(directory, "update-ref", NOTES_REF, adoptedNotes);

  const first = await (await Reveries.open(directory)).materializeNotesFromLedger({ expectedNotes: adoptedNotes });
  assert.equal(first.ok, true, JSON.stringify(first.diagnostics));
  assert.equal(first.state, "materialized");
  assert.equal(first.notesTip, notesTip);

  const second = await (await Reveries.open(directory)).materializeNotesFromLedger({ expectedNotes: first.notesTip });
  assert.equal(second.ok, true, JSON.stringify(second.diagnostics));
  assert.equal(second.state, "unchanged");
  assert.equal(second.notesTip, notesTip, "the second materialize moves nothing");
});

// --- Slash-containing remote names ------------------------------------------
//
// Git allows remote names with slashes, but the role config scheme
// (`reveries.remoteRole.<remote>` as a flat key) cannot represent them — git
// itself rejects `git config reveries.remoteRole.team/vendor ...` as an
// invalid key. A tracking ref must therefore resolve by longest exact
// `refs/remotes/<name>/` prefix over the configured remotes: matching only the
// first segment would apply one remote's role to another remote's evidence.

async function slashConsumer(
  bare: string,
  remotes: readonly { readonly name: string; readonly role: string | null; readonly slash?: boolean }[],
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "reveries-atomic-slash-consumer-"));
  temporary.push(root);
  const directory = join(root, "consumer");
  await execFileAsync("git", ["clone", "--quiet", bare, directory]);
  await git(directory, "config", "user.name", "Consumer");
  await git(directory, "config", "user.email", "consumer@example.com");
  for (const remote of remotes) {
    if (remote.name.includes("/")) {
      // Newer Git rejects nested names through `remote add`. Write the valid
      // remote subsection directly so these fixtures can test Reveries' name
      // resolution without relying on Git's version-specific validation.
      await git(directory, "config", `remote.${remote.name}.url`, bare);
      await git(
        directory,
        "config",
        `remote.${remote.name}.fetch`,
        `+refs/heads/*:refs/remotes/${remote.name}/*`,
      );
    } else {
      await git(directory, "remote", "add", remote.name, bare);
    }
    if (remote.role !== null) {
      // Slash names cannot use the legacy flat key (git rejects the `/`);
      // they are declared through the subsection encoding instead.
      await git(
        directory,
        "config",
        remote.slash === true ? `reveries.remoteRole/${remote.name}.role` : `reveries.remoteRole.${remote.name}`,
        remote.role,
      );
    }
    await git(directory, "config", "--add", "reveries.publishingRemote", remote.name);
  }
  return directory;
}

test("a slash remote is resolved by longest match, not first segment", async () => {
  const published = await publisherWithEnvelope("reveries-atomic-slash-decoy-");
  // `team` is import-only, but `team/vendor` carries no declarable role: its
  // envelope must not be judged by `team`'s role.
  const directory = await slashConsumer(published.bare, [
    { name: "team", role: "import-only" },
    { name: "team/vendor", role: null },
  ]);
  await git(directory, "fetch", "--quiet", "origin", "refs/heads/reveries-ledger:refs/remotes/team/vendor/reveries-ledger");

  const result = await (await Reveries.open(directory)).materializeNotesFromLedger({
    revision: "refs/remotes/team/vendor/reveries-ledger",
    expectedNotes: null,
  });

  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(result.state, "materialized", "team's import-only role must not spill onto team/vendor's evidence");
});

test("an exact remote name still wins over its own prefix", async () => {
  const published = await publisherWithEnvelope("reveries-atomic-slash-exact-");
  const directory = await slashConsumer(published.bare, [
    { name: "team", role: "primary" },
    { name: "team/vendor", role: null },
  ]);
  await git(directory, "fetch", "--quiet", "origin", "refs/heads/reveries-ledger:refs/remotes/team/reveries-ledger");

  const result = await (await Reveries.open(directory)).materializeNotesFromLedger({
    revision: "refs/remotes/team/reveries-ledger",
    expectedNotes: null,
  });

  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(result.state, "materialized");
});

test("a slash remote with no declarable role keeps pre-role promotion", async () => {
  const published = await publisherWithEnvelope("reveries-atomic-slash-compat-");
  const directory = await slashConsumer(published.bare, [{ name: "team/vendor", role: null }]);
  await git(directory, "fetch", "--quiet", "origin", "refs/heads/reveries-ledger:refs/remotes/team/vendor/reveries-ledger");

  const result = await (await Reveries.open(directory)).materializeNotesFromLedger({
    revision: "refs/remotes/team/vendor/reveries-ledger",
    expectedNotes: null,
  });

  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(result.state, "materialized");
});

test("a slash remote with an explicit import-only role is refused", async () => {
  const published = await publisherWithEnvelope("reveries-atomic-slash-role-");
  const directory = await slashConsumer(published.bare, [{ name: "team/vendor", role: "import-only", slash: true }]);
  await git(directory, "config", "reveries.remoteRole/team.someOtherSetting", "hello");
  await git(directory, "fetch", "--quiet", "origin", "refs/heads/reveries-ledger:refs/remotes/team/vendor/reveries-ledger");
  const status = await (await Reveries.open(directory)).authorityStatus();
  assert.equal(status.roles.get("team/vendor"), "import-only", "the subsection encoding must resolve the role");

  const result = await (await Reveries.open(directory)).materializeNotesFromLedger({
    revision: "refs/remotes/team/vendor/reveries-ledger",
    expectedNotes: null,
  });

  assert.equal(result.ok, false);
  assert.match(result.diagnostics.join(" "), /team\/vendor.*import-only|quarantined rather than promoted/);
  assert.equal(
    await (await GitRepository.open(directory)).notesTip(),
    null,
    "the refused slash-remote envelope must not create the canonical ref",
  );
});

test("a slash remote with an explicit primary role promotes", async () => {
  const published = await publisherWithEnvelope("reveries-atomic-slash-primary-");
  const directory = await slashConsumer(published.bare, [{ name: "team/vendor", role: "primary", slash: true }]);
  await git(directory, "fetch", "--quiet", "origin", "refs/heads/reveries-ledger:refs/remotes/team/vendor/reveries-ledger");
  const status = await (await Reveries.open(directory)).authorityStatus();
  assert.equal(status.primary, "team/vendor", "a slash primary that publishes must resolve as authoritative");

  const result = await (await Reveries.open(directory)).materializeNotesFromLedger({
    revision: "refs/remotes/team/vendor/reveries-ledger",
    expectedNotes: null,
  });

  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(result.state, "materialized");
});

test("a remote without atomic-push capability fails closed with all refs unchanged", async () => {
  const directory = await createRepository("reveries-atomic-capability-");
  const bare = await bareRemote(directory);
  await git(directory, "remote", "add", "origin", bare);
  await adopt(directory);
  await annotate(directory, "state.txt", "The repository recorded its decision.", "2026-09-30T10:05:00Z");
  const built = await (await Reveries.open(directory)).buildLedgerCheckpoint({});
  assert.equal(built.ok, true, JSON.stringify(built.diagnostics));
  assert.equal((await (await Reveries.open(directory)).push("origin")).ok, true);
  // Local work the capability-negative push would carry if it ran.
  await writeFile(join(directory, "second.txt"), "second\n", "utf8");
  await git(directory, "add", "second.txt");
  await git(directory, "commit", "-m", "second");
  const secondCommit = await git(directory, "rev-parse", "HEAD");
  await (await Reveries.open(directory)).summarize({ commit: secondCommit, summary: summary("Record the second transition.") });
  await annotate(directory, "second.txt", "The repository recorded a second decision.", "2026-09-30T11:00:00Z");
  const rebuilt = await (await Reveries.open(directory)).buildLedgerCheckpoint({});
  assert.equal(rebuilt.ok, true, JSON.stringify(rebuilt.diagnostics));
  const before = {
    main: await bareRef(bare, "refs/heads/main"),
    notes: await bareRef(bare, NOTES_REF),
    ledger: await bareRef(bare, LEDGER_REF),
  };
  // The bare receiver withholds the `atomic` capability, so the production
  // capability probe runs unmodified against a genuinely negative server.
  await git(bare, "config", "receive.advertiseAtomic", "false");

  const error = await (await Reveries.open(directory)).push("origin").then(
    () => null,
    (failure: unknown) => failure,
  );

  assert.ok(
    error instanceof AtomicPushUnavailableError,
    `expected AtomicPushUnavailableError, got ${error}`,
  );
  assert.deepEqual(
    { main: await bareRef(bare, "refs/heads/main"), notes: await bareRef(bare, NOTES_REF), ledger: await bareRef(bare, LEDGER_REF) },
    before,
    "an unsupported atomic capability must leave every advertised remote ref byte-identical",
  );
  assert.equal(await git(directory, "rev-parse", "HEAD"), secondCommit, "local state is untouched");
});
