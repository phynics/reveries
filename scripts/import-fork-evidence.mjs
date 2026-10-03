import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function parseScriptArgs(argv) {
  const options = { targetDir: null };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--target-dir") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--target-dir requires a value");
      }
      options.targetDir = value;
      index += 1;
    } else {
      throw new Error(`unknown option ${token}`);
    }
  }
  return options;
}

export function resolveTargetDir(options = {}) {
  // Fork objects are fetched into the target repository and never checked
  // out or executed. The default output manifest stays beside this script's
  // source tree; callers override it with REVERIES_EVIDENCE_OUTPUT.
  if (typeof options.targetDir === "string" && options.targetDir.length > 0) {
    return resolve(options.targetDir);
  }
  const fromEnv = process.env.REVERIES_TARGET_DIR;
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    return resolve(fromEnv);
  }
  return workspace;
}

function run(command, args, cwd = workspace) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({
      code: code ?? 128,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
}

async function main() {
  const options = parseScriptArgs(process.argv.slice(2));
  const targetDir = resolveTargetDir(options);
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
  const pullRequest = event.pull_request;
  if (pullRequest === undefined || pullRequest.head?.repo?.full_name === undefined) {
    throw new Error("Fork evidence import requires a pull_request_target event");
  }
  const repository = pullRequest.head.repo.full_name;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("The fork repository name is malformed");
  }

  const remoteRef = `refs/notes/reveries-import/pr-${pullRequest.number}`;
  const fetched = await run("git", [
    "fetch", "--no-tags", `https://github.com/${repository}.git`,
    `+refs/notes/reveries:${remoteRef}`,
  ], targetDir);
  const output = process.env.REVERIES_EVIDENCE_OUTPUT ?? join(workspace, "reveries-fork-evidence.json");
  await mkdir(dirname(output), { recursive: true });
  if (fetched.code !== 0) {
    await writeFile(output, `${JSON.stringify({ v: 1, state: "absent", pull_request: pullRequest.number })}\n`, "utf8");
    process.stdout.write("The fork did not publish a Reveries notes ref; no evidence was imported.\n");
    process.exitCode = 0;
  } else {
    const listed = await run("git", ["notes", `--ref=${remoteRef}`, "list"], targetDir);
    const tip = (await run("git", ["rev-parse", remoteRef], targetDir)).stdout.trim();
    const objects = listed.stdout.trim().split("\n").filter(Boolean).map((line) => line.split(" ")[1]).filter(Boolean);
    await writeFile(output, `${JSON.stringify({
      v: 1,
      state: "imported",
      pull_request: pullRequest.number,
      source_repository: repository,
      notes_tip: tip,
      evidence_objects: objects,
    })}\n`, "utf8");
    process.stdout.write(`Imported ${objects.length} fork evidence objects for PR #${pullRequest.number}.\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
