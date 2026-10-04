import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";

import { Reveries } from "../src/operations.ts";
import { type ReverieInput, type ReverieMetadata } from "../src/protocol.ts";

const execFileAsync = promisify(execFile);
const temporaryRepositories: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

async function createRepository(objectFormat: "sha1" | "sha256" = "sha1"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "reveries-ops-"));
  temporaryRepositories.push(directory);
  await git(directory, "init", "-b", "main", `--object-format=${objectFormat}`);
  await git(directory, "config", "user.name", "Reveries Test");
  await git(directory, "config", "user.email", "reveries@example.com");
  await writeFile(join(directory, "state.txt"), "first\n", "utf8");
  await git(directory, "add", "state.txt");
  await git(directory, "commit", "-m", "initial");
  return directory;
}

const semantic: ReverieInput = {
  v: 1,
  driving_event: "Two writers could accept incompatible state transitions.",
  decision: "Use one guarded mutation boundary because transition validity needs one owner.",
  impact: "Every transition writer must use the guarded boundary.",
  recurrence_control: "The concurrency test rejects a stale predecessor.",
  alternatives: ["Reconcile two transition histories after each write"],
  sources: [],
  supersedes: [],
};

const metadata: ReverieMetadata = {
  author_email: "reveries@example.com",
  session: "codex:test",
  created_at: "2026-08-25T03:00:00Z",
};

afterEach(async () => {
  await Promise.all(temporaryRepositories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("records, shows, and continues a decision onto a staged successor blob", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const first = await reveries.recordNew({ path: "state.txt", revision: "HEAD", semantic, metadata });

  const shown = await reveries.show({ target: "state.txt", revision: "HEAD" });
  assert.equal(shown.active.length, 1);
  assert.equal(shown.active[0]?.id, first.record.id);
  assert.deepEqual(shown.paths, ["state.txt"]);

  await writeFile(join(directory, "state.txt"), "second\n", "utf8");
  await git(directory, "add", "state.txt");
  const stagedBefore = await reveries.show({ target: "state.txt", revision: "index" });
  assert.equal(stagedBefore.active.length, 0);

  const continued = await reveries.recordContinue({
    fromBlob: first.object,
    toPath: "state.txt",
    toRevision: "index",
    id: first.record.id,
  });
  assert.equal(continued.record.id, first.record.id);
});

test("repository-backed semantic IDs use SHA-256 when the repository does", async () => {
  const directory = await createRepository("sha256");
  const reveries = await Reveries.open(directory);

  const result = await reveries.recordNew({ path: "state.txt", revision: "HEAD", semantic, metadata });
  const shown = await reveries.show({ target: "state.txt", revision: "HEAD" });

  assert.match(result.record.id, /^rv:[0-9a-f]{64}$/);
  assert.equal(shown.active[0]?.id, result.record.id);
});

test("search defaults to current blobs and supports historical notes", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  await reveries.recordNew({ path: "state.txt", revision: "HEAD", semantic, metadata });

  const current = await reveries.search({ query: "guarded mutation", all: false });
  assert.equal(current.length, 1);
  assert.deepEqual(current[0]?.paths, ["state.txt"]);

  await writeFile(join(directory, "state.txt"), "replacement\n", "utf8");
  await git(directory, "add", "state.txt");
  await git(directory, "commit", "-m", "replace");
  const noLongerCurrent = await reveries.search({ query: "guarded mutation", all: false });
  assert.equal(noLongerCurrent.length, 0);
  const historical = await reveries.search({ query: "guarded mutation", all: true });
  assert.equal(historical.length, 1);
});

test("doctor reports retention coverage and the subjects a vault misses", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const recorded = await reveries.recordNew({ path: "state.txt", revision: "HEAD", semantic, metadata });

  const uncovered = await reveries.doctor();
  assert.equal(uncovered.retention.policy, "active");
  assert.equal(uncovered.retention.state, "incomplete");
  assert.deepEqual([...uncovered.retention.missing], [recorded.object]);
  // An incomplete vault is rebuildable, so it is a notice and never damage.
  assert.doesNotMatch(uncovered.diagnostics.join(" "), /Retention policy active does not keep/);
  assert.match(uncovered.notices.join(" "), /Retention policy active does not keep 1 annotated subject/);
  assert.match(uncovered.notices.join(" "), /Retention: policy active; incomplete; 0 of 1 annotated subject/);

  await reveries.retain();
  const covered = await reveries.doctor();
  assert.equal(covered.retention.state, "current");
  assert.deepEqual([...covered.retention.missing], []);
  assert.match(covered.notices.join(" "), /Retention: policy active; current; 1 of 1 annotated subject/);
});

test("retention rebuild is byte-stable for the same annotated subject set", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  await reveries.recordNew({ path: "state.txt", revision: "HEAD", semantic, metadata });
  const first = await reveries.retain();
  const tip = await reveries.repository.notesTip("refs/reveries/retention");
  assert.notEqual(tip, null);
  assert.equal(first.changed, true);

  const second = await reveries.retain();
  assert.deepEqual([...second.retained].sort(), [...first.retained].sort());
  assert.notEqual(await reveries.repository.notesTip("refs/reveries/retention"), null);
  assert.equal(tip !== null, true);
});
