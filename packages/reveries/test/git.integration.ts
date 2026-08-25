import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";

import { GitRepository, NOTES_REF } from "../src/git.ts";

const execFileAsync = promisify(execFile);
const temporaryRepositories: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

async function createRepository(objectFormat: "sha1" | "sha256" = "sha1"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "reveries-git-"));
  temporaryRepositories.push(directory);
  await git(directory, "init", "-b", "main", `--object-format=${objectFormat}`);
  await git(directory, "config", "user.name", "Reveries Test");
  await git(directory, "config", "user.email", "reveries@example.com");
  await writeFile(join(directory, "state.txt"), "first\n", "utf8");
  await git(directory, "add", "state.txt");
  await git(directory, "commit", "-m", "initial");
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryRepositories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("resolves only committed and staged blobs", async () => {
  const directory = await createRepository();
  const repository = await GitRepository.open(directory);
  const committed = await repository.resolvePath({ path: "state.txt", revision: "HEAD" });

  await writeFile(join(directory, "state.txt"), "unstaged\n", "utf8");
  assert.equal(await repository.resolvePath({ path: "state.txt", revision: "HEAD" }), committed);

  await git(directory, "add", "state.txt");
  const staged = await repository.resolvePath({ path: "state.txt", revision: "index" });
  assert.notEqual(staged, committed);
});

test("hashes semantic payloads with the repository object format", async () => {
  for (const format of ["sha1", "sha256"] as const) {
    const directory = await createRepository(format);
    const repository = await GitRepository.open(directory);
    const oid = await repository.hashObject("{\"v\":1}\n");
    const expected = (await repository.run(["hash-object", "--stdin"], { input: "different\n" })).stdout.trim();
    assert.equal(oid.length, format === "sha1" ? 40 : 64);
    assert.notEqual(oid, expected, "the fixture hashes different input");
  }
});

test("writes exact JSONL through the canonical notes ref", async () => {
  const directory = await createRepository();
  const repository = await GitRepository.open(directory);
  const blob = await repository.resolvePath({ path: "state.txt", revision: "HEAD" });
  const line = "{\"v\":1,\"type\":\"reverie\",\"id\":\"rv:test\"}\n";
  const secondLine = "{\"v\":1,\"type\":\"reverie\",\"id\":\"rv:second\"}\n";

  await repository.withNotesWrite(async (notes) => {
    assert.equal(await notes.read(blob), null);
    await notes.append(blob, line);
    await notes.append(blob, secondLine);
  });

  assert.equal(await repository.readNote(blob), `${line}${secondLine}`);
  assert.equal(await git(directory, "rev-parse", "--verify", NOTES_REF), await repository.notesTip());
});

test("replaces one note without dropping another annotated object", async () => {
  const directory = await createRepository();
  const repository = await GitRepository.open(directory);
  const blob = await repository.resolvePath({ path: "state.txt", revision: "HEAD" });
  const commit = await repository.resolveCommit("HEAD");

  await repository.withNotesWrite(async (notes) => {
    await notes.append(blob, "{\"blob\":1}\n");
    await notes.append(commit, "{\"commit\":1}\n");
  });
  await repository.withNotesWrite(async (notes) => {
    await notes.replace(commit, "{\"commit\":2}\n");
  });

  assert.equal(await repository.readNote(blob), "{\"blob\":1}\n");
  assert.equal(await repository.readNote(commit), "{\"commit\":2}\n");
});

test("linked worktrees use the same common-directory lock", async () => {
  const directory = await createRepository();
  const linked = `${directory}-linked`;
  temporaryRepositories.push(linked);
  await git(directory, "worktree", "add", "-b", "linked", linked);
  const primary = await GitRepository.open(directory);
  const secondary = await GitRepository.open(linked);

  assert.equal(await primary.commonDirectory(), await secondary.commonDirectory());
  assert.equal(primary.writeLockPath(), secondary.writeLockPath());
});

test("notes remain ordinary Git data", async () => {
  const directory = await createRepository();
  const repository = await GitRepository.open(directory);
  const blob = await repository.resolvePath({ path: "state.txt", revision: "HEAD" });
  await repository.withNotesWrite((notes) => notes.append(blob, "{\"direct\":true}\n"));

  const noteOid = (await repository.listNotes()).find((entry) => entry.object === blob)?.note;
  assert.ok(noteOid);
  const looseNote = await readFile(join(directory, ".git", "refs", "notes", "reveries"), "utf8");
  assert.equal(looseNote.trim(), await repository.notesTip());
  assert.equal(await git(directory, "cat-file", "blob", noteOid), "{\"direct\":true}");
});

test("a writer outside the shared lock forces a compare-and-swap retry", async () => {
  const directory = await createRepository();
  const repository = await GitRepository.open(directory);
  const blob = await repository.resolvePath({ path: "state.txt", revision: "HEAD" });
  let attempts = 0;

  await repository.withNotesWrite(async (notes) => {
    attempts += 1;
    await notes.append(blob, "{\"inside\":true}\n");
    if (attempts === 1) {
      await git(
        directory,
        "notes",
        "--ref=refs/notes/reveries",
        "add",
        "-m",
        "{\"outside\":true}",
        blob,
      );
    }
  });

  assert.equal(attempts, 2);
  const note = await repository.readNote(blob);
  assert.match(note ?? "", /"inside":true/);
  assert.match(note ?? "", /"outside":true/);
});

test("two clones merge independent canonical note lines without loss", async () => {
  const source = await createRepository();
  const bare = await mkdtemp(join(tmpdir(), "reveries-bare-"));
  const firstClone = await mkdtemp(join(tmpdir(), "reveries-clone-a-"));
  const secondClone = await mkdtemp(join(tmpdir(), "reveries-clone-b-"));
  temporaryRepositories.push(bare, firstClone, secondClone);
  await git(bare, "init", "--bare");
  await git(source, "remote", "add", "origin", bare);
  await git(source, "push", "origin", "main");
  await git(firstClone, "clone", source, ".");
  await git(secondClone, "clone", source, ".");
  for (const clone of [firstClone, secondClone]) {
    await git(clone, "remote", "set-url", "origin", bare);
    await git(clone, "config", "user.name", "Reveries Test");
    await git(clone, "config", "user.email", "reveries@example.com");
  }
  const first = await GitRepository.open(firstClone);
  const second = await GitRepository.open(secondClone);
  const blob = await first.resolvePath({ path: "state.txt", revision: "HEAD" });
  await first.withNotesWrite((notes) => notes.append(blob, "{\"record\":\"a\"}\n"));
  await second.withNotesWrite((notes) => notes.append(blob, "{\"record\":\"b\"}\n"));
  await git(firstClone, "push", "origin", "refs/notes/reveries:refs/notes/reveries");

  await second.fetchNotes("origin");
  await second.mergeFetchedNotes("origin");

  const merged = await second.readNote(blob);
  assert.match(merged ?? "", /"record":"a"/);
  assert.match(merged ?? "", /"record":"b"/);
});

test("fetching an unpublished remote notes ref reports absence without failing", async () => {
  const directory = await createRepository();
  const bare = await mkdtemp(join(tmpdir(), "reveries-no-notes-"));
  temporaryRepositories.push(bare);
  await git(bare, "init", "--bare");
  await git(directory, "remote", "add", "origin", bare);
  await git(directory, "push", "origin", "main");

  const repository = await GitRepository.open(directory);
  assert.equal(await repository.fetchNotes("origin"), "absent");
});
