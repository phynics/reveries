import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";

import { GitRepository } from "../src/git.ts";

const execFileAsync = promisify(execFile);
const temporaryRepositories: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

async function createRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "reveries-transition-"));
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
  while (temporaryRepositories.length > 0) {
    const directory = temporaryRepositories.pop();
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  }
});

test("parentTreesForCommit returns an empty list for root commits", async () => {
  const directory = await createRepository();
  const repository = await GitRepository.open(directory);
  const root = await repository.resolveCommit("HEAD");
  assert.deepEqual([...await repository.parentTreesForCommit(root)], []);
});

test("parentTreesForCommit preserves merge parent order", async () => {
  const directory = await createRepository();
  await git(directory, "checkout", "-b", "side");
  await writeFile(join(directory, "side.txt"), "side\n", "utf8");
  await git(directory, "add", "side.txt");
  await git(directory, "commit", "-m", "side work");
  const sideTip = await git(directory, "rev-parse", "HEAD");
  await git(directory, "checkout", "main");
  await writeFile(join(directory, "main.txt"), "main\n", "utf8");
  await git(directory, "add", "main.txt");
  await git(directory, "commit", "-m", "main work");
  const mainTip = await git(directory, "rev-parse", "HEAD");
  await git(directory, "merge", "--no-ff", "side", "-m", "merge side");

  const repository = await GitRepository.open(directory);
  const merge = await repository.resolveCommit("HEAD");
  const parents = await repository.parentTreesForCommit(merge);
  const expectedFirst = await repository.treeForCommit(mainTip);
  const expectedSecond = await repository.treeForCommit(sideTip);
  assert.equal(parents.length, 2);
  assert.equal(parents[0], expectedFirst);
  assert.equal(parents[1], expectedSecond);
});

test("resultTreeForCommit matches the commit tree", async () => {
  const directory = await createRepository();
  const repository = await GitRepository.open(directory);
  const head = await repository.resolveCommit("HEAD");
  assert.equal(await repository.resultTreeForCommit(head), await repository.treeForCommit("HEAD"));
});

test("mergeCandidateTree computes a result tree without creating a commit", async () => {
  const directory = await createRepository();
  await git(directory, "checkout", "-b", "side");
  await writeFile(join(directory, "side.txt"), "side\n", "utf8");
  await git(directory, "add", "side.txt");
  await git(directory, "commit", "-m", "side work");
  await git(directory, "checkout", "main");
  await writeFile(join(directory, "main.txt"), "main\n", "utf8");
  await git(directory, "add", "main.txt");
  await git(directory, "commit", "-m", "main work");

  const repository = await GitRepository.open(directory);
  const tipBefore = await git(directory, "rev-parse", "HEAD");
  const candidate = await repository.mergeCandidateTree(["main", "side"]);
  assert.equal(await git(directory, "rev-parse", "HEAD"), tipBefore);
  assert.equal(await repository.objectType(candidate), "tree");
  assert.ok(await repository.treeExists(candidate));
});

test("treeExists distinguishes trees from other objects", async () => {
  const directory = await createRepository();
  const repository = await GitRepository.open(directory);
  const head = await repository.resolveCommit("HEAD");
  const tree = await repository.resultTreeForCommit(head);
  const blob = await repository.resolvePath({ path: "state.txt", revision: "HEAD" });
  assert.equal(await repository.treeExists(tree), true);
  assert.equal(await repository.treeExists(head), false);
  assert.equal(await repository.treeExists(blob), false);
});
