import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";

import { commitAdoption, initializeRepository, removeIntegration } from "../src/install.ts";
import { Reveries } from "../src/operations.ts";

const execFileAsync = promisify(execFile);
const temporaryRepositories: string[] = [];
let previousGlobalConfig: string | undefined;
const helper = {
  command: "/bin/sh",
  args: ["-c", "if [ \"$1\" = --version ]; then echo 'reveries 1.0.1'; fi", "reveries-test-helper"],
  verification: "probe",
} as const;

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

async function createSkillSource(directory: string): Promise<void> {
  for (const name of ["using-reveries", "reveries-git-notes-search", "reveries-git-notes-init"]) {
    await mkdir(join(directory, "skills", name), { recursive: true });
    await writeFile(join(directory, "skills", name, "SKILL.md"), `---\nname: ${name}\n---\n`, "utf8");
  }
  await git(directory, "add", "skills");
  await git(directory, "commit", "-m", "add skill sources");
}

async function createSkillRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "reveries-skills-"));
  temporaryRepositories.push(directory);
  await git(directory, "init", "-b", "main");
  await git(directory, "config", "user.name", "Reveries Skills Test");
  await git(directory, "config", "user.email", "reveries-skills@example.com");
  for (const name of ["using-reveries", "reveries-git-notes-search", "reveries-git-notes-init"]) {
    await mkdir(join(directory, "skills", name), { recursive: true });
    await writeFile(join(directory, "skills", name, "SKILL.md"), `---\nname: ${name}\n---\n`, "utf8");
  }
  await git(directory, "add", "skills");
  await git(directory, "commit", "-m", "add skill sources");
  return directory;
}

async function configureLocalSubmoduleSource(directory: string, source: string): Promise<void> {
  previousGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
  const configPath = join(directory, ".git", "reveries-test-global-config");
  await writeFile(configPath, "", "utf8");
  process.env.GIT_CONFIG_GLOBAL = configPath;
  await git(directory, "config", "--global", "protocol.file.allow", "always");
  await git(directory, "config", "--global", `url.file://${source}.insteadOf`, "https://github.com/phynics/reveries");
}

afterEach(async () => {
  if (previousGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = previousGlobalConfig;
  previousGlobalConfig = undefined;
  await Promise.all(temporaryRepositories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("initialization is explicit and idempotent", async () => {
  const directory = await createRepository();
  const options = {
    hosts: ["codex", "claude", "gemini"] as const,
    publishingRemotes: ["origin"],
    directiveEmail: "user@example.com",
    skillSetup: { kind: "reminder" } as const,
    helper,
  };

  const first = await initializeRepository(directory, options);
  const second = await initializeRepository(directory, options);

  assert.equal(first.enforcement, "complete");
  assert.equal(second.changedFiles.length, 0);
  assert.deepEqual(second.adoptionFiles, ["AGENTS.md", "CLAUDE.md", "GEMINI.md"]);
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
  assert.match(fetchValues, /refs\/notes\/reveries\*:refs\/notes\/remotes\/origin\/reveries\*/);
  assert.deepEqual(await configValues(directory, "remote.origin.push"), []);
  assert.match(first.nextCommands.join("\n"), /push origin/);
  assert.match(agents, /generic `git push` is not atomic/);
  const prePush = await readFile(join(directory, ".git", "hooks", "pre-push"), "utf8");
  assert.match(prePush, /\/bin\/sh/);
  assert.doesNotMatch(prePush, /exec reveries pre-push/);
});

test("initialization configures every selected remote and explains host routing", async () => {
  const directory = await createRepository();
  await git(directory, "remote", "add", "mirror", "https://example.invalid/mirror.git");

  const result = await initializeRepository(directory, {
    hosts: ["pi", "opencode", "codex"],
    publishingRemotes: ["origin", "mirror"],
    directiveEmail: "user@example.com",
    skillSetup: { kind: "reminder" },
    helper,
  });

  for (const remote of ["origin", "mirror"]) {
    const fetchValues = await git(directory, "config", "--get-all", `remote.${remote}.fetch`);
    assert.match(fetchValues, new RegExp(`refs/notes/reveries\\*:refs/notes/remotes/${remote}/reveries\\*`));
    assert.deepEqual(await configValues(directory, `remote.${remote}.push`), []);
  }
  assert.deepEqual(result.hostRouting, [
    { host: "pi", instructionFile: "AGENTS.md" },
    { host: "opencode", instructionFile: "AGENTS.md" },
    { host: "codex", instructionFile: "AGENTS.md" },
  ]);
  await assert.rejects(readFile(join(directory, "CLAUDE.md"), "utf8"), { code: "ENOENT" });
  await assert.rejects(readFile(join(directory, "GEMINI.md"), "utf8"), { code: "ENOENT" });
});

test("initialization can direct agents to pull the Skills from a named repository", async () => {
  const directory = await createRepository();

  await initializeRepository(directory, {
    hosts: ["codex"],
    publishingRemotes: ["origin"],
    directiveEmail: "user@example.com",
    skillSetup: { kind: "pull", repository: "https://github.com/phynics/reveries" },
    helper,
  });

  const agents = await readFile(join(directory, "AGENTS.md"), "utf8");
  assert.match(agents, /use `using-reveries`/);
  assert.match(agents, /https:\/\/github\.com\/phynics\/reveries/);
  assert.match(agents, /npx skills add/);
  assert.match(agents, /reveries-git-notes-search/);
});

test("initialization can vendor the complete Reveries Skill set", async () => {
  const directory = await createRepository();
  await createSkillSource(directory);

  const result = await initializeRepository(directory, {
    hosts: ["pi", "codex"],
    publishingRemotes: ["origin"],
    directiveEmail: "user@example.com",
    skillSetup: { kind: "vendored", sourceRoot: "skills" },
    helper,
  });

  const agents = await readFile(join(directory, "AGENTS.md"), "utf8");
  assert.match(agents, /vendors the Reveries Skills/);
  assert.match(await readFile(join(directory, ".agents", "skills", "using-reveries", "SKILL.md"), "utf8"), /using-reveries/);
  assert.ok(result.adoptionFiles.includes(".agents/skills/using-reveries"));
  await assert.doesNotReject(initializeRepository(directory, {
    hosts: ["pi", "codex"],
    publishingRemotes: ["origin"],
    directiveEmail: "user@example.com",
    skillSetup: { kind: "vendored", sourceRoot: "skills" },
    helper,
  }));
});

test("initialization can link project-local tracked Skills without calling them vendored", async () => {
  const directory = await createRepository();
  await createSkillSource(directory);

  const result = await initializeRepository(directory, {
    hosts: ["pi"],
    publishingRemotes: [],
    directiveEmail: null,
    skillSetup: { kind: "symlink", sourceRoot: "skills" },
    helper,
  });

  const agents = await readFile(join(directory, "AGENTS.md"), "utf8");
  assert.match(agents, /linked project Skills/);
  assert.doesNotMatch(agents, /vendors/);
  assert.equal(await readlink(join(directory, ".agents", "skills", "using-reveries")), "../../skills/using-reveries");
  assert.ok(result.adoptionFiles.includes(".agents/skills/using-reveries"));
  assert.doesNotMatch(result.nextCommands.join("\n"), /reveries push/);
});

test("initialization can deliver the Skills through a pinned Git submodule", async () => {
  const directory = await createRepository();
  const source = await createSkillRepository();
  await configureLocalSubmoduleSource(directory, source);

  const options = {
    hosts: ["codex"] as const,
    publishingRemotes: ["origin"],
    directiveEmail: "user@example.com",
    skillSetup: { kind: "submodule", repository: "https://github.com/phynics/reveries" } as const,
    helper,
  };
  const first = await initializeRepository(directory, options);
  const agents = await readFile(join(directory, "AGENTS.md"), "utf8");
  assert.match(agents, /git submodule update --init --recursive -- \.agents\/reveries/);
  assert.match(agents, /\.agents\/reveries\/skills\/using-reveries\/SKILL\.md/);
  assert.match(await readFile(join(directory, ".agents", "reveries", "skills", "using-reveries", "SKILL.md"), "utf8"), /using-reveries/);
  assert.match(await git(directory, "ls-files", "--stage", "--", ".agents/reveries"), /^160000 /m);
  assert.equal(await git(directory, "config", "-f", ".gitmodules", "--get", "submodule.reveries-skills.path"), ".agents/reveries");
  assert.ok(first.adoptionFiles.includes(".gitmodules"));
  assert.ok(first.adoptionFiles.includes(".agents/reveries"));
  await commitAdoption(directory, first.templatePaths.plan, "Adopt Reveries Skills");

  const second = await initializeRepository(directory, options);
  assert.deepEqual(second.changedFiles, []);
  await git(directory, "submodule", "deinit", "--force", "--", ".agents/reveries");
  await assert.rejects(readFile(join(directory, ".agents", "reveries", "skills", "using-reveries", "SKILL.md"), "utf8"), { code: "ENOENT" });
  await git(directory, "submodule", "update", "--init", "--recursive", "--", ".agents/reveries");
  assert.match(await readFile(join(directory, ".agents", "reveries", "skills", "using-reveries", "SKILL.md"), "utf8"), /using-reveries/);

  await removeIntegration(directory, { publishingRemotes: ["origin"] });
  await assert.rejects(readFile(join(directory, ".agents", "reveries"), "utf8"), { code: "ENOENT" });
  await assert.rejects(readFile(join(directory, ".gitmodules"), "utf8"), { code: "ENOENT" });
});

test("linked Skills refuse an untracked referenced file", async () => {
  const directory = await createRepository();
  await createSkillSource(directory);
  await mkdir(join(directory, "skills", "using-reveries", "references"), { recursive: true });
  await writeFile(join(directory, "skills", "using-reveries", "references", "workflow.md"), "untracked\n", "utf8");

  await assert.rejects(initializeRepository(directory, {
    hosts: ["pi"],
    publishingRemotes: [],
    directiveEmail: null,
    skillSetup: { kind: "symlink", sourceRoot: "skills" },
    helper,
  }), /every linked Skill source file must be tracked/i);
});

test("linked Skills refuse tracked nested links that escape the repository", async () => {
  const directory = await createRepository();
  await createSkillSource(directory);
  await symlink("/tmp", join(directory, "skills", "using-reveries", "references"));
  await git(directory, "add", "skills/using-reveries/references");
  await git(directory, "commit", "-m", "add escaping reference");

  await assert.rejects(initializeRepository(directory, {
    hosts: ["pi"],
    publishingRemotes: [],
    directiveEmail: null,
    skillSetup: { kind: "symlink", sourceRoot: "skills" },
    helper,
  }), /skill source escapes the repository/i);
});

test("removal deletes only Skill links owned by initialization", async () => {
  const directory = await createRepository();
  await createSkillSource(directory);
  await initializeRepository(directory, {
    hosts: ["pi"],
    publishingRemotes: [],
    directiveEmail: null,
    skillSetup: { kind: "symlink", sourceRoot: "skills" },
    helper,
  });

  await removeIntegration(directory, { publishingRemotes: [] });

  await assert.rejects(readlink(join(directory, ".agents", "skills", "using-reveries")), { code: "ENOENT" });
  assert.match(await readFile(join(directory, "skills", "using-reveries", "SKILL.md"), "utf8"), /using-reveries/);
});

test("Skill target conflicts are detected before any links are created", async () => {
  const directory = await createRepository();
  await createSkillSource(directory);
  await mkdir(join(directory, ".agents", "skills", "reveries-git-notes-search"), { recursive: true });
  await writeFile(join(directory, ".agents", "skills", "reveries-git-notes-search", "owned.txt"), "user\n", "utf8");

  await assert.rejects(initializeRepository(directory, {
    hosts: ["pi"],
    publishingRemotes: [],
    directiveEmail: null,
    skillSetup: { kind: "symlink", sourceRoot: "skills" },
    helper,
  }), /refusing to replace/i);
  await assert.rejects(readlink(join(directory, ".agents", "skills", "using-reveries")), { code: "ENOENT" });
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
    helper,
  });

  assert.equal(result.enforcement, "partial");
  assert.equal(await readFile(hook, "utf8"), "#!/bin/sh\necho custom-hook\n");
  assert.match(result.hookSnippets.join("\n"), /pre-push/);
});

test("missing helper leaves hooks uninstalled and enforcement partial", async () => {
  const directory = await createRepository();
  const result = await initializeRepository(directory, {
    hosts: ["codex"],
    publishingRemotes: ["origin"],
    directiveEmail: "user@example.com",
    skillSetup: { kind: "reminder" },
    helper: { command: join(directory, "missing-reveries"), args: [] },
  });

  assert.equal(result.enforcement, "partial");
  await assert.rejects(readFile(join(directory, ".git", "hooks", "pre-push"), "utf8"), { code: "ENOENT" });
  assert.match(result.hookSnippets.join("\n"), /missing-reveries/);
});

test("an executable that is not Reveries fails hook preflight", async () => {
  const directory = await createRepository();
  const result = await initializeRepository(directory, {
    hosts: ["codex"],
    publishingRemotes: ["origin"],
    directiveEmail: null,
    skillSetup: { kind: "reminder" },
    helper: { command: "/bin/true", args: [] },
  });

  assert.equal(result.enforcement, "partial");
  await assert.rejects(readFile(join(directory, ".git", "hooks", "pre-push"), "utf8"), { code: "ENOENT" });
});

test("initialization repairs an old owned hook invocation", async () => {
  const directory = await createRepository();
  const hook = join(directory, ".git", "hooks", "pre-push");
  await writeFile(hook, "#!/bin/sh\n# reveries:begin\nexec reveries pre-push \"$@\"\n# reveries:end\n", {
    encoding: "utf8",
    mode: 0o755,
  });

  const result = await initializeRepository(directory, {
    hosts: ["codex"],
    publishingRemotes: ["origin"],
    directiveEmail: null,
    skillSetup: { kind: "reminder" },
    helper,
  });

  assert.equal(result.enforcement, "complete");
  assert.doesNotMatch(await readFile(hook, "utf8"), /exec reveries pre-push/);
});

test("doctor reports a prepared installation as successful before the adoption commit", async () => {
  const directory = await createRepository();
  await initializeRepository(directory, {
    hosts: ["codex"],
    publishingRemotes: ["origin"],
    directiveEmail: "user@example.com",
    skillSetup: { kind: "reminder" },
    helper,
  });

  const result = await (await Reveries.open(directory)).doctor();

  assert.equal(result.ok, true);
  assert.equal(result.state, "prepared");
  assert.equal(result.diagnostics.length, 0);
  assert.deepEqual(result.protection, {
    helper: "available",
    local: "complete",
    receiveSide: "unknown",
  });
  assert.match(result.notices.join("\n"), /prepared.*adoption boundary/i);
  assert.match(result.notices.join("\n"), /helper available; local complete; receive-side unknown/i);
});

test("initialization removes legacy managed generic push refspecs", async () => {
  const directory = await createRepository();
  await git(directory, "config", "--add", "remote.origin.push", "HEAD");
  await git(directory, "config", "--add", "remote.origin.push", "refs/notes/reveries:refs/notes/reveries");
  await git(directory, "config", "reveries.managed-origin.pushHead", "true");
  await git(directory, "config", "reveries.managed-origin.pushNotes", "true");

  await initializeRepository(directory, {
    hosts: ["codex"],
    publishingRemotes: ["origin"],
    directiveEmail: null,
    skillSetup: { kind: "reminder" },
    helper,
  });

  assert.deepEqual(await configValues(directory, "remote.origin.push"), []);
  assert.deepEqual(await configValues(directory, "reveries.managed-origin.pushHead"), []);
  assert.deepEqual(await configValues(directory, "reveries.managed-origin.pushNotes"), []);
});

test("doctor detects a hook runner that disappeared after setup", async () => {
  const directory = await createRepository();
  await initializeRepository(directory, {
    hosts: ["codex"],
    publishingRemotes: ["origin"],
    directiveEmail: null,
    skillSetup: { kind: "reminder" },
    helper,
  });
  await git(directory, "config", "reveries.helperCommand", join(directory, "missing-runner"));

  const result = await (await Reveries.open(directory)).doctor();
  assert.equal(result.state, "damaged");
  assert.match(result.diagnostics.join("\n"), /runner is unavailable/i);
});

test("doctor detects a modified owned hook body", async () => {
  const directory = await createRepository();
  await initializeRepository(directory, {
    hosts: ["codex"],
    publishingRemotes: ["origin"],
    directiveEmail: null,
    skillSetup: { kind: "reminder" },
    helper,
  });
  const hook = join(directory, ".git", "hooks", "pre-push");
  await writeFile(hook, "#!/bin/sh\n# reveries:begin\nexec /bin/true\n# reveries:end\n", { mode: 0o755 });

  const result = await (await Reveries.open(directory)).doctor();
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((diagnostic) => /pre-push enforcement is partial/i.test(diagnostic)));

  const repaired = await initializeRepository(directory, {
    hosts: ["codex"],
    publishingRemotes: ["origin"],
    directiveEmail: null,
    skillSetup: { kind: "reminder" },
    helper,
  });
  assert.equal(repaired.enforcement, "partial");
  assert.match(await readFile(hook, "utf8"), /exec \/bin\/true/);
  await removeIntegration(directory, { publishingRemotes: ["origin"] });
  assert.match(await readFile(hook, "utf8"), /exec \/bin\/true/);
});

test("doctor validates selected remote config before adoption", async () => {
  const directory = await createRepository();
  await initializeRepository(directory, {
    hosts: ["codex"],
    publishingRemotes: ["origin"],
    directiveEmail: null,
    skillSetup: { kind: "reminder" },
    helper,
  });
  await git(directory, "config", "--add", "remote.origin.push", "refs/notes/reveries:refs/notes/reveries");

  const result = await (await Reveries.open(directory)).doctor();
  assert.equal(result.state, "damaged");
  assert.match(result.diagnostics.join("\n"), /unsafe non-atomic notes push refspec/i);
});

test("local-only setup accepts no hosts, publishing remotes, or directive email", async () => {
  const directory = await createRepository();
  const result = await initializeRepository(directory, {
    hosts: [],
    publishingRemotes: [],
    directiveEmail: null,
    skillSetup: { kind: "reminder" },
    helper,
  });

  assert.equal(result.state, "prepared");
  assert.equal(await git(directory, "config", "--get", "notes.reveries.mergeStrategy"), "cat_sort_uniq");
  await assert.rejects(execFileAsync("git", ["config", "--get", "reveries.directiveEmail"], { cwd: directory }));
  assert.deepEqual(result.hostRouting, []);
  assert.doesNotMatch(result.nextCommands.join("\n"), /reveries push/);
  await assert.rejects(readFile(join(directory, ".git", "hooks", "pre-push"), "utf8"), { code: "ENOENT" });
  assert.equal((await (await Reveries.open(directory)).doctor()).state, "prepared");
});

test("switching to local-only removes previously managed remote publication", async () => {
  const directory = await createRepository();
  await initializeRepository(directory, {
    hosts: ["codex"],
    publishingRemotes: ["origin"],
    directiveEmail: null,
    skillSetup: { kind: "reminder" },
    helper,
  });
  await initializeRepository(directory, {
    hosts: ["codex"],
    publishingRemotes: [],
    directiveEmail: null,
    skillSetup: { kind: "reminder" },
    helper,
  });

  const fetchValues = await git(directory, "config", "--get-all", "remote.origin.fetch");
  assert.doesNotMatch(fetchValues, /refs\/notes\/reveries/);
  await assert.rejects(execFileAsync("git", ["config", "--get-all", "remote.origin.push"], { cwd: directory }));
  await assert.rejects(readFile(join(directory, ".git", "hooks", "pre-push"), "utf8"), { code: "ENOENT" });
});

test("initialization writes real templates and limits adoption commands to the complete file set", async () => {
  const directory = await createRepository();
  await writeFile(join(directory, "unrelated.txt"), "keep out\n", "utf8");
  await git(directory, "add", "unrelated.txt");
  const options = {
    hosts: ["claude", "gemini"] as const,
    publishingRemotes: ["origin"],
    directiveEmail: "user@example.com",
    skillSetup: { kind: "reminder" } as const,
    helper,
  };

  const first = await initializeRepository(directory, options);
  const second = await initializeRepository(directory, options);
  const summary = JSON.parse(await readFile(first.templatePaths.sessionSummary, "utf8")) as {
    entries: Array<{ sources: Array<{ relation: string; kind: string; ref: string }> }>;
  };

  assert.deepEqual(first.adoptionFiles, ["AGENTS.md", "CLAUDE.md", "GEMINI.md"]);
  assert.deepEqual(second.adoptionFiles, first.adoptionFiles);
  assert.match(await readFile(first.templatePaths.initialization, "utf8"), /"reveries-init"/);
  assert.deepEqual(summary.entries[0]?.sources, [{ relation: "requested-by", kind: "git-email", ref: "user@example.com" }]);
  assert.ok(first.unrelatedChanges.includes("unrelated.txt"));
  assert.match(first.nextCommands[0] ?? "", /adopt --plan .*plan\.json --message 'Adopt Reveries'/);
  assert.equal(first.nextCommands.filter((command) => command.includes(" adopt ")).length, 1);

  await commitAdoption(directory, second.templatePaths.plan, "adopt reveries");
  assert.doesNotMatch(await git(directory, "show", "--format=", "--name-only", "HEAD"), /unrelated\.txt/);
  assert.equal(await git(directory, "diff", "--cached", "--name-only"), "unrelated.txt");
});

test("adoption refuses an owned file changed after initialization", async () => {
  const directory = await createRepository();
  const result = await initializeRepository(directory, {
    hosts: ["codex"],
    publishingRemotes: [],
    directiveEmail: null,
    skillSetup: { kind: "reminder" },
    helper,
  });
  await writeFile(join(directory, "AGENTS.md"), `${await readFile(join(directory, "AGENTS.md"), "utf8")}concurrent edit\n`, "utf8");

  await assert.rejects(commitAdoption(directory, result.templatePaths.plan, "adopt reveries"), /changed after initialization/i);
  assert.equal(await git(directory, "rev-parse", "HEAD"), await git(directory, "rev-list", "--max-parents=0", "HEAD"));
});

test("adoption resumes after the exact planned commit was created before its result was saved", async () => {
  const directory = await createRepository();
  const result = await initializeRepository(directory, {
    hosts: ["codex"],
    publishingRemotes: [],
    directiveEmail: null,
    skillSetup: { kind: "reminder" },
    helper,
  });
  await git(directory, "add", "AGENTS.md");
  await git(directory, "commit", "-m", "adopt reveries");
  const expected = await git(directory, "rev-parse", "HEAD");

  const recovered = await commitAdoption(directory, result.templatePaths.plan, "adopt reveries");
  assert.equal(recovered.commit, expected);
});

test("adoption refuses templates changed after initialization", async () => {
  const directory = await createRepository();
  const result = await initializeRepository(directory, {
    hosts: ["codex"],
    publishingRemotes: [],
    directiveEmail: null,
    skillSetup: { kind: "reminder" },
    helper,
  });
  await writeFile(result.templatePaths.sessionSummary, "{}\n", "utf8");

  await assert.rejects(
    commitAdoption(directory, result.templatePaths.plan, "adopt reveries"),
    /templates changed/i,
  );
});

test("repeated initialization creates an immutable plan without overwriting reviewed templates", async () => {
  const directory = await createRepository();
  const options = {
    hosts: ["codex"] as const,
    publishingRemotes: [] as const,
    directiveEmail: null,
    skillSetup: { kind: "reminder" } as const,
    helper,
  };
  const first = await initializeRepository(directory, options);
  const reviewed = `${await readFile(first.templatePaths.sessionSummary, "utf8")}\n`;
  await writeFile(first.templatePaths.sessionSummary, reviewed, "utf8");

  const second = await initializeRepository(directory, options);
  assert.notEqual(second.templatePaths.sessionSummary, first.templatePaths.sessionSummary);
  assert.match(await readFile(second.templatePaths.sessionSummary, "utf8"), /"session-summary"/);
  assert.equal(await readFile(first.templatePaths.sessionSummary, "utf8"), reviewed);
  await assert.rejects(
    commitAdoption(directory, first.templatePaths.plan, "adopt reveries"),
    /stale or was modified/i,
  );
});

test("ordinary fetch succeeds before a remote publishes Reveries notes", async () => {
  const directory = await createRepository();
  const bare = await mkdtemp(join(tmpdir(), "reveries-empty-remote-"));
  temporaryRepositories.push(bare);
  await git(bare, "init", "--bare");
  await git(directory, "remote", "set-url", "origin", bare);
  await initializeRepository(directory, {
    hosts: ["pi"],
    publishingRemotes: ["origin"],
    directiveEmail: null,
    skillSetup: { kind: "reminder" },
    helper,
  });

  await assert.doesNotReject(git(directory, "fetch", "origin"));
});

test("repair migrates the previously managed exact fetch refspec", async () => {
  const directory = await createRepository();
  await git(directory, "config", "--add", "remote.origin.fetch", "+refs/notes/reveries:refs/notes/remotes/origin/reveries");
  await git(directory, "config", "reveries.managed-origin.fetch", "true");

  await initializeRepository(directory, {
    hosts: ["pi"],
    publishingRemotes: ["origin"],
    directiveEmail: null,
    skillSetup: { kind: "reminder" },
    helper,
  });

  const fetchValues = await git(directory, "config", "--get-all", "remote.origin.fetch");
  assert.doesNotMatch(fetchValues, /refs\/notes\/reveries:refs\/notes\/remotes/);
  assert.match(fetchValues, /refs\/notes\/reveries\*:refs\/notes\/remotes\/origin\/reveries\*/);
});

test("an unmanaged exact fetch refspec requires explicit migration", async () => {
  const directory = await createRepository();
  await git(directory, "config", "--add", "remote.origin.fetch", "+refs/notes/reveries:refs/notes/remotes/origin/reveries");

  await assert.rejects(initializeRepository(directory, {
    hosts: ["pi"],
    publishingRemotes: ["origin"],
    directiveEmail: null,
    skillSetup: { kind: "reminder" },
    helper,
  }), /unmanaged exact Reveries fetch refspec/i);
  assert.doesNotMatch(await readFile(join(directory, "AGENTS.md"), "utf8"), /reveries:begin/);
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
      helper,
    }),
    /marker/i,
  );
});

test("a common-directory setup lock rejects concurrent initialization", async () => {
  const directory = await createRepository();
  await mkdir(join(directory, ".git", "reveries", "setup.lock"), { recursive: true });

  await assert.rejects(initializeRepository(directory, {
    hosts: ["codex"],
    publishingRemotes: ["origin"],
    directiveEmail: null,
    skillSetup: { kind: "reminder" },
    helper,
  }), /already running/i);
});

test("removal keeps the notes ref and unknown prose", async () => {
  const directory = await createRepository();
  await git(directory, "config", "--add", "remote.origin.push", "HEAD");
  await initializeRepository(directory, {
    hosts: ["codex", "gemini"],
    publishingRemotes: ["origin"],
    directiveEmail: "user@example.com",
    skillSetup: { kind: "reminder" },
    helper,
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
