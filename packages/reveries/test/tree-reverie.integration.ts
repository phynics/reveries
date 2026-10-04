import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";

import { runCli, type CliIo } from "../src/cli.ts";
import { Reveries } from "../src/operations.ts";
import {
  createReverie,
  validateNote,
  type ReverieInput,
  type ReverieMetadata,
} from "../src/protocol.ts";

const execFileAsync = promisify(execFile);
const temporaryRepositories: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

async function createRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "reveries-tree-reverie-"));
  temporaryRepositories.push(directory);
  await git(directory, "init", "-b", "main");
  await git(directory, "config", "user.name", "Reveries Test");
  await git(directory, "config", "user.email", "reveries@example.com");
  await mkdir(join(directory, "mod", "inner"), { recursive: true });
  await writeFile(join(directory, "mod", "a.txt"), "alpha\n", "utf8");
  await writeFile(join(directory, "mod", "inner", "b.txt"), "beta\n", "utf8");
  await writeFile(join(directory, "top.txt"), "top\n", "utf8");
  await git(directory, "add", ".");
  await git(directory, "commit", "-m", "initial");
  return directory;
}

afterEach(async () => {
  while (temporaryRepositories.length > 0) {
    const directory = temporaryRepositories.pop();
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  }
});

const semantic: ReverieInput = {
  v: 1,
  driving_event: "The module layout forces every consumer to update together.",
  decision: "Keep the module directory composition because its split layout matches the loader.",
  impact: "Every checkout with this exact subtree shares the same loading behavior.",
  recurrence_control: "Tree fixtures fail when subtree evidence stops resolving.",
  alternatives: ["Flatten the module"],
  sources: [],
  supersedes: [],
};

const metadata: ReverieMetadata = {
  author_email: "reveries@example.com",
  session: "codex:tree-reverie",
  created_at: "2026-10-02T00:00:00Z",
};

test("a directory records a tree reverie that show resolves by path and by tree OID", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const recorded = await reveries.recordNew({ path: "mod", revision: "HEAD", semantic, metadata });
  assert.deepEqual(recorded.paths, ["mod"]);

  const byPath = await reveries.show({ target: "mod", revision: "HEAD" });
  assert.equal(byPath.objectType, "tree");
  assert.deepEqual(byPath.paths, ["mod"]);
  assert.equal(byPath.active[0]?.id, recorded.record.id);

  const byOid = await reveries.show({ target: String(recorded.object), revision: "HEAD" });
  assert.equal(byOid.object, recorded.object);
  assert.equal(byOid.active[0]?.id, recorded.record.id);
});

test("a tree source kind validates strictly without changing existing source bytes", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const recorded = await reveries.recordNew({ path: "mod", revision: "HEAD", semantic, metadata });
  const tree = String(recorded.object);

  const withTreeSource: ReverieInput = {
    ...semantic,
    decision: "Reference the exact subtree as provenance for this file decision.",
    sources: [{ relation: "derived-from", kind: "tree", ref: tree }],
  };
  const record = createReverie(
    withTreeSource,
    metadata,
    (bytes) => reveries.repository.hashObjectSync(bytes),
  );
  const validated = validateNote([record], {
    hashObject: (bytes) => reveries.repository.hashObjectSync(bytes),
  });
  assert.equal(validated.length, 1);

  const malformed: ReverieInput = {
    ...semantic,
    sources: [{ relation: "derived-from", kind: "tree", ref: "not-an-object-id" }],
  };
  assert.throws(
    () => createReverie(malformed, metadata, (bytes) => reveries.repository.hashObjectSync(bytes)),
    /Invalid Git object ID/,
  );
});

test("a missing tree source fails closed instead of validating silently", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const missing = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  assert.equal(await reveries.repository.treeExists(missing as never), false);
  const withMissingSource: ReverieInput = {
    ...semantic,
    decision: "Cite a subtree that does not exist locally.",
    sources: [{ relation: "derived-from", kind: "tree", ref: missing }],
  };
  await assert.rejects(
    reveries.recordNew({ path: "top.txt", revision: "HEAD", semantic: withMissingSource, metadata }),
    /Broken local tree source/,
  );
});

function captureIo(cwd: string): { readonly io: CliIo; readonly stdout: () => string } {
  let out = "";
  return {
    io: {
      cwd,
      stdin: async () => "",
      stdout: (text) => { out += text; },
      stderr: () => undefined,
    },
    stdout: () => out,
  };
}

test("recording discloses universal tree applicability", async () => {
  const directory = await createRepository();
  const captured = captureIo(directory);
  const exitCode = await runCli([
    "record", "new", "mod",
    "--driving-event", semantic.driving_event,
    "--decision", semantic.decision,
    "--impact", semantic.impact,
    "--recurrence-control", semantic.recurrence_control!,
  ], captured.io);
  assert.equal(exitCode, 0);
  assert.match(captured.stdout(), /Applies to every occurrence of the exact recorded content/);
});
