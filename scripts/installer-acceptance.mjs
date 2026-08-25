import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillsCli = join(workspace, "node_modules", "skills", "bin", "cli.mjs");
const source = join(workspace, "skills");
const skillNames = [
  "reveries-git-notes-init",
  "using-reveries",
  "reveries-git-notes-search",
];
const agents = ["pi", "claude-code", "opencode", "codex", "gemini-cli"];

function run(args, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [skillsCli, ...args], {
      cwd: workspace,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
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
      if (result.code !== 0) {
        reject(new Error(`skills ${args.join(" ")} failed (${result.code}): ${result.stderr}\n${result.stdout}`));
        return;
      }
      resolvePromise(result);
    });
  });
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
  process.stdout.write("Reveries Skills installer acceptance passed.\n");
} finally {
  await rm(home, { recursive: true, force: true });
}
