import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";

import { runCli, type CliIo } from "../src/cli.ts";
import { GitRepository, LEDGER_REF, NOTES_REF, QUARANTINE_REF_PREFIX, hashBlobContent } from "../src/git.ts";
import { Reveries } from "../src/operations.ts";
import { canonicalRecord, createReverie, type ObjectId } from "../src/protocol.ts";

const execFileAsync = promisify(execFile);
const temporary: string[] = [];

/**
 * A published snapshot of the publisher's *first* notes commit. It is a test
 * fixture ref, not a Reveries ref: it exists so a consumer can be placed in the
 * strict-ancestor state after the publisher has already moved on.
 */
const FIRST_NOTES_REF = "refs/published/first-notes";

/**
 * Remove a temporary tree, retrying a contended directory.
 *
 * A Git subprocess can still be flushing objects when the assertion finishes, so a
 * plain recursive remove intermittently fails with ENOTEMPTY. `maxRetries` makes
 * the cleanup deterministic without hiding a real failure, because the error still
 * propagates once the retries are exhausted.
 */
async function removeTree(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => removeTree(path)));
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd, encoding: "utf8" })).stdout.trim();
}

function captureIo(cwd: string): { readonly io: CliIo; readonly stdout: () => string; readonly stderr: () => string } {
  let out = "";
  let error = "";
  return {
    io: {
      cwd,
      stdin: async () => "",
      stdout: (text) => { out += text; },
      stderr: (text) => { error += text; },
      environment: {},
    },
    stdout: () => out,
    stderr: () => error,
  };
}

function reverieLine(decision: string, createdAt: string): string {
  return canonicalRecord(createReverie(
    {
      v: 1,
      driving_event: "A remote published evidence this repository does not own.",
      decision,
      impact: "Promotion is decided by the remote's role, not by the transport that carried it.",
      recurrence_control: null,
      alternatives: [],
      sources: [],
      supersedes: [],
    },
    { author_email: "authority@example.com", session: null, created_at: createdAt },
    (bytes) => hashBlobContent(bytes, "sha1"),
  ));
}

async function annotate(directory: string, path: string, decision: string, createdAt: string): Promise<ObjectId> {
  const repository = await GitRepository.open(directory);
  const blob = await repository.resolvePath({ path, revision: "HEAD" });
  await repository.withNotesWrite(async (notes) => {
    await notes.append(blob, reverieLine(decision, createdAt));
  });
  return blob;
}

interface Publisher {
  readonly source: string;
  readonly bare: string;
  /**
   * The publisher's notes commit from the *first* revision. A consumer that holds
   * exactly this is a strict ancestor of the published envelope's notes commit,
   * which is the one state in which the envelope route would otherwise
   * fast-forward the canonical ref.
   */
  readonly firstNotes: ObjectId;
}

/**
 * A publisher that carries BOTH evidence routes: `refs/notes/reveries` and a
 * `refs/heads/reveries-ledger` envelope over the same notes tip. A remote in this
 * shape is the only case where the two routes can disagree, which is exactly the
 * case the envelope guard has to cover.
 *
 * The envelope is built unsigned on purpose: the guard is about promotion
 * authority, not about trust, and an unsigned checkpoint is a normal state.
 */
async function publisherWithEnvelope(prefix: string): Promise<Publisher> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(root);
  const source = join(root, "source");
  const bare = join(root, "remote.git");
  await mkdir(source);
  await execFileAsync("git", ["init", "--bare", bare]);
  await git(source, "init", "-b", "main");
  await git(source, "config", "user.name", "Publisher");
  await git(source, "config", "user.email", "publisher@example.com");
  await git(source, "remote", "add", "origin", bare);
  await writeFile(join(source, "state.txt"), "first\n", "utf8");
  await git(source, "add", "state.txt");
  await git(source, "commit", "-m", "first");
  await annotate(source, "state.txt", "The publisher recorded the first decision.", "2026-09-30T10:00:00Z");
  const firstNotes = (await git(source, "rev-parse", NOTES_REF)) as ObjectId;
  await git(source, "push", "origin", "main", `${NOTES_REF}:${NOTES_REF}`);
  // The first notes commit has to stay reachable after the second revision
  // supersedes the ref, otherwise a consumer could never be put in the
  // strict-ancestor state the envelope route would fast-forward from.
  await git(source, "update-ref", FIRST_NOTES_REF, firstNotes);
  await git(source, "push", "origin", `${FIRST_NOTES_REF}:${FIRST_NOTES_REF}`);

  // A second revision so the published envelope leads whatever the consumer has.
  await writeFile(join(source, "state.txt"), "second\n", "utf8");
  await git(source, "add", "state.txt");
  await git(source, "commit", "-m", "second");
  await annotate(source, "state.txt", "The publisher recorded the second decision.", "2026-09-30T11:00:00Z");
  const built = await (await Reveries.open(source)).buildLedgerCheckpoint({});
  assert.equal(built.ok, true, JSON.stringify(built.diagnostics));
  await git(source, "push", "origin", "main", `${NOTES_REF}:${NOTES_REF}`, `${LEDGER_REF}:${LEDGER_REF}`);
  return { source, bare, firstNotes };
}

interface Consumer {
  readonly directory: string;
  /** Local notes tip before the sync, or null when the consumer has none. */
  readonly notesBefore: ObjectId | null;
}

/**
 * A clone of the published remote with `remote` declared under `role`.
 *
 * `withLocalNotes` decides the gate the envelope route would see: with no local
 * notes ref the gate is "absent", and with the publisher's first notes commit
 * fetched the gate is "a strict ancestor of the envelope", which is the only state
 * in which materialization would actually move the ref.
 */
async function consumer(
  bare: string,
  remote: string,
  role: string,
  options: { readonly withLocalNotes: boolean; readonly firstNotes?: ObjectId },
): Promise<Consumer> {
  const root = await mkdtemp(join(tmpdir(), "reveries-envelope-guard-consumer-"));
  temporary.push(root);
  const directory = join(root, "consumer");
  await execFileAsync("git", ["clone", "--quiet", bare, directory]);
  await git(directory, "config", "user.name", "Consumer");
  await git(directory, "config", "user.email", "consumer@example.com");
  if (options.withLocalNotes) {
    assert.ok(options.firstNotes !== undefined, "withLocalNotes needs the first notes commit");
    await git(directory, "fetch", "--quiet", "origin", `+${FIRST_NOTES_REF}:${NOTES_REF}`);
    const local = (await git(directory, "rev-parse", NOTES_REF)) as ObjectId;
    assert.equal(local, options.firstNotes, "the clone must hold the publisher's first notes commit");
  }
  await git(directory, "remote", "add", remote, bare);
  await git(directory, "config", "--add", "reveries.publishingRemote", remote);
  await git(directory, "config", `reveries.remoteRole.${remote}`, role);
  return {
    directory,
    notesBefore: options.withLocalNotes ? options.firstNotes as ObjectId : null,
  };
}

async function notesTip(directory: string): Promise<ObjectId | null> {
  const repository = await GitRepository.open(directory);
  return repository.notesTip();
}

async function pull(directory: string, remote: string): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  const io = captureIo(directory);
  const code = await runCli(["sync", remote, "--pull", "--json"], io.io);
  return { code, stdout: io.stdout(), stderr: io.stderr() };
}

function parseEnvelope(stdout: string): {
  readonly ok: boolean;
  readonly result: { readonly quarantineRef?: string | null; readonly ledger?: { readonly state: string; readonly reason?: string } };
  readonly notices: readonly string[];
  readonly diagnostics: readonly string[];
} {
  return JSON.parse(stdout) as ReturnType<typeof parseEnvelope>;
}

/**
 * The envelope is a second, independent route to the same evidence. If the notes
 * route withheld promotion, the envelope route must withhold it too, otherwise an
 * `import-only` or `mirror` remote reaches `refs/notes/reveries` through the
 * transport that happens to be checked second. These tests pin that for both
 * non-primary roles and for both gate states an envelope materialization would
 * otherwise satisfy: an absent local notes ref, and a local tip that is a strict
 * ancestor of the envelope's notes commit.
 */

for (const role of ["import-only", "mirror"]) {
  test(`a ${role} remote with a ledger envelope cannot reach an absent notes ref`, async () => {
    const published = await publisherWithEnvelope(`reveries-envelope-absent-${role}-`);
    const client = await consumer(published.bare, "vendor", role, { withLocalNotes: false });
    assert.equal(await notesTip(client.directory), null, "the precondition is a clone with no notes ref");

    const result = await pull(client.directory, "vendor");

    assert.equal(result.code, 0, result.stderr);
    const envelope = parseEnvelope(result.stdout);
    assert.equal(envelope.ok, true, "held valid evidence is a success, not a failure");
    assert.match(String(envelope.result.quarantineRef), new RegExp(`^${QUARANTINE_REF_PREFIX}vendor/`));
    assert.equal(envelope.result.ledger?.state, "skipped");
    assert.equal(await notesTip(client.directory), null, "the envelope route must not create the canonical notes ref");
    // The held candidate really is preserved, so nothing is lost.
    const held = await (await GitRepository.open(client.directory)).notesTip(envelope.result.quarantineRef as string);
    assert.notEqual(held, null, "the validated candidate must remain inspectable");
  });

  test(`a ${role} remote with a ledger envelope cannot advance an ancestor notes ref`, async () => {
    const published = await publisherWithEnvelope(`reveries-envelope-ancestor-${role}-`);
    const client = await consumer(published.bare, "vendor", role, {
      withLocalNotes: true,
      firstNotes: published.firstNotes,
    });
    const before = await notesTip(client.directory);
    assert.notEqual(before, null, "the precondition is a local notes tip");

    const result = await pull(client.directory, "vendor");

    assert.equal(result.code, 0, result.stderr);
    const envelope = parseEnvelope(result.stdout);
    assert.equal(envelope.ok, true, "held valid evidence is a success, not a failure");
    assert.notEqual(envelope.result.quarantineRef, null);
    assert.equal(
      await notesTip(client.directory),
      before,
      "a local tip that the envelope would have fast-forwarded must be left exactly as it was",
    );
  });
}

test("an archive is refused as a source and its envelope is not materialized either", async () => {
  const published = await publisherWithEnvelope("reveries-envelope-archive-");
  const client = await consumer(published.bare, "vault", "archive", { withLocalNotes: true, firstNotes: published.firstNotes });
  const before = await notesTip(client.directory);

  const result = await pull(client.directory, "vault");

  assert.equal(result.code, 1, "a refused sync is a failure");
  const envelope = parseEnvelope(result.stdout);
  assert.equal(envelope.ok, false);
  assert.match(envelope.diagnostics.join(" "), /not a source of Reveries evidence/);
  assert.equal(
    await notesTip(client.directory),
    before,
    "a role refusal on the notes route must not fall through into envelope promotion",
  );
});

test("a malformed role value fails closed without materializing an envelope", async () => {
  const published = await publisherWithEnvelope("reveries-envelope-bad-role-");
  const client = await consumer(published.bare, "vendor", "import-only", { withLocalNotes: true, firstNotes: published.firstNotes });
  // Replace the valid role with a value outside the closed vocabulary.
  await git(client.directory, "config", "reveries.remoteRole.vendor", "not-a-role");
  const before = await notesTip(client.directory);

  const result = await pull(client.directory, "vendor");

  // `resolveAuthorityRoles` throws on an unknown role, so the sync cannot be
  // evaluated safely. Exit 2 is "could not evaluate safely" and never falls
  // through to the envelope route, which would otherwise promote anyway.
  assert.equal(result.code, 2, result.stderr);
  assert.match(result.stdout, /must name a role from/);
  assert.equal(await notesTip(client.directory), before);
});

test("a quarantined sync reports ok true with a notice rather than a diagnostic", async () => {
  const published = await publisherWithEnvelope("reveries-envelope-notice-");
  const client = await consumer(published.bare, "vendor", "import-only", { withLocalNotes: false });

  const result = await pull(client.directory, "vendor");

  const envelope = parseEnvelope(result.stdout);
  assert.equal(envelope.ok, true, "a held, validated union is not a failure");
  assert.deepEqual(envelope.diagnostics, [], "held evidence must not be reported as a diagnostic");
  assert.equal(envelope.notices.length > 0, true, "the quarantine must still be reported");
  assert.match(envelope.notices.join(" "), new RegExp(QUARANTINE_REF_PREFIX));
  assert.match(envelope.notices.join(" "), /envelope/i);
});

test("a primary sync still materializes and promotes as before", async () => {
  const published = await publisherWithEnvelope("reveries-envelope-primary-");
  const client = await consumer(published.bare, "vendor", "primary", { withLocalNotes: true, firstNotes: published.firstNotes });

  const result = await pull(client.directory, "vendor");

  assert.equal(result.code, 0, result.stderr);
  const envelope = parseEnvelope(result.stdout);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.result.quarantineRef, null, "a primary promotes, so nothing is held");
  assert.notEqual(await notesTip(client.directory), null, "the primary's evidence reaches canonical state");
});

test("the human sync line names the quarantine ref and the skipped envelope", async () => {
  const published = await publisherWithEnvelope("reveries-envelope-human-");
  const client = await consumer(published.bare, "vendor", "import-only", { withLocalNotes: false });
  const io = captureIo(client.directory);

  const code = await runCli(["sync", "vendor", "--pull"], io.io);

  assert.equal(code, 0, io.stderr());
  const out = io.stdout();
  assert.match(out, /quarantined at refs\/reveries\/quarantine\/vendor\//);
  assert.match(out, new RegExp(`${NOTES_REF} is unchanged`));
  assert.match(out, /envelope/i);
});
