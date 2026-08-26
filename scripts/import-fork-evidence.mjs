import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
const pullRequest = event.pull_request;
if (pullRequest === undefined || pullRequest.head?.repo?.full_name === undefined) {
  throw new Error("Fork evidence import requires a pull_request_target event");
}
const repository = pullRequest.head.repo.full_name;
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
  throw new Error("The fork repository name is malformed");
}

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: workspace, stdio: ["ignore", "pipe", "pipe"] });
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

const remoteRef = `refs/notes/reveries-import/pr-${pullRequest.number}`;
const fetched = await run("git", [
  "fetch", "--no-tags", `https://github.com/${repository}.git`,
  `+refs/notes/reveries:${remoteRef}`,
]);
const output = process.env.REVERIES_EVIDENCE_OUTPUT ?? join(workspace, "reveries-fork-evidence.json");
await mkdir(dirname(output), { recursive: true });
if (fetched.code !== 0) {
  await writeFile(output, `${JSON.stringify({ v: 1, state: "absent", pull_request: pullRequest.number })}\n`, "utf8");
  process.stdout.write("The fork did not publish a Reveries notes ref; no evidence was imported.\n");
  process.exitCode = 0;
} else {
  const listed = await run("git", ["notes", `--ref=${remoteRef}`, "list"]);
  const tip = (await run("git", ["rev-parse", remoteRef])).stdout.trim();
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
