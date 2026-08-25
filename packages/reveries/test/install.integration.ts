import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";

import { initializeRepository, removeIntegration } from "../src/install.ts";
import { Reveries } from "../src/operations.ts";

const execFileAsync = promisify(execFile);
const temporaryRepositories: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

async function createRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "reveries-init-"));
  temporaryRepositories.push(directory);
  await git(directory, "init", "-b", "main");
  await git(directory, "config", "user.name", "Reveries Test");
  await git(directory, "config", "user.email", "reveries@example.com");
  await git(directory, "remote", "add", "origin", "https://example.invalid/reveries.git");
  await writeFile(join(directory, "AGENTS.md"), "# Existing guidance\n\nKeep this paragraph.\n", "utf8");
  await git(directory, "add", "AGENTS.md");
  await git(directory, "commit", "-m", "initial");
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryRepositories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("initialization is explicit and idempotent", async () => {
  const directory = await createRepository();
  const options = {
    hosts: ["codex", "claude", "gemini"] as const,
    publishingRemotes: ["origin"],
    directiveEmail: "user@example.com",
    skillSetup: { kind: "reminder" } as const,
  };

  const first = await initializeRepository(directory, options);
  const second = await initializeRepository(directory, options);

  assert.equal(first.enforcement, "complete");
  assert.equal(second.changedFiles.length, 0);
  const agents = await readFile(join(directory, "AGENTS.md"), "utf8");
  assert.match(agents, /# Existing guidance/);
  assert.match(agents, /Keep this paragraph\./);
  assert.equal(agents.match(/<!-- reveries:begin -->/g)?.length, 1);
  assert.match(agents, /use `using-reveries`/);
  assert.doesNotMatch(agents, /npx skills add/);
  assert.match(await readFile(join(directory, "CLAUDE.md"), "utf8"), /@AGENTS\.md/);
  assert.match(await readFile(join(directory, "GEMINI.md"), "utf8"), /@\.\/AGENTS\.md/);
  assert.equal(await git(directory, "config", "notes.reveries.mergeStrategy"), "cat_sort_uniq");
  assert.equal(await git(directory, "config", "reveries.directiveEmail"), "user@example.com");
  const fetchValues = await git(directory, "config", "--get-all", "remote.origin.fetch");
  assert.match(fetchValues, /refs\/notes\/remotes\/origin\/reveries/);
  const pushValues = await git(directory, "config", "--get-all", "remote.origin.push");
  assert.match(pushValues, /^HEAD$/m);
  assert.match(pushValues, /refs\/notes\/reveries:refs\/notes\/reveries/);
});

test("initialization can direct agents to pull using-reveries from a named repository", async () => {
  const directory = await createRepository();

  await initializeRepository(directory, {
    hosts: ["codex"],
    publishingRemotes: ["origin"],
    directiveEmail: "user@example.com",
    skillSetup: {
      kind: "pull",
      repository: "https://github.com/phynics/reveries",
    },
  });

  const agents = await readFile(join(directory, "AGENTS.md"), "utf8");
  assert.match(agents, /use `using-reveries`/);
  assert.match(agents, /https:\/\/github\.com\/phynics\/reveries/);
  assert.match(agents, /npx skills add/);
});

test("initialization can point agents at a vendored using-reveries skill", async () => {
  const directory = await createRepository();

  await initializeRepository(directory, {
    hosts: ["pi", "codex"],
    publishingRemotes: ["origin"],
    directiveEmail: "user@example.com",
    skillSetup: { kind: "vendored" },
  });

  const agents = await readFile(join(directory, "AGENTS.md"), "utf8");
  assert.match(agents, /use `using-reveries`/);
  assert.match(agents, /\.agents\/skills\/using-reveries\/SKILL\.md/);
  assert.doesNotMatch(agents, /npx skills add/);
});

test("unknown hooks are preserved and reported as partial enforcement", async () => {
  const directory = await createRepository();
  const hook = join(directory, ".git", "hooks", "pre-push");
  await writeFile(hook, "#!/bin/sh\necho custom-hook\n", { encoding: "utf8", mode: 0o755 });

  const result = await initializeRepository(directory, {
    hosts: ["codex"],
    publishingRemotes: ["origin"],
    directiveEmail: "user@example.com",
    skillSetup: { kind: "reminder" },
  });

  assert.equal(result.enforcement, "partial");
  assert.equal(await readFile(hook, "utf8"), "#!/bin/sh\necho custom-hook\n");
  assert.match(result.hookSnippets.join("\n"), /reveries pre-push/);
});

test("doctor reads the prepared worktree marker before the adoption commit", async () => {
  const directory = await createRepository();
  await initializeRepository(directory, {
    hosts: ["codex"],
    publishingRemotes: ["origin"],
    directiveEmail: "user@example.com",
    skillSetup: { kind: "reminder" },
  });

  const result = await (await Reveries.open(directory)).doctor();

  assert.doesNotMatch(result.diagnostics.join("\n"), /AGENTS\.md Reveries marker/i);
  assert.doesNotMatch(result.diagnostics.join("\n"), /mergeStrategy/i);
  assert.match(result.diagnostics.join("\n"), /initialization boundary/i);
});

test("malformed or duplicated owned markers are refused", async () => {
  const directory = await createRepository();
  await writeFile(
    join(directory, "AGENTS.md"),
    "<!-- reveries:begin -->\nold\n<!-- reveries:begin -->\nduplicate\n<!-- reveries:end -->\n",
    "utf8",
  );

  await assert.rejects(
    initializeRepository(directory, {
      hosts: ["codex"],
      publishingRemotes: ["origin"],
      directiveEmail: "user@example.com",
      skillSetup: { kind: "reminder" },
    }),
    /marker/i,
  );
});

test("removal keeps the notes ref and unknown prose", async () => {
  const directory = await createRepository();
  await git(directory, "config", "--add", "remote.origin.push", "HEAD");
  await initializeRepository(directory, {
    hosts: ["codex", "gemini"],
    publishingRemotes: ["origin"],
    directiveEmail: "user@example.com",
    skillSetup: { kind: "reminder" },
  });
  await git(directory, "notes", "--ref=refs/notes/reveries", "add", "-m", "evidence", "HEAD");
  const notesTip = await git(directory, "rev-parse", "refs/notes/reveries");
  const hook = join(directory, ".git", "hooks", "pre-push");
  await writeFile(hook, `${await readFile(hook, "utf8")}echo retained-custom-step\n`, { encoding: "utf8", mode: 0o755 });

  await removeIntegration(directory, { publishingRemotes: ["origin"] });

  const agents = await readFile(join(directory, "AGENTS.md"), "utf8");
  assert.match(agents, /Keep this paragraph\./);
  assert.doesNotMatch(agents, /reveries:begin/);
  assert.equal(await git(directory, "rev-parse", "refs/notes/reveries"), notesTip);
  assert.equal(await git(directory, "config", "--get-all", "remote.origin.push"), "HEAD");
  assert.match(await readFile(hook, "utf8"), /retained-custom-step/);
  assert.doesNotMatch(await readFile(hook, "utf8"), /reveries:begin/);
});
