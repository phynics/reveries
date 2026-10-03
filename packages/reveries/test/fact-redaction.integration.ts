import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";

import { hashBlobContent } from "../src/git.ts";
import { Reveries } from "../src/operations.ts";
import {
  canonicalRecord,
  createCorrection,
  createResolution,
  NOTES_REF,
  recordFactId,
} from "../src/protocol.ts";

const execFileAsync = promisify(execFile);
const temporaryRepositories: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

async function createRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "reveries-fact-redaction-"));
  temporaryRepositories.push(directory);
  await git(directory, "init", "-b", "main");
  await git(directory, "config", "user.name", "Reveries Test");
  await git(directory, "config", "user.email", "reveries@example.com");
  await writeFile(join(directory, "state.txt"), "first\n", "utf8");
  await git(directory, "add", "state.txt");
  await git(directory, "commit", "-m", "initial");
  return directory;
}

afterEach(async () => {
  while (temporaryRepositories.length > 0) {
    const directory = temporaryRepositories.pop();
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  }
});

const metadata = {
  author_email: "reveries@example.com",
  session: "codex:fact-redaction",
  created_at: "2026-09-29T07:00:00Z",
};

function semantic(decision: string) {
  return {
    v: 1 as const,
    driving_event: "A narrative pasted a credential.",
    decision,
    impact: "Normal display must skip the target while bytes remain.",
    recurrence_control: "The redaction integration fails when the target still renders.",
    alternatives: [] as string[],
    sources: [],
    supersedes: [] as never[],
  };
}

test("a redaction hides its target from show and search but keeps history", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const recorded = await reveries.recordNew({ path: "state.txt", revision: "HEAD", semantic: semantic("Redact the narrative because it must not render."), metadata });
  const before = await reveries.show({ target: "state.txt" });
  assert.ok(before.active.some((record) => record.id === recorded.record.id));

  const { record: hide } = await reveries.recordRedaction({
    object: recorded.object,
    target: recorded.record.id,
    reason: "The narrative pasted a credential that must not render.",
    metadata,
  });
  assert.match(hide.id, /^rd:[0-9a-f]{40}$/);

  const shown = await reveries.show({ target: "state.txt" });
  assert.ok(!shown.records.some((record) => record.type === "reverie"));
  assert.deepEqual(shown.active, []);
  assert.ok(shown.diagnostics.some((diagnostic) => /redacted/i.test(diagnostic)));

  const revealed = await reveries.show({ target: "state.txt", includeRedacted: true });
  assert.ok(revealed.records.some((record) => record.type === "reverie"));

  const history = await reveries.history("state.txt");
  const historical = history.flatMap((entry) => entry.records);
  assert.ok(historical.some((record) => record.type === "reverie"));
  assert.ok(historical.some((record) => record.type === "redaction"));

  const found = await reveries.searchWithCompleteness({ query: "credential" });
  assert.ok(!found.hits.some((hit) => hit.record.type === "reverie"));
  const foundAll = await reveries.searchWithCompleteness({ query: "credential", includeRedacted: true });
  assert.ok(foundAll.hits.some((hit) => hit.record.type === "reverie"));
});

test("corrections only append: earlier canonical lines stay verbatim", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const recorded = await reveries.recordNew({ path: "state.txt", revision: "HEAD", semantic: semantic("Use the guarded boundary because it owns the transition."), metadata });
  const baseLine = canonicalRecord(recorded.record);
  const left = await reveries.recordCorrection({
    object: recorded.object,
    correction: { ...semantic("Use the left owner because it guards writes."), supersedes: [recorded.record.id] },
    metadata,
  });
  const raw = await reveries.repository.readNoteFromRef(NOTES_REF, recorded.object);
  assert.ok(raw !== null && raw.includes(baseLine));
  assert.ok(raw !== null && raw.includes(canonicalRecord(left.record)));
  assert.equal(raw?.split("\n").filter((line) => line.length > 0).length, 2);

  const shown = await reveries.show({ target: "state.txt" });
  assert.equal(shown.factGraph.forks.length, 0);
  assert.deepEqual(shown.factGraph.active.map((record) => recordFactId(record)), [left.record.id]);
  await reveries.validateNotesSnapshot(await reveries.loadEvidenceSnapshot({}));
});

/**
 * Concurrent corrections arrive from another replica, so the fixture appends
 * the foreign lines directly. The local writer itself stays fail-closed:
 * `mutateNotes` validates the candidate before promotion, so it can never
 * create a fork locally. Forked unions are what sync quarantines (RVR-001,
 * deferred), and the projection is what makes them visible.
 *
 * `git notes append -m` joins note bodies with a blank line, which the
 * protocol forbids, so the whole body is rewritten from a line list instead.
 */
async function writeNoteLines(directory: string, object: string, lines: readonly string[]): Promise<void> {
  const body = `${lines.map((line) => line.trimEnd()).join("\n")}\n`;
  await git(directory, "notes", "--ref=refs/notes/reveries", "add", "-f", "-m", body, object);
}

async function currentNoteLines(directory: string, object: string): Promise<string[]> {
  const body = await git(directory, "notes", "--ref=refs/notes/reveries", "show", object);
  return body.split("\n").filter((line) => line.length > 0);
}

function correctionRecord(decision: string, heads: string[]) {
  return createCorrection(
    { ...semantic(decision), supersedes: heads as never[] },
    metadata,
    (bytes) => hashBlobContent(bytes, "sha1"),
  );
}

test("a concurrent correction forms a visible fork and fails promotion closed", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const recorded = await reveries.recordNew({ path: "state.txt", revision: "HEAD", semantic: semantic("Use the guarded boundary because it owns the transition."), metadata });
  const local = await reveries.recordCorrection({
    object: recorded.object,
    correction: { ...semantic("Use the left owner because it guards writes."), supersedes: [recorded.record.id] },
    metadata,
  });
  const foreign = correctionRecord("Use the right owner because it guards reads.", [recorded.record.id]);
  const before = await currentNoteLines(directory, recorded.object);
  await writeNoteLines(directory, recorded.object, [
    ...before,
    canonicalRecord(foreign),
  ]);

  const shown = await reveries.show({ target: "state.txt" });
  assert.equal(shown.factGraph.forks.length, 1);
  assert.deepEqual(
    shown.factGraph.forks[0]?.slice(1).sort(),
    [foreign.id, local.record.id].sort(),
  );
  // Promotion is the same gate sync, push, and receive use.
  await assert.rejects(
    reveries.validateNotesSnapshot(await reveries.loadEvidenceSnapshot({})),
    /Unresolved supersession fork detected/,
  );
  // The local writer refuses to create such a union itself.
  await assert.rejects(
    reveries.recordCorrection({
      object: recorded.object,
      correction: { ...semantic("Use a third owner because it guards writes."), supersedes: [recorded.record.id] },
      metadata,
    }),
    /Unresolved supersession fork detected/,
  );
});

test("a resolution naming every head converges the fork and unblocks promotion", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const recorded = await reveries.recordNew({ path: "state.txt", revision: "HEAD", semantic: semantic("Use the guarded boundary because it owns the transition."), metadata });
  const local = await reveries.recordCorrection({
    object: recorded.object,
    correction: { ...semantic("Use the left owner because it guards writes."), supersedes: [recorded.record.id] },
    metadata,
  });
  const foreign = correctionRecord("Use the right owner because it guards reads.", [recorded.record.id]);
  let lines = await currentNoteLines(directory, recorded.object);
  await writeNoteLines(directory, recorded.object, [...lines, canonicalRecord(foreign)]);
  assert.equal((await reveries.show({ target: "state.txt" })).factGraph.forks.length, 1);

  const resolve = createResolution(
    {
      v: 1,
      driving_event: "Two replicas recorded concurrent corrections.",
      decision: "Converge on the guarded boundary.",
      impact: "Naming every head produces one active result.",
      recurrence_control: "The resolution integration fails when the fork stays open.",
      alternatives: [],
      sources: [],
      resolves: [foreign.id, local.record.id],
    },
    metadata,
    (bytes) => hashBlobContent(bytes, "sha1"),
  );
  lines = await currentNoteLines(directory, recorded.object);
  await writeNoteLines(directory, recorded.object, [...lines, canonicalRecord(resolve)]);

  const converged = await reveries.show({ target: "state.txt" });
  assert.equal(converged.factGraph.forks.length, 0);
  assert.deepEqual(converged.factGraph.active.map((record) => recordFactId(record)), [resolve.id]);
  await reveries.validateNotesSnapshot(await reveries.loadEvidenceSnapshot({}));

  // Every earlier canonical line survives the convergence.
  const raw = await reveries.repository.readNoteFromRef(NOTES_REF, recorded.object);
  for (const line of [
    canonicalRecord(recorded.record),
    canonicalRecord(local.record),
    canonicalRecord(foreign),
    canonicalRecord(resolve),
  ]) {
    assert.ok(raw !== null && raw.includes(line));
  }
});

test("a resolution naming only one head leaves the fork visible and unpromotable", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const recorded = await reveries.recordNew({ path: "state.txt", revision: "HEAD", semantic: semantic("Use the guarded boundary because it owns the transition."), metadata });
  const local = await reveries.recordCorrection({
    object: recorded.object,
    correction: { ...semantic("Use the left owner because it guards writes."), supersedes: [recorded.record.id] },
    metadata,
  });
  const foreign = correctionRecord("Use the right owner because it guards reads.", [recorded.record.id]);
  const lines = await currentNoteLines(directory, recorded.object);
  await writeNoteLines(directory, recorded.object, [...lines, canonicalRecord(foreign)]);

  const partial = createResolution(
    {
      v: 1,
      driving_event: "Two replicas recorded concurrent corrections.",
      decision: "Converge on the left owner alone.",
      impact: "A partial resolution leaves the fork open.",
      recurrence_control: "The resolution integration fails when a partial resolution converges.",
      alternatives: [],
      sources: [],
      resolves: [local.record.id],
    },
    metadata,
    (bytes) => hashBlobContent(bytes, "sha1"),
  );
  const withPartial = await currentNoteLines(directory, recorded.object);
  await writeNoteLines(directory, recorded.object, [...withPartial, canonicalRecord(partial)]);

  const shown = await reveries.show({ target: "state.txt" });
  assert.equal(shown.factGraph.forks.length, 1);
  // The partial resolution supersedes the local correction only. The foreign
  // correction has no successor, so it stays an active head and the fork
  // remains two-terminal instead of converging.
  assert.deepEqual(
    shown.factGraph.forks[0]?.slice(1).sort(),
    [foreign.id, partial.id].sort(),
  );
  const active = shown.factGraph.active.map((record) => recordFactId(record));
  assert.ok(active.includes(foreign.id));
  assert.ok(active.includes(partial.id));
  assert.ok(!active.includes(local.record.id));
  await assert.rejects(
    reveries.validateNotesSnapshot(await reveries.loadEvidenceSnapshot({})),
    /Unresolved supersession fork detected/,
  );
});
