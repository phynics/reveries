import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { GitRepository, NotesContentionError } from "../src/git.ts";
import { Reveries } from "../src/operations.ts";
import type { ObjectId } from "../src/protocol.ts";
import type { ReverieInput, ReverieMetadata } from "../src/protocol.ts";

const execFileAsync = promisify(execFile);
const temporaryPaths: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

async function createRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "reveries-concurrency-"));
  temporaryPaths.push(directory);
  await git(directory, "init", "-b", "main");
  await git(directory, "config", "user.name", "Reveries Test");
  await git(directory, "config", "user.email", "reveries@example.com");
  await writeFile(join(directory, "state.txt"), "first\n", "utf8");
  await git(directory, "add", "state.txt");
  await git(directory, "commit", "-m", "initial");
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryRefs(directory: string): Promise<string> {
  return git(directory, "for-each-ref", "--format=%(refname)", "refs/notes/reveries-txn");
}

function semanticFor(index: number): ReverieInput {
  return {
    v: 1,
    driving_event: `Concurrent writer ${index} observed a shared transition.`,
    decision: `Writer ${index} appends its own guarded record.`,
    impact: `Record ${index} must survive concurrent publication.`,
    recurrence_control: `The 20-writer test asserts record ${index} converges.`,
    alternatives: [],
    sources: [],
    supersedes: [],
  };
}

const metadata: ReverieMetadata = {
  author_email: "reveries@example.com",
  session: "codex:concurrency",
  created_at: "2026-08-25T03:00:00Z",
};

test("a stale write.lock left by a killed writer never blocks later writes", async () => {
  const directory = await createRepository();
  const repository = await GitRepository.open(directory);
  const blob = await repository.resolvePath({ path: "state.txt", revision: "HEAD" });

  // Simulate `kill -9` between lock acquisition and release: the lock
  // directory and its owner file survive the dead process.
  const lockPath = repository.writeLockPath();
  await mkdir(lockPath, { recursive: true });
  await writeFile(join(lockPath, "owner.json"), `{"pid":999999,"started_at":"2026-01-01T00:00:00Z"}\n`, "utf8");

  await repository.withNotesWrite((notes) => notes.append(blob, "{\"after-kill\":true}\n"));

  assert.match(await repository.readNote(blob) ?? "", /"after-kill":true/);
});

test("a SIGKILLed writer mid-transaction leaves the next write unblocked", async () => {
  const directory = await createRepository();
  const repository = await GitRepository.open(directory);
  const blob = await repository.resolvePath({ path: "state.txt", revision: "HEAD" });
  const srcUrl = new URL("../src/git.ts", import.meta.url).href;
  const marker = join(directory, "child-started");
  const childScript = [
    `import { writeFileSync } from "node:fs";`,
    `import { GitRepository } from ${JSON.stringify(fileURLToPath(srcUrl))};`,
    `const repository = await GitRepository.open(${JSON.stringify(directory)});`,
    `await repository.withNotesWrite(async () => {`,
    `  writeFileSync(${JSON.stringify(marker)}, "started\\n");`,
    `  await new Promise((resolve) => setTimeout(resolve, 30000));`,
    `});`,
  ].join("\n");
  const child = spawn(
    process.execPath,
    ["--experimental-transform-types", "--input-type=module", "--eval", childScript],
    { stdio: "ignore" },
  );
  try {
    const deadline = Date.now() + 15000;
    for (;;) {
      try {
        await access(marker);
        break;
      } catch {
        if (Date.now() > deadline) throw new Error("Child writer never started its transaction");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    child.kill("SIGKILL");
    await new Promise((resolve) => child.on("exit", resolve));

    await repository.withNotesWrite((notes) => notes.append(blob, "{\"after-sigkill\":true}\n"));
    assert.match(await repository.readNote(blob) ?? "", /"after-sigkill":true/);
    // The killed writer's abandoned temp ref is disposable, never a blockage.
    const leftovers = await repository.listTemporaryNotesRefs();
    assert.ok(Array.isArray(leftovers));
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already exited.
    }
  }
});

test("two contention events replay without losing either record", async () => {
  const directory = await createRepository();
  const repository = await GitRepository.open(directory);
  const blob = await repository.resolvePath({ path: "state.txt", revision: "HEAD" });
  let attempts = 0;

  await repository.withNotesWrite(async (notes) => {
    attempts += 1;
    await notes.append(blob, "{\"inside\":true}\n");
    if (attempts <= 2) {
      await git(
        directory,
        "notes",
        "--ref=refs/notes/reveries",
        "append",
        "-m",
        `{"outside":${attempts}}`,
        blob,
      );
    }
  });

  assert.equal(attempts, 3);
  const note = await repository.readNote(blob);
  assert.match(note ?? "", /"inside":true/);
  assert.match(note ?? "", /"outside":1/);
  assert.match(note ?? "", /"outside":2/);
  assert.equal(await temporaryRefs(directory), "");
});

test("concurrent linked-worktree writers lose no records", async () => {
  const directory = await createRepository();
  const linked = `${directory}-linked`;
  temporaryPaths.push(linked);
  await git(directory, "worktree", "add", "-b", "linked", linked);
  for (const cwd of [directory, linked]) {
    await git(cwd, "config", "user.name", "Reveries Test");
    await git(cwd, "config", "user.email", "reveries@example.com");
  }

  const primary = await Reveries.open(directory);
  const secondary = await Reveries.open(linked);

  await Promise.all([
    primary.recordNew({ path: "state.txt", revision: "HEAD", semantic: semanticFor(1), metadata }),
    secondary.recordNew({ path: "state.txt", revision: "HEAD", semantic: semanticFor(2), metadata }),
  ]);

  const first = await GitRepository.open(directory);
  const blob = await first.resolvePath({ path: "state.txt", revision: "HEAD" });
  const note = await first.readNote(blob);
  assert.match(note ?? "", /Concurrent writer 1/);
  assert.match(note ?? "", /Concurrent writer 2/);
  assert.equal(await temporaryRefs(directory), "");
});

test("twenty parallel appenders converge or fail with bounded contention, never silent loss", { timeout: 120000 }, async () => {
  const directory = await createRepository();
  const writers = await Promise.all(
    Array.from({ length: 20 }, () => Reveries.open(directory)),
  );
  const contentions: NotesContentionError[] = [];
  const failures: unknown[] = [];

  await Promise.all(writers.map((reveries, index) =>
    reveries.recordNew({
      path: "state.txt",
      revision: "HEAD",
      semantic: semanticFor(index),
      metadata,
    }).catch((error: unknown) => {
      if (error instanceof NotesContentionError) contentions.push(error);
      else failures.push(error);
    }),
  ));

  assert.deepEqual(failures, []);
  const repository = await GitRepository.open(directory);
  const blob = await repository.resolvePath({ path: "state.txt", revision: "HEAD" });
  const note = await repository.readNote(blob);
  // Match the full phrase: "writer 1" is a substring of "writer 10", so an
  // unanchored match would count phantom survivors.
  const phrase = (index: number): RegExp => new RegExp(`Concurrent writer ${index} observed`);
  if (contentions.length === 0) {
    for (let index = 0; index < 20; index += 1) {
      assert.match(note ?? "", phrase(index), `writer ${index} record missing`);
    }
  } else {
    for (const contention of contentions) {
      assert.ok(contention.attempts >= 2, "contention failure reports its attempt count");
    }
    // Bounded failure is explicit: every surviving record is still present.
    const surviving = Array.from({ length: 20 }, (_, index) => index)
      .filter((index) => phrase(index).test(note ?? ""));
    assert.equal(surviving.length, 20 - contentions.length);
  }
  assert.equal(await temporaryRefs(directory), "");
  await assert.rejects(access(repository.writeLockPath()), { code: "ENOENT" });
});

test("doctor reports stale lock leftovers and orphan temp refs as notices, not damage", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const repository = reveries.repository;

  const lockPath = repository.writeLockPath();
  await mkdir(lockPath, { recursive: true });
  await writeFile(join(lockPath, "owner.json"), `{"pid":999999,"started_at":"2026-01-01T00:00:00Z"}\n`, "utf8");
  await repository.run(["update-ref", "refs/notes/reveries-txn/999999-orphan", await repository.resolveCommit("HEAD")]);

  const result = await reveries.doctor();
  assert.ok(result.notices.some((notice) => notice.includes("write.lock")), "stale lock reported");
  assert.ok(result.notices.some((notice) => notice.includes("reveries-txn")), "orphan temp ref reported");
  assert.ok(
    result.diagnostics.every((diagnostic) => !diagnostic.includes("write.lock") && !diagnostic.includes("reveries-txn")),
    "leftovers never count as damage",
  );

  const pruned = await reveries.pruneTemporaryNotesRefs({ olderThanMs: 0 });
  assert.ok(pruned.pruned.includes("refs/notes/reveries-txn/999999-orphan"));
  assert.equal(await temporaryRefs(directory), "");
  const after = await reveries.doctor();
  assert.ok(after.notices.every((notice) => !notice.includes("reveries-txn")));
});
