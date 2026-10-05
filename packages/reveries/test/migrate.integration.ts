import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";

import { Reveries } from "../src/operations.ts";
import { objectId } from "../src/protocol.ts";

const execFileAsync = promisify(execFile);
const temporaryRepositories: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

async function createRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "reveries-migrate-"));
  temporaryRepositories.push(directory);
  await git(directory, "init", "-b", "main");
  await git(directory, "config", "user.name", "Reveries Test");
  await git(directory, "config", "user.email", "reveries@example.com");
  await git(directory, "config", "notes.reveries.mergeStrategy", "cat_sort_uniq");
  await writeFile(join(directory, "state.txt"), "first\n", "utf8");
  await git(directory, "add", "state.txt");
  await git(directory, "commit", "-m", "initial");
  return directory;
}

async function writeNote(reveries: Reveries, object: string, body: string): Promise<void> {
  await reveries.repository.run(
    ["notes", "--ref=refs/notes/reveries", "add", "-f", "-F", "-", object],
    { input: body },
  );
}

function legacyEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    driving_event: "A legacy event.",
    decision: "A legacy decision.",
    impact: "A legacy impact.",
    recurrence_control: null,
    alternatives: [],
    sources: [],
    reveries: [],
    retirements: [],
    ...overrides,
  };
}

function sessionSummary(entries: readonly Record<string, unknown>[]): string {
  return `${JSON.stringify({
    v: 1,
    type: "session-summary",
    author_email: "legacy@example.com",
    session: "legacy:session",
    created_at: "2026-08-26T00:00:00Z",
    entries,
  })}\n`;
}

afterEach(async () => {
  await Promise.all(temporaryRepositories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("migrate converts a content-attached summary into a reverie and keeps the legacy bytes", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const blob = await git(directory, "rev-parse", "HEAD:state.txt");
  await writeNote(reveries, blob, sessionSummary([legacyEntry()]));

  const first = await reveries.migrate();
  assert.equal(first.convertedReveries, 1);
  assert.equal(first.changed, true);
  const note = await reveries.repository.readNoteFromRef("refs/notes/reveries", objectId(blob));
  assert.match(note ?? "", /session-summary/);
  assert.match(note ?? "", /A legacy decision\./);
  const shown = await reveries.show({ target: blob, revision: "HEAD" });
  assert.equal(shown.active.length, 1);
  assert.equal(shown.active[0]?.decision, "A legacy decision.");

  // Idempotent: a second run appends nothing.
  const second = await reveries.migrate();
  assert.equal(second.convertedReveries, 0);
  assert.equal(second.changed, false);
  const after = await reveries.repository.readNoteFromRef("refs/notes/reveries", objectId(blob));
  assert.equal(after, note);
});

test("migrate converts a commit-attached retirement into a retire lineage edge", async () => {
  const directory = await createRepository();
  await writeFile(join(directory, "state.txt"), "second\n", "utf8");
  await git(directory, "add", "state.txt");
  await git(directory, "commit", "-m", "change");
  const reveries = await Reveries.open(directory);
  const oldBlob = await git(directory, "rev-parse", "HEAD~1:state.txt");
  const commit = await git(directory, "rev-parse", "HEAD");
  await writeNote(
    reveries,
    commit,
    sessionSummary([legacyEntry({
      retirements: [{ reverie: "rv:0000000000000000000000000000000000000000", from_blob: oldBlob, reason: "The old guard no longer applies." }],
    })]),
  );

  const report = await reveries.migrate();
  assert.equal(report.convertedLineages, 1);
  const note = await reveries.repository.readNoteFromRef("refs/notes/reveries", objectId(oldBlob));
  assert.match(note ?? "", /"type":"lineage"/);
  assert.match(note ?? "", /"kind":"retire"/);
  const shown = await reveries.show({ target: oldBlob, revision: "HEAD" });
  assert.equal(shown.lineage.length, 1);
  assert.equal(shown.lineage[0]?.kind, "retire");

  const again = await reveries.migrate();
  assert.equal(again.convertedLineages, 0);
  assert.equal(again.changed, false);
});
