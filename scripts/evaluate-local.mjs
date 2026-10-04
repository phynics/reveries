import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * LOCAL evaluation for the lean Reveries core.
 *
 * The 20 PRD acceptance criteria are proved by scripts/direct-git-acceptance.mjs
 * against the built CLI and raw Git. This runner executes the build, typecheck,
 * full test suite, script tests, and that acceptance, then maps every criterion
 * to its passing step. No network, hosted runner, or external service is used.
 */

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const json = process.argv.includes("--json");
const strict = process.argv.includes("--strict");

async function run(command, args) {
  const started = performance.now();
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd: workspace,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => resolvePromise({
      ok: false,
      command: [command, ...args],
      duration_ms: Math.round(performance.now() - started),
      stdout: "",
      stderr: error.message,
    }));
    child.on("close", (code) => resolvePromise({
      ok: code === 0,
      command: [command, ...args],
      duration_ms: Math.round(performance.now() - started),
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
}

async function markdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await markdownFiles(path));
    else if (entry.isFile() && path.endsWith(".md")) paths.push(path);
  }
  return paths;
}

async function validateSkills() {
  const names = ["reveries-git-notes-init", "using-reveries", "reveries-git-notes-search"];
  const failures = [];
  for (const name of names) {
    const path = join(workspace, "skills", name, "SKILL.md");
    let content;
    try {
      content = await readFile(path, "utf8");
    } catch {
      failures.push(`${name}: SKILL.md is missing`);
      continue;
    }
    const frontmatter = content.match(/^---\n([\s\S]*?)\n---\n/);
    if (frontmatter === null || !frontmatter[1].includes(`name: ${name}`)) {
      failures.push(`${name}: invalid or mismatched frontmatter name`);
    }
    if (!frontmatter?.[1].includes("description:")) failures.push(`${name}: missing description`);
    if (content.split("\n").length > 120) failures.push(`${name}: main Skill exceeds 120 lines`);
  }
  const skillDirectory = join(workspace, "skills", "using-reveries");
  for (const path of await markdownFiles(skillDirectory)) {
    const content = await readFile(path, "utf8");
    for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const link = match[1].trim().match(/^<([^>]*)>|^(\S+)/);
      if (link === null) continue;
      const target = (link[1] ?? link[2]).split(/[?#]/, 1)[0];
      if (target.length === 0 || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)) continue;
      const resolved = resolve(dirname(path), decodeURIComponent(target));
      const relativeTarget = relative(skillDirectory, resolved);
      if (relativeTarget === ".." || relativeTarget.startsWith(`..${sep}`) || isAbsolute(relativeTarget)) {
        failures.push(`${relative(skillDirectory, path)}: link escapes the using-reveries Skill folder`);
        continue;
      }
      try {
        await readFile(resolved, "utf8");
      } catch {
        failures.push(`${relative(skillDirectory, path)}: link target does not exist (${target})`);
      }
    }
  }
  return failures;
}

const gates = [];
gates.push(await run("npm", ["run", "build"]));
gates.push(await run("npm", ["run", "typecheck"]));
gates.push(await run("npm", ["run", "test:full"]));
const acceptance = await run("node", ["scripts/direct-git-acceptance.mjs", "--json"]);
gates.push(acceptance);

let acceptanceReport = { ok: false, criteria: [] };
if (acceptance.ok) {
  try {
    acceptanceReport = JSON.parse(acceptance.stdout.trim().split("\n").at(-1) ?? "{}");
  } catch {
    acceptanceReport = { ok: false, criteria: [] };
  }
}
const skillFailures = await validateSkills();
const gatesOk = gates.every((gate) => gate.ok);
const criteria = acceptanceReport.criteria.map((item) => ({
  id: item.id,
  criterion: item.title,
  status: item.ok ? "covered" : "failed",
  evidence: "scripts/direct-git-acceptance.mjs",
  reason: item.ok ? null : item.detail,
}));
const acceptanceOk = acceptanceReport.ok === true && criteria.length === 20
  && criteria.every((item) => item.status === "covered");
const releaseReady = gatesOk && acceptanceOk && skillFailures.length === 0;

const result = {
  grade: "LOCAL",
  generated_at: new Date().toISOString(),
  host: {
    name: "local-workstation",
    version: `${process.version}, ${(await run("git", ["--version"])).stdout.trim()}`,
  },
  repository: "local worktree (no network access, no writes outside disposable directories)",
  verdict: releaseReady ? "verified" : "failed",
  environment: {
    network_used: false,
    external_writes: false,
    native_host_testing: false,
  },
  gates: gates.map(({ ok, command, duration_ms, stdout, stderr }) => ({
    ok,
    command,
    duration_ms,
    diagnostic: ok ? null : [stdout, stderr].filter((output) => output.trim().length > 0).join("\n").trim(),
  })),
  acceptance: {
    counts: {
      covered: criteria.filter((item) => item.status === "covered").length,
      failed: criteria.filter((item) => item.status === "failed").length,
    },
    skill_failures: skillFailures,
    criteria,
  },
  release_ready: releaseReady,
};

if (json) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  process.stdout.write("Reveries LOCAL evaluation (grade: LOCAL)\n\n");
  for (const gate of result.gates) {
    process.stdout.write(`${gate.ok ? "PASS" : "FAIL"} ${gate.command.join(" ")} (${gate.duration_ms} ms)\n`);
    if (!gate.ok && gate.diagnostic !== null) process.stdout.write(`  ${gate.diagnostic.replaceAll("\n", "\n  ")}\n`);
  }
  process.stdout.write("\nPRD acceptance criteria\n");
  for (const item of criteria) {
    process.stdout.write(`${item.status === "covered" ? "PASS" : "FAIL"} ${item.id}. ${item.criterion}\n`);
    if (item.reason !== null && item.reason !== undefined) process.stdout.write(`  ${item.reason}\n`);
  }
  if (skillFailures.length > 0) {
    process.stdout.write("\nSkill failures\n");
    for (const failure of skillFailures) process.stdout.write(`${failure}\n`);
  }
  process.stdout.write(`\nRelease ready: ${releaseReady ? "yes" : "no"}\n`);
}

if (!gatesOk || !acceptanceOk || skillFailures.length > 0 || (strict && !releaseReady)) {
  process.exitCode = 1;
}
