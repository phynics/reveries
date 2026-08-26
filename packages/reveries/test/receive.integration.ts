import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";

import { checkReceive } from "../src/receive.ts";
import { Reveries } from "../src/operations.ts";
import { commitId, objectId, type ReveriesInit, type SessionSummary } from "../src/protocol.ts";

const execFileAsync = promisify(execFile);
const temporary: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd, encoding: "utf8" })).stdout.trim();
}

function summary(): SessionSummary {
  return {
    v: 1,
    type: "session-summary",
    author_email: "receive@example.com",
    session: "receive:test",
    created_at: "2026-08-25T03:05:00Z",
    entries: [{
      driving_event: "The receive boundary needs a durable publication account.",
      decision: "Validate the proposed commit and notes objects before moving refs.",
      impact: "Hosted merges cannot bypass continuity and summary coverage.",
      recurrence_control: "The receive fixture rejects missing evidence.",
      alternatives: [],
      sources: [],
      reveries: [],
      retirements: [],
    }],
  };
}

function initialization(): ReveriesInit {
  return {
    v: 1,
    type: "reveries-init",
    protocol: 1,
    notes_ref: "refs/notes/reveries",
    publishing_remotes: ["origin"],
    hosts: [],
    author_email: "receive@example.com",
    created_at: "2026-08-25T03:05:00Z",
  };
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("receive fixture validates proposed ref updates without moving refs", async () => {
  const root = await mkdtemp(join(tmpdir(), "reveries-receive-"));
  temporary.push(root);
  const source = join(root, "source");
  const bare = join(root, "remote.git");
  await execFileAsync("mkdir", [source]);
  await execFileAsync("git", ["init", "--bare", bare]);
  await git(source, "init", "-b", "main");
  await git(source, "config", "user.name", "Receive Test");
  await git(source, "config", "user.email", "receive@example.com");
  await git(source, "remote", "add", "origin", bare);
  await writeFile(join(source, "state.txt"), "first\n", "utf8");
  await git(source, "add", "state.txt");
  await git(source, "commit", "-m", "initial");

  const reveries = await Reveries.open(source);
  const adoption = await git(source, "rev-parse", "HEAD");
  await reveries.summarize({ commit: adoption, summary: summary() });
  await reveries.attachInitialization({ commit: adoption, record: initialization() });
  const first = await reveries.recordNew({
    path: "state.txt",
    revision: "HEAD",
    semantic: {
      v: 1,
      driving_event: "The receive boundary needs one stable state decision.",
      decision: "Keep the state transition attached to its exact blob.",
      impact: "Every edited successor must explicitly continue this decision.",
      recurrence_control: "The receive checker validates the successor disposition.",
      alternatives: [],
      sources: [],
      supersedes: [],
    },
    metadata: {
      author_email: "receive@example.com",
      session: "receive:test",
      created_at: "2026-08-25T03:00:00Z",
    },
  });
  await git(source, "push", "origin", "main");
  await git(source, "push", "origin", "refs/notes/reveries:refs/notes/reveries");

  await writeFile(join(source, "state.txt"), "second\n", "utf8");
  await git(source, "add", "state.txt");
  await reveries.recordContinue({
    fromBlob: first.object,
    toPath: "state.txt",
    toRevision: "index",
    id: first.record.id,
  });
  await git(source, "commit", "-m", "change state");
  const proposed = commitId(await git(source, "rev-parse", "HEAD"));
  await reveries.summarize({ commit: proposed, summary: summary() });
  const oldObject = commitId(await git(bare, "rev-parse", "refs/heads/main"));
  const oldNotes = objectId(await git(bare, "rev-parse", "refs/notes/reveries"));
  await git(source, "push", "origin", `${proposed}:refs/fixtures/proposed`);
  await git(source, "push", "origin", "refs/notes/reveries:refs/notes/proposed");
  const proposedNotes = objectId(await git(bare, "rev-parse", "refs/notes/proposed"));
  const baseTree = objectId(await git(bare, "rev-parse", `${oldObject}^{tree}`));
  const changedTree = objectId(await git(bare, "rev-parse", `${proposed}^{tree}`));

  const accepted = await checkReceive(bare, {
    updates: [
      { ref: "refs/heads/main", oldObject, newObject: proposed },
      { ref: "refs/notes/reveries", oldObject: oldNotes, newObject: proposedNotes },
    ],
    evidence: [{ object: proposed, baseTree }],
    baseTree,
  });
  assert.equal(accepted.ok, true, JSON.stringify(accepted.diagnostics));
  assert.equal(await git(bare, "rev-parse", "refs/heads/main"), oldObject);

  const missingEvidence = await checkReceive(bare, {
    updates: [{ ref: "refs/heads/main", oldObject, newObject: proposed }],
  });
  assert.equal(missingEvidence.ok, false);
  assert.match(missingEvidence.diagnostics.join("\n"), /notes\/reveries.*update/i);

  const staleBase = await checkReceive(bare, {
    updates: [
      { ref: "refs/heads/main", oldObject, newObject: proposed },
      { ref: "refs/notes/reveries", oldObject: oldNotes, newObject: proposedNotes },
    ],
    evidence: [{ object: proposed, baseTree }],
    baseTree: changedTree,
  });
  assert.equal(staleBase.ok, false);
  assert.match(staleBase.diagnostics.join("\n"), /base tree changed/i);
});
