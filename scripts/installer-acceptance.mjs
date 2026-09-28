import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillsCli = join(workspace, "node_modules", "skills", "bin", "cli.mjs");
const reveriesCli = join(workspace, "packages", "reveries", "src", "main.ts");
const manualSetupGuide = join(workspace, "skills", "reveries-git-notes-init", "references", "manual-setup.md");
const source = join(workspace, "skills");
const skillNames = [
  "reveries-git-notes-init",
  "using-reveries",
  "reveries-git-notes-search",
];
const agents = ["pi", "claude-code", "opencode", "codex", "gemini-cli"];

function runCommand(command, args, { cwd, env = process.env, stdin = "", allowFailure = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      stdio: [stdin.length === 0 ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const result = {
        code: code ?? 128,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (result.code !== 0 && !allowFailure) {
        reject(new Error(`${command} ${args.join(" ")} failed (${result.code}): ${result.stderr}\n${result.stdout}`));
        return;
      }
      resolvePromise(result);
    });
    if (child.stdin !== null) {
      child.stdin.on("error", (error) => {
        if (error.code !== "EPIPE") reject(error);
      });
      child.stdin.end(stdin);
    }
  });
}

function run(args, env) {
  return runCommand(process.execPath, [skillsCli, ...args], { cwd: workspace, env });
}

async function git(cwd, ...args) {
  return (await runCommand("git", args, { cwd })).stdout;
}

async function configValues(cwd, key) {
  const result = await runCommand("git", ["config", "--get-all", key], { cwd, allowFailure: true });
  assert.ok(result.code === 0 || result.code === 1,
    `git config --get-all ${key} failed (${result.code}): ${result.stderr}`);
  return result.code === 0 ? result.stdout.trimEnd().split("\n") : [];
}

function documentedTemplate(markdown, label, language = "markdown") {
  const marker = `<!-- manual-template:${label} -->`;
  const markerOffset = markdown.indexOf(marker);
  assert.notEqual(markerOffset, -1, `manual setup guide is missing template ${label}`);
  const fence = `\`\`\`${language}\n`;
  const fenceOffset = markdown.indexOf(fence, markerOffset + marker.length);
  assert.notEqual(fenceOffset, -1, `manual setup template ${label} has no markdown fence`);
  const contentStart = fenceOffset + fence.length;
  const contentEnd = markdown.indexOf("\n```", contentStart);
  assert.notEqual(contentEnd, -1, `manual setup template ${label} has no closing fence`);
  return markdown.slice(contentStart, contentEnd).replaceAll(
    "{{SKILL_REPOSITORY}}",
    "https://github.com/phynics/reveries",
  );
}

async function trackedSnapshot(cwd) {
  const paths = (await git(cwd, "ls-files", "-z")).split("\0").filter(Boolean);
  return Object.fromEntries(await Promise.all(paths.map(async (path) => [
    path,
    await readFile(join(cwd, path)),
  ])));
}

async function runCli(cwd, ...args) {
  return runCommand(process.execPath, ["--experimental-transform-types", reveriesCli, ...args], {
    cwd,
    allowFailure: true,
  });
}

async function assertManualOnboarding() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "reveries-manual-onboarding-"));
  try {
    const repository = join(temporaryRoot, "repository");
    await mkdir(repository);
    await git(repository, "init", "-b", "main");
    await git(repository, "config", "user.name", "Reveries Manual Setup Test");
    await git(repository, "config", "user.email", "manual@example.test");
    await git(repository, "remote", "add", "origin", "https://example.invalid/reveries.git");

    const guide = await readFile(manualSetupGuide, "utf8");
    assert.doesNotMatch(guide, /git push --no-verify/, "manual publication must preserve installed hooks");
    const remoteFetchTemplate = documentedTemplate(guide, "remote-fetch", "bash");
    const remoteFetchCommand = remoteFetchTemplate.replace(
      "remote='the-selected-remote'",
      "remote='origin'",
    );
    assert.notEqual(remoteFetchCommand, remoteFetchTemplate, "manual fetch example has no replaceable remote choice");
    const remoteConfigTemplate = documentedTemplate(guide, "publishing-remotes", "bash");
    const remoteConfigCommand = remoteConfigTemplate
      .replace("publishing_remotes=('the-selected-remote')", "publishing_remotes=('origin')")
      .replace("directive_email='the-selected-directive-email'", "directive_email=''");
    assert.notEqual(remoteConfigCommand, remoteConfigTemplate, "manual publisher example has no replaceable choices");
    await git(repository, "config", "--add", "reveries.publishingRemote", "old-primary");
    await git(repository, "config", "--add", "reveries.publishingRemote", "old-mirror");
    await git(repository, "config", "--add", "reveries.directiveEmail", "old@example.test");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const configured = await runCommand("bash", ["-c", remoteConfigCommand], { cwd: repository });
      assert.equal(configured.code, 0, configured.stderr);
      assert.deepEqual(await configValues(repository, "reveries.publishingRemote"), ["origin"]);
      assert.deepEqual(await configValues(repository, "reveries.directiveEmail"), []);
      assert.equal((await git(repository, "config", "reveries.localOnly")).trim(), "false");
    }

    const directiveEmailCommand = remoteConfigCommand.replace("directive_email=''", "directive_email='manual@example.test'");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const configured = await runCommand("bash", ["-c", directiveEmailCommand], { cwd: repository });
      assert.equal(configured.code, 0, configured.stderr);
      assert.deepEqual(await configValues(repository, "reveries.directiveEmail"), ["manual@example.test"]);
    }
    const unsetDirectiveEmail = await runCommand("bash", ["-c", remoteConfigCommand], { cwd: repository });
    assert.equal(unsetDirectiveEmail.code, 0, unsetDirectiveEmail.stderr);

    const localOnlyCommand = remoteConfigCommand.replace(
      "publishing_remotes=('origin')",
      "publishing_remotes=()",
    );
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const configured = await runCommand("bash", ["-c", localOnlyCommand], { cwd: repository });
      assert.equal(configured.code, 0, configured.stderr);
      assert.deepEqual(await configValues(repository, "reveries.publishingRemote"), []);
      assert.equal((await git(repository, "config", "reveries.localOnly")).trim(), "true");
    }
    const restored = await runCommand("bash", ["-c", remoteConfigCommand], { cwd: repository });
    assert.equal(restored.code, 0, restored.stderr);

    const brokenConfigRepository = join(temporaryRoot, "broken-config");
    await mkdir(brokenConfigRepository);
    await git(brokenConfigRepository, "init", "-b", "main");
    await writeFile(join(brokenConfigRepository, ".git", "config"), "[broken\n", "utf8");
    const brokenConfig = await runCommand("bash", ["-c", localOnlyCommand], {
      cwd: brokenConfigRepository,
      allowFailure: true,
    });
    assert.notEqual(brokenConfig.code, 0, "manual config command swallowed a malformed Git config error");
    assert.match(brokenConfig.stderr, /bad config line/i);
    const brokenConfigBeforeFetch = await readFile(join(brokenConfigRepository, ".git", "config"));
    const brokenFetchConfig = await runCommand("bash", ["-c", remoteFetchCommand], {
      cwd: brokenConfigRepository,
      allowFailure: true,
    });
    assert.notEqual(brokenFetchConfig.code, 0, "manual fetch command swallowed a malformed Git config error");
    assert.match(brokenFetchConfig.stderr, /bad config line/i);
    assert.deepEqual(await readFile(join(brokenConfigRepository, ".git", "config")), brokenConfigBeforeFetch,
      "manual fetch command wrote configuration after its read failed");

    const agentsTemplate = documentedTemplate(guide, "agents-reminder");
    const initialAgents = "# Existing project guidance\n\nKeep this text.\n";
    await writeFile(join(repository, "AGENTS.md"), initialAgents, "utf8");
    await git(repository, "add", "AGENTS.md");
    await git(repository, "commit", "-m", "Create test repository");

    await writeFile(join(repository, "AGENTS.md"), `${initialAgents}\n${agentsTemplate}\n`, "utf8");
    await git(repository, "config", "notes.reveries.mergeStrategy", "cat_sort_uniq");
    const unrelatedFetch = "+refs/heads/manual/*:refs/remotes/origin/manual/*";
    await git(repository, "config", "--add", "remote.origin.fetch", unrelatedFetch);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const manualFetchConfig = await runCommand("bash", ["-c", remoteFetchCommand], { cwd: repository });
      assert.equal(manualFetchConfig.code, 0, manualFetchConfig.stderr);
      const fetchValues = await configValues(repository, "remote.origin.fetch");
      assert.ok(fetchValues.includes(unrelatedFetch), "manual setup removed an unrelated fetch refspec");
      assert.equal(fetchValues.filter((value) => value === "+refs/notes/reveries*:refs/notes/remotes/origin/reveries*").length, 1);
    }
    const manualPublicationConfig = await runCommand("bash", ["-c", remoteConfigCommand], { cwd: repository });
    assert.equal(manualPublicationConfig.code, 0, manualPublicationConfig.stderr);
    assert.deepEqual(await configValues(repository, "reveries.publishingRemote"), ["origin"]);
    assert.deepEqual(await configValues(repository, "reveries.directiveEmail"), []);
    assert.equal((await git(repository, "config", "reveries.localOnly")).trim(), "false");
    await git(repository, "add", "-A", "--", "AGENTS.md");
    await git(repository, "commit", "--only", "-m", "Adopt Reveries manually", "--", "AGENTS.md");

    const createdAt = "2026-09-28T00:00:00.000Z";
    const authorEmail = "manual@example.test";
    const recordLines = documentedTemplate(guide, "adoption-records", "jsonl").split("\n");
    assert.equal(recordLines.length, 2, "manual example must contain one summary and one initialization record");
    const summary = JSON.parse(recordLines[0]);
    const initialization = JSON.parse(recordLines[1]);
    summary.author_email = authorEmail;
    summary.created_at = createdAt;
    initialization.author_email = authorEmail;
    initialization.created_at = createdAt;
    const notePath = join(temporaryRoot, "adoption.jsonl");
    await writeFile(notePath, `${JSON.stringify(summary)}\n${JSON.stringify(initialization)}\n`, "utf8");
    await git(repository, "notes", "--ref=refs/notes/reveries", "add", "-F", notePath, "HEAD");

    const doctorBeforeHelper = await runCli(repository, "doctor", "--json");
    assert.notEqual(doctorBeforeHelper.code, 0, "manual setup should disclose missing helper hooks");
    const doctorResult = JSON.parse(doctorBeforeHelper.stdout);
    assert.equal(doctorResult.command, "doctor");
    assert.equal(doctorResult.result.state, "damaged", doctorResult.diagnostics.join("; "));
    assert.ok(doctorResult.diagnostics.length > 0, "doctor should identify missing local enforcement");
    assert.ok(doctorResult.diagnostics.every((diagnostic) => /hook|runner/i.test(diagnostic)),
      `manual doctor returned unrelated diagnostics: ${doctorResult.diagnostics.join("; ")}`);

    const checkBeforeHelper = await runCli(repository, "check", "HEAD", "--json");
    assert.equal(checkBeforeHelper.code, 0, checkBeforeHelper.stderr || checkBeforeHelper.stdout);
    assert.equal(JSON.parse(checkBeforeHelper.stdout).result.ok, true);

    const beforeHelperInit = await trackedSnapshot(repository);
    const initArgs = [
      "init",
      "--hosts", "codex",
      "--remote", "origin",
      "--no-directive-email",
      "--skill-setup", "reminder",
      "--json",
    ];
    const firstInit = await runCli(repository, ...initArgs);
    assert.equal(firstInit.code, 0, firstInit.stderr || firstInit.stdout);
    assert.deepEqual(await trackedSnapshot(repository), beforeHelperInit,
      "helper init changed manually prepared tracked configuration");

    const doctorAfterHelper = await runCli(repository, "doctor", "--json");
    assert.equal(doctorAfterHelper.code, 0, doctorAfterHelper.stderr || doctorAfterHelper.stdout);
    assert.equal(JSON.parse(doctorAfterHelper.stdout).result.ok, true);

    const secondInit = await runCli(repository, ...initArgs);
    assert.equal(secondInit.code, 0, secondInit.stderr || secondInit.stdout);
    assert.deepEqual(await trackedSnapshot(repository), beforeHelperInit,
      "repeated helper init changed manually prepared tracked configuration");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function skillRoots(home) {
  return {
    pi: join(home, ".pi", "agent", "skills"),
    "claude-code": join(home, ".claude", "skills"),
    // These hosts share the Skills CLI's global universal-agent directory.
    opencode: join(home, ".agents", "skills"),
    codex: join(home, ".agents", "skills"),
    "gemini-cli": join(home, ".agents", "skills"),
  };
}

async function assertInstalled(roots) {
  for (const agent of agents) {
    for (const skill of skillNames) {
      await access(join(roots[agent], skill, "SKILL.md"));
    }
  }
}

async function assertRemoved(roots) {
  for (const agent of agents) {
    for (const skill of skillNames) {
      await assert.rejects(access(join(roots[agent], skill, "SKILL.md")));
    }
  }
}

const home = await mkdtemp(join(tmpdir(), "reveries-skills-home-"));
try {
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    CODEX_HOME: join(home, ".codex"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
  };
  const roots = skillRoots(home);
  const selectedAgents = ["--agent", ...agents];
  const selectedSkills = ["--skill", ...skillNames];

  await run([
    "add",
    source,
    "--global",
    "--copy",
    "--yes",
    "--full-depth",
    ...selectedAgents,
    ...selectedSkills,
  ], env);
  await assertInstalled(roots);

  await run(["update", "--global", "--yes"], env);
  await assertInstalled(roots);

  await run([
    "remove",
    "--global",
    "--yes",
    ...selectedAgents,
    ...selectedSkills,
  ], env);
  await assertRemoved(roots);
  await assertManualOnboarding();
  process.stdout.write("Reveries Skills installer acceptance passed.\n");
} finally {
  await rm(home, { recursive: true, force: true });
}
