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
} from "../src/git.ts";
import { Reveries } from "../src/operations.ts";
import { SIGNATURE_ROLES, type SignatureRole } from "../src/protocol.ts";

const execFileAsync = promisify(execFile);
const temporaryRepositories: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

async function createRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "reveries-roles-"));
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
  await Promise.all(temporaryRepositories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/**
 * `reveries.signingRoles` is where Q4 put role requirements, so without this
 * read the `policy-satisfying` trust state is unreachable in practice and the
 * decision is hollow. These tests pin the read, the override, and the refusal to
 * silently ignore a typo.
 */

test("an absent signingRoles key means no role is required", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const status = await reveries.signatureStatus();
  assert.deepEqual(status.requiredRoles, []);
  // With no required role, `trusted` is the honest ceiling.
  assert.deepEqual(status.counts["policy-satisfying"], 0);
});

test("a valid multi-role signingRoles value is read in order", async () => {
  const directory = await createRepository();
  await git(directory, "config", "reveries.signingRoles", "reviewer,author");
  const reveries = await Reveries.open(directory);
  const status = await reveries.signatureStatus();
  assert.deepEqual(status.requiredRoles, ["reviewer", "author"]);
});

test("a single role is accepted", async () => {
  const directory = await createRepository();
  await git(directory, "config", "reveries.signingRoles", "publisher");
  const reveries = await Reveries.open(directory);
  assert.deepEqual((await reveries.signatureStatus()).requiredRoles, ["publisher"]);
});

test("surrounding whitespace and empty list items are tolerated", async () => {
  const directory = await createRepository();
  await git(directory, "config", "reveries.signingRoles", " author , reviewer ,");
  const reveries = await Reveries.open(directory);
  assert.deepEqual((await reveries.signatureStatus()).requiredRoles, ["author", "reviewer"]);
});

test("an empty value requires no role", async () => {
  const directory = await createRepository();
  await git(directory, "config", "reveries.signingRoles", "");
  const reveries = await Reveries.open(directory);
  assert.deepEqual((await reveries.signatureStatus()).requiredRoles, []);
});

test("an unknown role is rejected with a diagnostic naming the valid roles", async () => {
  const directory = await createRepository();
  await git(directory, "config", "reveries.signingRoles", "author,owner");
  const reveries = await Reveries.open(directory);
  await assert.rejects(
    () => reveries.signatureStatus(),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /reveries\.signingRoles/);
      assert.match(message, /owner/, "the diagnostic must name the offending role");
      for (const role of SIGNATURE_ROLES) assert.match(message, new RegExp(role));
      return true;
    },
  );
});

test("every valid role is accepted by the config read", async () => {
  const directory = await createRepository();
  await git(directory, "config", "reveries.signingRoles", SIGNATURE_ROLES.join(","));
  const reveries = await Reveries.open(directory);
  assert.deepEqual((await reveries.signatureStatus()).requiredRoles, [...SIGNATURE_ROLES]);
});

test("explicit SigningOptions.requiredRoles overrides the config key", async () => {
  const directory = await createRepository();
  await git(directory, "config", "reveries.signingRoles", "publisher");
  // An explicit option wins, so a caller's intent is not silently overridden by
  // repository configuration.
  const reveries = await Reveries.open(directory, { requiredRoles: ["author"] as readonly SignatureRole[] });
  assert.deepEqual((await reveries.signatureStatus()).requiredRoles, ["author"]);
});

test("an explicit empty override still wins over a configured role", async () => {
  const directory = await createRepository();
  await git(directory, "config", "reveries.signingRoles", "author,reviewer");
  const reveries = await Reveries.open(directory, { requiredRoles: [] });
  assert.deepEqual((await reveries.signatureStatus()).requiredRoles, []);
});

test("a bad config value still fails when roles are supplied explicitly", async () => {
  const directory = await createRepository();
  await git(directory, "config", "reveries.signingRoles", "owner");
  // The override short-circuits the config read, so a repository with a typo
  // does not break a caller that stated its own policy.
  const reveries = await Reveries.open(directory, { requiredRoles: ["author"] as readonly SignatureRole[] });
  assert.deepEqual((await reveries.signatureStatus()).requiredRoles, ["author"]);
});

test("the configured roles decide which signatures reach policy-satisfying", async () => {
  const directory = await createRepository();
  const pair = generateEd25519KeyPair();
  const signer: SignatureSigner = createLocalEd25519Signer({
    signer: "alice@example.test",
    keyId: pair.keyId,
    privateKey: pair.privateKey,
  });
  await git(directory, "config", "reveries.signingRoles", "reviewer");

  const reveries = await Reveries.open(directory, {
    signer,
    verifier: createLocalEd25519Verifier({ [pair.keyId]: pair.publicKey }),
    trust: { keys: [{ key_id: pair.keyId, signer: "alice@example.test", revoked: false }] },
  });

  const author = await reveries.signRecord({
    target: {
      v: 1,
      type: "reverie",
      id: `rv:${"a".repeat(40)}`,
      driving_event: "Roles were only a plan.",
      decision: "Read the required roles from configuration.",
      impact: "The policy-satisfying state becomes reachable.",
      recurrence_control: null,
      alternatives: [],
      sources: [],
      supersedes: [],
      author_email: "reveries@example.com",
      session: null,
      created_at: "2026-09-29T21:11:20Z",
    } as never,
    subject: (await reveries.repository.resolvePath({ path: "state.txt", revision: "HEAD" })),
    role: "author",
    metadata: { author_email: "reveries@example.com", session: null, created_at: "2026-09-29T21:11:20Z" },
  });
  assert.equal(author.state, "signed");

  const reviewer = await reveries.signRecord({
    target: {
      v: 1,
      type: "reverie",
      id: `rv:${"a".repeat(40)}`,
      driving_event: "Roles were only a plan.",
      decision: "Read the required roles from configuration.",
      impact: "The policy-satisfying state becomes reachable.",
      recurrence_control: null,
      alternatives: [],
      sources: [],
      supersedes: [],
      author_email: "reveries@example.com",
      session: null,
      created_at: "2026-09-29T21:11:20Z",
    } as never,
    subject: (await reveries.repository.resolvePath({ path: "state.txt", revision: "HEAD" })),
    role: "reviewer",
    metadata: { author_email: "reveries@example.com", session: null, created_at: "2026-09-29T21:11:20Z" },
  });
  assert.equal(reviewer.state, "signed");

  const reports = await reveries.signatureReports();
  const states = (reports.get(`rv:${"a".repeat(40)}`) ?? []).map((report) => report.state).sort();
  // Only the reviewer satisfies the configured policy; the author is merely
  // trusted. This is the state the Q4 decision exists to express.
  assert.deepEqual(states, ["policy-satisfying", "trusted"]);

  const status = await reveries.signatureStatus();
  assert.equal(status.counts["policy-satisfying"], 1);
  assert.equal(status.counts.trusted, 1);
  assert.deepEqual(status.requiredRoles, ["reviewer"]);
});

test("doctor surfaces a bad signingRoles value as a diagnostic, not a crash", async () => {
  const directory = await createRepository();
  await git(directory, "config", "reveries.signingRoles", "owner");
  const reveries = await Reveries.open(directory);
  const doctor = await reveries.doctor();
  assert.equal(doctor.ok, false);
  assert.equal(doctor.state, "damaged");
  assert.match(doctor.diagnostics.join(" "), /reveries\.signingRoles/);
});
