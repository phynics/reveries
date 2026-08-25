import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(workspace, "packages", "reveries", "dist", "src", "main.js");
const cliLibrary = join(workspace, "packages", "reveries", "dist", "src", "cli.js");

async function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
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
      if (!(options.allow ?? [0]).includes(result.code)) {
        reject(new Error(`${command} ${args.join(" ")} failed (${result.code})\n${result.stderr}`));
        return;
      }
      resolvePromise(result);
    });
    child.stdin.end(options.input ?? "");
  });
}

async function git(cwd, ...args) {
  return (await run("git", args, { cwd })).stdout.trim();
}

const temporary = await mkdtemp(join(tmpdir(), "reveries-conformance-"));
try {
  const repository = join(temporary, "repository");
  const remote = join(temporary, "remote.git");
  const bin = join(temporary, "bin");
  await mkdir(repository);
  await mkdir(remote);
  await mkdir(bin);
  await git(remote, "init", "--bare");
  await git(repository, "init", "-b", "main");
  await git(repository, "config", "user.name", "Reveries Conformance");
  await git(repository, "config", "user.email", "conformance@example.com");
  await git(repository, "remote", "add", "origin", remote);
  await writeFile(join(repository, "state.txt"), "first\n", "utf8");
  await git(repository, "add", "state.txt");
  await git(repository, "commit", "-m", "initial fixture");

  const wrapper = join(bin, "reveries");
  await writeFile(wrapper, `#!/bin/sh\nexec node ${JSON.stringify(cli)} "$@"\n`, "utf8");
  await chmod(wrapper, 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` };
  process.env.PATH = env.PATH;
  const { runCli } = await import(pathToFileURL(cliLibrary).href);
  const invokeRaw = async (args, stdin = "") => {
    let stdout = "";
    let stderr = "";
    const code = await runCli(args, {
      cwd: repository,
      stdin: async () => stdin,
      stdout: (text) => { stdout += text; },
      stderr: (text) => { stderr += text; },
      helper: { command: process.execPath, args: [cli], verification: "self" },
    });
    return { code, stdout, stderr };
  };
  const invoke = async (...args) => {
    const result = await invokeRaw(args);
    if (result.code !== 0) throw new Error(`reveries ${args.join(" ")} failed (${result.code})\n${result.stderr}${result.stdout}`);
    return result;
  };

  const initializationResult = await invoke(
    "init",
    "--hosts", "codex,claude,gemini",
    "--remote", "origin",
    "--directive-email", "user@example.com",
    "--skill-setup", "reminder",
    "--json",
  );
  assert.notEqual(initializationResult.stdout.trim(), "", initializationResult.stderr);
  const initialized = JSON.parse(initializationResult.stdout);
  assert.equal(initialized.ok, true);
  assert.equal(initialized.result.enforcement, "complete");
  const adopted = JSON.parse((await invoke(
    "adopt",
    "--plan", initialized.result.templatePaths.plan,
    "--message", "adopt Reveries",
    "--json",
  )).stdout);
  const adoption = adopted.result.commit;
  const adoptionNote = JSON.parse((await invoke("show", adoption, "--json")).stdout);
  assert.deepEqual(adoptionNote.result.records.map((record) => record.type).sort(), ["reveries-init", "session-summary"]);
  assert.equal((await invoke("check", adoption, "--json")).code, 0);
  const summaryPath = join(repository, "summary.json");
  const summary = JSON.parse(await readFile(initialized.result.templatePaths.sessionSummary, "utf8"));

  const reveriePath = join(repository, "reverie.json");
  await writeFile(reveriePath, JSON.stringify({
    v: 1,
    driving_event: "Two transition owners could accept incompatible histories.",
    decision: "Use one guarded mutation boundary because transition validity needs one owner.",
    impact: "Every transition writer must use the guarded boundary.",
    recurrence_control: "The concurrency test rejects a stale predecessor.",
    alternatives: [],
    sources: [],
    supersedes: [],
    author_email: "conformance@example.com",
    session: "automation:conformance",
    created_at: "2026-08-25T03:10:00Z"
  }), "utf8");
  const recorded = JSON.parse((await invoke(
    "record", "new", "state.txt", "--committed", "--from", reveriePath, "--json",
  )).stdout).result;
  await writeFile(join(repository, "state.txt"), "second\n", "utf8");
  await git(repository, "add", "state.txt");
  const successor = await git(repository, "rev-parse", ":state.txt");
  await invoke(
    "record", "continue",
    "--from-blob", recorded.object,
    "--to-blob", successor,
    "--id", recorded.record.id,
  );
  await git(repository, "commit", "-m", "change state implementation");
  const changed = await git(repository, "rev-parse", "HEAD");
  await writeFile(summaryPath, JSON.stringify({
    ...summary,
    created_at: "2026-08-25T03:15:00Z",
    entries: [{ ...summary.entries[0], decision: "Publish the state change because the guarded-boundary decision remains valid." }],
  }), "utf8");
  await invoke("summarize", changed, "--from", summaryPath);
  assert.equal((await invoke("check", changed, "--json")).code, 0);

  const search = JSON.parse((await invoke("search", "guarded mutation", "--json")).stdout);
  assert.equal(search.result.length, 1);
  const hookInput = JSON.stringify({
    host: "codex",
    session: "conformance",
    tool: "read",
    input: { path: "state.txt" },
    output: {},
  });
  const hook = JSON.parse((await invokeRaw(["hook", "after-tool"], hookInput)).stdout);
  assert.match(hook.context, /repository engineering evidence/);

  await invoke("push", "origin");
  assert.equal(await git(remote, "rev-parse", "refs/heads/main"), changed);
  assert.match(await git(remote, "rev-parse", "refs/notes/reveries"), /^[0-9a-f]{40}$/);
  assert.match(await readFile(join(repository, "AGENTS.md"), "utf8"), /reveries:begin/);

  process.stdout.write("Reveries compiled-artifact conformance passed.\n");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
