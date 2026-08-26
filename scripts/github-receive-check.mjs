import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));

function run(command, args, input = "") {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: workspace, stdio: ["pipe", "pipe", "pipe"] });
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
    child.stdin.end(input);
  });
}

async function git(...args) {
  const result = await run("git", args);
  if (result.code !== 0) throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

const notesTip = await git("rev-parse", "refs/notes/reveries");
let baseSha;
let headSha;
let ref;
if (event.pull_request !== undefined) {
  baseSha = event.pull_request.base.sha;
  headSha = event.pull_request.head.sha;
  ref = `refs/pull/${event.pull_request.number}/head`;
} else if (event.merge_group !== undefined) {
  baseSha = event.merge_group.base_sha;
  headSha = event.merge_group.head_sha;
  ref = event.merge_group.base_ref;
} else {
  throw new Error("Reveries receive check only supports pull_request and merge_group events");
}

const baseTree = await git("rev-parse", `${baseSha}^{tree}`);
const proposal = {
  updates: [
    { ref, old: baseSha, new: headSha },
    { ref: "refs/notes/reveries", old: notesTip, new: notesTip },
  ],
  base_tree: baseTree,
  evidence: [
    { object: headSha, base_tree: baseTree },
    { object: notesTip },
  ],
};
const cli = join(workspace, "packages", "reveries", "dist", "src", "main.js");
const result = await run(process.execPath, [cli, "receive-check", "--json"], `${JSON.stringify(proposal)}\n`);
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.code;
