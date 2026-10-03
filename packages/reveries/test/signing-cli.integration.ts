import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";

import { runCli, type CliIo } from "../src/cli.ts";
import { GitRepository, LEDGER_REF, ed25519KeyId, generateEd25519KeyPair } from "../src/git.ts";
import { initializeRepository, readLocalTrustStore } from "../src/install.ts";
import { Reveries } from "../src/operations.ts";
import { objectId, readLedgerManifest, type ObjectId, type ReveriesInit, type SessionSummary } from "../src/protocol.ts";

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

function captureIo(cwd: string, stdin = ""): { readonly io: CliIo; readonly stdout: () => string; readonly stderr: () => string } {
  let out = "";
  let error = "";
  return {
    io: {
      cwd,
      stdin: async () => stdin,
      stdout: (text) => { out += text; },
      stderr: (text) => { error += text; },
      environment: {},
    },
    stdout: () => out,
    stderr: () => error,
  };
}

interface Fixture {
  readonly root: string;
  readonly directory: string;
  /** A directory outside the repository, where private key material may live. */
  readonly outside: string;
  readonly trustStorePath: string;
}

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "reveries-signing-cli-"));
  temporary.push(path);
  return path;
}

function adoptionSummary(): SessionSummary {
  return {
    v: 1,
    type: "session-summary",
    author_email: "signer@example.com",
    session: "codex:test",
    created_at: "2026-09-30T09:00:00Z",
    entries: [{
      driving_event: "The repository adopted durable engineering memory.",
      decision: "Initialize Reveries so a signature has evidence to attest.",
      impact: "Every record written after this boundary is a valid signature target.",
      recurrence_control: "The signing tests assert the trust state of a real record.",
      alternatives: [],
      sources: [],
      reveries: [],
      retirements: [],
    }],
  };
}

const INIT_RECORD: ReveriesInit = {
  v: 1,
  type: "reveries-init",
  protocol: 1,
  notes_ref: "refs/notes/reveries",
  publishing_remotes: ["origin"],
  hosts: ["codex"],
  author_email: "signer@example.com",
  created_at: "2026-09-30T09:00:00Z",
};

/** An adopted repository holding exactly one record, which is what gets signed. */
async function adoptedWithOneReverie(prefix: string): Promise<Fixture & { readonly reverieId: string; readonly blob: string }> {
  const base = await root();
  const directory = join(base, "repo");
  const outside = join(base, "keys");
  await mkdir(directory);
  await mkdir(outside);
  await git(directory, "init", "-b", "main");
  await git(directory, "config", "user.name", "Signing Test");
  await git(directory, "config", "user.email", "signer@example.com");
  await writeFile(join(directory, "state.txt"), "first\n", "utf8");
  await git(directory, "add", "state.txt");
  await git(directory, "commit", "-m", "initial");
  // A real remote, so authority resolution has something to resolve against and a
  // declared role names a remote that exists.
  await execFileAsync("git", ["init", "--bare", join(base, "origin.git")]);
  await git(directory, "remote", "add", "origin", join(base, "origin.git"));

  const reveries = await Reveries.open(directory);
  const commit = await git(directory, "rev-parse", "HEAD");
  await reveries.summarize({ commit, summary: adoptionSummary() });
  await reveries.attachInitialization({ commit, record: INIT_RECORD });

  const draft = join(base, "reverie.json");
  await writeFile(draft, JSON.stringify({
    driving_event: "An unsigned decision could not be distinguished from a forged one.",
    decision: "Sign the decision with a key the trust store authorizes.",
    impact: "A reader can separate cryptographic validity from established identity.",
    recurrence_control: "The trust-state tests assert each state through the CLI.",
  }), "utf8");
  const record = captureIo(directory);
  assert.equal(await runCli(["record", "new", "state.txt", "--committed", "--from", draft, "--json"], record.io), 0);
  const reverieId = (JSON.parse(record.stdout()) as { result: { record: { id: string } } }).result.record.id;
  const blob = objectId(await git(directory, "rev-parse", "HEAD:state.txt"));
  const trust = await readLocalTrustStore(reveries.repository);
  return { root: base, directory, outside, trustStorePath: trust.path, reverieId, blob };
}

/** Create a key outside the repository and register it, the supported path. */
async function withSigningKey(
  fixture: Fixture,
  signer: string,
  name = "signing.pem",
): Promise<{ readonly keyPath: string; readonly keyId: string }> {
  const keyPath = join(fixture.outside, name);
  const created = captureIo(fixture.directory);
  assert.equal(
    await runCli(["trust", "init", "--signer", signer, "--key-file", keyPath, "--json"], created.io),
    0,
    created.stderr(),
  );
  const keyId = (JSON.parse(created.stdout()) as { result: { key_id: string } }).result.key_id;
  await git(fixture.directory, "config", "reveries.signingKey", keyPath);
  return { keyPath, keyId };
}

async function verifyJson(fixture: Fixture, args: readonly string[]): Promise<{
  readonly code: number;
  readonly ok: boolean;
  readonly result: {
    readonly state: string;
    readonly counts?: Readonly<Record<string, number>>;
    readonly signatures?: readonly { readonly state: string; readonly signer: string; readonly key_id: string; readonly target: string }[];
    readonly signature?: { readonly state: string } | null;
    readonly envelope?: { readonly ok: boolean };
  };
  readonly diagnostics: readonly string[];
}> {
  const io = captureIo(fixture.directory);
  const code = await runCli(["verify", ...args, "--json"], io.io);
  const parsed = JSON.parse(io.stdout()) as ReturnType<typeof verifyJson>;
  return { code, ...parsed };
}

async function signOnce(fixture: Fixture, target: string, role = "author"): Promise<{ readonly code: number; readonly out: string; readonly err: string }> {
  const io = captureIo(fixture.directory);
  const code = await runCli(["sign", target, "--role", role, "--json"], io.io);
  return { code, out: io.stdout(), err: io.stderr() };
}

// Trust store management
// -------------------------------------------------------------------------------

test("trust list on a repository with no store reports the path and zero keys", async () => {
  const fixture = await adoptedWithOneReverie("absent-");
  const io = captureIo(fixture.directory);

  assert.equal(await runCli(["trust", "list", "--json"], io.io), 0);

  const parsed = JSON.parse(io.stdout()) as { result: { present: boolean; keys: readonly unknown[]; path: string } };
  assert.equal(parsed.result.present, false, "an unwritten store is absent, not broken");
  assert.deepEqual(parsed.result.keys, []);
  assert.equal(parsed.result.path, fixture.trustStorePath);
  // The default lives in the Git directory, which no clone receives.
  assert.match(parsed.result.path, /\.git\/reveries\/trust\.json$/);
});

test("trust init writes an exclusive 0600 private key and registers only the public key", async () => {
  const fixture = await adoptedWithOneReverie("init-");
  const keyPath = join(fixture.outside, "signing.pem");
  const io = captureIo(fixture.directory);

  assert.equal(await runCli(["trust", "init", "--signer", "alice@example.test", "--key-file", keyPath, "--json"], io.io), 0);

  const parsed = JSON.parse(io.stdout()) as { result: { key_id: string; signer: string; privateKeyPath: string; privateKeyMode: string } };
  const mode = (await stat(keyPath)).mode & 0o777;
  assert.equal(mode, 0o600, "key material must not be group or world readable");
  const pair = generateEd25519KeyPair();
  assert.notEqual(pair.keyId, parsed.result.key_id);
  const pem = await readFile(keyPath, "utf8");
  assert.match(pem, /BEGIN PRIVATE KEY/);
  // The derived identity is the one the store binds, and the reported location is
  // the only private-key information that leaves the process.
  const store = await readLocalTrustStore((await Reveries.open(fixture.directory)).repository);
  const entry = store.file.keys[0];
  assert.equal(entry?.key_id, parsed.result.key_id);
  assert.equal(ed25519KeyId(entry?.public_key ?? ""), parsed.result.key_id);
  assert.equal(entry?.revoked, false);
  const reported = io.stdout();
  assert.doesNotMatch(reported, /PRIVATE KEY/, "no private material may appear in output");
  const secretLine = pem.split("\n").find((line) => line.length > 20) ?? "nonsense";
  assert.doesNotMatch(reported, new RegExp(secretLine.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "no private material may appear in output");
});

test("trust init refuses to overwrite an existing key file", async () => {
  const fixture = await adoptedWithOneReverie("no-overwrite-");
  const keyPath = join(fixture.outside, "signing.pem");
  await writeFile(keyPath, "an existing key an operator still depends on\n", "utf8");
  const io = captureIo(fixture.directory);

  assert.equal(await runCli(["trust", "init", "--signer", "alice@example.test", "--key-file", keyPath], io.io), 3);

  assert.match(io.stderr(), /Refusing to overwrite/);
  assert.equal(
    await readFile(keyPath, "utf8"),
    "an existing key an operator still depends on\n",
    "the existing key must be untouched",
  );
});

test("trust init refuses a key path inside the repository, however it is spelled", async () => {
  const fixture = await adoptedWithOneReverie("inside-");
  const cases: readonly (readonly [string, string])[] = [
    ["absolute", join(fixture.directory, "leaked.pem")],
    ["dot relative", "leaked.pem"],
    ["dot slash relative", "./nested/../leaked.pem"],
    ["from outside, back in", join(fixture.outside, "..", "repo", "leaked.pem")],
    ["doubled traversal", join(fixture.outside, "..", "keys", "..", "repo", "leaked.pem")],
  ];
  for (const [label, target] of cases) {
    const io = captureIo(fixture.directory);
    assert.equal(
      await runCli(["trust", "init", "--signer", "alice@example.test", "--key-file", target], io.io),
      3,
      `${label} must be refused`,
    );
    assert.match(io.stderr(), /inside the repository/);
  }
  assert.equal(await stat(join(fixture.directory, "leaked.pem")).then(() => true, () => false), false);
});

test("trust init accepts a traversal that genuinely leaves the repository", async () => {
  const fixture = await adoptedWithOneReverie("outside-ok-");
  // `..` is not a reason to refuse on its own. This path normalizes to a
  // directory outside the repository, so refusing it would be refusing a
  // legitimate location on the grounds that it was spelled indirectly.
  const target = join(fixture.directory, "..", "keys", "outside.pem");
  const io = captureIo(fixture.directory);

  assert.equal(await runCli(["trust", "init", "--signer", "alice@example.test", "--key-file", target], io.io), 0, io.stderr());

  assert.equal((await stat(target)).mode & 0o777, 0o600);
});

test("trust init resolves a symlinked parent before deciding, so a link cannot escape the check", async () => {
  const fixture = await adoptedWithOneReverie("symlink-");
  // A link that *looks* external but resolves back inside the repository.
  const link = join(fixture.outside, "looks-external");
  await symlink(fixture.directory, link);
  const io = captureIo(fixture.directory);

  assert.equal(
    await runCli(["trust", "init", "--signer", "alice@example.test", "--key-file", join(link, "leaked.pem")], io.io),
    3,
  );

  assert.match(io.stderr(), /inside the repository/);
  assert.equal(await stat(join(fixture.directory, "leaked.pem")).then(() => true, () => false), false);
});

test("trust init refuses a path inside the Git directory", async () => {
  const fixture = await adoptedWithOneReverie("gitdir-");
  const io = captureIo(fixture.directory);

  assert.equal(
    await runCli(
      ["trust", "init", "--signer", "alice@example.test", "--key-file", join(fixture.directory, ".git", "key.pem")],
      io.io,
    ),
    3,
  );

  assert.match(io.stderr(), /inside the repository/);
});

test("trust init refuses a path inside a linked worktree's own Git directory", async () => {
  const fixture = await adoptedWithOneReverie("worktree-");
  const worktree = join(fixture.root, "linked");
  await git(fixture.directory, "worktree", "add", "-b", "side", worktree);
  // A linked worktree has its own private Git directory under the common one, so
  // checking only the common directory would leave it unchecked.
  const worktreeGitDir = (await git(worktree, "rev-parse", "--absolute-git-dir"));
  assert.notEqual(worktreeGitDir, join(fixture.directory, ".git"), "the precondition is a distinct per-worktree Git directory");
  const io = captureIo(worktree);

  assert.equal(
    await runCli(["trust", "init", "--signer", "alice@example.test", "--key-file", join(worktreeGitDir, "leaked.pem")], io.io),
    3,
  );

  assert.match(io.stderr(), /inside the repository/);
  assert.equal(await stat(join(worktreeGitDir, "leaked.pem")).then(() => true, () => false), false);
});

test("trust add derives the fingerprint from the public key and refuses a second identity", async () => {
  const fixture = await adoptedWithOneReverie("add-");
  const pair = generateEd25519KeyPair();
  const pemPath = join(fixture.outside, "public.pem");
  await writeFile(pemPath, pair.publicKey, "utf8");

  const first = captureIo(fixture.directory);
  assert.equal(await runCli(["trust", "add", "--signer", "alice@example.test", "--from-file", pemPath, "--json"], first.io), 0);
  assert.equal((JSON.parse(first.stdout()) as { result: { key_id: string } }).result.key_id, pair.keyId);

  const second = captureIo(fixture.directory);
  assert.equal(await runCli(["trust", "add", "--signer", "mallory@example.test", "--from-file", pemPath], second.io), 3);
  assert.match(second.stderr(), /already binds/);
});

test("trust add refuses a signer identity that is not email shaped", async () => {
  const fixture = await adoptedWithOneReverie("email-");
  const pair = generateEd25519KeyPair();
  const pemPath = join(fixture.outside, "public.pem");
  await writeFile(pemPath, pair.publicKey, "utf8");
  const io = captureIo(fixture.directory);

  assert.equal(await runCli(["trust", "add", "--signer", "alice", "--from-file", pemPath], io.io), 3);

  // A manifest signature records the signer identity as the author email, so a
  // non-email identity would make a signed checkpoint impossible to construct.
  assert.match(io.stderr(), /email-shaped identity/);
});

test("trust add refuses an unreadable public key file", async () => {
  const fixture = await adoptedWithOneReverie("badpem-");
  const pemPath = join(fixture.outside, "not-a-key.pem");
  await writeFile(pemPath, "this is not a key\n", "utf8");
  const io = captureIo(fixture.directory);

  assert.equal(await runCli(["trust", "add", "--signer", "alice@example.test", "--from-file", pemPath], io.io), 3);

  assert.match(io.stderr(), /not a readable public key/);
});

test("a malformed trust store is reported rather than silently treated as empty", async () => {
  const fixture = await adoptedWithOneReverie("malformed-");
  const store = (await Reveries.open(fixture.directory)).repository;
  const path = (await readLocalTrustStore(store)).path;
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify({ keys: [{ key_id: "SHA256:aa" }] }), "utf8");
  const io = captureIo(fixture.directory);

  assert.equal(await runCli(["verify", "--json"], io.io), 2);

  assert.match(io.stdout(), /is invalid/);
  assert.doesNotMatch(io.stdout(), /"ok":true/);
});

test("revoking a key makes its signatures revoked and still visible, and removing it returns them to unknown", async () => {
  const fixture = await adoptedWithOneReverie("revoke-");
  const { keyId } = await withSigningKey(fixture, "alice@example.test");
  assert.equal((await signOnce(fixture, fixture.reverieId)).code, 0);

  const revoked = captureIo(fixture.directory);
  assert.equal(await runCli(["trust", "revoke", "--key", keyId, "--json"], revoked.io), 0);
  assert.equal((JSON.parse(revoked.stdout()) as { result: { revoked: boolean } }).result.revoked, true);

  const afterRevoke = await verifyJson(fixture, []);
  assert.equal(afterRevoke.code, 1, "a revoked attestation is damage and is reported as such");
  assert.equal(afterRevoke.result.counts?.revoked, 1);
  assert.equal(afterRevoke.result.signatures?.length, 1, "the record stays visible and reported");

  const removed = captureIo(fixture.directory);
  assert.equal(await runCli(["trust", "remove", "--key", keyId, "--json"], removed.io), 0);

  const afterRemove = await verifyJson(fixture, []);
  assert.equal(afterRemove.code, 0, "an unknown key is not a failure");
  assert.equal(afterRemove.result.counts?.unknown, 1);
  assert.equal(afterRemove.result.signatures?.length, 1, "removing trust never removes the signature");
});

test("restore un-revokes a key so rotation and revocation are reversible", async () => {
  const fixture = await adoptedWithOneReverie("restore-");
  const { keyId } = await withSigningKey(fixture, "alice@example.test");
  assert.equal((await signOnce(fixture, fixture.reverieId)).code, 0);
  const revoke = captureIo(fixture.directory);
  assert.equal(await runCli(["trust", "revoke", "--key", keyId], revoke.io), 0, revoke.stderr());

  const restored = captureIo(fixture.directory);
  assert.equal(await runCli(["trust", "restore", "--key", keyId, "--json"], restored.io), 0);

  assert.equal((await verifyJson(fixture, [])).result.counts?.trusted, 1);
});

// Signing
// -------------------------------------------------------------------------------

test("a real repository reaches the trusted state with only ed25519 and a trust fixture", async () => {
  const fixture = await adoptedWithOneReverie("trusted-");
  await withSigningKey(fixture, "alice@example.test");

  const signed = await signOnce(fixture, fixture.reverieId);

  assert.equal(signed.code, 0, signed.err);
  const parsed = JSON.parse(signed.out) as { result: { record: { id: string }; trust: { state: string } } };
  assert.match(parsed.result.record.id, /^sg:[0-9a-f]{40}$/);
  assert.equal(
    parsed.result.trust.state,
    "trusted",
    "a signature written with a key the store binds reaches trusted, with no SSH backend involved",
  );
  const verified = await verifyJson(fixture, []);
  assert.equal(verified.code, 0, "trusted is not a failure");
  assert.equal(verified.result.counts?.trusted, 1);
  assert.equal(verified.result.signatures?.[0]?.signer, "alice@example.test");
});

test("a real repository reaches policy-satisfying once signingRoles names the role", async () => {
  const fixture = await adoptedWithOneReverie("policy-");
  await withSigningKey(fixture, "alice@example.test");
  assert.equal((await signOnce(fixture, fixture.reverieId)).code, 0);

  const beforePolicy = await verifyJson(fixture, []);
  assert.equal(beforePolicy.result.counts?.trusted, 1);
  assert.equal(beforePolicy.result.counts?.["policy-satisfying"], 0, "with no policy, trusted is the ceiling");

  const policy = captureIo(fixture.directory);
  assert.equal(await runCli(["policy", "set", "author,reviewer", "--json"], policy.io), 0);

  const afterPolicy = await verifyJson(fixture, []);
  assert.equal(afterPolicy.result.counts?.["policy-satisfying"], 1);
  assert.equal(afterPolicy.result.counts?.trusted, 0, "policy-satisfying is a strictly stronger claim, not an extra one");
});

test("key rotation adds a signature and leaves the decision id byte identical", async () => {
  const fixture = await adoptedWithOneReverie("rotation-");
  await withSigningKey(fixture, "alice@example.test");
  assert.equal((await signOnce(fixture, fixture.reverieId)).code, 0);
  const first = await verifyJson(fixture, [fixture.reverieId]);
  assert.equal(first.result.signatures?.length, 1);

  // Rotate: a second key, the same stable identity.
  const rotated = join(fixture.outside, "rotated.pem");
  const pair = generateEd25519KeyPair();
  const publicPath = join(fixture.outside, "rotated.pub.pem");
  await writeFile(publicPath, pair.publicKey, "utf8");
  const add = captureIo(fixture.directory);
  assert.equal(await runCli(["trust", "add", "--signer", "alice@example.test", "--from-file", publicPath, "--json"], add.io), 0);
  await writeFile(rotated, pair.privateKey, { encoding: "utf8", mode: 0o600 });
  await git(fixture.directory, "config", "reveries.signingKey", rotated);

  assert.equal((await signOnce(fixture, fixture.reverieId)).code, 0);

  const after = await verifyJson(fixture, [fixture.reverieId]);
  assert.equal(after.result.signatures?.length, 2, "rotation is a second signature over the same target");
  const keyIds = new Set(after.result.signatures?.map((row) => row.key_id));
  assert.equal(keyIds.size, 2, "both keys are still trusted under the same identity");
  // The decision itself never moved: the reverie line is untouched, so a rotation
  // cannot invalidate a published decision.
  const note = await (await Reveries.open(fixture.directory)).repository.readNote(await objectId(fixture.blob));
  assert.match(note ?? "", new RegExp(fixture.reverieId));
  // The signature records name the target, so counting by id would count them
  // too. Only the decision line itself is what must be untouched.
  const decisions = (note ?? "").split("\n").filter((line) => line.includes('"type":"reverie"'));
  assert.equal(decisions.length, 1, "the reverie line is unchanged and not duplicated");
  assert.equal(decisions[0]?.includes(fixture.reverieId), true);
});

test("sign refuses a key the trust store does not authorize", async () => {
  const fixture = await adoptedWithOneReverie("unauthorized-");
  const pair = generateEd25519KeyPair();
  const keyPath = join(fixture.outside, "unknown.pem");
  await writeFile(keyPath, pair.privateKey, "utf8");
  await git(fixture.directory, "config", "reveries.signingKey", keyPath);
  const io = captureIo(fixture.directory);

  const code = await runCli(["sign", fixture.reverieId], io.io);

  assert.equal(code, 1);
  assert.match(io.stdout(), /has no entry in/);
  assert.match(io.stdout(), /reveries trust add/);
});

test("sign refuses a target that is not in the current notes", async () => {
  const fixture = await adoptedWithOneReverie("no-target-");
  await withSigningKey(fixture, "alice@example.test");
  const io = captureIo(fixture.directory);

  const code = await runCli(["sign", `rv:${"0".repeat(40)}`], io.io);

  assert.equal(code, 3);
  assert.match(io.stderr(), /No record with id/);
});

test("sign refuses a target that is not an ID-bearing record", async () => {
  const fixture = await adoptedWithOneReverie("no-identity-");
  await withSigningKey(fixture, "alice@example.test");
  const io = captureIo(fixture.directory);

  const code = await runCli(["sign", "ledger-manifest"], io.io);

  assert.equal(code, 3);
});

test("sign reports an unconfigured key as an ordinary unsigned state", async () => {
  const fixture = await adoptedWithOneReverie("nokey-");
  const io = captureIo(fixture.directory);

  assert.equal(await runCli(["sign", fixture.reverieId], io.io), 0);

  assert.match(io.stdout(), /No signing key is configured/);
  assert.equal((await verifyJson(fixture, [])).result.counts?.unknown, 0, "nothing was written");
});

test("sign does not present the signature record's own metadata as attested", async () => {
  const fixture = await adoptedWithOneReverie("metadata-");
  await withSigningKey(fixture, "alice@example.test");
  const signed = await signOnce(fixture, fixture.reverieId);
  assert.equal(signed.code, 0, signed.err);

  // The signed payload is the eight protocol fields; `author_email`, `session`,
  // and `created_at` of the signature record are outside it and outside the record
  // ID, so nothing in the output may claim they are attested.
  const payload = (JSON.parse(signed.out) as { result: { record: Record<string, unknown> } }).result.record;
  for (const field of ["author_email", "session", "created_at"]) {
    assert.ok(field in payload, `the record does carry ${field}`);
  }
  const human = captureIo(fixture.directory);
  assert.equal(await runCli(["sign", fixture.reverieId, "--role", "reviewer"], human.io), 0);
  assert.doesNotMatch(human.stdout(), /signed at/i);
  assert.doesNotMatch(human.stdout(), new RegExp(payload.created_at as string));
  assert.match(human.stdout(), /attests the exact canonical bytes/);
});

// Verification
// -------------------------------------------------------------------------------

test("verify reports every state at face value and fails only for invalid or revoked", async () => {
  const fixture = await adoptedWithOneReverie("states-");
  const { keyId } = await withSigningKey(fixture, "alice@example.test");
  assert.equal((await signOnce(fixture, fixture.reverieId)).code, 0);

  // `valid`: the bytes verify and a key is present, but the store binds that key
  // to a different identity, so cryptographic validity is not established
  // identity. The same public key is reused deliberately: a different key would
  // leave the record's key unknown rather than known-but-unbound.
  const publicKey = (await readLocalTrustStore((await Reveries.open(fixture.directory)).repository))
    .file.keys[0]?.public_key ?? "";
  const publicPath = join(fixture.outside, "rebound.pub.pem");
  await writeFile(publicPath, publicKey, "utf8");
  const drop = captureIo(fixture.directory);
  assert.equal(await runCli(["trust", "remove", "--key", keyId], drop.io), 0, drop.stderr());
  const rebind = captureIo(fixture.directory);
  assert.equal(await runCli(["trust", "add", "--signer", "other@example.test", "--from-file", publicPath], rebind.io), 0, rebind.stderr());

  const valid = await verifyJson(fixture, []);
  assert.equal(valid.code, 0, "a valid-but-unbound signature is not a failure");
  assert.equal(valid.result.signatures?.[0]?.state, "valid");
  assert.equal(valid.result.signatures?.[0]?.signer, "alice@example.test", "the record still names its own signer");
});

test("verify --require-policy fails for every state below policy-satisfying", async () => {
  // absent
  const absent = await adoptedWithOneReverie("policy-absent-");
  const absentResult = await verifyJson(absent, ["--require-policy"]);
  assert.equal(absentResult.code, 1);
  assert.match(absentResult.diagnostics.join(" "), /No signature reaches policy-satisfying/);

  // trusted, with a policy that does not include the signed role
  const trusted = await adoptedWithOneReverie("policy-trusted-");
  await withSigningKey(trusted, "alice@example.test");
  assert.equal((await signOnce(trusted, trusted.reverieId)).code, 0);
  const set = captureIo(trusted.directory);
  assert.equal(await runCli(["policy", "set", "reviewer"], set.io), 0);
  const trustedResult = await verifyJson(trusted, ["--require-policy"]);
  assert.equal(trustedResult.code, 1, "a trusted signature whose role is not required does not satisfy the policy");
  assert.equal(trustedResult.result.counts?.trusted, 1);
  assert.match(trustedResult.diagnostics.join(" "), /strongest state present is trusted/);

  // unknown: a key nobody in this repository trusts
  const unknown = await adoptedWithOneReverie("policy-unknown-");
  const pair = generateEd25519KeyPair();
  const publicPath = join(unknown.outside, "stranger.pub.pem");
  await writeFile(publicPath, pair.publicKey, "utf8");
  const strangerKey = join(unknown.outside, "stranger.pem");
  await writeFile(strangerKey, pair.privateKey, "utf8");
  await git(unknown.directory, "config", "reveries.signingKey", strangerKey);
  // The key is authorized under a different identity, so the signature verifies
  // but the store does not bind it to the claimed signer.
  const stranger = captureIo(unknown.directory);
  assert.equal(await runCli(["trust", "add", "--signer", "nobody@example.test", "--from-file", publicPath], stranger.io), 0, stranger.stderr());
  assert.equal((await signOnce(unknown, unknown.reverieId)).code, 0);
  const unknownResult = await verifyJson(unknown, ["--require-policy"]);
  assert.equal(unknownResult.code, 1);

  // revoked
  const revoked = await adoptedWithOneReverie("policy-revoked-");
  const revokedKey = await withSigningKey(revoked, "alice@example.test");
  assert.equal((await signOnce(revoked, revoked.reverieId)).code, 0);
  const revoke = captureIo(revoked.directory);
  assert.equal(await runCli(["trust", "revoke", "--key", revokedKey.keyId], revoke.io), 0, revoke.stderr());
  const revokedResult = await verifyJson(revoked, ["--require-policy"]);
  assert.equal(revokedResult.code, 1);
  assert.match(revokedResult.diagnostics.join(" "), /is revoked/);
});

test("verify --require-policy passes only when something is policy-satisfying", async () => {
  const fixture = await adoptedWithOneReverie("policy-pass-");
  await withSigningKey(fixture, "alice@example.test");
  assert.equal((await signOnce(fixture, fixture.reverieId)).code, 0);
  assert.equal((await runCli(["policy", "set", "author"], captureIo(fixture.directory).io)), 0);

  const result = await verifyJson(fixture, ["--require-policy"]);

  assert.equal(result.code, 0, result.diagnostics.join(" "));
  assert.equal(result.result.counts?.["policy-satisfying"], 1);
});

test("verify --require-policy fails on an unsigned repository even with a policy set", async () => {
  const fixture = await adoptedWithOneReverie("policy-unsigned-");
  assert.equal((await runCli(["policy", "set", "author"], captureIo(fixture.directory).io)), 0);

  const result = await verifyJson(fixture, ["--require-policy"]);

  assert.equal(result.code, 1);
  assert.match(result.diagnostics.join(" "), /no signatures/);
});

test("verify scoped to a target narrows to that target's signatures", async () => {
  const fixture = await adoptedWithOneReverie("scoped-");
  await withSigningKey(fixture, "alice@example.test");
  assert.equal((await signOnce(fixture, fixture.reverieId)).code, 0);

  const scoped = await verifyJson(fixture, [fixture.reverieId]);

  assert.equal(scoped.code, 0);
  assert.equal(scoped.result.signatures?.length, 1);
  assert.equal(scoped.result.signatures?.[0]?.target, fixture.reverieId);
});

test("verify refuses an unknown target rather than reporting an empty success", async () => {
  const fixture = await adoptedWithOneReverie("scoped-missing-");
  const io = captureIo(fixture.directory);

  assert.equal(await runCli(["verify", `rv:${"1".repeat(40)}`], io.io), 3);

  assert.match(io.stderr(), /No record with id/);
});

test("verify --ledger reports the checkpoint attestation and fails once the key is revoked", async () => {
  const fixture = await adoptedWithOneReverie("ledger-verify-");
  const { keyId } = await withSigningKey(fixture, "publisher@example.test");
  assert.equal((await runCli(["role", "set", "origin", "primary"], captureIo(fixture.directory).io)), 0);
  const built = captureIo(fixture.directory);
  assert.equal(await runCli(["ledger", "build", "--json"], built.io), 0, built.stderr());
  assert.equal((JSON.parse(built.stdout()) as { result: { checkpoint: string } }).result.checkpoint !== null, true);

  const signed = await verifyJson(fixture, ["--ledger"]);
  assert.equal(signed.code, 0, signed.diagnostics.join(" "));
  assert.equal(signed.result.signature?.state, "trusted");

  // The ledger signature's timestamp is a fixed reproducibility constant, never a
  // signing time, so no date is rendered.
  const human = captureIo(fixture.directory);
  assert.equal(await runCli(["verify", "--ledger"], human.io), 0);
  assert.doesNotMatch(human.stdout(), /1970-01-01/);

  const revoke = captureIo(fixture.directory);
  assert.equal(await runCli(["trust", "revoke", "--key", keyId], revoke.io), 0, revoke.stderr());
  const afterRevoke = await verifyJson(fixture, ["--ledger"]);
  assert.equal(afterRevoke.code, 1);
  assert.match(afterRevoke.diagnostics.join(" "), /revoked/);
});

test("verify --ledger always fails on a structurally invalid envelope", async () => {
  const fixture = await adoptedWithOneReverie("ledger-broken-");
  const built = captureIo(fixture.directory);
  assert.equal(await runCli(["ledger", "build", "--json"], built.io), 0, built.stderr());
  const checkpoint = objectId((JSON.parse(built.stdout()) as { result: { checkpoint: string } }).result.checkpoint);

  // Forge an envelope that contradicts the agreed shape: a fourth tree entry
  // beside `manifest.json`, `notes/`, and `signatures/`. This is the RVR-019
  // `review/` slot, and until that contract exists the envelope must refuse it.
  const repository = (await Reveries.open(fixture.directory)).repository;
  const manifest = readLedgerManifest((await repository.readLedgerManifestAt(checkpoint)) ?? "");
  const notesTree = (await repository.run(["rev-parse", `${checkpoint}^{tree}:notes`])).stdout.trim();
  const extra = await repository.writeBlob("a projection this protocol has not agreed\n");
  const entries = [
    `100644 blob ${await repository.run(["rev-parse", `${checkpoint}^{tree}:manifest.json`]).then((r) => r.stdout.trim())}\tmanifest.json`,
    `040000 tree ${notesTree}\tnotes`,
    `100644 blob ${extra}\treview`,
  ];
  const tree = (await repository.run(["mktree"], { input: `${entries.join("\n")}\n` })).stdout.trim();
  const args = ["commit-tree", tree];
  for (const parent of [manifest?.notes_commit, manifest?.retention_commit].filter((value) => value !== null)) {
    if (parent !== undefined) args.push("-p", parent);
  }
  args.push("-m", "Reveries ledger checkpoint");
  const forged = (await repository.run(args)).stdout.trim();
  await repository.run(["update-ref", LEDGER_REF, forged, checkpoint]);

  const result = await verifyJson(fixture, ["--ledger", "--require-policy"]);

  assert.equal(result.code, 1, "a broken envelope is damage regardless of policy");
  assert.equal(result.result.envelope?.ok, false);
  assert.match(result.diagnostics.join(" "), /not part of the ledger envelope/);
});

test("a tampered content id makes the cryptographic signature invalid", async () => {
  const fixture = await adoptedWithOneReverie("tamper-");
  await withSigningKey(fixture, "alice@example.test");
  assert.equal((await signOnce(fixture, fixture.reverieId)).code, 0);
  const repository = (await Reveries.open(fixture.directory)).repository;
  const body = await repository.readNote(await objectId(fixture.blob));
  const record = JSON.parse((body ?? "").split("\n").find((line) => line.includes('"type":"signature"')) ?? "{}") as {
    content_id: string;
    signature: string;
  };
  assert.equal(typeof record.content_id, "string");
  // Rewrite the signature bytes. The record ID changes with them, which the strict
  // note validator reports separately; what this pins is that the bytes no longer
  // verify, so the attestation is `invalid` rather than quietly still trusted.
  const forged = Buffer.from(record.signature, "base64");
  forged[0] = (forged[0] ?? 0) ^ 0xff;
  const rewritten = (body ?? "").replace(record.signature, forged.toString("base64"));
  await repository.withNotesWrite(async (notes) => {
    await notes.replace(await objectId(fixture.blob), `${rewritten}\n`);
  });

  const result = await verifyJson(fixture, []);

  assert.equal(result.code, 1);
  assert.equal(result.result.signatures?.[0]?.state, "invalid");
});

// Installer integration
// -------------------------------------------------------------------------------

test("init creates the trust store once and never replaces an existing one", async () => {
  const base = await root();
  const directory = join(base, "repo");
  await mkdir(directory);
  await git(directory, "init", "-b", "main");
  await git(directory, "config", "user.name", "Init Test");
  await git(directory, "config", "user.email", "init@example.com");
  const options = {
    hosts: [] as const,
    publishingRemotes: [] as string[],
    directiveEmail: "init@example.com",
    skillSetup: { kind: "reminder" as const },
  };

  const first = await initializeRepository(directory, options);

  assert.equal(first.trustStoreCreated, true);
  assert.match(first.trustStorePath, /reveries\/trust\.json$/);
  const store = await readLocalTrustStore((await Reveries.open(directory)).repository);
  assert.equal(store.present, true);
  assert.deepEqual(store.file.keys, []);
  assert.equal(first.nextCommands.some((command) => command.includes("trust add")), true);

  // An operator's own entry must survive a repeated initialization.
  const pair = generateEd25519KeyPair();
  const pemPath = join(base, "public.pem");
  await writeFile(pemPath, pair.publicKey, "utf8");
  const addEntry = captureIo(directory);
  assert.equal(await runCli(["trust", "add", "--signer", "alice@example.test", "--from-file", pemPath], addEntry.io), 0, addEntry.stderr());

  const second = await initializeRepository(directory, options);

  assert.equal(second.trustStoreCreated, false, "an existing trust store is left alone");
  const after = await readLocalTrustStore((await Reveries.open(directory)).repository);
  assert.equal(after.file.keys.length, 1);
  assert.equal(after.file.keys[0]?.signer, "alice@example.test");
});

test("an existing trust store survives a failed initialization untouched", async () => {
  const base = await root();
  const directory = join(base, "repo");
  await mkdir(directory);
  await git(directory, "init", "-b", "main");
  await git(directory, "config", "user.name", "Init Test");
  await git(directory, "config", "user.email", "init@example.com");
  const pair = generateEd25519KeyPair();
  const pemPath = join(base, "public.pem");
  await writeFile(pemPath, pair.publicKey, "utf8");
  // Write the store through the command before initialization has ever run.
  await mkdir(join(directory, ".git", "reveries"), { recursive: true });
  await writeFile(
    join(directory, ".git", "reveries", "trust.json"),
    `${JSON.stringify({ keys: [{ key_id: pair.keyId, signer: "alice@example.test", revoked: false, public_key: pair.publicKey }] }, null, 2)}\n`,
    "utf8",
  );
  // A malformed marker makes initialization fail partway through.
  await writeFile(join(directory, "AGENTS.md"), "<!-- reveries:begin -->\n<!-- reveries:begin -->\n", "utf8");

  await assert.rejects(
    initializeRepository(directory, {
      hosts: [],
      publishingRemotes: [],
      directiveEmail: "init@example.com",
      skillSetup: { kind: "reminder" },
    }),
  );

  const after = await readLocalTrustStore((await Reveries.open(directory)).repository);
  assert.equal(after.file.keys.length, 1, "a failed setup must not disturb existing trust");
  assert.equal(after.file.keys[0]?.key_id, pair.keyId);
});

test("a trust store that is not readable as a file is left in place by init", async () => {
  const base = await root();
  const directory = join(base, "repo");
  await mkdir(directory);
  await git(directory, "init", "-b", "main");
  await git(directory, "config", "user.name", "Init Test");
  await git(directory, "config", "user.email", "init@example.com");
  // A directory where the store belongs: an unreadable store is a real problem,
  // and setup must surface it rather than pretend the store is absent.
  await mkdir(join(directory, ".git", "reveries", "trust.json"), { recursive: true });

  await assert.rejects(initializeRepository(directory, {
    hosts: [],
    publishingRemotes: [],
    directiveEmail: "init@example.com",
    skillSetup: { kind: "reminder" },
  }));

  assert.equal((await stat(join(directory, ".git", "reveries", "trust.json"))).isDirectory(), true);
});

// Rollback and key-format boundaries
// -------------------------------------------------------------------------------

test("a failed trust store write rolls back the private key it just created", async () => {
  // `trust init` writes the key before the store, so a store failure would
  // otherwise leave a key behind whose only trace is an EEXIST refusal on the
  // next attempt. A retry must work.
  const fixture = await adoptedWithOneReverie("rollback-");
  const keyPath = join(fixture.outside, "signing.pem");
  // A directory where the store belongs makes the write fail *after* the key
  // exists, which is the ordering that has to be recoverable.
  await mkdir(join(fixture.directory, ".git", "reveries", "trust.json"), { recursive: true });

  const first = captureIo(fixture.directory);
  assert.notEqual(await runCli(["trust", "init", "--signer", "alice@example.test", "--key-file", keyPath], first.io), 0);
  assert.equal(
    await stat(keyPath).then(() => true, () => false),
    false,
    "a key the failed run could not register must not be left behind",
  );

  // Clear the obstruction and retry: the same command must now succeed, which is
  // only possible if the first run left no residue.
  await rm(join(fixture.directory, ".git", "reveries", "trust.json"), { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  const retry = captureIo(fixture.directory);
  assert.equal(
    await runCli(["trust", "init", "--signer", "alice@example.test", "--key-file", keyPath], retry.io),
    0,
    retry.stderr(),
  );
  assert.equal((await stat(keyPath)).mode & 0o777, 0o600);
  assert.equal((await readLocalTrustStore((await Reveries.open(fixture.directory)).repository)).file.keys.length, 1);
});

test("a rollback never removes a key that already existed", async () => {
  // The exclusive create is what makes a rollback safe: a pre-existing key can
  // only produce EEXIST, and that refusal must leave the operator's key alone.
  const fixture = await adoptedWithOneReverie("rollback-existing-");
  const keyPath = join(fixture.outside, "signing.pem");
  const existing = await generateEd25519KeyPair();
  await writeFile(keyPath, existing.privateKey, "utf8");
  await mkdir(join(fixture.directory, ".git", "reveries", "trust.json"), { recursive: true });

  const io = captureIo(fixture.directory);
  assert.notEqual(await runCli(["trust", "init", "--signer", "alice@example.test", "--key-file", keyPath], io.io), 0);

  assert.equal(
    await readFile(keyPath, "utf8"),
    existing.privateKey,
    "a key this run did not create must survive untouched",
  );
});

test("trust add refuses a private key rather than storing secret material", async () => {
  // A PKCS#8 private key parses as a key, so it would pass a naive check and be
  // written into a file the project documents as public material only.
  const fixture = await adoptedWithOneReverie("private-add-");
  const pair = generateEd25519KeyPair();
  const pemPath = join(fixture.outside, "private.pem");
  await writeFile(pemPath, pair.privateKey, "utf8");
  const io = captureIo(fixture.directory);

  assert.equal(await runCli(["trust", "add", "--signer", "alice@example.test", "--from-file", pemPath], io.io), 3);

  assert.match(io.stderr(), /public key/);
  const store = await readLocalTrustStore((await Reveries.open(fixture.directory)).repository);
  assert.deepEqual(store.file.keys, [], "nothing may be written when the input was refused");
});

test("trust add refuses an unsupported key format with a named format", async () => {
  const fixture = await adoptedWithOneReverie("openssh-add-");
  const pemPath = join(fixture.outside, "id_ed25519.pub");
  await writeFile(pemPath, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl me@example.test\n", "utf8");
  const io = captureIo(fixture.directory);

  assert.equal(await runCli(["trust", "add", "--signer", "alice@example.test", "--from-file", pemPath], io.io), 3);

  // An OpenSSH public key is a legitimate key, so the refusal has to say which
  // formats are accepted rather than surfacing a decoder error.
  assert.match(io.stderr(), /PEM/);
  assert.match(io.stderr(), /OpenSSH/);
  assert.doesNotMatch(io.stderr(), /DECODER|0E08010C/, "a low-level decoder error is not an explanation");
});

test("an accepted public key derives the same identity the verifier will use", async () => {
  const fixture = await adoptedWithOneReverie("key-roundtrip-");
  const pair = generateEd25519KeyPair();
  const pemPath = join(fixture.outside, "public.pem");
  await writeFile(pemPath, pair.publicKey, "utf8");
  const add = captureIo(fixture.directory);

  assert.equal(await runCli(["trust", "add", "--signer", "alice@example.test", "--from-file", pemPath, "--json"], add.io), 0, add.stderr());

  const keyId = (JSON.parse(add.stdout()) as { result: { key_id: string } }).result.key_id;
  assert.equal(keyId, pair.keyId, "the stored identity is the fingerprint of the stored key");
  // Normalisation must not change what a verifier does with the stored bytes.
  const store = await readLocalTrustStore((await Reveries.open(fixture.directory)).repository);
  const stored = store.verifierKeys[keyId];
  assert.ok(stored !== undefined, "the key must be resolvable by the stored identity");
  assert.match(stored, /BEGIN PUBLIC KEY/);
});

test("--require-policy with no policy configured fails with an actionable message", async () => {
  const fixture = await adoptedWithOneReverie("policy-empty-");
  await withSigningKey(fixture, "alice@example.test");
  assert.equal((await signOnce(fixture, fixture.reverieId)).code, 0);

  const result = await verifyJson(fixture, ["--require-policy"]);

  // `trusted` is not `policy-satisfying`; equating them would make the flag
  // meaningless. The failure has to tell an operator how to get there.
  assert.equal(result.code, 1);
  assert.equal(result.result.counts?.trusted, 1);
  assert.equal(result.result.counts?.["policy-satisfying"], 0);
  const message = result.diagnostics.join(" ");
  assert.match(message, /policy-satisfying/);
  assert.match(message, /reveries\.signingRoles|reveries policy set/, "the message must name the way out");
});
