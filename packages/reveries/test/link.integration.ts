import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";

import { Reveries } from "../src/operations.ts";
import { runCli, type CliIo } from "../src/cli.ts";
import { type ObjectId, type ReverieInput, type ReverieMetadata } from "../src/protocol.ts";

const execFileAsync = promisify(execFile);
const temporaryRepositories: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return result.stdout.trim();
}

async function createRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "reveries-link-"));
  temporaryRepositories.push(directory);
  await git(directory, "init", "-b", "main");
  await git(directory, "config", "user.name", "Reveries Test");
  await git(directory, "config", "user.email", "reveries@example.com");
  await writeFile(join(directory, "state.txt"), "first\nsecond\nthird\n", "utf8");
  await git(directory, "add", "state.txt");
  await git(directory, "commit", "-m", "initial");
  return directory;
}

afterEach(async () => {
  for (const directory of temporaryRepositories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

const semantic: ReverieInput = {
  v: 1,
  driving_event: "A repeated state transition needs one decision.",
  decision: "Use a guarded mutation boundary.",
  impact: "Every transition writer uses the same guard.",
  recurrence_control: "The concurrency test rejects a stale predecessor.",
  alternatives: [],
  sources: [],
  supersedes: [],
};

const metadata: ReverieMetadata = {
  author_email: "reveries@example.com",
  session: "test:link",
  created_at: "2026-08-25T03:00:00Z",
};

test("a link is written to every `to` note and shares one ID across notes", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  // One predecessor splits into two distinct successor subjects.
  await reveries.recordNew({ path: "state.txt", revision: "HEAD", semantic, metadata });
  await rm(join(directory, "state.txt"));
  await writeFile(join(directory, "left.txt"), "left successor\n", "utf8");
  await writeFile(join(directory, "right.txt"), "right successor\n", "utf8");
  await git(directory, "add", "-A");
  await git(directory, "commit", "-m", "split into two paths");

  const result = await reveries.link({
    kind: "split",
    commit: "HEAD",
    parent: "HEAD~1",
    from: ["state.txt"],
    to: ["left.txt", "right.txt"],
    semantic: {
      driving_event: "One subject became two.",
      decision: "Both paths continue the original decision.",
      impact: "Each path carries the same lineage edge.",
      recurrence_control: null,
      alternatives: [],
      sources: [],
    },
    metadata,
  });

  assert.equal(result.subjects.length, 2);
  assert.deepEqual(
    [...result.subjects].sort(),
    [await git(directory, "rev-parse", "HEAD:left.txt"), await git(directory, "rev-parse", "HEAD:right.txt")].sort(),
  );
  for (const subject of result.subjects) {
    const note = await git(directory, "notes", "--ref=refs/notes/reveries", "show", subject as string);
    assert.match(note, new RegExp(`"id":"${result.record.id}"`));
  }
  // The immutable record is byte-identical on both endpoint notes: the lineage
  // line is present on each, with the rest of the note's own records around it.
  const lineageLines = new Set<string>();
  for (const subject of result.subjects) {
    const note = await git(directory, "notes", "--ref=refs/notes/reveries", "show", subject as string);
    const matching = note.split("\n").filter((line) => line.includes(`"id":"${result.record.id}"`));
    assert.equal(matching.length, 1, `expected exactly one lineage line on ${subject}`);
    lineageLines.add(matching[0]!);
  }
  assert.equal(lineageLines.size, 1);
});

test("a retire link with no successor is written to every `from` endpoint", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  await reveries.recordNew({ path: "state.txt", revision: "HEAD", semantic, metadata });
  await rm(join(directory, "state.txt"));
  await git(directory, "add", "-A");
  await git(directory, "commit", "-m", "delete the subject");

  const result = await reveries.link({
    kind: "retire",
    commit: "HEAD",
    parent: "HEAD~1",
    from: ["state.txt"],
    to: [],
    semantic: {
      driving_event: "The subject was deleted.",
      decision: "Stop asserting the decision.",
      impact: "No successor carries it.",
      recurrence_control: null,
      alternatives: [],
      sources: [],
    },
    metadata,
  });

  assert.equal(result.subjects.length, 1);
  assert.deepEqual(result.to, []);
  const note = await git(directory, "notes", "--ref=refs/notes/reveries", "show", result.subjects[0] as string);
  assert.match(note, new RegExp(`"id":"${result.record.id}"`));
});

test("the CLI exposes link and points the removed lineage record form at it", async () => {
  const directory = await createRepository();
  let out = "";
  let error = "";
  const io: CliIo = {
    cwd: directory,
    stdin: async () => "",
    stdout: (text) => { out += text; },
    stderr: (text) => { error += text; },
  };

  assert.equal(await runCli(["help", "link"], io), 0);
  assert.match(out, /reveries link --kind/);

  // A missing --edit means the draft is read from stdin; the interactive path
  // fails before any prompt, so no repository state is touched.
  out = "";
  error = "";
  const code = await runCli([
    "lineage", "record", "--kind", "preserve", "--commit", "HEAD", "--from", "state.txt",
  ], io);
  assert.equal(code, 3, `${out}${error}`);
  assert.match(error, /replaced by link/i);
});

test("link suggest prints a runnable link command and never asserts evidence", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  await reveries.recordNew({ path: "state.txt", revision: "HEAD", semantic, metadata });
  await git(directory, "mv", "state.txt", "moved.txt");
  await git(directory, "commit", "-m", "rename");

  const suggestions = await reveries.suggestLineage({ revision: "HEAD" });
  for (const suggestion of suggestions.suggestions) {
    assert.equal(suggestion.confirmed, false);
  }

  let out = "";
  const io: CliIo = {
    cwd: directory,
    stdin: async () => "",
    stdout: (text) => { out += text; },
    stderr: () => undefined,
  };
  assert.equal(await runCli(["link", "suggest", "HEAD", "--json"], io), 0);
  const parsed = JSON.parse(out) as { command: string; result: { suggestions: Array<{ record: string; confirmed: boolean }> } };
  assert.equal(parsed.command, "link suggest");
  for (const suggestion of parsed.result.suggestions) {
    assert.equal(suggestion.confirmed, false);
    assert.match(suggestion.record, /^reveries link /);
  }
});

test("a lineage record attached by link is discoverable from both endpoints", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  await reveries.recordNew({ path: "state.txt", revision: "HEAD", semantic, metadata });
  await writeFile(join(directory, "moved.txt"), "first\nsecond edited\nthird\n", "utf8");
  await git(directory, "add", "moved.txt");
  await git(directory, "commit", "-m", "copy the subject elsewhere");

  const result = await reveries.link({
    kind: "derive",
    commit: "HEAD",
    parent: "HEAD~1",
    from: ["state.txt"],
    to: ["moved.txt"],
    semantic: {
      driving_event: "The subject was derived into a new path.",
      decision: "The new path continues the decision.",
      impact: "The edge is discoverable from the new path.",
      recurrence_control: null,
      alternatives: [],
      sources: [],
    },
    metadata,
  });

  const shown = await reveries.show({ target: "moved.txt" });
  assert.deepEqual(shown.lineage.map((entry) => entry.id), [result.record.id]);
  assert.equal(await reveries.repository.objectType(result.subjects[0] as ObjectId), "blob");
});
