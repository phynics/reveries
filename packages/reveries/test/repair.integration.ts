import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";

import { runCli, type CliIo } from "../src/cli.ts";
import { commitAdoption, initializeRepository, repairLocalIntegration } from "../src/install.ts";
import { Reveries } from "../src/operations.ts";
import type { ReveriesInit, SessionSummary } from "../src/protocol.ts";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const helper = {
  command: "/bin/sh",
  args: ["-c", "if [ \"$1\" = --version ]; then echo 'reveries 1.0.2'; fi", "reveries-repair-helper"],
  verification: "probe",
} as const;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

async function configValue(cwd: string, key: string): Promise<string> {
  const result = await execFileAsync("git", ["config", "--get", key], { cwd, encoding: "utf8" })
    .then((value) => value.stdout.trim())
    .catch(() => "");
  return result;
}

async function configValues(cwd: string, key: string): Promise<readonly string[]> {
  const result = await execFileAsync("git", ["config", "--get-all", key], { cwd, encoding: "utf8" })
    .then((value) => value.stdout.trimEnd().split("\n").filter(Boolean))
    .catch(() => []);
  return result;
}

async function temporary(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function adoptAndPublish(): Promise<{ readonly source: string; readonly remote: string }> {
  const remote = await temporary("reveries-repair-remote-");
  await git(remote, "init", "--bare", "-b", "main");
  const source = await temporary("reveries-repair-source-");
  await git(source, "init", "-b", "main");
  await git(source, "config", "user.name", "Reveries Test");
  await git(source, "config", "user.email", "reveries@example.com");
  await git(source, "remote", "add", "origin", remote);
  await writeFile(join(source, "AGENTS.md"), "# Project\n\nKeep this guidance.\n", "utf8");
  await git(source, "add", "AGENTS.md");
  await git(source, "commit", "-m", "initial");

  const prepared = await initializeRepository(source, {
    hosts: ["codex"],
    publishingRemotes: ["origin"],
    directiveEmail: null,
    skillSetup: { kind: "reminder" },
    helper,
  });
  const adoption = await commitAdoption(source, prepared.templatePaths.plan, "Adopt Reveries");
  await (await Reveries.open(source)).attachAdoption({
    commit: adoption.commit,
    summary: JSON.parse(adoption.sessionSummary) as SessionSummary,
    initialization: JSON.parse(adoption.initialization) as ReveriesInit,
  });
  await git(source, "push", "origin", "main");
  await git(source, "push", "origin", "refs/notes/reveries:refs/notes/reveries");
  return { source, remote };
}

async function freshClone(): Promise<string> {
  const { remote } = await adoptAndPublish();
  const clone = await temporary("reveries-repair-clone-");
  await git(clone, "clone", remote, clone);
  await git(clone, "config", "user.name", "Reveries Test");
  await git(clone, "config", "user.email", "reveries@example.com");
  await git(clone, "fetch", "origin", "+refs/notes/reveries:refs/notes/reveries");
  return clone;
}

async function repositorySnapshot(directory: string): Promise<{
  readonly tree: string;
  readonly notes: string;
  readonly status: string;
  readonly adoptionPlan: string;
  readonly adoptionPlanHash: string;
}> {
  return {
    tree: await git(directory, "ls-tree", "-r", "HEAD"),
    notes: await git(directory, "rev-parse", "--verify", "refs/notes/reveries")
      .catch(() => "absent"),
    status: await git(directory, "status", "--porcelain=v1"),
    adoptionPlan: await configValue(directory, "reveries.adoptionPlan"),
    adoptionPlanHash: await configValue(directory, "reveries.adoptionPlanHash"),
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("a fresh clone reports missing local integration before repair", async () => {
  const clone = await freshClone();

  const before = await (await Reveries.open(clone)).doctor();

  assert.equal(before.state, "damaged");
  assert.match(before.diagnostics.join("\n"), /mergeStrategy/);
  assert.match(before.diagnostics.join("\n"), /pre-push hook is missing/);
});

test("repair restores local integration in a fresh clone without changing tracked files or evidence", async () => {
  const clone = await freshClone();
  const before = await repositorySnapshot(clone);

  const repair = await repairLocalIntegration(clone, { helper });

  assert.equal(repair.state, "repaired");
  assert.equal(await configValue(clone, "notes.reveries.mergeStrategy"), "cat_sort_uniq");
  assert.match(
    (await configValues(clone, "remote.origin.fetch")).join("\n"),
    /refs\/notes\/reveries\*:refs\/notes\/remotes\/origin\/reveries\*/,
  );
  assert.equal(await configValue(clone, "reveries.helperCommand"), helper.command);
  assert.match(await readFile(join(clone, ".git", "hooks", "pre-push"), "utf8"), /# reveries:begin/);
  assert.match(await readFile(join(clone, ".git", "hooks", "post-commit"), "utf8"), /# reveries:begin/);
  assert.deepEqual(await repositorySnapshot(clone), before);
  assert.equal((await (await Reveries.open(clone)).doctor()).ok, true);
});

test("repeated repair is a no-op", async () => {
  const clone = await freshClone();
  await repairLocalIntegration(clone, { helper });

  const second = await repairLocalIntegration(clone, { helper });

  assert.equal(second.state, "repaired");
  assert.deepEqual(second.changedConfig, []);
  assert.deepEqual(second.hookSnippets, []);
});

test("repair without a committed initialization record changes nothing", async () => {
  const clone = await freshClone();
  await git(clone, "update-ref", "-d", "refs/notes/reveries");
  const before = await repositorySnapshot(clone);

  const repair = await repairLocalIntegration(clone, { helper });

  assert.equal(repair.state, "unavailable");
  assert.match(repair.diagnostics.join("\n"), /reveries sync origin --pull/);
  assert.deepEqual(await repositorySnapshot(clone), before);
  await assert.rejects(readFile(join(clone, ".git", "hooks", "pre-push"), "utf8"), { code: "ENOENT" });
});

test("repair preserves unrelated local configuration", async () => {
  const clone = await freshClone();
  await git(clone, "config", "alias.st", "status");
  await git(clone, "config", "branch.main.description", "keep me");

  const repair = await repairLocalIntegration(clone, { helper });

  assert.equal(repair.state, "repaired");
  assert.equal(await configValue(clone, "alias.st"), "status");
  assert.equal(await configValue(clone, "branch.main.description"), "keep me");
});

test("repair preserves an unknown pre-push hook and reports partial enforcement", async () => {
  const clone = await freshClone();
  const hook = join(clone, ".git", "hooks", "pre-push");
  await writeFile(hook, "#!/bin/sh\necho custom-hook\n", { encoding: "utf8", mode: 0o755 });

  const repair = await repairLocalIntegration(clone, { helper });

  assert.equal(repair.state, "partial");
  assert.equal(await readFile(hook, "utf8"), "#!/bin/sh\necho custom-hook\n");
  assert.match(repair.hookSnippets.join("\n"), /pre-push/);
  assert.match(await readFile(join(clone, ".git", "hooks", "post-commit"), "utf8"), /# reveries:begin/);
});

test("repair preserves an edited owned hook block and reports partial enforcement", async () => {
  const clone = await freshClone();
  await repairLocalIntegration(clone, { helper });
  const hook = join(clone, ".git", "hooks", "pre-push");
  const edited = (await readFile(hook, "utf8")).replace(/# reveries:begin\nexec [^\n]*\n/, "# reveries:begin\nexec /bin/true\n");
  await writeFile(hook, edited, "utf8");

  const repair = await repairLocalIntegration(clone, { helper });

  assert.equal(repair.state, "partial");
  assert.equal(await readFile(hook, "utf8"), edited);
});

test("repair keeps operator content that follows a verified owned hook block", async () => {
  const clone = await freshClone();
  await repairLocalIntegration(clone, { helper });
  const hook = join(clone, ".git", "hooks", "pre-push");
  const extended = `${await readFile(hook, "utf8")}echo operator-added-step\n`;
  await writeFile(hook, extended, "utf8");

  const repair = await repairLocalIntegration(clone, { helper });

  assert.equal(repair.state, "repaired");
  assert.equal(await readFile(hook, "utf8"), extended);
});

test("repair reports an unsupported hook manager instead of writing hooks elsewhere", async () => {
  const clone = await freshClone();
  const hooksPath = join(clone, ".githooks");
  await mkdir(hooksPath, { recursive: true });
  await git(clone, "config", "core.hooksPath", hooksPath);

  const repair = await repairLocalIntegration(clone, { helper });

  assert.equal(repair.state, "partial");
  assert.deepEqual(repair.unsupportedManagers, [hooksPath]);
  assert.match(repair.diagnostics.join("\n"), /core\.hooksPath/);
  assert.match(repair.hookSnippets.join("\n"), /pre-push/);
  await assert.rejects(readFile(join(clone, ".git", "hooks", "pre-push"), "utf8"), { code: "ENOENT" });
  assert.deepEqual((await readdir(hooksPath)), []);
});

test("repair without a resolvable helper installs no broken hook", async () => {
  const clone = await freshClone();

  const repair = await repairLocalIntegration(clone, { helper: { command: join(clone, "missing-reveries"), args: [] } });

  assert.equal(repair.state, "partial");
  assert.match(repair.hookSnippets.join("\n"), /missing-reveries/);
  await assert.rejects(readFile(join(clone, ".git", "hooks", "pre-push"), "utf8"), { code: "ENOENT" });
  assert.equal(await configValue(clone, "reveries.helperCommand"), "");
  assert.equal(await configValue(clone, "notes.reveries.mergeStrategy"), "cat_sort_uniq");
});

function captureIo(cwd: string, helperInvocation = helper): {
  readonly io: CliIo;
  readonly stdout: () => string;
  readonly stderr: () => string;
} {
  let out = "";
  let error = "";
  return {
    io: {
      cwd,
      stdin: async () => "",
      stdout: (text) => { out += text; },
      stderr: (text) => { error += text; },
      helper: helperInvocation,
    },
    stdout: () => out,
    stderr: () => error,
  };
}

test("doctor --fix repairs a fresh clone and reports the result", async () => {
  const clone = await freshClone();
  const before = await repositorySnapshot(clone);
  const io = captureIo(clone);

  assert.equal(await runCli(["doctor", "--fix", "--json"], io.io), 0, `${io.stdout()}${io.stderr()}`);
  const envelope = JSON.parse(io.stdout()) as {
    ok: boolean;
    result: { ok: boolean; state: string; repair: { state: string; publishingRemotes: readonly string[] } };
  };

  assert.equal(envelope.ok, true);
  assert.equal(envelope.result.repair.state, "repaired");
  assert.deepEqual(envelope.result.repair.publishingRemotes, ["origin"]);
  assert.deepEqual(await repositorySnapshot(clone), before);
});

test("doctor --fix reports what it could not repair", async () => {
  const clone = await freshClone();
  await git(clone, "update-ref", "-d", "refs/notes/reveries");
  const io = captureIo(clone);

  assert.equal(await runCli(["doctor", "--fix"], io.io), 1);
  assert.match(io.stdout(), /Repair: unavailable\./);
  assert.match(io.stderr(), /reveries sync origin --pull/);
});

test("help for doctor documents the repair flag", async () => {
  const io = captureIo(await temporary("reveries-repair-help-"));

  assert.equal(await runCli(["help", "doctor"], io.io), 0);
  assert.match(io.stdout(), /--fix/);
  assert.match(io.stdout(), /never changes tracked files, notes, or the adoption plan/);
});
