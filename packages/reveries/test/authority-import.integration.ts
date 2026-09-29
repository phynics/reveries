import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";

import { GitRepository, hashBlobContent, NOTES_REF, QUARANTINE_REF_PREFIX } from "../src/git.ts";
import { Reveries } from "../src/operations.ts";
import { canonicalRecord, createReverie, type ObjectId } from "../src/protocol.ts";

const execFileAsync = promisify(execFile);
const temporary: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd, encoding: "utf8" })).stdout.trim();
}

function reverieLine(decision: string): string {
  return canonicalRecord(createReverie(
    {
      v: 1,
      driving_event: "Several publishing remotes could all be merged into canonical state.",
      decision,
      impact: "Only the primary promotes; everything else is validated and quarantined.",
      recurrence_control: null,
      alternatives: [],
      sources: [],
      supersedes: [],
    },
    { author_email: "authority@example.com", session: null, created_at: "2026-09-29T12:00:00Z" },
    (bytes) => hashBlobContent(bytes, "sha1"),
  ));
}

interface Root {
  readonly source: string;
  readonly bare: string;
}

/** A publisher with a bare `origin` carrying one annotated decision. */
async function publisher(prefix: string): Promise<Root> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(root);
  const source = join(root, "source");
  const bare = join(root, "remote.git");
  await execFileAsync("mkdir", [source]);
  await execFileAsync("git", ["init", "--bare", bare]);
  await git(source, "init", "-b", "main");
  await git(source, "config", "user.name", "Authority Test");
  await git(source, "config", "user.email", "authority@example.com");
  await git(source, "remote", "add", "origin", bare);
  await writeFile(join(source, "state.txt"), "first\n", "utf8");
  await git(source, "add", "state.txt");
  await git(source, "commit", "-m", "initial");
  return { source, bare };
}

async function annotate(source: string, decision: string): Promise<void> {
  const repository = await GitRepository.open(source);
  const blob = await repository.resolvePath({ path: "state.txt", revision: "HEAD" });
  await repository.withNotesWrite(async (notes) => {
    await notes.append(blob, reverieLine(decision));
  });
}

/**
 * A consumer with the given remote roles. Each named remote is a real bare
 * repository, so a sync actually fetches over a refspec rather than resolving a
 * path that does not exist.
 */
async function consumer(
  prefix: string,
  remotes: readonly string[],
  roles: Readonly<Record<string, string>>,
  sources: Readonly<Record<string, string>> = {},
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(root);
  const directory = join(root, "consumer");
  await execFileAsync("mkdir", [directory]);
  await git(directory, "init", "-b", "main");
  await git(directory, "config", "user.name", "Consumer");
  await git(directory, "config", "user.email", "consumer@example.com");
  // A record may only be attached to an object this repository holds, and the
  // remote annotated the same `state.txt` blob. Committing the identical file
  // gives the consumer that object, so the failure under test is the promotion
  // decision rather than a missing blob.
  await writeFile(join(directory, "state.txt"), "first\n", "utf8");
  await git(directory, "add", "state.txt");
  await git(directory, "commit", "-m", "initial");
  for (const remote of remotes) {
    const url = sources[remote] ?? join(root, `${remote}.git`);
    await execFileAsync("git", ["init", "--bare", url]);
    await git(directory, "remote", "add", remote, url);
  }
  for (const remote of remotes) {
    await git(directory, "config", "--add", "reveries.publishingRemote", remote);
  }
  for (const [remote, role] of Object.entries(roles)) {
    await git(directory, "config", `reveries.remoteRole.${remote}`, role);
  }
  return directory;
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/**
 * The import-quarantine guarantee is a property of the sync path, not a
 * convention: a non-primary remote runs the identical full-snapshot validation
 * and then has promotion withheld, so its evidence is preserved and inspectable
 * while `refs/notes/reveries` is left byte-for-byte unchanged. These tests pin
 * both halves, because a bug in either would let import evidence reach canonical
 * state without anything looking wrong.
 */

test("an import-only sync quarantines the candidate and leaves the notes ref untouched", async () => {
  const { source } = await publisher("reveries-import-publisher-");
  await annotate(source, "The import-only remote published this decision.");
  await git(source, "push", "origin", `${NOTES_REF}:${NOTES_REF}`);

  const consumerDirectory = await consumer(
    "reveries-import-consumer-",
    ["vendor"],
    { vendor: "import-only" },
    { vendor: source },
  );
  const before = await (await Reveries.open(consumerDirectory)).repository.notesTip();
  const result = await (await Reveries.open(consumerDirectory)).syncPull("vendor");

  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(result.state, "fetched");
  assert.match(String(result.quarantineRef), new RegExp(`^${QUARANTINE_REF_PREFIX}vendor/`));
  // The candidate is held, not lost, and not canonical.
  assert.equal(await (await Reveries.open(consumerDirectory)).repository.notesTip(), before);
  assert.equal(before, null);
  // The validated candidate is preserved rather than discarded.
  const verifier = await Reveries.open(consumerDirectory);
  const resolved = await verifier.repository.notesTip(result.quarantineRef as string);
  assert.notEqual(resolved, null, "the validated candidate must be preserved");
  const held = resolved as ObjectId;
  // The evidence really is present in the quarantined candidate, so an operator
  // can inspect it without it having entered canonical state.
  const blob = await verifier.repository.resolvePath({ path: "state.txt", revision: "HEAD" });
  // `readNoteAt`, not `readNoteFromRef`: `git notes --ref=` only resolves refs
  // under `refs/notes/`, and the quarantine ref is not there. The bytes are
  // present and readable as objects; the RVR-001 namespace simply is not a notes
  // ref as far as Git is concerned. See the reported gap.
  const body = await verifier.repository.readNoteAt(held, blob);
  assert.match(body ?? "", /import-only remote published this decision/);
});

test("a mirror sync quarantines rather than promoting", async () => {
  const { source } = await publisher("reveries-mirror-sync-publisher-");
  await annotate(source, "The mirror published this decision.");
  await git(source, "push", "origin", `${NOTES_REF}:${NOTES_REF}`);

  const consumerDirectory = await consumer(
    "reveries-mirror-sync-consumer-",
    ["origin", "backup"],
    { origin: "primary", backup: "mirror" },
    { backup: source },
  );
  const reveries = await Reveries.open(consumerDirectory);
  const result = await reveries.syncPull("backup");

  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.match(String(result.quarantineRef), new RegExp(`^${QUARANTINE_REF_PREFIX}backup/`));
  assert.equal(await reveries.repository.notesTip(), null);
  // The report says what happened and why, so a quarantine is never a silent
  // no-op that an operator learns about from a missing decision.
  assert.match(result.diagnostics.join(" "), /quarantined/);
  assert.match(result.diagnostics.join(" "), /mirror/);
});

test("a primary sync still promotes into canonical state", async () => {
  const { source } = await publisher("reveries-primary-sync-publisher-");
  await annotate(source, "The primary published this decision.");
  await git(source, "push", "origin", `${NOTES_REF}:${NOTES_REF}`);

  const consumerDirectory = await consumer(
    "reveries-primary-sync-consumer-",
    ["origin"],
    { origin: "primary" },
    { origin: source },
  );
  const reveries = await Reveries.open(consumerDirectory);
  const result = await reveries.syncPull("origin");

  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(result.quarantineRef, null);
  assert.notEqual(await reveries.repository.notesTip(), null);
});

test("a remote with no declared role still promotes, so a V1 repository is unaffected", async () => {
  const { source } = await publisher("reveries-unset-role-publisher-");
  await annotate(source, "The unconfigured remote published this decision.");
  await git(source, "push", "origin", `${NOTES_REF}:${NOTES_REF}`);

  const consumerDirectory = await consumer(
    "reveries-unset-role-consumer-",
    ["origin"],
    {},
    { origin: source },
  );
  const reveries = await Reveries.open(consumerDirectory);
  const result = await reveries.syncPull("origin");

  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(result.quarantineRef, null);
  assert.notEqual(await reveries.repository.notesTip(), null);
});

test("an archive is refused as a synchronization source without fetching", async () => {
  const { source } = await publisher("reveries-archive-publisher-");
  await annotate(source, "The archive holds this decision.");
  await git(source, "push", "origin", `${NOTES_REF}:${NOTES_REF}`);

  const consumerDirectory = await consumer(
    "reveries-archive-consumer-",
    ["origin", "vault"],
    { origin: "primary", vault: "archive" },
    { vault: source },
  );
  const reveries = await Reveries.open(consumerDirectory);
  const result = await reveries.syncPull("vault");

  assert.equal(result.ok, false);
  assert.match(result.diagnostics.join(" "), /archive/);
  assert.equal(result.diagnostics.join(" ").includes("not a source"), true);
  assert.equal(await reveries.repository.notesTip(), null);
  // Nothing was fetched, so the archive's evidence never entered this repository.
  assert.equal(await reveries.repository.notesTip("refs/notes/remotes/vault/reveries"), null);
});

test("an import-only remote is refused as a publication destination", async () => {
  const { source } = await publisher("reveries-import-push-publisher-");
  await annotate(source, "A decision that must not be pushed into someone else's history.");
  const consumerDirectory = await consumer(
    "reveries-import-push-consumer-",
    ["vendor"],
    { vendor: "import-only" },
    { vendor: source },
  );
  const reveries = await Reveries.open(consumerDirectory);
  // The role refusal is asserted next to the initialization-boundary refusal
  // that every unadopted repository gets, so this pins the role diagnostic
  // without depending on a full initialization fixture.
  const result = await reveries.checkOutgoingUpdates("vendor", []);
  assert.equal(result.ok, false);
  const message = result.diagnostics.join(" ");
  assert.match(message, /vendor/);
  assert.match(message, /import-only/);
  assert.match(message, /not a publication destination/);
});

test("the role refusal is independent of the initialization boundary", async () => {
  // `checkOutgoingUpdates` returns early on a missing initialization, so the
  // role check is pinned here at the operation it guards: `push` reaches the
  // same refusal once a repository is adopted, and this proves the diagnostic
  // text the operator sees is the role one rather than an adoption complaint.
  const { source } = await publisher("reveries-import-push-independent-");
  await annotate(source, "A decision that must not be pushed into someone else's history.");
  const consumerDirectory = await consumer(
    "reveries-import-push-independent-consumer-",
    ["vendor"],
    { vendor: "import-only" },
    { vendor: source },
  );
  const reveries = await Reveries.open(consumerDirectory);
  const status = await reveries.authorityStatus();
  assert.equal(status.roles.get("vendor"), "import-only");
  const unadopted = await reveries.checkOutgoingUpdates("vendor", []);
  // The role refusal leads even though the boundary is missing, so the operator
  // sees the configuration problem that will persist after adoption.
  assert.match(unadopted.diagnostics.join(" "), /not a publication destination/);
  assert.match(unadopted.diagnostics.join(" "), /initialization boundary is missing/);
});

test("a mirror and an archive remain valid publication destinations", async () => {
  const consumerDirectory = await consumer("reveries-mirror-push-consumer-", ["alpha", "backup", "vault"], {
    alpha: "primary",
    backup: "mirror",
    vault: "archive",
  });
  const reveries = await Reveries.open(consumerDirectory);
  for (const remote of ["backup", "vault"]) {
    // These checks are the only ones asserted here: the remote-refspec and
    // initialization checks would otherwise add unrelated diagnostics.
    const result = await reveries.checkOutgoingUpdates(remote, []);
    assert.doesNotMatch(result.diagnostics.join(" "), /publication destination/);
  }
});
