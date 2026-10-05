import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";

import { initializeRepository } from "../src/install.ts";

const execFileAsync = promisify(execFile);
const temporaryRepositories: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

async function configValues(cwd: string, key: string): Promise<readonly string[]> {
  try {
    const result = await execFileAsync("git", ["config", "--get-all", key], { cwd, encoding: "utf8" });
    return result.stdout.trimEnd().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function createRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "reveries-lean-init-"));
  temporaryRepositories.push(directory);
  await git(directory, "init", "-b", "main");
  await git(directory, "config", "user.name", "Reveries Test");
  await git(directory, "config", "user.email", "reveries@example.com");
  await writeFile(join(directory, "AGENTS.md"), "# Existing guidance\n\nKeep this paragraph.\n", "utf8");
  await git(directory, "add", "AGENTS.md");
  await git(directory, "commit", "-m", "initial");
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryRepositories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("init prepares the notes merge strategy and nothing else", async () => {
  const directory = await createRepository();
  const result = await initializeRepository(directory);

  assert.equal(result.state, "prepared");
  assert.equal(await git(directory, "config", "notes.reveries.mergeStrategy"), "cat_sort_uniq");
  // Setup recommends the fetch refspec but never configures a remote itself.
  assert.match(result.nextCommands.join(" "), /refs\/notes\/reveries/);
  assert.match(result.nextCommands.join(" "), /refs\/reveries\/retention/);
});

test("init writes the Reveries block into AGENTS.md and keeps surrounding text", async () => {
  const directory = await createRepository();
  await initializeRepository(directory);

  const agents = await readFile(join(directory, "AGENTS.md"), "utf8");
  assert.match(agents, /^# Existing guidance\n\nKeep this paragraph\.\n/m);
  assert.match(agents, /<!-- reveries:begin -->/);
  assert.match(agents, /<!-- reveries:end -->/);
});

test("init installs no hooks, no publishing configuration, and no trust store", async () => {
  const directory = await createRepository();
  await initializeRepository(directory);

  assert.deepEqual(await configValues(directory, "reveries.publishingRemote"), []);
  assert.deepEqual(await configValues(directory, "reveries.directiveEmail"), []);
  assert.deepEqual(await configValues(directory, "reveries.helperCommand"), []);
  const hooks = await execFileAsync("sh", ["-c", "ls .git/hooks/pre-push .git/hooks/post-commit 2>/dev/null || true"], { cwd: directory, encoding: "utf8" });
  assert.equal(hooks.stdout.trim(), "");
});

test("init is idempotent", async () => {
  const directory = await createRepository();
  const first = await initializeRepository(directory);
  const second = await initializeRepository(directory);

  assert.equal(first.state, "prepared");
  assert.equal(second.state, "prepared");
  const agents = await readFile(join(directory, "AGENTS.md"), "utf8");
  assert.equal(agents.match(/<!-- reveries:begin -->/g)?.length, 1);
});
