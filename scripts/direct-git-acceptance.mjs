import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function run(command, args, cwd, input = "") {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.on("close", (code) => {
      const result = {
        code: code ?? 128,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (result.code !== 0) {
        reject(new Error(`${command} ${args.join(" ")} failed (${result.code}): ${result.stderr}`));
        return;
      }
      resolvePromise(result.stdout.trim());
    });
    child.stdin.end(input, "utf8");
  });
}

async function git(cwd, ...args) {
  return run("git", args, cwd);
}

const directory = await mkdtemp(join(tmpdir(), "reveries-direct-git-"));
try {
  await git(directory, "init", "-b", "main");
  await git(directory, "config", "user.name", "Reveries acceptance");
  await git(directory, "config", "user.email", "acceptance@example.com");
  await writeFile(join(directory, "state.txt"), "one\n", "utf8");
  await git(directory, "add", "state.txt");
  await git(directory, "commit", "-m", "initial");

  const semantic = {
    v: 1,
    driving_event: "A reproducible defect required one transition authority.",
    decision: "Use one guarded state boundary because it rejects conflicting transitions.",
    impact: "All transition writers must use the guarded boundary.",
    recurrence_control: "A focused concurrency test rejects stale predecessors.",
    alternatives: [],
    sources: [],
    supersedes: [],
  };
  const semanticLine = `${JSON.stringify(semantic)}\n`;
  const oid = await run("git", ["hash-object", "--stdin"], directory, semanticLine);
  const record = {
    v: 1,
    type: "reverie",
    id: `rv:${oid}`,
    ...semantic,
    author_email: "acceptance@example.com",
    session: null,
    created_at: "2026-08-25T03:00:00Z",
  };
  const recordPath = join(directory, "record.jsonl");
  await writeFile(recordPath, `${JSON.stringify(record)}\n`, "utf8");
  const blob = await git(directory, "rev-parse", "HEAD:state.txt");

  await git(
    directory,
    "notes",
    "--ref=refs/notes/reveries",
    "append",
    "--no-separator",
    "--no-stripspace",
    "-F",
    recordPath,
    blob,
  );
  assert.equal(
    await git(directory, "notes", "--ref=refs/notes/reveries", "show", blob),
    JSON.stringify(record),
  );
  assert.match(
    await git(directory, "log", "-1", "--format=%H", "refs/notes/reveries"),
    /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/,
  );
  process.stdout.write("Reveries direct-Git cookbook acceptance passed.\n");
} finally {
  await rm(directory, { recursive: true, force: true });
}
