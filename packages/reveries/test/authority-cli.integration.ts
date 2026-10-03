import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";

import { runCli, type CliIo } from "../src/cli.ts";
import { GitRepository, LEDGER_REF, NOTES_REF, generateEd25519KeyPair, hashBlobContent } from "../src/git.ts";
import { initializeRepository, readLocalTrustStore, repairLocalIntegration } from "../src/install.ts";
import { Reveries } from "../src/operations.ts";
import { canonicalRecord, createReverie, readLedgerManifest, type ObjectId, type ReveriesInit, type SessionSummary } from "../src/protocol.ts";

const execFileAsync = promisify(execFile);
const temporary: string[] = [];

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

/** A `git` read whose answer may legitimately be "not set". */
async function gitMaybe(cwd: string, ...args: string[]): Promise<string> {
  try {
    return await git(cwd, ...args);
  } catch {
    return "";
  }
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

const INIT_RECORD: ReveriesInit = {
  v: 1,
  type: "reveries-init",
  protocol: 1,
  notes_ref: "refs/notes/reveries",
  publishing_remotes: ["origin"],
  hosts: ["codex"],
  author_email: "authority@example.com",
  created_at: "2026-09-30T09:00:00Z",
};

const ADOPTION: SessionSummary = {
  v: 1,
  type: "session-summary",
  author_email: "authority@example.com",
  session: "codex:test",
  created_at: "2026-09-30T09:00:00Z",
  entries: [{
    driving_event: "The repository adopted durable engineering memory.",
    decision: "Initialize Reveries so authority has a boundary to resolve against.",
    impact: "Remote roles and a signed ledger both have something to describe.",
    recurrence_control: "The authority tests assert the resolved primary, not a configured string.",
    alternatives: [],
    sources: [],
    reveries: [],
    retirements: [],
  }],
};

interface Fixture {
  readonly root: string;
  readonly directory: string;
  readonly outside: string;
}

/** An adopted repository with a real `origin`, `backup`, and `vault` remote. */
async function adopted(
  prefix: string,
  remotes: readonly string[] = ["origin", "backup", "vault"],
  publishing: readonly string[] = ["origin"],
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(root);
  const directory = join(root, "repo");
  const outside = join(root, "keys");
  await mkdir(directory);
  await mkdir(outside);
  await git(directory, "init", "-b", "main");
  await git(directory, "config", "user.name", "Authority Test");
  await git(directory, "config", "user.email", "authority@example.com");
  await writeFile(join(directory, "state.txt"), "first\n", "utf8");
  await git(directory, "add", "state.txt");
  await git(directory, "commit", "-m", "initial");
  for (const remote of remotes) {
    const bare = join(root, `${remote}.git`);
    await execFileAsync("git", ["init", "--bare", bare]);
    if (remote.includes("/")) {
      // Newer Git rejects nested names through `remote add`. Configure the
      // remote subsection directly so tests retain their overlap coverage.
      await git(directory, "config", `remote.${remote}.url`, bare);
      await git(directory, "config", `remote.${remote}.fetch`, `+refs/heads/*:refs/remotes/${remote}/*`);
    } else {
      await git(directory, "remote", "add", remote, bare);
    }
  }
  const reveries = await Reveries.open(directory);
  const commit = await git(directory, "rev-parse", "HEAD");
  await reveries.summarize({ commit, summary: ADOPTION });
  // The committed record, not local configuration, is which remotes publish. Two
  // of them with no declared role is `unconfigured`; one is `inferred`.
  await reveries.attachInitialization({ commit, record: { ...INIT_RECORD, publishing_remotes: [...publishing] } });
  const draft = join(root, "reverie.json");
  await writeFile(draft, JSON.stringify({
    driving_event: "The manifest's authority field had no defined meaning.",
    decision: "Resolve the primary from declared remote roles and stamp it.",
    impact: "A reader can tell which remote a checkpoint speaks for.",
    recurrence_control: "The build tests assert the manifest's authority value.",
  }), "utf8");
  const record = captureIo(directory);
  assert.equal(await runCli(["record", "new", "state.txt", "--committed", "--from", draft, "--json"], record.io), 0);
  return { root, directory, outside };
}

async function withSigningKey(fixture: Fixture, signer: string): Promise<{ readonly keyId: string; readonly keyPath: string }> {
  const keyPath = join(fixture.outside, "signing.pem");
  const io = captureIo(fixture.directory);
  assert.equal(await runCli(["trust", "init", "--signer", signer, "--key-file", keyPath, "--json"], io.io), 0, io.stderr());
  const keyId = (JSON.parse(io.stdout()) as { result: { key_id: string } }).result.key_id;
  await git(fixture.directory, "config", "reveries.signingKey", keyPath);
  return { keyId, keyPath };
}

async function build(fixture: Fixture, args: readonly string[]): Promise<{ readonly code: number; readonly out: string; readonly err: string }> {
  const io = captureIo(fixture.directory);
  const code = await runCli(["ledger", "build", ...args, "--json"], io.io);
  return { code, out: io.stdout(), err: io.stderr() };
}

async function manifestOf(directory: string, checkpoint: string): Promise<Record<string, unknown> | null> {
  const repository = await GitRepository.open(directory);
  const stored = await repository.readLedgerManifestAt(checkpoint as ObjectId);
  return stored === null ? null : readLedgerManifest(stored) as unknown as Record<string, unknown>;
}

// Remote roles
// -------------------------------------------------------------------------------

test("role set writes the role and role show reports the resolved authority", async () => {
  const fixture = await adopted("role-set-");

  const set = captureIo(fixture.directory);
  assert.equal(await runCli(["role", "set", "origin", "primary", "--json"], set.io), 0, set.stderr());
  const stored = await git(fixture.directory, "config", "--get", "reveries.remoteRole.origin");
  assert.equal(stored, "primary", "the declaration is real configuration, not a display string");

  const show = captureIo(fixture.directory);
  assert.equal(await runCli(["role", "show", "--json"], show.io), 0, show.stderr());
  const parsed = JSON.parse(show.stdout()) as { result: { state: string; primary: string; roles: Record<string, string> } };
  assert.equal(parsed.result.state, "configured");
  assert.equal(parsed.result.primary, "origin");
  assert.equal(parsed.result.roles.origin, "primary");
});

test("role set refuses an unknown role and names the valid set", async () => {
  const fixture = await adopted("role-unknown-");
  const io = captureIo(fixture.directory);

  assert.equal(await runCli(["role", "set", "origin", "boss"], io.io), 3);

  assert.match(io.stderr(), /must name a role from primary, mirror, archive, import-only/);
  assert.match(io.stderr(), /found boss/);
});

test("role set refuses a second primary instead of writing a contradiction", async () => {
  const fixture = await adopted("role-two-primaries-");
  const first = captureIo(fixture.directory);
  assert.equal(await runCli(["role", "set", "origin", "primary"], first.io), 0, first.stderr());

  const second = captureIo(fixture.directory);
  assert.equal(await runCli(["role", "set", "backup", "primary"], second.io), 3);

  assert.match(second.stderr(), /exactly one primary/);
  const state = await (await Reveries.open(fixture.directory)).authorityStatus();
  assert.equal(state.state, "configured", "the refused write left the configuration valid");
  assert.equal(state.primary, "origin");
});

test("role set refuses a remote that does not exist", async () => {
  const fixture = await adopted("role-dangling-", ["origin"]);
  const io = captureIo(fixture.directory);

  assert.equal(await runCli(["role", "set", "nowhere", "mirror"], io.io), 3);

  assert.match(io.stderr(), /does not exist in this repository/);
});

test("a role declared for a remote that later disappears is invalid and doctor says so", async () => {
  const fixture = await adopted("role-vanished-", ["origin", "backup"]);
  const set = captureIo(fixture.directory);
  assert.equal(await runCli(["role", "set", "backup", "mirror"], set.io), 0, set.stderr());
  await git(fixture.directory, "remote", "remove", "backup");

  const state = await (await Reveries.open(fixture.directory)).authorityStatus();
  assert.equal(state.state, "invalid");
  assert.match(state.diagnostics.join(" "), /remote that does not exist/);

  const doctor = captureIo(fixture.directory);
  await runCli(["doctor", "--json"], doctor.io);
  const reported = JSON.parse(doctor.stdout()) as { result: { state: string }; diagnostics: readonly string[] };
  assert.equal(reported.result.state, "damaged");
  assert.match(reported.diagnostics.join(" "), /names a role for a remote that does not exist/);
});

test("role clear restores the inferred primary of a single publishing remote", async () => {
  const fixture = await adopted("role-clear-");
  const set = captureIo(fixture.directory);
  assert.equal(await runCli(["role", "set", "origin", "primary"], set.io), 0, set.stderr());

  const clear = captureIo(fixture.directory);
  assert.equal(await runCli(["role", "clear", "origin", "--json"], clear.io), 0, clear.stderr());

  const parsed = JSON.parse(clear.stdout()) as { result: { state: string; primary: string } };
  assert.equal(parsed.result.state, "inferred", "one publisher with no declared role is ordinary");
  assert.equal(parsed.result.primary, "origin");
  assert.equal(await gitMaybe(fixture.directory, "config", "--get", "reveries.remoteRole.origin"), "");
});

test("several publishing remotes with no declared role are unconfigured, not damaged", async () => {
  const fixture = await adopted("role-unconfigured-", ["origin", "backup"], ["origin", "backup"]);

  const show = captureIo(fixture.directory);
  assert.equal(await runCli(["role", "show", "--json"], show.io), 0, show.stderr());

  const parsed = JSON.parse(show.stdout()) as { result: { state: string; primary: null; diagnostics: readonly string[] } };
  assert.equal(parsed.result.state, "unconfigured", "two publishers and no declaration has no principled answer");
  assert.equal(parsed.result.primary, null);
  assert.deepEqual(parsed.result.diagnostics, [], "an ordinary state contributes no diagnostics");

  // Declaring one resolves it, and clearing it returns to the same honest state.
  const set = captureIo(fixture.directory);
  assert.equal(await runCli(["role", "set", "backup", "primary"], set.io), 0, set.stderr());
  const resolved = captureIo(fixture.directory);
  assert.equal(await runCli(["role", "show", "--json"], resolved.io), 0, resolved.stderr());
  assert.equal((JSON.parse(resolved.stdout()) as { result: { state: string; primary: string } }).result.primary, "backup");
});

// Signing policy
// -------------------------------------------------------------------------------

test("policy set and clear drive the roles a signature must satisfy", async () => {
  const fixture = await adopted("policy-set-");

  const set = captureIo(fixture.directory);
  assert.equal(await runCli(["policy", "set", "author, reviewer", "--json"], set.io), 0, set.stderr());
  assert.equal(await git(fixture.directory, "config", "--get", "reveries.signingRoles"), "author,reviewer");
  assert.equal(
    (await (await Reveries.open(fixture.directory)).signingPolicy()).requiredRoles.join(","),
    "author,reviewer",
  );

  const clear = captureIo(fixture.directory);
  assert.equal(await runCli(["policy", "clear"], clear.io), 0, clear.stderr());
  assert.deepEqual([...(await (await Reveries.open(fixture.directory)).signingPolicy()).requiredRoles], []);
});

test("policy set refuses an unknown role and names the valid set", async () => {
  const fixture = await adopted("policy-unknown-");
  const io = captureIo(fixture.directory);

  assert.equal(await runCli(["policy", "set", "author,auditor"], io.io), 3);

  assert.match(io.stderr(), /must name roles from author, reviewer, publisher/);
  assert.match(io.stderr(), /found auditor/);
});

// Ledger build authority
// -------------------------------------------------------------------------------

test("ledger build stamps the resolved primary and leaves the manifest key set unchanged", async () => {
  const fixture = await adopted("build-authority-");
  const set = captureIo(fixture.directory);
  assert.equal(await runCli(["role", "set", "origin", "primary"], set.io), 0, set.stderr());

  const built = await build(fixture, []);

  assert.equal(built.code, 0, built.err);
  const parsed = JSON.parse(built.out) as { result: { checkpoint: string; authority: string; authorityState: string } };
  assert.equal(parsed.result.authority, "origin");
  assert.equal(parsed.result.authorityState, "configured");
  const manifest = await manifestOf(fixture.directory, parsed.result.checkpoint);
  assert.equal(manifest?.authority, "origin", "the manifest names the remote it is published for");
  // The field already existed; only its value moved. Adding a key would change
  // the bytes RVR-009 signs, which this asserts against.
  // The exact key set the manifest schema declares. Only `authority`'s value
  // moved; adding or renaming a key would change the bytes a signature covers.
  assert.deepEqual(Object.keys(manifest ?? {}).sort(), [
    "annotated_subjects",
    "authority",
    "ledger_ref",
    "note_bytes",
    "notes_commit",
    "notes_ref",
    "notes_tree",
    "previous_ledger",
    "protocol",
    "records",
    "retention_commit",
    "type",
    "v",
  ]);
});

test("all three authority cases are reachable and distinct", async () => {
  const fixture = await adopted("build-authority-cases-");
  const set = captureIo(fixture.directory);
  assert.equal(await runCli(["role", "set", "origin", "primary"], set.io), 0, set.stderr());

  // Omitted: core resolves from configuration.
  const resolved = await build(fixture, []);
  assert.equal(resolved.code, 0, resolved.err);
  const resolvedManifest = await manifestOf(fixture.directory, (JSON.parse(resolved.out) as { result: { checkpoint: string } }).result.checkpoint);
  assert.equal(resolvedManifest?.authority, "origin");

  // Explicit null: inference is suppressed, not merged with.
  const suppressed = await build(fixture, ["--no-authority"]);
  assert.equal(suppressed.code, 0, suppressed.err);
  const suppressedManifest = await manifestOf(fixture.directory, (JSON.parse(suppressed.out) as { result: { checkpoint: string } }).result.checkpoint);
  assert.equal(suppressedManifest?.authority, null, "--no-authority is an override, not a synonym for saying nothing");

  // Explicit name.
  const named = await build(fixture, ["--authority", "origin"]);
  assert.equal(named.code, 0, named.err);
  const namedManifest = await manifestOf(fixture.directory, (JSON.parse(named.out) as { result: { checkpoint: string } }).result.checkpoint);
  assert.equal(namedManifest?.authority, "origin");

  const conflicting = captureIo(fixture.directory);
  assert.equal(await runCli(["ledger", "build", "--authority", "origin", "--no-authority"], conflicting.io), 3);
  assert.match(conflicting.stderr(), /choose only one of/);
});

test("ledger build signs the manifest when a key is configured", async () => {
  const fixture = await adopted("build-signed-");
  await withSigningKey(fixture, "publisher@example.test");
  const set = captureIo(fixture.directory);
  assert.equal(await runCli(["role", "set", "origin", "primary"], set.io), 0, set.stderr());

  const built = await build(fixture, []);

  assert.equal(built.code, 0, built.err);
  const parsed = JSON.parse(built.out) as { result: { checkpoint: string; signed: boolean; reason: string } };
  assert.equal(parsed.result.signed, true);
  assert.match(parsed.result.reason, /signed the manifest/);
  const repository = await GitRepository.open(fixture.directory);
  const entries = await repository.ledgerTreeEntries(parsed.result.checkpoint as ObjectId);
  assert.equal(entries.some((entry) => entry.path === "signatures"), true, "the attestation is transported in the envelope");
});

test("--no-sign bypasses a configured signer instead of merely ignoring the result", async () => {
  const fixture = await adopted("build-unsigned-");
  await withSigningKey(fixture, "publisher@example.test");
  const set = captureIo(fixture.directory);
  assert.equal(await runCli(["role", "set", "origin", "primary"], set.io), 0, set.stderr());

  const unsigned = await build(fixture, ["--no-sign"]);

  assert.equal(unsigned.code, 0, unsigned.err);
  const parsed = JSON.parse(unsigned.out) as { result: { checkpoint: string; signed: boolean; reason: string } };
  assert.equal(parsed.result.signed, false);
  assert.match(parsed.result.reason, /declined with --no-sign/);
  const repository = await GitRepository.open(fixture.directory);
  const entries = await repository.ledgerTreeEntries(parsed.result.checkpoint as ObjectId);
  assert.equal(
    entries.some((entry) => entry.path === "signatures"),
    false,
    "a declined signature must not be written at all, not written and ignored",
  );
});

test("a build without a key produces a valid unsigned checkpoint and says why", async () => {
  const fixture = await adopted("build-nokey-");
  const built = await build(fixture, []);

  assert.equal(built.code, 0, built.err);
  const parsed = JSON.parse(built.out) as { result: { signed: boolean; reason: string } };
  assert.equal(parsed.result.signed, false);
  assert.match(parsed.result.reason, /no signing key is configured/);
});

test("two signed builds in a row both append, and the measured result is pinned", async () => {
  // `build` is an append operation, not an idempotent no-op. The manifest names
  // the previous ledger, so a second build over identical notes is a new
  // checkpoint whose attestation covers a different manifest. This test measures
  // that rather than asserting it: the values below are the ones observed, and a
  // future change to the envelope contract has to change them deliberately.
  const fixture = await adopted("build-append-");
  await withSigningKey(fixture, "publisher@example.test");
  const set = captureIo(fixture.directory);
  assert.equal(await runCli(["role", "set", "origin", "primary"], set.io), 0, set.stderr());
  const repository = await GitRepository.open(fixture.directory);

  const first = await build(fixture, []);
  assert.equal(first.code, 0, first.err);
  const firstResult: { result: { checkpoint: string; state: string } } = JSON.parse(first.out);
  const firstTipBefore = await git(fixture.directory, "rev-parse", LEDGER_REF);
  const firstSignatures = (await repository.readLedgerSignaturesAt(firstResult.result.checkpoint as ObjectId) ?? "")
    .split("\n").filter((line) => line.length > 0);

  const second = await build(fixture, []);
  assert.equal(second.code, 0, second.err);
  const secondResult: { result: { checkpoint: string; state: string } } = JSON.parse(second.out);
  const secondTip = await git(fixture.directory, "rev-parse", LEDGER_REF);
  const secondSignatures = (await repository.readLedgerSignaturesAt(secondResult.result.checkpoint as ObjectId) ?? "")
    .split("\n").filter((line) => line.length > 0);

  assert.equal(firstResult.result.state, "created");
  assert.equal(secondResult.result.state, "created", "a second build over unchanged evidence still appends");
  assert.notEqual(secondResult.result.checkpoint, firstResult.result.checkpoint, "the checkpoint advances");
  assert.equal(secondTip, secondResult.result.checkpoint, "the branch tip is the new checkpoint");
  assert.equal(firstTipBefore, firstResult.result.checkpoint);
  assert.equal(firstSignatures.length, 1);
  assert.equal(
    secondSignatures.length,
    2,
    "the signature entry is a growing log: the first attestation is carried forward, not replaced",
  );
  assert.equal(secondSignatures[0], firstSignatures[0], "the earlier line is byte-identical, so nothing was rewritten");
  assert.notEqual(secondSignatures[1], firstSignatures[0], "the new line covers this checkpoint's own manifest");
  // The carried-forward rule is a real invariant, not an artifact of counting.
  const envelope = await (await Reveries.open(fixture.directory)).verifyLedgerEnvelope(secondResult.result.checkpoint);
  assert.equal(envelope.ok, true, JSON.stringify(envelope.diagnostics));
});

// Doctor output
// -------------------------------------------------------------------------------

test("doctor reports signatures, authority, and the trust store as their own lines", async () => {
  const fixture = await adopted("doctor-blocks-");
  await withSigningKey(fixture, "publisher@example.test");
  for (const [remote, role] of [["origin", "primary"], ["backup", "mirror"], ["vault", "archive"]] as const) {
    const io = captureIo(fixture.directory);
    assert.equal(await runCli(["role", "set", remote, role], io.io), 0, io.stderr());
  }
  assert.equal((await build(fixture, [])).code, 0);
  // Give the mirror a fetched envelope so it is checked rather than unavailable.
  // The mirror has to carry a real envelope over the same notes, fetched into its
  // remote-tracking ref, which is the only place the network-free check looks.
  await execFileAsync("git", ["push", "origin", `${LEDGER_REF}:${LEDGER_REF}`, `${NOTES_REF}:${NOTES_REF}`], { cwd: fixture.directory });
  await execFileAsync("git", ["push", "backup", `${LEDGER_REF}:${LEDGER_REF}`, `${NOTES_REF}:${NOTES_REF}`], { cwd: fixture.directory });
  await git(fixture.directory, "fetch", "backup", `+refs/heads/reveries-ledger:refs/remotes/backup/reveries-ledger`);

  const doctor = captureIo(fixture.directory);
  await runCli(["doctor"], doctor.io);
  const out = doctor.stdout();
  assert.match(out, /^Signatures: signed; checkpoint [0-9a-f]+; manifest signed; /m);
  assert.match(out, /^Authority: configured; primary origin; 1 mirror\(s\), 1 archive\(s\), 0 import-only\.$/m);
  assert.match(out, /^Mirror backup: /m);
  assert.match(out, /^Trust store: .*trust\.json; 1 key\(s\); 0 revoked; signing key loaded\.$/m);
  // The generic notice copies are suppressed, so nothing is printed twice.
  assert.doesNotMatch(out, /Notice: Signatures:/);
  assert.doesNotMatch(out, /Notice: Authority:/);
  assert.doesNotMatch(out, /Notice: Mirror/);
  assert.doesNotMatch(out, /Notice: Ledger:/);
  // The trust states are named exactly as the protocol names them.
  assert.match(out, /0 unknown, 0 valid, \d+ trusted, \d+ policy-satisfying, 0 invalid, 0 revoked/);
});

test("doctor stays healthy on a repository with no signing or role configuration", async () => {
  const fixture = await adopted("doctor-plain-");
  const doctor = captureIo(fixture.directory);

  const code = await runCli(["doctor", "--json"], doctor.io);

  const parsed = JSON.parse(doctor.stdout()) as {
    result: { signatures: { state: string }; authority: { state: string }; trust: { keys: number; keyLoaded: boolean } };
    diagnostics: readonly string[];
  };
  assert.equal(parsed.result.signatures.state, "absent", "an unsigned repository is an ordinary state");
  assert.equal(parsed.result.authority.state, "inferred");
  assert.equal(parsed.result.trust.keys, 0);
  assert.equal(parsed.result.trust.keyLoaded, false);
  // Only the missing local enforcement a fresh fixture has; nothing signing
  // related may appear, because absence is not damage.
  assert.equal(parsed.diagnostics.some((entry) => /signature|trust|authorit/i.test(entry)), false, parsed.diagnostics.join("; "));
  assert.equal(typeof code, "number");
});

// Installer convergence
// -------------------------------------------------------------------------------

test("init drops a role for a remote that no longer exists and keeps one that does", async () => {
  const fixture = await adopted("init-roles-", ["origin", "backup"]);
  for (const [remote, role] of [["origin", "primary"], ["backup", "mirror"]] as const) {
    const io = captureIo(fixture.directory);
    assert.equal(await runCli(["role", "set", remote, role], io.io), 0, io.stderr());
  }
  await git(fixture.directory, "remote", "remove", "backup");

  await initializeRepository(fixture.directory, {
    hosts: [],
    publishingRemotes: ["origin"],
    directiveEmail: "authority@example.com",
    skillSetup: { kind: "reminder" },
  });

  assert.equal(await gitMaybe(fixture.directory, "config", "--get", "reveries.remoteRole.backup"), "", "a dangling role is removed");
  assert.equal(await gitMaybe(fixture.directory, "config", "--get", "reveries.remoteRole.origin"), "primary", "a live role is kept");
});

test("repair reports the trust store without creating, replacing, or deleting it", async () => {
  const fixture = await adopted("repair-trust-");
  // No store yet: repair must not invent one.
  const beforeMissing = await repairLocalIntegration(fixture.directory);
  assert.equal(beforeMissing.trustStorePresent, false);
  assert.match(beforeMissing.trustStorePath, /trust\.json$/);
  assert.equal(
    (await readLocalTrustStore((await Reveries.open(fixture.directory)).repository)).present,
    false,
    "repair must not create a trust store",
  );

  await withSigningKey(fixture, "publisher@example.test");
  const pair = generateEd25519KeyPair();
  const pemPath = join(fixture.outside, "second.pub.pem");
  await writeFile(pemPath, pair.publicKey, "utf8");
  const add = captureIo(fixture.directory);
  assert.equal(await runCli(["trust", "add", "--signer", "second@example.test", "--from-file", pemPath], add.io), 0, add.stderr());
  const before = (await readFile((await readLocalTrustStore((await Reveries.open(fixture.directory)).repository)).path, "utf8"));

  const repaired = await repairLocalIntegration(fixture.directory);

  assert.equal(repaired.trustStorePresent, true);
  const after = await readFile((await readLocalTrustStore((await Reveries.open(fixture.directory)).repository)).path, "utf8");
  assert.equal(after, before, "repair never rotates, replaces, or rewrites a trust decision");
  const keys = (await readLocalTrustStore((await Reveries.open(fixture.directory)).repository)).file.keys;
  assert.equal(keys.length, 2, "both identities survive a repair");
});

test("doctor --json keeps the existing envelope shape and adds trust additively", async () => {
  const fixture = await adopted("doctor-shape-");
  const doctor = captureIo(fixture.directory);
  await runCli(["doctor", "--json"], doctor.io);
  const parsed = JSON.parse(doctor.stdout()) as { result: Record<string, unknown> };

  for (const key of ["ok", "state", "notices", "diagnostics", "protection", "retention", "ledger", "signatures", "authority", "mirrors"]) {
    assert.ok(key in parsed.result, `doctor keeps its ${key} field`);
  }
  assert.deepEqual(Object.keys(parsed.result.trust as object).sort(), [
    "keyId",
    "keyLoaded",
    "keys",
    "path",
    "present",
    "revoked",
    "signer",
  ]);
});

// Failing closed on a contradictory authority configuration
// -------------------------------------------------------------------------------

/**
 * Write two primaries directly, bypassing the CLI writer that refuses them.
 * The refusal has to live in the operation as well, because configuration is
 * editable by hand and by other tools.
 */
async function declareTwoPrimaries(fixture: Fixture): Promise<void> {
  await git(fixture.directory, "config", "reveries.remoteRole.origin", "primary");
  await git(fixture.directory, "config", "reveries.remoteRole.backup", "primary");
}

test("ledger build refuses a contradictory authority configuration", async () => {
  const fixture = await adopted("dual-primary-build-", ["origin", "backup"], ["origin", "backup"]);
  await declareTwoPrimaries(fixture);

  const built = await build(fixture, []);

  assert.equal(built.code, 1, "a build on a configuration that contradicts itself is not publishable");
  const parsed = JSON.parse(built.out) as { result: { state: string }; diagnostics: readonly string[] };
  assert.equal(parsed.result.state, "refused");
  assert.match(parsed.diagnostics.join(" "), /exactly one primary/);
});

test("ledger build refuses before writing a checkpoint or signing anything", async () => {
  const fixture = await adopted("dual-primary-nowrite-", ["origin", "backup"], ["origin", "backup"]);
  await declareTwoPrimaries(fixture);
  const { keyId } = await withSigningKey(fixture, "publisher@example.test");

  const built = await build(fixture, []);

  assert.equal(built.code, 1);
  // Nothing may be left behind by a refused build: no branch tip, and no
  // attestation the operator would have to clean up by hand.
  assert.equal(
    await gitMaybe(fixture.directory, "rev-parse", "--verify", LEDGER_REF),
    "",
    "a refused build must not move the ledger branch",
  );
  const store = await readLocalTrustStore((await Reveries.open(fixture.directory)).repository);
  assert.equal(store.file.keys.some((entry) => entry.key_id === keyId), true, "the trust store is untouched");
});

test("an invalid authority configuration fails a sync closed too", async () => {
  const fixture = await adopted("dual-primary-sync-", ["origin", "backup"], ["origin", "backup"]);
  await declareTwoPrimaries(fixture);
  const repository = (await Reveries.open(fixture.directory)).repository;
  const before = await repository.notesTip();

  const io = captureIo(fixture.directory);
  const code = await runCli(["sync", "origin", "--pull", "--json"], io.io);

  // The sync itself reports the role problem; what matters here is that no
  // canonical state moved while the configuration was self-contradictory.
  assert.notEqual(code, 0);
  assert.equal(await repository.notesTip(), before, "a contradictory authority must not promote anything");
});

// Explicit materialize must not route around the quarantine
// -------------------------------------------------------------------------------

/**
 * A publisher carrying both evidence routes, so an envelope really exists to
 * be materialized. `role` is the declared role of the remote in the consumer.
 */
/** Attach one reverie to the committed `state.txt` blob, as a publisher would. */
async function annotate(source: string, decision: string): Promise<void> {
  const repository = await GitRepository.open(source);
  const blob = await repository.resolvePath({ path: "state.txt", revision: "HEAD" });
  await repository.withNotesWrite(async (notes) => {
    await notes.append(blob, canonicalRecord(createReverie(
      {
        v: 1,
        driving_event: "A published decision must travel to a consumer that cannot fetch notes.",
        decision,
        impact: "The envelope is the only route this consumer has.",
        recurrence_control: null,
        alternatives: [],
        sources: [],
        supersedes: [],
      },
      { author_email: "authority@example.com", session: null, created_at: "2026-09-30T10:00:00Z" },
      (bytes) => hashBlobContent(bytes, "sha1"),
    )));
  });
}

async function consumerWithEnvelope(prefix: string, role: string): Promise<{ readonly directory: string; readonly envelope: string }> {
  const published = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(published);
  const source = join(published, "source");
  const bare = join(published, "remote.git");
  await mkdir(source);
  await execFileAsync("git", ["init", "--bare", bare]);
  await git(source, "init", "-b", "main");
  await git(source, "config", "user.name", "Publisher");
  await git(source, "config", "user.email", "publisher@example.com");
  await git(source, "remote", "add", "origin", bare);
  await writeFile(join(source, "state.txt"), "first\n", "utf8");
  await git(source, "add", "state.txt");
  await git(source, "commit", "-m", "first");
  await annotate(source, "The published decision travels by envelope.");
  const built = await (await Reveries.open(source)).buildLedgerCheckpoint({});
  assert.equal(built.ok, true, JSON.stringify(built.diagnostics));
  await git(source, "push", "origin", "main", `${NOTES_REF}:${NOTES_REF}`, `${LEDGER_REF}:${LEDGER_REF}`);

  const consumer = join(published, "consumer");
  await execFileAsync("git", ["clone", "--quiet", bare, consumer]);
  await git(consumer, "config", "user.name", "Consumer");
  await git(consumer, "config", "user.email", "consumer@example.com");
  await git(consumer, "remote", "add", "vendor", bare);
  await git(consumer, "config", "--add", "reveries.publishingRemote", "vendor");
  await git(consumer, "config", "reveries.remoteRole.vendor", role);
  // Fetch the envelope into the place an operator would name explicitly.
  await git(consumer, "fetch", "--quiet", "vendor", `+${LEDGER_REF}:refs/remotes/vendor/reveries-ledger`);
  const envelope = await git(consumer, "rev-parse", "refs/remotes/vendor/reveries-ledger");
  return { directory: consumer, envelope };
}

for (const role of ["mirror", "import-only"]) {
  test(`an explicit ledger materialize refuses a ${role} remote's envelope`, async () => {
    const { directory, envelope } = await consumerWithEnvelope(`materialize-${role}-`, role);
    const repository = (await Reveries.open(directory)).repository;
    const before = await repository.notesTip();

    const io = captureIo(directory);
    const code = await runCli(["ledger", "materialize", "refs/remotes/vendor/reveries-ledger", "--json"], io.io);

    // The envelope carries the same evidence the notes route quarantined.
    // Materializing it explicitly must not hand the decision to the second
    // transport, so the same role applies here.
    assert.equal(code, 1, `a ${role} envelope must not be materialized into canonical state`);
    const parsed = JSON.parse(io.stdout()) as { result: { state: string }; diagnostics: readonly string[] };
    assert.equal(parsed.result.state, "refused");
    assert.match(parsed.diagnostics.join(" "), new RegExp(role));
    assert.equal(
      await repository.notesTip(),
      before,
      "the canonical notes ref must be byte-identical after a refused materialize",
    );
    assert.notEqual(envelope, "");
  });
}

test("an explicit materialize still works for a primary remote", async () => {
  const { directory } = await consumerWithEnvelope("materialize-primary-", "primary");
  const repository = (await Reveries.open(directory)).repository;

  const io = captureIo(directory);
  const code = await runCli(["ledger", "materialize", "refs/remotes/vendor/reveries-ledger", "--json"], io.io);

  assert.equal(code, 0, io.stderr());
  assert.notEqual(await repository.notesTip(), null, "a primary's envelope materializes as before");
});

test("a materialize from a remote with no declared role still works", async () => {
  // A repository that never adopted roles keeps its pre-role behaviour, so the
  // new gate must not become a new reason an ordinary V1 repository fails.
  const { directory } = await consumerWithEnvelope("materialize-undeclared-", "primary");
  await git(directory, "config", "--unset-all", "reveries.remoteRole.vendor");

  const io = captureIo(directory);
  const code = await runCli(["ledger", "materialize", "refs/remotes/vendor/reveries-ledger", "--json"], io.io);

  assert.equal(code, 0, io.stderr());
  assert.notEqual(await (await Reveries.open(directory)).repository.notesTip(), null);
});

test("a materialize under a contradictory authority configuration fails closed", async () => {
  const { directory } = await consumerWithEnvelope("materialize-invalid-", "primary");
  await git(directory, "config", "reveries.remoteRole.backup", "primary");

  const io = captureIo(directory);
  const code = await runCli(["ledger", "materialize", "refs/remotes/vendor/reveries-ledger", "--json"], io.io);

  assert.equal(code, 1);
  assert.equal(
    await (await Reveries.open(directory)).repository.notesTip(),
    null,
    "a self-contradictory configuration must not authorize any promotion",
  );
});

// The reported authority must be the one the checkpoint actually carries
// -------------------------------------------------------------------------------

test("an explicit non-primary authority is reported and rendered as stamped", async () => {
  // `--authority` is allowed to name any remote, because the field records the
  // remote this repository publishes on behalf of and an operator may legitimately
  // publish to a mirror. What is not allowed is for the report to name a
  // *different* remote from the one the manifest carries.
  const fixture = await adopted("explicit-authority-", ["origin", "backup"], ["origin", "backup"]);
  const primary = captureIo(fixture.directory);
  assert.equal(await runCli(["role", "set", "origin", "primary"], primary.io), 0, primary.stderr());
  const mirror = captureIo(fixture.directory);
  assert.equal(await runCli(["role", "set", "backup", "mirror"], mirror.io), 0, mirror.stderr());

  const built = await build(fixture, ["--authority", "backup"]);

  assert.equal(built.code, 0, built.err);
  const parsed = JSON.parse(built.out) as {
    result: { checkpoint: string; authority: string; authorityResolved: string };
  };
  const manifest = await manifestOf(fixture.directory, parsed.result.checkpoint);
  assert.equal(manifest?.authority, "backup", "the manifest carries what was asked for");
  assert.equal(
    parsed.result.authority,
    manifest?.authority,
    "the reported authority must be the stamped one, not the resolved primary",
  );
  assert.equal(parsed.result.authority, "backup");
  // Both are visible, so a reader can tell a deliberate divergence from a bug.
  assert.equal(parsed.result.authorityResolved, "origin");

  const human = captureIo(fixture.directory);
  assert.equal(await runCli(["ledger", "build", "--authority", "backup"], human.io), 0, human.stderr());
  assert.match(human.stdout(), /Authority: backup \(resolved primary is origin\)/);
});

test("an explicit non-primary authority that does not exist is still stamped and reported", async () => {
  // The field is a name the operator supplies, so an unrecognised one is recorded
  // rather than silently replaced by the resolved primary.
  const fixture = await adopted("explicit-unknown-authority-", ["origin", "backup"], ["origin", "backup"]);
  const primary = captureIo(fixture.directory);
  assert.equal(await runCli(["role", "set", "origin", "primary"], primary.io), 0, primary.stderr());

  const built = await build(fixture, ["--authority", "vendor"]);

  assert.equal(built.code, 0, built.err);
  const parsed = JSON.parse(built.out) as { result: { checkpoint: string; authority: string } };
  const manifest = await manifestOf(fixture.directory, parsed.result.checkpoint);
  assert.equal(manifest?.authority, "vendor");
  assert.equal(parsed.result.authority, "vendor", "an explicit name is reported as given");
});

test("no override reports the resolved primary and claims no divergence", async () => {
  const fixture = await adopted("resolved-authority-", ["origin", "backup"], ["origin", "backup"]);
  const primary = captureIo(fixture.directory);
  assert.equal(await runCli(["role", "set", "origin", "primary"], primary.io), 0, primary.stderr());

  const built = await build(fixture, []);

  assert.equal(built.code, 0, built.err);
  const parsed = JSON.parse(built.out) as {
    result: { checkpoint: string; authority: string; authorityResolved: string };
  };
  const manifest = await manifestOf(fixture.directory, parsed.result.checkpoint);
  assert.equal(parsed.result.authority, manifest?.authority);
  assert.equal(parsed.result.authorityResolved, parsed.result.authority);
  const human = captureIo(fixture.directory);
  assert.equal(await runCli(["ledger", "build"], human.io), 0, human.stderr());
  assert.doesNotMatch(human.stdout(), /resolved primary is/, "no divergence exists to report");
});

test("--no-authority still reports null rather than falling back to the primary", async () => {
  const fixture = await adopted("explicit-null-authority-", ["origin", "backup"], ["origin", "backup"]);
  const primary = captureIo(fixture.directory);
  assert.equal(await runCli(["role", "set", "origin", "primary"], primary.io), 0, primary.stderr());

  const built = await build(fixture, ["--no-authority"]);

  assert.equal(built.code, 0, built.err);
  const parsed = JSON.parse(built.out) as {
    result: { checkpoint: string; authority: string | null; authorityResolved: string | null };
  };
  const manifest = await manifestOf(fixture.directory, parsed.result.checkpoint);
  assert.equal(manifest?.authority, null);
  assert.equal(parsed.result.authority, null, "an explicit null is a value, not an absence");
  // The resolved primary is still reported separately, so nothing is hidden.
  assert.equal(parsed.result.authorityResolved, "origin");
});

// --- Slash-containing remote names ------------------------------------------
//
// Git permits a remote named `team/vendor`, but `reveries.remoteRole.team/vendor`
// is rejected by git itself as an invalid key, so such a remote is declared
// through the subsection encoding `reveries.remoteRole/team/vendor.role`. Two
// things then have to hold, and neither is obvious:
//
//  1. a tracking ref for `team/vendor` must resolve to `team/vendor`, not to its
//     first path segment. Reading `team` applied *that* remote's role to another
//     remote's evidence, so the command layer refused promotions the direct API
//     performed; and
//  2. every reader of role configuration — the CLI writer, init convergence, and
//     removal — must see the subsection form. A flat-only `--get-regexp` pattern
//     returns zero rows for a subsection key, so narrowing it hides the role
//     instead of failing loudly.

test("a slash remote's role can be set, shown, and cleared", async () => {
  const fixture = await adopted("slash-role-cli-", ["origin", "team", "team/vendor"], ["origin"]);
  const set = captureIo(fixture.directory);
  assert.equal(await runCli(["role", "set", "team/vendor", "import-only"], set.io), 0, set.stderr());

  // The subsection encoding is the only one git can store for this name.
  assert.equal(
    await gitMaybe(fixture.directory, "config", "--get", "reveries.remoteRole/team/vendor.role"),
    "import-only",
  );
  assert.equal(
    await gitMaybe(fixture.directory, "config", "--get", "reveries.remoteRole.team/vendor"),
    "",
    "git would reject the flat key for a slash name",
  );

  const show = captureIo(fixture.directory);
  assert.equal(await runCli(["role", "show", "--json"], show.io), 0, show.stderr());
  const roles = (JSON.parse(show.stdout()) as { result: { roles: Record<string, string> } }).result.roles;
  assert.equal(roles["team/vendor"], "import-only");

  const clear = captureIo(fixture.directory);
  assert.equal(await runCli(["role", "clear", "team/vendor"], clear.io), 0, clear.stderr());
  assert.equal(
    await gitMaybe(fixture.directory, "config", "--get", "reveries.remoteRole/team/vendor.role"),
    "",
  );
});

test("a decoy subsection under the role prefix is never a role", async () => {
  const fixture = await adopted("slash-role-decoy-", ["origin", "team", "team/vendor"], ["origin"]);
  await git(fixture.directory, "config", "reveries.remoteRole/team/vendor.role", "import-only");
  // A different key that happens to share the prefix. Reading it as a role would
  // invent an authority boundary nobody declared.
  await git(fixture.directory, "config", "reveries.remoteRole/team.someOtherSetting", "hello");

  const show = captureIo(fixture.directory);
  assert.equal(await runCli(["role", "show", "--json"], show.io), 0, show.stderr());
  const roles = (JSON.parse(show.stdout()) as { result: { roles: Record<string, string> } }).result.roles;
  assert.equal(roles["team/vendor"], "import-only");
  assert.equal("team.someOtherSetting" in roles, false, JSON.stringify(roles));

  // Clearing the role must not eat a key the role writer does not own.
  const clear = captureIo(fixture.directory);
  assert.equal(await runCli(["role", "clear", "team/vendor"], clear.io), 0, clear.stderr());
  assert.equal(
    await gitMaybe(fixture.directory, "config", "--get", "reveries.remoteRole/team.someOtherSetting"),
    "hello",
  );
});

test("a slash-free remote keeps the legacy flat key", async () => {
  const fixture = await adopted("flat-role-cli-", ["origin", "team/vendor"], ["origin"]);
  const set = captureIo(fixture.directory);
  assert.equal(await runCli(["role", "set", "origin", "primary"], set.io), 0, set.stderr());
  // Byte for byte the key a pre-slash-support repository already has: declaring a
  // role never rewrites configuration that exists.
  assert.equal(
    await gitMaybe(fixture.directory, "config", "--get", "reveries.remoteRole.origin"),
    "primary",
  );
  assert.equal(
    await gitMaybe(fixture.directory, "config", "--get", "reveries.remoteRole/origin.role"),
    "",
    "a simple name must not gain a subsection key",
  );
});

test("a second primary declared through a subsection key is refused", async () => {
  const fixture = await adopted("slash-two-primary-", ["origin", "team", "team/vendor"], ["origin"]);
  const first = captureIo(fixture.directory);
  assert.equal(await runCli(["role", "set", "origin", "primary"], first.io), 0, first.stderr());
  await git(fixture.directory, "config", "reveries.remoteRole/team/vendor.role", "primary");

  // The existing primary is a subsection key, so a flat-only read would miss it
  // and write the contradiction while reporting success.
  const second = captureIo(fixture.directory);
  assert.equal(await runCli(["role", "set", "team", "primary"], second.io), 3);
  assert.match(second.stderr(), /exactly one primary/i);
  assert.equal(
    await gitMaybe(fixture.directory, "config", "--get", "reveries.remoteRole.team"),
    "",
    "the refused second primary must not be written",
  );
});

test("a tracking ref resolves by longest remote name, not first segment", async () => {
  const fixture = await adopted("slash-tracking-", ["origin", "team", "team/vendor"], ["origin"]);
  const reveries = await Reveries.open(fixture.directory);
  // `team` and `team/vendor` both exist, so the answer depends on the whole
  // configured name rather than the first path segment.
  assert.equal(
    await reveries.trackingRemote("refs/remotes/team/reveries-ledger"),
    "team",
  );
  assert.equal(
    await reveries.trackingRemote("refs/remotes/team/vendor/reveries-ledger"),
    "team/vendor",
  );
  // Anything that is not a configured remote's tracking ref names no remote.
  assert.equal(await reveries.trackingRemote("refs/remotes/absent/reveries-ledger"), null);
  assert.equal(await reveries.trackingRemote("main"), null);
  assert.equal(await reveries.trackingRemote(undefined), null);
});
