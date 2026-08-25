import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";

import { runCli, type CliIo } from "../src/cli.ts";
import { Reveries } from "../src/operations.ts";
import type { ReveriesInit, SessionSummary } from "../src/protocol.ts";

const execFileAsync = promisify(execFile);
const temporaryRepositories: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function createRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "reveries-cli-"));
  temporaryRepositories.push(directory);
  await git(directory, "init", "-b", "main");
  await git(directory, "config", "user.name", "Reveries Test");
  await git(directory, "config", "user.email", "reveries@example.com");
  await writeFile(join(directory, "state.txt"), "first\n", "utf8");
  await git(directory, "add", "state.txt");
  await git(directory, "commit", "-m", "initial");
  return directory;
}

function captureIo(cwd: string, stdin = ""): { readonly io: CliIo; readonly stdout: () => string; readonly stderr: () => string } {
  let out = "";
  let error = "";
  return {
    io: {
      cwd,
      stdin: async () => stdin,
      stdout: (text) => { out += text; },
      stderr: (text) => { error += text; },
    },
    stdout: () => out,
    stderr: () => error,
  };
}

function adoptionSummary(): SessionSummary {
  return {
    v: 1,
    type: "session-summary",
    author_email: "reveries@example.com",
    session: "codex:test",
    created_at: "2026-08-25T03:05:00Z",
    entries: [{
      driving_event: "The repository adopted durable engineering memory.",
      decision: "Initialize Reveries because future commits require causal accounts.",
      impact: "Published descendants require one session summary.",
      recurrence_control: "The pre-push checker validates outgoing commits.",
      alternatives: [],
      sources: [],
      reveries: [],
      retirements: [],
    }],
  };
}

async function adopt(directory: string): Promise<{ readonly commit: string; readonly notes: string }> {
  const reveries = await Reveries.open(directory);
  const commit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" })).stdout.trim();
  await reveries.summarize({ commit, summary: adoptionSummary() });
  const init: ReveriesInit = {
    v: 1,
    type: "reveries-init",
    protocol: 1,
    notes_ref: "refs/notes/reveries",
    publishing_remotes: ["origin"],
    hosts: ["codex"],
    author_email: "reveries@example.com",
    created_at: "2026-08-25T03:05:00Z",
  };
  await reveries.attachInitialization({ commit, record: init });
  const notes = (await execFileAsync("git", ["rev-parse", "refs/notes/reveries"], { cwd: directory, encoding: "utf8" })).stdout.trim();
  return { commit, notes };
}

afterEach(async () => {
  await Promise.all(temporaryRepositories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("record and show expose stable JSON output", async () => {
  const directory = await createRepository();
  const draftPath = join(directory, "reverie.json");
  await writeFile(draftPath, JSON.stringify({
    v: 1,
    driving_event: "Two writers could accept incompatible state transitions.",
    decision: "Use one guarded mutation boundary because transition validity needs one owner.",
    impact: "Every transition writer must use the guarded boundary.",
    recurrence_control: "The concurrency test rejects a stale predecessor.",
    alternatives: [],
    sources: [],
    supersedes: [],
    author_email: "reveries@example.com",
    session: "codex:test",
    created_at: "2026-08-25T03:00:00Z"
  }), "utf8");

  const record = captureIo(directory);
  assert.equal(await runCli(["record", "new", "state.txt", "--committed", "--from", draftPath, "--json"], record.io), 0);
  const recorded = JSON.parse(record.stdout()) as { ok: boolean; result: { record: { id: string } } };
  assert.equal(recorded.ok, true);
  assert.match(recorded.result.record.id, /^rv:[0-9a-f]{40}$/);

  const show = captureIo(directory);
  assert.equal(await runCli(["show", "state.txt", "--json"], show.io), 0);
  const shown = JSON.parse(show.stdout()) as { result: { active: Array<{ id: string }> } };
  assert.equal(shown.result.active[0]?.id, recorded.result.record.id);
});

test("semantic failures use exit code 1 and usage errors use exit code 3", async () => {
  const directory = await createRepository();
  const check = captureIo(directory);
  assert.equal(await runCli(["check", "HEAD", "--json"], check.io), 1);
  assert.match(check.stdout(), /initialization boundary/i);

  const usage = captureIo(directory);
  assert.equal(await runCli(["record", "unknown"], usage.io), 3);
  assert.match(usage.stderr(), /usage/i);
});

test("pre-push validates every pushed branch tip rather than HEAD", async () => {
  const directory = await createRepository();
  const adoption = await adopt(directory);
  await git(directory, "checkout", "-b", "topic");
  await writeFile(join(directory, "state.txt"), "topic\n", "utf8");
  await git(directory, "add", "state.txt");
  await git(directory, "commit", "-m", "unsummarized topic");
  const topic = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" })).stdout.trim();
  await git(directory, "checkout", "main");

  const zero = "0".repeat(40);
  const stdin = [
    `refs/heads/topic ${topic} refs/heads/topic ${zero}`,
    `refs/notes/reveries ${adoption.notes} refs/notes/reveries ${zero}`,
    "",
  ].join("\n");
  const prePush = captureIo(directory, stdin);

  assert.equal(await runCli(["pre-push", "origin"], prePush.io), 1);
  assert.match(prePush.stderr(), /session summary/i);
});

test("pre-push rejects a remote notes history not incorporated locally", async () => {
  const directory = await createRepository();
  const adoption = await adopt(directory);
  const blob = (await execFileAsync("git", ["rev-parse", "HEAD:state.txt"], { cwd: directory, encoding: "utf8" })).stdout.trim();
  await git(directory, "notes", "--ref=refs/notes/remote-simulated", "add", "-m", "remote", blob);
  const remoteNotes = (await execFileAsync("git", ["rev-parse", "refs/notes/remote-simulated"], { cwd: directory, encoding: "utf8" })).stdout.trim();

  const stdin = [
    `refs/heads/main ${adoption.commit} refs/heads/main ${adoption.commit}`,
    `refs/notes/reveries ${adoption.notes} refs/notes/reveries ${remoteNotes}`,
    "",
  ].join("\n");
  const prePush = captureIo(directory, stdin);

  assert.equal(await runCli(["pre-push", "origin"], prePush.io), 1);
  assert.match(prePush.stderr(), /remote notes|incorporated/i);
});

test("pre-push does not treat a disappeared established remote notes ref as first publication", async () => {
  const directory = await createRepository();
  const adoption = await adopt(directory);
  await git(directory, "update-ref", "refs/notes/remotes/origin/reveries", adoption.notes);
  const zero = "0".repeat(40);
  const stdin = [
    `refs/heads/main ${adoption.commit} refs/heads/main ${adoption.commit}`,
    `refs/notes/reveries ${adoption.notes} refs/notes/reveries ${zero}`,
    "",
  ].join("\n");
  const prePush = captureIo(directory, stdin);

  assert.equal(await runCli(["pre-push", "origin"], prePush.io), 1);
  assert.match(prePush.stderr(), /remote notes ref is absent|established remote notes/i);
});
