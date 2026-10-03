import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";

import { runCli, type CliIo } from "../src/cli.ts";
import { GitRepository, hashBlobContent, LEDGER_MANIFEST_PATH, LEDGER_NOTES_PATH, NOTES_REF } from "../src/git.ts";
import { Reveries } from "../src/operations.ts";
import {
  canonicalLedgerManifest,
  canonicalRecord,
  createLedgerManifest,
  createReverie,
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
  const directory = await mkdtemp(join(tmpdir(), "reveries-ledger-"));
  temporaryRepositories.push(directory);
  await git(directory, "init", "-b", "main");
  await git(directory, "config", "user.name", "Reveries Test");
  await git(directory, "config", "user.email", "reveries@example.com");
  await writeFile(join(directory, "state.txt"), "first\n", "utf8");
  await git(directory, "add", "state.txt");
  await git(directory, "commit", "-m", "initial");
  return directory;
}

async function appendNote(repository: GitRepository, line: string): Promise<ObjectId> {
  const blob = await repository.resolvePath({ path: "state.txt", revision: "HEAD" });
  await repository.withNotesWrite(async (transaction) => {
    await transaction.append(blob, line);
  });
  return blob;
}

/** A protocol-valid reverie line with a correct semantic ID, so `show` accepts it. */
function reverieLine(decision: string): string {
  return `${canonicalRecord(createReverie(
    {
      v: 1,
      driving_event: "The ledger envelope had no owner for the notes boundary.",
      decision,
      impact: "A normal clone receives the evidence without a custom notes-ref fetch.",
      recurrence_control: null,
      alternatives: [],
      sources: [],
      supersedes: [],
    },
    { author_email: "reveries@example.com", session: null, created_at: "2026-08-25T03:00:00Z" },
    (bytes) => hashBlobContent(bytes, "sha1"),
  ))}`;
}

/**
 * Build a checkpoint envelope by hand so a test can state any manifest it
 * likes, including one that lies about its own tree or parents. This is the
 * adversarial path: nothing here goes through the writer.
 */
async function forgeCheckpoint(
  repository: GitRepository,
  manifest: LedgerManifest,
  options: { readonly notesTree?: ObjectId; readonly parents?: readonly ObjectId[] } = {},
): Promise<ObjectId> {
  const notesTree = options.notesTree
    ?? (manifest.notes_commit === null ? await repository.emptyTreeObjectId() : await repository.treeForCommit(manifest.notes_commit));
  const manifestBlob = await repository.writeBlob(canonicalLedgerManifest(manifest));
  const tree = (await repository.run(["mktree"], {
    input: `100644 blob ${manifestBlob}\t${LEDGER_MANIFEST_PATH}\n040000 tree ${notesTree}\t${LEDGER_NOTES_PATH}\n`,
  })).stdout.trim();
  const argumentsList = ["commit-tree", tree];
  for (const parent of options.parents ?? []) argumentsList.push("-p", parent);
  argumentsList.push("-m", "Reveries ledger checkpoint");
  return (await repository.run(argumentsList)).stdout.trim() as ObjectId;
}

async function currentManifest(
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
    annotated_subjects: 1,
    records: 1,
    note_bytes: 40,
    ...overrides,
  });
}

afterEach(async () => {
  await Promise.all(temporaryRepositories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

// --- Acceptance criterion 1: a normal clone receives the ledger branch -------

test("a normal clone receives the ledger branch and its notes parent", async () => {
  const origin = await createRepository();
  const repository = await GitRepository.open(origin);
  await appendNote(repository, '{"v":1,"type":"reverie","id":"rv:one"}\n');
  const reveries = await Reveries.open(origin);
  await reveries.buildLedgerCheckpoint({ authority: null });

  const clone = await mkdtemp(join(tmpdir(), "reveries-ledger-clone-"));
  temporaryRepositories.push(clone);
  await execFileAsync("git", ["clone", "--quiet", origin, clone], { encoding: "utf8" });

  const cloned = await GitRepository.open(clone);
  const branch = await cloned.notesTip("refs/remotes/origin/reveries-ledger");
  assert.notEqual(branch, null, "the clone has no origin/reveries-ledger ref");
  assert.equal(await cloned.isLedgerCheckpoint(branch!), true);
  // The notes commit arrives through an ordinary branch fetch, with no custom
  // notes-ref fetch and no `refs/notes/reveries` in the clone.
  assert.equal(await cloned.notesTip(), null);
  const transported = await cloned.ledgerNotesLines(branch!);
  assert.equal(transported.size, 1);
  assert.deepEqual([...[...transported.values()][0]!], ['{"v":1,"type":"reverie","id":"rv:one"}']);
});

// --- Acceptance criterion 3: materialized notes work with `git notes` --------

test("notes re-materialized from the ledger parent work with git notes", async () => {
  const origin = await createRepository();
  const repository = await GitRepository.open(origin);
  const blob = await appendNote(repository, reverieLine("Transport notes in a ledger envelope."));
  const reveries = await Reveries.open(origin);
  const checkpoint = await reveries.buildLedgerCheckpoint({ authority: null });

  // A fresh clone that has the ledger but no notes ref.
  const clone = await mkdtemp(join(tmpdir(), "reveries-ledger-clone-"));
  temporaryRepositories.push(clone);
  await execFileAsync("git", ["clone", "--quiet", origin, clone], { encoding: "utf8" });
  const cloned = await GitRepository.open(clone);
  assert.equal(await cloned.notesTip(), null);

  const result = await (await Reveries.open(clone)).materializeNotesFromLedger({
    expectedNotes: null,
    revision: "refs/remotes/origin/reveries-ledger",
  });
  assert.equal(result.state, "materialized");
  assert.equal(await cloned.notesTip(), result.notesTip!);
  const original = await repository.readNote(blob);
  assert.notEqual(original, null);
  assert.deepEqual(
    (await execFileAsync("git", ["notes", `--ref=${NOTES_REF}`, "show", blob], { cwd: clone, encoding: "utf8" })).stdout.trim(),
    (original as string).trimEnd(),
  );
  assert.equal((await (await Reveries.open(clone)).show({ target: blob })).records.length, 1);
  assert.notEqual(checkpoint, null);
});

// --- Acceptance criterion 4: fast-forward and append-only -------------------

test("a second ledger checkpoint fast-forwards the branch", async () => {
  const directory = await createRepository();
  const repository = await GitRepository.open(directory);
  await appendNote(repository, '{"v":1,"type":"reverie","id":"rv:one"}\n');
  const reveries = await Reveries.open(directory);
  const first = await reveries.buildLedgerCheckpoint({ authority: null });
  const second = await reveries.buildLedgerCheckpoint({ authority: null });

  assert.notEqual(first.checkpoint, second.checkpoint);
  assert.equal(second.previousLedger, first.checkpoint!);
  assert.equal(await repository.ledgerTip(), second.checkpoint);
  assert.equal(await repository.isAncestor(first.checkpoint!, second.checkpoint!), true);
  assert.deepEqual(await reveries.verifyLedgerEnvelope(), { ok: true, diagnostics: [] });
});

test("a concurrent ledger move refuses the next checkpoint and moves no ref", async () => {
  const directory = await createRepository();
  const repository = await GitRepository.open(directory);
  await appendNote(repository, '{"v":1,"type":"reverie","id":"rv:one"}\n');
  const reveries = await Reveries.open(directory);
  await reveries.buildLedgerCheckpoint({ authority: null });

  // Someone else advanced the branch after this reader took its expectation.
  const stale = await repository.ledgerTip();
  await appendNote(repository, '{"v":1,"type":"reverie","id":"rv:two"}\n');
  const other = await reveries.buildLedgerCheckpoint({ authority: null });
  assert.notEqual(stale, other.checkpoint);

  await appendNote(repository, '{"v":1,"type":"reverie","id":"rv:three"}\n');
  const result = await reveries.buildLedgerCheckpoint({ authority: null, expectedLedger: stale });
  assert.equal(result.state, "refused");
  assert.match(result.diagnostics.join(" "), /changed concurrently/);
  assert.equal(await repository.ledgerTip(), other.checkpoint);
});

// --- Acceptance criterion 5: mismatch rejection -----------------------------

test("a commit that is not a ledger checkpoint is rejected", async () => {
  const directory = await createRepository();
  const repository = await GitRepository.open(directory);
  await repository.updateLedgerRef({ next: await repository.resolveCommit("HEAD") });
  const result = await (await Reveries.open(directory)).verifyLedgerEnvelope();
  assert.equal(result.ok, false);
  assert.match(result.diagnostics.join(" "), /checkpoint/i);
});

test("a manifest that disagrees with the grafted notes tree is rejected", async () => {
  const directory = await createRepository();
  const repository = await GitRepository.open(directory);
  await appendNote(repository, '{"v":1,"type":"reverie","id":"rv:one"}\n');
  const manifest = await currentManifest(repository);
  const other = await repository.emptyTreeObjectId();
  const checkpoint = await forgeCheckpoint(repository, manifest, { notesTree: other });
  await repository.updateLedgerRef({ next: checkpoint });

  const result = await (await Reveries.open(directory)).verifyLedgerEnvelope();
  assert.equal(result.ok, false);
  assert.match(result.diagnostics.join(" "), /notes_tree|notes subtree/);
});

test("a manifest whose notes tree names a missing object is rejected", async () => {
  const directory = await createRepository();
  const repository = await GitRepository.open(directory);
  await appendNote(repository, '{"v":1,"type":"reverie","id":"rv:one"}\n');
  const real = await currentManifest(repository);
  const lying = { ...real, notes_tree: "b".repeat(40) } as LedgerManifest;
  const checkpoint = await forgeCheckpoint(repository, lying);
  await repository.updateLedgerRef({ next: checkpoint });

  const result = await (await Reveries.open(directory)).verifyLedgerEnvelope();
  assert.equal(result.ok, false);
  assert.match(result.diagnostics.join(" "), /notes_tree|notes commit/);
});

test("a manifest whose notes commit is not a parent is rejected", async () => {
  const directory = await createRepository();
  const repository = await GitRepository.open(directory);
  await appendNote(repository, '{"v":1,"type":"reverie","id":"rv:one"}\n');
  const manifest = await currentManifest(repository);
  // Correct notes tree, but the notes commit is not among the parents.
  const checkpoint = await forgeCheckpoint(repository, manifest, { parents: [] });
  await repository.updateLedgerRef({ next: checkpoint });

  const result = await (await Reveries.open(directory)).verifyLedgerEnvelope();
  assert.equal(result.ok, false);
  assert.match(result.diagnostics.join(" "), /notes_commit|parent/);
});

test("an out-of-order parent list is rejected", async () => {
  const directory = await createRepository();
  const repository = await GitRepository.open(directory);
  await appendNote(repository, '{"v":1,"type":"reverie","id":"rv:one"}\n');
  const first = await forgeCheckpoint(repository, await currentManifest(repository));
  const secondManifest = await currentManifest(repository, { previous_ledger: first });
  // Swapped: the notes commit sits where the previous ledger must be.
  const notesCommit = secondManifest.notes_commit!;
  const swapped = await forgeCheckpoint(repository, secondManifest, { parents: [notesCommit, first] });
  await repository.updateLedgerRef({ next: swapped });

  const result = await (await Reveries.open(directory)).verifyLedgerEnvelope();
  assert.equal(result.ok, false);
  assert.match(result.diagnostics.join(" "), /previous_ledger|parent/);
});

test("a retention parent that is not a retention checkpoint is rejected", async () => {
  const directory = await createRepository();
  const repository = await GitRepository.open(directory);
  await appendNote(repository, '{"v":1,"type":"reverie","id":"rv:one"}\n');
  const manifest = await currentManifest(repository, {
    retention_commit: await repository.resolveCommit("HEAD"),
  });
  const checkpoint = await forgeCheckpoint(repository, manifest, {
    parents: [manifest.notes_commit!, manifest.retention_commit!],
  });
  await repository.updateLedgerRef({ next: checkpoint });

  const result = await (await Reveries.open(directory)).verifyLedgerEnvelope();
  assert.equal(result.ok, false);
  assert.match(result.diagnostics.join(" "), /retention_commit|retention/);
});

test("a manifest whose counts disagree with the grafted tree is reported", async () => {
  const directory = await createRepository();
  const repository = await GitRepository.open(directory);
  await appendNote(repository, '{"v":1,"type":"reverie","id":"rv:one"}\n');
  const manifest = await currentManifest(repository, { annotated_subjects: 99, records: 99, note_bytes: 99999 });
  const checkpoint = await forgeCheckpoint(repository, manifest);
  await repository.updateLedgerRef({ next: checkpoint });

  const result = await (await Reveries.open(directory)).verifyLedgerEnvelope();
  assert.equal(result.ok, false);
  assert.match(result.diagnostics.join(" "), /annotated_subjects|records|note_bytes/);
});

test("a malformed manifest body is rejected", async () => {
  const directory = await createRepository();
  const repository = await GitRepository.open(directory);
  const notesCommit = await appendNote(repository, '{"v":1,"type":"reverie","id":"rv:one"}\n').then(() => repository.notesTip());
  const notesTree = await repository.treeForCommit(notesCommit!);
  const manifest = createLedgerManifest({
    notes_commit: notesCommit,
    notes_tree: notesTree,
    previous_ledger: null,
    retention_commit: null,
    authority: null,
    annotated_subjects: 1,
    records: 1,
    note_bytes: 40,
  });
  // A manifest that parses but was not written canonically.
  const blob = await repository.writeBlob(`${JSON.stringify({ ...manifest, v: 2 })}\n`);
  const tree = (await repository.run(["mktree"], {
    input: `100644 blob ${blob}\t${LEDGER_MANIFEST_PATH}\n040000 tree ${notesTree}\t${LEDGER_NOTES_PATH}\n`,
  })).stdout.trim();
  const checkpoint = (await repository.run([
    "commit-tree", tree, "-p", notesCommit!, "-m", "Reveries ledger checkpoint",
  ])).stdout.trim() as ObjectId;
  await repository.updateLedgerRef({ next: checkpoint });

  const result = await (await Reveries.open(directory)).verifyLedgerEnvelope();
  assert.equal(result.ok, false);
  assert.match(result.diagnostics.join(" "), /manifest/);
});

test("a ledger tree carrying an unexpected entry is rejected", async () => {
  const directory = await createRepository();
  const repository = await GitRepository.open(directory);
  await appendNote(repository, '{"v":1,"type":"reverie","id":"rv:one"}\n');
  const manifest = await currentManifest(repository);
  const extra = await repository.writeBlob("surprise\n");
  const notesTree = manifest.notes_tree!;
  const review = await repository.run(["mktree"], { input: `100644 blob ${extra}\tprojection.json\n` });
  const tree = (await repository.run(["mktree"], {
    input: [
      `100644 blob ${await repository.writeBlob(canonicalLedgerManifest(manifest))}\t${LEDGER_MANIFEST_PATH}`,
      `040000 tree ${notesTree}\t${LEDGER_NOTES_PATH}`,
      `040000 tree ${review.stdout.trim()}\treview`,
      "",
    ].join("\n"),
  })).stdout.trim();
  const checkpoint = (await repository.run([
    "commit-tree", tree, "-p", manifest.notes_commit!, "-m", "Reveries ledger checkpoint",
  ])).stdout.trim() as ObjectId;
  await repository.updateLedgerRef({ next: checkpoint });

  const result = await (await Reveries.open(directory)).verifyLedgerEnvelope();
  assert.equal(result.ok, false);
  assert.match(result.diagnostics.join(" "), /review/);
});

// --- Acceptance criterion 6: V1 history imports without rewriting ------------

test("V1 notes history imports into the ledger without rewriting any note", async () => {
  const directory = await createRepository();
  const repository = await GitRepository.open(directory);
  const blob = await repository.resolvePath({ path: "state.txt", revision: "HEAD" });
  const line = '{"v":1,"type":"reverie","id":"rv:v1","driving_event":"e","decision":"d","impact":"i",'
    + '"recurrence_control":null,"alternatives":[],"sources":[],"supersedes":[],"author_email":"a@b.co",'
    + '"session":null,"created_at":"2026-08-25T03:00:00Z"}\n';
  await repository.withNotesWrite(async (transaction) => {
    await transaction.append(blob, line);
  });
  const notesTipBefore = await repository.notesTip();
  const noteBefore = await repository.readNote(blob);

  const reveries = await Reveries.open(directory);
  const { checkpoint } = await reveries.buildLedgerCheckpoint({ authority: null });

  // The envelope transports the existing notes commit unchanged.
  assert.notEqual(await repository.readLedgerManifestAt(checkpoint!), null);
  assert.equal(await repository.notesTip(), notesTipBefore, "the notes ref moved during import");
  assert.equal(await repository.readNote(blob), noteBefore, "a note was rewritten during import");
  const transported = await repository.ledgerNotesLines(checkpoint!);
  assert.deepEqual([...(transported.get(blob!) ?? [])], [line.trimEnd()]);
  assert.deepEqual(await reveries.verifyLedgerEnvelope(), { ok: true, diagnostics: [] });
});

// --- Acceptance criterion 7: no fact removal --------------------------------

test("a checkpoint that drops a canonical note line is rejected", async () => {
  const directory = await createRepository();
  const repository = await GitRepository.open(directory);
  const blob = await repository.resolvePath({ path: "state.txt", revision: "HEAD" });
  await repository.withNotesWrite(async (transaction) => {
    await transaction.append(blob, '{"v":1,"type":"reverie","id":"rv:one"}\n');
  });
  const reveries = await Reveries.open(directory);
  const first = await reveries.buildLedgerCheckpoint({ authority: null });

  // Replace the notes with a different note for the same subject: the subject
  // survives but the earlier canonical line is gone.
  await repository.withNotesWrite(async (transaction) => {
    await transaction.replace(blob, '{"v":1,"type":"reverie","id":"rv:two"}\n');
  });
  const notesCommit = await repository.notesTip();
  const dropping = createLedgerManifest({
    notes_commit: notesCommit,
    notes_tree: await repository.treeForCommit(notesCommit!),
    previous_ledger: first.checkpoint,
    retention_commit: null,
    authority: null,
    annotated_subjects: 1,
    records: 1,
    note_bytes: 40,
  });
  const forged = await forgeCheckpoint(repository, dropping);

  const result = await reveries.verifyLedgerEnvelope(forged);
  assert.equal(result.ok, false);
  assert.match(result.diagnostics.join(" "), /remov|append-only/i);

  // The writer refuses to create it in the first place.
  const refused = await reveries.buildLedgerCheckpoint({ authority: null });
  assert.equal(refused.state, "refused");
  assert.match(refused.diagnostics.join(" "), /remov|append-only/i);
  assert.equal(await repository.ledgerTip(), first.checkpoint);
});

test("an append inside one note keeps the ledger append-only", async () => {
  const directory = await createRepository();
  const repository = await GitRepository.open(directory);
  const blob = await repository.resolvePath({ path: "state.txt", revision: "HEAD" });
  await repository.withNotesWrite(async (transaction) => {
    await transaction.append(blob, '{"v":1,"type":"reverie","id":"rv:one"}\n');
  });
  const reveries = await Reveries.open(directory);
  await reveries.buildLedgerCheckpoint({ authority: null });

  await repository.withNotesWrite(async (transaction) => {
    await transaction.append(blob, '{"v":1,"type":"reverie","id":"rv:two"}\n');
  });
  const second = await reveries.buildLedgerCheckpoint({ authority: null });
  assert.equal(second.state, "created");
  assert.deepEqual(await reveries.verifyLedgerEnvelope(), { ok: true, diagnostics: [] });
});

// --- Notes-tip staleness is distinct from invalidity -------------------------

test("a ledger behind the local notes ref is stale, not invalid", async () => {
  const directory = await createRepository();
  const repository = await GitRepository.open(directory);
  await appendNote(repository, '{"v":1,"type":"reverie","id":"rv:one"}\n');
  const reveries = await Reveries.open(directory);
  await reveries.buildLedgerCheckpoint({ authority: null });

  await appendNote(repository, '{"v":1,"type":"reverie","id":"rv:two"}\n');
  const status = await reveries.ledgerStatus();
  assert.equal(status.state, "stale");
  assert.deepEqual(await reveries.verifyLedgerEnvelope(), { ok: true, diagnostics: [] });
});

// --- doctor surface ---------------------------------------------------------

test("doctor reports the ledger state without changing an adopted repository", async () => {
  const directory = await createRepository();
  const repository = await GitRepository.open(directory);
  await appendNote(repository, '{"v":1,"type":"reverie","id":"rv:one"}\n');
  const reveries = await Reveries.open(directory);

  const absent = await reveries.ledgerStatus();
  assert.equal(absent.state, "absent");
  assert.equal((await reveries.doctor()).ledger.state, "absent");

  await reveries.buildLedgerCheckpoint({ authority: null });
  const valid = await reveries.ledgerStatus();
  assert.equal(valid.state, "valid");
  assert.equal(valid.annotatedSubjects, 1);

  const doctor = await reveries.doctor();
  assert.equal(doctor.ledger?.state, "valid");
  assert.equal(doctor.ledger?.tip, await repository.ledgerTip());
  assert.ok(doctor.notices.some((notice) => notice.includes("Ledger:")));
  // A repository with no initialization boundary is "prepared", not "damaged",
  // and the ledger block must not turn that into damage.
  assert.ok(!doctor.diagnostics.some((diagnostic) => diagnostic.toLowerCase().includes("ledger")));
});

// --- The ledger is evidence, not a code branch ------------------------------

test("checkOutgoingUpdates does not demand summary coverage for the ledger branch", async () => {
  const directory = await createRepository();
  const repository = await GitRepository.open(directory);
  const reveries = await Reveries.open(directory);
  await reveries.attachAdoption({
    commit: "HEAD",
    summary: {
      v: 1,
      type: "session-summary",
      author_email: "reveries@example.com",
      session: null,
      created_at: "2026-08-25T03:00:01Z",
      entries: [{
        driving_event: "The repository adopted Reveries.",
        decision: "Record the initialization boundary on the adoption commit.",
        impact: "Every later commit needs a causal summary.",
        recurrence_control: null,
        alternatives: [],
        sources: [],
        reveries: [],
        retirements: [],
      }],
    },
    initialization: {
      v: 1,
      type: "reveries-init",
      protocol: 1,
      notes_ref: "refs/notes/reveries",
      publishing_remotes: [],
      hosts: ["opencode"],
      author_email: "reveries@example.com",
      created_at: "2026-08-25T03:00:00Z",
    },
  });
  const checkpoint = await reveries.buildLedgerCheckpoint({ authority: null });

  const ledgerOnly = await reveries.checkOutgoingUpdates("origin", [{
    localRef: "refs/heads/reveries-ledger",
    localObject: checkpoint.checkpoint!,
    remoteRef: "refs/heads/reveries-ledger",
    remoteObject: null,
  }]);
  assert.equal(
    ledgerOnly.diagnostics.some((diagnostic) => /session summary|transition/i.test(diagnostic)),
    false,
    `the ledger was treated as a code branch: ${ledgerOnly.diagnostics.join("; ")}`,
  );

  // A real code branch in the same push is still held to summary coverage, so
  // the exclusion is specific to the ledger ref.
  const withCode = await reveries.checkOutgoingUpdates("origin", [
    {
      localRef: "refs/heads/reveries-ledger",
      localObject: checkpoint.checkpoint!,
      remoteRef: "refs/heads/reveries-ledger",
      remoteObject: null,
    },
    {
      localRef: "refs/heads/main",
      localObject: await repository.resolveCommit("HEAD"),
      remoteRef: "refs/heads/main",
      remoteObject: null,
    },
  ]);
  assert.equal(withCode.ok, false);
});

// --- Publication surfaces: the CLI commands and the sync --pull path --------

function captureIo(cwd: string): { readonly io: CliIo; readonly stdout: () => string; readonly stderr: () => string } {
  let out = "";
  let error = "";
  return {
    io: {
      cwd,
      stdin: async () => "",
      stdout: (text) => { out += text; },
      stderr: (text) => { error += text; },
    },
    stdout: () => out,
    stderr: () => error,
  };
}

interface Published {
  readonly origin: string;
  /** The publisher's work tree, kept so a test can forge a replacement envelope. */
  readonly work: string;
  readonly notesCommit: ObjectId;
}

/**
 * A publisher that ships the envelope as an ordinary branch and never publishes
 * `refs/notes/reveries`. That is the case the envelope exists for: a remote
 * where the notes ref is unavailable, refused, or simply not mirrored.
 *
 * The remote must be bare. A non-bare origin exposes its own
 * `refs/notes/reveries`, so `syncPull` would deliver the evidence by the
 * ordinary route and the envelope would never be exercised.
 */
async function publishWithoutNotes(decision = "Carry the notes in the envelope."): Promise<Published> {
  const work = await createRepository();
  const repository = await GitRepository.open(work);
  await appendNote(repository, reverieLine(decision));
  const checkpoint = await (await Reveries.open(work)).buildLedgerCheckpoint({ authority: null });
  assert.notEqual(checkpoint.checkpoint, null);
  assert.notEqual(checkpoint.notesTip, null);

  const origin = await mkdtemp(join(tmpdir(), "reveries-ledger-remote-"));
  temporaryRepositories.push(origin);
  await git(origin, "init", "--bare");
  await git(work, "remote", "add", "publish", origin);
  await git(work, "push", "publish", "main");
  // Only the envelope crosses. The notes ref deliberately stays behind.
  await git(work, "push", "publish", "refs/heads/reveries-ledger:refs/heads/reveries-ledger");
  assert.equal(await git(origin, "rev-parse", "--verify", "refs/notes/reveries").then(
    () => true,
    () => false,
  ), false, "the bare remote unexpectedly publishes a notes ref");
  return { origin, work, notesCommit: checkpoint.notesTip as ObjectId };
}

/** A clone of `origin` that already has the envelope but no notes ref. */
async function cloneOf(origin: string): Promise<string> {
  const clone = await mkdtemp(join(tmpdir(), "reveries-ledger-cli-"));
  temporaryRepositories.push(clone);
  // The bare remote's HEAD may name a branch that was never pushed, so pin the
  // branch the publisher actually created or the clone has no worktree.
  await execFileAsync("git", ["clone", "--quiet", "-b", "main", origin, clone], { encoding: "utf8" });
  // A notes mutation needs a committer identity, which `git clone` does not copy.
  await git(clone, "config", "user.name", "Ledger Test");
  await git(clone, "config", "user.email", "reveries@example.com");
  return clone;
}

test("sync --pull materializes a clone's notes ref from the envelope", async () => {
  const { origin } = await publishWithoutNotes();
  const clone = await cloneOf(origin);
  const cloned = await GitRepository.open(clone);
  assert.equal(await cloned.notesTip(), null, "the clone already has a notes ref");

  const sync = captureIo(clone);
  assert.equal(await runCli(["sync", "--pull", "origin"], sync.io), 0, sync.stderr());
  assert.match(sync.stdout(), /Ledger: materialized/);

  const shown = captureIo(clone);
  assert.equal(await runCli(["show", "state.txt", "--json"], shown.io), 0);
  const payload = JSON.parse(shown.stdout()) as { result: { records: readonly unknown[] } };
  assert.equal(payload.result.records.length, 1, "the envelope did not deliver its evidence");
});

test("sync --pull leaves a local notes ref that leads the envelope alone", async () => {
  const { origin } = await publishWithoutNotes();
  const clone = await cloneOf(origin);
  const cloned = await GitRepository.open(clone);

  // Local-only evidence the envelope does not carry. Materializing would replace
  // the ref and destroy it, so the gate must refuse.
  const blob = await cloned.resolvePath({ path: "state.txt", revision: "HEAD" });
  await cloned.withNotesWrite(async (transaction) => {
    await transaction.append(blob, canonicalRecord(createReverie(
      {
        v: 1,
        driving_event: "This clone has evidence the publisher has not checkpointed.",
        decision: "Keep the local notes ref.",
        impact: "The envelope must not replace unpublished evidence.",
        recurrence_control: null,
        alternatives: [],
        sources: [],
        supersedes: [],
      },
      { author_email: "reveries@example.com", session: null, created_at: "2026-08-25T03:10:00Z" },
      (bytes) => hashBlobContent(bytes, "sha1"),
    )));
  });
  const before = await cloned.notesTip();

  const sync = captureIo(clone);
  // Approved severity split: on a sync this refusal is a notice, not a failure.
  assert.equal(await runCli(["sync", "--pull", "origin"], sync.io), 0, sync.stderr());
  assert.equal(await cloned.notesTip(), before, "the local notes ref was overwritten");

  const shown = captureIo(clone);
  assert.equal(await runCli(["show", "state.txt", "--json"], shown.io), 0, "the local evidence was lost");
  assert.equal(
    (JSON.parse(shown.stdout()) as { result: { records: readonly unknown[] } }).result.records.length,
    1,
  );
});

test("an explicit ledger materialize refuses loudly and changes nothing", async () => {
  const { origin } = await publishWithoutNotes();
  const clone = await cloneOf(origin);
  const cloned = await GitRepository.open(clone);
  const blob = await cloned.resolvePath({ path: "state.txt", revision: "HEAD" });
  await cloned.withNotesWrite(async (transaction) => {
    await transaction.append(blob, '{"v":1,"type":"reverie","id":"rv:local-only"}\n');
  });
  const before = await cloned.notesTip();

  const materialize = captureIo(clone);
  // Approved severity split: an explicit request that does not happen fails.
  assert.equal(await runCli([
    "ledger", "materialize", "refs/remotes/origin/reveries-ledger",
  ], materialize.io), 1);
  assert.match(materialize.stderr(), /carries notes the ledger envelope does not contain/);
  assert.equal(await cloned.notesTip(), before, "the local notes ref was overwritten");
});

test("sync --pull on a remote with no envelope is not an error", async () => {
  const origin = await createRepository();
  const clone = await cloneOf(origin);
  assert.equal(await GitRepository.open(clone).then((r) => r.ledgerTip()), null);

  const sync = captureIo(clone);
  assert.equal(await runCli(["sync", "--pull", "origin"], sync.io), 0, sync.stderr());
});

test("a forged envelope fails the sync and leaves the notes ref alone", async () => {
  // A bare remote that publishes only the envelope, so the envelope is the sole
  // route for the evidence and a refusal is observable as an unmoved ref.
  const { origin, work, notesCommit } = await publishWithoutNotes("Publish an envelope that lies.");
  const repository = await GitRepository.open(work);
  const empty = await repository.emptyTreeObjectId();

  // A manifest that claims an empty notes tree while naming a real notes commit.
  const manifest = createLedgerManifest({
    notes_commit: notesCommit,
    notes_tree: empty,
    previous_ledger: null,
    retention_commit: null,
    authority: null,
    annotated_subjects: 0,
    records: 0,
    note_bytes: 0,
  });
  const manifestBlob = await repository.writeBlob(canonicalLedgerManifest(manifest));
  const tree = (await repository.run(["mktree"], {
    input: `100644 blob ${manifestBlob}\t${LEDGER_MANIFEST_PATH}\n040000 tree ${empty}\t${LEDGER_NOTES_PATH}\n`,
  })).stdout.trim();
  const forged = (await repository.run([
    "commit-tree", tree, "-p", notesCommit, "-m", "Reveries ledger checkpoint",
  ])).stdout.trim();
  await git(work, "push", "--force", "publish", `${forged}:refs/heads/reveries-ledger`);

  const clone = await cloneOf(origin);
  const cloned = await GitRepository.open(clone);
  const sync = captureIo(clone);
  assert.equal(await runCli(["sync", "--pull", "origin"], sync.io), 1, "a forged envelope passed the sync");
  assert.match(sync.stderr(), /notes_tree|notes tree|subtree/i);
  assert.equal(await cloned.notesTip(), null, "a failed sync still moved the notes ref");
});
