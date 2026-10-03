import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";

import { Reveries } from "../src/operations.ts";

const execFileAsync = promisify(execFile);
const temporaryRepositories: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

async function createRepository(prefix = "reveries-authority-"): Promise<string> {
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

/** A repository with the given publishing remotes and roles configured. */
async function authorityRepository(
  remotes: readonly string[],
  roles: Readonly<Record<string, string>>,
): Promise<string> {
  const directory = await createRepository();
  for (const remote of remotes) await git(directory, "remote", "add", remote, "https://example.invalid/x.git");
  for (const remote of remotes) {
    await git(directory, "config", "--add", "reveries.publishingRemote", remote);
  }
  for (const [remote, role] of Object.entries(roles)) {
    await git(directory, "config", `reveries.remoteRole.${remote}`, role);
  }
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryRepositories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/**
 * RVR-017 makes the source of authoritative publication explicit. The rule that
 * matters operationally is that absence is ordinary: a repository that never
 * adopted roles, or that has exactly one publisher, must keep reporting healthy,
 * or every existing V1 setup would flip to damaged on upgrade. Only a
 * configuration that contradicts itself is damage.
 */

test("a repository with no publishing remote has absent authority", async () => {
  const directory = await createRepository();
  const status = await (await Reveries.open(directory)).authorityStatus();
  assert.equal(status.state, "absent");
  assert.equal(status.primary, null);
  assert.deepEqual(status.diagnostics, []);
});

test("a single publishing remote is an inferred primary without any configuration", async () => {
  const directory = await authorityRepository(["origin"], {});
  const status = await (await Reveries.open(directory)).authorityStatus();
  assert.equal(status.state, "inferred");
  assert.equal(status.primary, "origin");
  // Inference needs no diagnostic: the repository has an unambiguous source
  // already, and reporting otherwise would be noise.
  assert.deepEqual(status.diagnostics, []);
});

test("several publishing remotes with no declared role are unconfigured, not damaged", async () => {
  const directory = await authorityRepository(["alpha", "beta"], {});
  const status = await (await Reveries.open(directory)).authorityStatus();
  assert.equal(status.state, "unconfigured");
  assert.equal(status.primary, null);
  assert.deepEqual(status.diagnostics, []);
  assert.match(status.notice, /alpha/);
  assert.match(status.notice, /beta/);
});

test("a declared primary among several remotes is the authoritative one", async () => {
  const directory = await authorityRepository(
    ["alpha", "beta", "vendor"],
    { alpha: "primary", beta: "mirror", vendor: "import-only" },
  );
  const status = await (await Reveries.open(directory)).authorityStatus();
  assert.equal(status.state, "configured");
  assert.equal(status.primary, "alpha");
  assert.equal(status.roles.get("beta"), "mirror");
  assert.equal(status.roles.get("vendor"), "import-only");
});

test("two declared primaries are a diagnostic naming both remotes", async () => {
  const directory = await authorityRepository(["alpha", "beta"], { alpha: "primary", beta: "primary" });
  const status = await (await Reveries.open(directory)).authorityStatus();
  assert.equal(status.state, "invalid");
  assert.equal(status.primary, null);
  const message = status.diagnostics.join(" ");
  assert.match(message, /alpha/);
  assert.match(message, /beta/);
  assert.match(message, /exactly one primary/i);
});

test("an unknown role is a diagnostic naming the valid set, not a crash", async () => {
  const directory = await authorityRepository(["alpha"], { alpha: "leader" });
  // The throw is what `doctor` turns into a diagnostic. Letting it escape would
  // make a typo look like a crash and hide the rest of the report.
  await assert.rejects(
    () => (async () => (await Reveries.open(directory)).authorityStatus())(),
    /reveries\.remoteRole/,
  );
  await assert.rejects(
    () => (async () => (await Reveries.open(directory)).authorityStatus())(),
    /primary, mirror, archive, import-only/,
  );
});

test("doctor surfaces a bad role value as a diagnostic rather than crashing", async () => {
  const directory = await authorityRepository(["alpha"], { alpha: "leader" });
  const doctor = await (await Reveries.open(directory)).doctor();
  assert.equal(doctor.ok, false);
  assert.equal(doctor.state, "damaged");
  assert.match(doctor.diagnostics.join(" "), /reveries\.remoteRole/);
});

test("doctor reports a valid authority configuration as a notice, not damage", async () => {
  const directory = await authorityRepository(["alpha", "beta"], { alpha: "primary", beta: "mirror" });
  const reveries = await Reveries.open(directory);
  const doctor = await reveries.doctor();
  // A configured primary is the healthy case. The remote loop will still report
  // fetch-refspec problems for these bare repositories, so this asserts on the
  // authority notice rather than on the whole doctor result.
  assert.match(doctor.notices.join(" "), /Authority: configured; primary alpha/);
  assert.doesNotMatch(doctor.diagnostics.join(" "), /primary/i);
});

test("doctor reports two primaries as damage", async () => {
  const directory = await authorityRepository(["alpha", "beta"], { alpha: "primary", beta: "primary" });
  const doctor = await (await Reveries.open(directory)).doctor();
  assert.equal(doctor.state, "damaged");
  assert.match(doctor.diagnostics.join(" "), /exactly one primary/i);
});

test("doctor reports the counts of each non-primary role", async () => {
  const directory = await authorityRepository(
    ["alpha", "backup", "vault", "vendor"],
    { alpha: "primary", backup: "mirror", vault: "archive", vendor: "import-only" },
  );
  const doctor = await (await Reveries.open(directory)).doctor();
  assert.match(doctor.notices.join(" "), /1 mirror\(s\), 1 archive\(s\), 1 import-only/);
});

test("doctor does not report an unfetched mirror as damage", async () => {
  const directory = await authorityRepository(["alpha", "backup"], { alpha: "primary", backup: "mirror" });
  const reveries = await Reveries.open(directory);
  const mirrors = await reveries.verifyMirrorEnvelopes();
  assert.equal(mirrors.length, 1);
  assert.equal(mirrors[0]?.state, "unavailable");
  // An unfetched mirror is a state, not a contradiction, so its own message is
  // reported once and never duplicated into the diagnostic list.
  const doctor = await reveries.doctor();
  assert.doesNotMatch(doctor.diagnostics.join(" "), /no fetched ledger checkpoint/);
  assert.match(doctor.notices.join(" "), /Mirror backup: unavailable/);
});

test("a mirror role alone does not make doctor report damage", async () => {
  const directory = await authorityRepository(["alpha", "backup"], { alpha: "primary", backup: "mirror" });
  const doctor = await (await Reveries.open(directory)).doctor();
  const authority = doctor.diagnostics.filter((entry) => /Authority|primary|mirror/i.test(entry));
  assert.deepEqual(authority, []);
});
