import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";

import { runCli, type CliIo } from "../src/cli.ts";
import { LEDGER_REF, NOTES_REF, RETENTION_OBJECTS_REF } from "../src/git.ts";
import { Reveries } from "../src/operations.ts";
import { canonicalRecord, type ReverieInput, type ReverieMetadata } from "../src/protocol.ts";

const execFileAsync = promisify(execFile);
const temporaryRepositories: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd, encoding: "utf8" })).stdout.trim();
}

const metadata: ReverieMetadata = {
  author_email: "reveries@example.com",
  session: "codex:hard-redaction-cli",
  created_at: "2026-09-29T09:30:00Z",
};

function semantic(decision: string): ReverieInput {
  return {
    v: 1,
    driving_event: "A recorded decision carried regulated customer data.",
    decision,
    impact: "The rewritten snapshot keeps every surviving decision byte-identical.",
    recurrence_control: "The CLI fixture asserts the removed record is unreachable.",
    alternatives: [],
    sources: [],
    supersedes: [],
  };
}

async function createRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "reveries-hard-redaction-cli-"));
  temporaryRepositories.push(directory);
  await git(directory, "init", "-b", "main");
  await git(directory, "config", "user.name", "Reveries Test");
  await git(directory, "config", "user.email", "reveries@example.com");
  await writeFile(join(directory, "state.txt"), "first\n", "utf8");
  await git(directory, "add", "state.txt");
  await git(directory, "commit", "-m", "initial");
  return directory;
}

interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(argv: readonly string[], cwd: string): Promise<CliResult> {
  let stdout = "";
  let stderr = "";
  const io: CliIo = {
    cwd,
    stdin: async () => "",
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  };
  const code = await runCli(argv, io);
  return { code, stdout, stderr };
}

afterEach(async () => {
  while (temporaryRepositories.length > 0) {
    const directory = temporaryRepositories.pop();
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  }
});

test("redact hard reports the rewrite, the remote work, and the disclaimer", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const secret = await reveries.recordNew({
    path: "state.txt",
    revision: "HEAD",
    semantic: semantic("Keep the customer account numbers."),
    metadata,
  });
  await reveries.retain();
  await git(directory, "remote", "add", "origin", join(directory, ".git"));
  await git(directory, "config", "reveries.remoteRole.origin", "primary");

  const result = await run(
    ["redact", "hard", secret.record.id, "--reason", "Redacted per incident INC-60.", "--no-sign", "--json"],
    directory,
  );

  assert.equal(result.code, 0, result.stderr);
  const envelope = JSON.parse(result.stdout.trim()) as {
    ok: boolean;
    command: string;
    result: {
      state: string;
      removed: string[];
      severedRefs: string[];
      remoteActions: { remote: string; role: string; action: string }[];
      disclaimer: string;
      ledgerAfter: string | null;
    };
  };
  assert.equal(envelope.ok, true);
  assert.equal(envelope.command, "redact hard");
  assert.equal(envelope.result.state, "redacted");
  assert.deepEqual(envelope.result.removed, [secret.record.id]);
  assert.deepEqual(envelope.result.remoteActions, [{
    remote: "origin",
    role: "primary",
    action: envelope.result.remoteActions[0]?.action,
  }]);
  assert.match(envelope.result.disclaimer, /not guaranteed/);
  assert.equal(await git(directory, "rev-parse", "--verify", RETENTION_OBJECTS_REF).then(() => true, () => false), false);
  assert.equal(
    await git(directory, "rev-parse", "--verify", LEDGER_REF),
    envelope.result.ledgerAfter as string,
  );
  const body = await reveries.repository.readNoteFromRef(NOTES_REF, secret.object);
  assert.equal(body?.includes(canonicalRecord(secret.record)), false);
});

test("redact hard prints the disclaimer in human output", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const secret = await reveries.recordNew({
    path: "state.txt",
    revision: "HEAD",
    semantic: semantic("Keep the customer export path."),
    metadata,
  });

  const result = await run(
    ["redact", "hard", secret.record.id, "--reason", "Redacted per incident INC-61.", "--no-sign"],
    directory,
  );

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Hard redacted 1 fact\(s\)/);
  assert.match(result.stdout, /discontinuity checkpoint/);
  assert.match(result.stdout, /may still hold the bytes/);
});

test("redact hard refuses usage errors before touching the repository", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const secret = await reveries.recordNew({
    path: "state.txt",
    revision: "HEAD",
    semantic: semantic("Keep this decision."),
    metadata,
  });
  const notesBefore = await reveries.repository.notesTip();

  const missingReason = await run(["redact", "hard", secret.record.id], directory);
  assert.equal(missingReason.code, 3);
  assert.match(missingReason.stderr, /requires --reason/);

  const noTarget = await run(["redact", "hard", "--reason", "why"], directory);
  assert.equal(noTarget.code, 3);
  assert.match(noTarget.stderr, /at least one fact ID/);

  const badId = await run(["redact", "hard", "not-an-id", "--reason", "why"], directory);
  assert.equal(badId.code, 3);
  assert.match(badId.stderr, /not a fact ID/);

  const wrongAction = await run(["redact", "soft", secret.record.id], directory);
  assert.equal(wrongAction.code, 3);
  assert.match(wrongAction.stderr, /redact action must be hard/);

  assert.equal(await reveries.repository.notesTip(), notesBefore);
});

test("a stale --expect-notes refuses the rewrite and moves no ref", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const secret = await reveries.recordNew({
    path: "state.txt",
    revision: "HEAD",
    semantic: semantic("Keep this decision."),
    metadata,
  });
  const notesBefore = await reveries.repository.notesTip();

  const result = await run([
    "redact",
    "hard",
    secret.record.id,
    "--reason",
    "Redacted per incident INC-62.",
    "--no-sign",
    "--expect-notes",
    "0123456789abcdef0123456789abcdef01234567",
    "--json",
  ], directory);

  assert.equal(result.code, 1);
  const envelope = JSON.parse(result.stdout.trim()) as { ok: boolean; result: { state: string; notesAfter: string | null } };
  assert.equal(envelope.ok, false);
  assert.equal(envelope.result.state, "refused");
  assert.equal(envelope.result.notesAfter, notesBefore);
  assert.equal(await reveries.repository.notesTip(), notesBefore);
});

test("help documents the hard-redaction surface and its limits", async () => {
  const directory = await createRepository();
  const general = await run(["help"], directory);
  assert.match(general.stdout, /redact\s+Hard-redact named facts/);

  const topic = await run(["help", "redact"], directory);
  assert.match(topic.stdout, /Usage: reveries redact hard/);
  assert.match(topic.stdout, /not a claim of erasure/);
  assert.match(topic.stdout, /--reason/);
});