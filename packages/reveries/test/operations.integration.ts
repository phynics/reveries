import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";

import { Reveries } from "../src/operations.ts";
import { blobId, type ReverieInput, type ReverieMetadata, type ReveriesInit, type SessionSummary } from "../src/protocol.ts";

const execFileAsync = promisify(execFile);
const temporaryRepositories: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

async function gitPath(cwd: string, path: string): Promise<string> {
  const resolved = await git(cwd, "rev-parse", "--git-path", path);
  return isAbsolute(resolved) ? resolved : join(cwd, resolved);
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

function summary(reveries: SessionSummary["entries"][number]["reveries"] = []): SessionSummary {
  return {
    v: 1,
    type: "session-summary",
    author_email: "reveries@example.com",
    session: "codex:test",
    created_at: "2026-08-25T03:05:00Z",
    entries: [{
      driving_event: "The implementation needed one transition owner.",
      decision: "Publish the guarded-boundary change because it removes competing transition authority.",
      impact: "Callers now write through one boundary.",
      recurrence_control: "The concurrency test covers stale predecessors.",
      alternatives: [],
      sources: [],
      reveries: [...reveries],
      retirements: [],
    }],
  };
}

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
  const check = await reveries.checkStaged();
  assert.equal(check.ok, true, JSON.stringify(check.diagnostics));
});

test("repository-backed semantic IDs use SHA-256 when the repository does", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reveries-ops-sha256-"));
  temporaryRepositories.push(directory);
  await git(directory, "init", "-b", "main", "--object-format=sha256");
  await git(directory, "config", "user.name", "Reveries Test");
  await git(directory, "config", "user.email", "reveries@example.com");
  await writeFile(join(directory, "state.txt"), "sha256\n", "utf8");
  await git(directory, "add", "state.txt");
  await git(directory, "commit", "-m", "initial");
  const reveries = await Reveries.open(directory);

  const result = await reveries.recordNew({ path: "state.txt", revision: "HEAD", semantic, metadata });
  const shown = await reveries.show({ target: "state.txt", revision: "HEAD" });

  assert.match(result.record.id, /^rv:[0-9a-f]{64}$/);
  assert.equal(shown.active[0]?.id, result.record.id);
});

test("requires one summary for every descendant of the initialization commit", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const adoption = await git(directory, "rev-parse", "HEAD");
  await reveries.summarize({ commit: adoption, summary: summary() });
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
  await reveries.attachInitialization({ commit: adoption, record: init });

  await writeFile(join(directory, "state.txt"), "second\n", "utf8");
  await git(directory, "add", "state.txt");
  await git(directory, "commit", "-m", "unsummarized");
  const commit = await git(directory, "rev-parse", "HEAD");
  const missing = await reveries.checkCommit(commit);
  assert.equal(missing.ok, false);
  assert.match(missing.diagnostics.join("\n"), /session summary/i);

  await reveries.summarize({ commit, summary: summary() });
  const complete = await reveries.checkCommit(commit);
  assert.equal(complete.ok, true, JSON.stringify(complete.diagnostics));
});

test("summary replacement keeps the initialization record and rejects concurrent duplicates", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const commit = await git(directory, "rev-parse", "HEAD");
  await reveries.summarize({ commit, summary: summary() });
  await reveries.attachInitialization({
    commit,
    record: {
      v: 1,
      type: "reveries-init",
      protocol: 1,
      notes_ref: "refs/notes/reveries",
      publishing_remotes: ["origin"],
      hosts: ["codex"],
      author_email: "reveries@example.com",
      created_at: "2026-08-25T03:05:00Z",
    },
  });
  await assert.rejects(reveries.summarize({ commit, summary: summary() }), /more than one session summary/i);

  await reveries.summarize({
    commit,
    summary: { ...summary(), correction_reason: "The first summary omitted the compatibility constraint." },
    replace: true,
  });
  const shown = await reveries.show({ target: commit });
  assert.equal(shown.records.filter((record) => record.type === "session-summary").length, 1);
  assert.equal(shown.records.filter((record) => record.type === "reveries-init").length, 1);
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

test("deleting one path does not retire a blob that remains at another path", async () => {
  const directory = await createRepository();
  await writeFile(join(directory, "copy.txt"), "first\n", "utf8");
  await git(directory, "add", "copy.txt");
  await git(directory, "commit", "-m", "copy identical blob");
  const reveries = await Reveries.open(directory);
  await reveries.recordNew({ path: "state.txt", revision: "HEAD", semantic, metadata });

  await rm(join(directory, "copy.txt"));
  await git(directory, "add", "copy.txt");
  const check = await reveries.checkStaged();

  assert.equal(check.ok, true, JSON.stringify(check.diagnostics));
});

test("continuity refuses an arbitrary unstaged object", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const first = await reveries.recordNew({ path: "state.txt", revision: "HEAD", semantic, metadata });
  await writeFile(join(directory, "orphan.txt"), "orphan\n", "utf8");
  const orphan = await git(directory, "hash-object", "-w", "orphan.txt");

  await assert.rejects(
    reveries.recordContinueToBlob({
      fromBlob: first.object,
      toBlob: blobId(orphan),
      id: first.record.id,
    }),
    /neither staged nor reachable/i,
  );
});

test("an explicit successor resolves a rename-plus-edit that Git cannot map", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const first = await reveries.recordNew({ path: "state.txt", revision: "HEAD", semantic, metadata });
  await rename(join(directory, "state.txt"), join(directory, "renamed.txt"));
  await writeFile(join(directory, "renamed.txt"), "entirely different successor content\n", "utf8");
  await git(directory, "add", "-A");
  await reveries.recordContinue({
    fromBlob: first.object,
    toPath: "renamed.txt",
    toRevision: "index",
    id: first.record.id,
  });

  assert.equal((await reveries.checkStaged()).ok, false);
  const explicit = await reveries.checkStaged(new Map([["state.txt", "renamed.txt"]]));
  assert.equal(explicit.ok, true, JSON.stringify(explicit.diagnostics));
});

test("merge continuity is checked independently from every parent", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const base = await git(directory, "rev-parse", "HEAD");
  const first = await reveries.recordNew({ path: "state.txt", revision: "HEAD", semantic, metadata });
  await reveries.summarize({ commit: base, summary: summary([first.record.id]) });
  await reveries.attachInitialization({
    commit: base,
    record: {
      v: 1,
      type: "reveries-init",
      protocol: 1,
      notes_ref: "refs/notes/reveries",
      publishing_remotes: ["origin"],
      hosts: ["codex"],
      author_email: "reveries@example.com",
      created_at: "2026-08-25T03:05:00Z",
    },
  });

  await git(directory, "checkout", "-b", "left");
  await writeFile(join(directory, "state.txt"), "left parent\n", "utf8");
  await git(directory, "add", "state.txt");
  const replacement = await reveries.recordSupersede({
    path: "state.txt",
    revision: "index",
    semantic: {
      ...semantic,
      decision: "Use the left-parent guard because it owns the migrated transition format.",
    },
    metadata,
    old: first.record.id,
  });
  await git(directory, "commit", "-m", "left decision");
  const leftCommit = await git(directory, "rev-parse", "HEAD");
  await reveries.summarize({ commit: leftCommit, summary: summary([replacement.record.id]) });

  await git(directory, "checkout", "main");
  await writeFile(join(directory, "state.txt"), "right parent\n", "utf8");
  await git(directory, "add", "state.txt");
  await reveries.recordContinue({
    fromBlob: first.object,
    toPath: "state.txt",
    toRevision: "index",
    id: first.record.id,
  });
  await git(directory, "commit", "-m", "right continuation");
  const rightCommit = await git(directory, "rev-parse", "HEAD");
  await reveries.summarize({ commit: rightCommit, summary: summary() });

  try {
    await git(directory, "merge", "--no-commit", "left");
  } catch {
    // The fixture intentionally creates a content conflict.
  }
  await writeFile(join(directory, "state.txt"), "merged result\n", "utf8");
  await git(directory, "add", "state.txt");
  const mergedBlob = blobId(await git(directory, "rev-parse", ":state.txt"));
  const rightBlob = blobId(await git(directory, "rev-parse", `${rightCommit}:state.txt`));
  await reveries.recordContinueToBlob({ fromBlob: rightBlob, toBlob: mergedBlob, id: first.record.id });
  await git(directory, "commit", "-m", "merge histories");
  const mergeCommit = await git(directory, "rev-parse", "HEAD");
  await reveries.summarize({ commit: mergeCommit, summary: summary() });

  const missingLeft = await reveries.checkCommit(mergeCommit);
  assert.equal(missingLeft.ok, false);
  assert.match(missingLeft.diagnostics.join("\n"), new RegExp(replacement.record.id));

  const leftBlob = blobId(await git(directory, "rev-parse", `${leftCommit}:state.txt`));
  await reveries.recordContinueToBlob({
    fromBlob: leftBlob,
    toBlob: mergedBlob,
    id: replacement.record.id,
  });
  const reconciled = await reveries.checkCommit(mergeCommit);
  assert.equal(reconciled.ok, true, JSON.stringify(reconciled.diagnostics));
});

test("atomically creates a commit and attaches its session summary", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const base = await git(directory, "rev-parse", "HEAD");
  await reveries.summarize({ commit: base, summary: summary() });
  await reveries.attachInitialization({
    commit: base,
    record: {
      v: 1,
      type: "reveries-init",
      protocol: 1,
      notes_ref: "refs/notes/reveries",
      publishing_remotes: [],
      hosts: ["codex"],
      author_email: "reveries@example.com",
      created_at: "2026-08-25T03:05:00Z",
    },
  });
  const previousNotes = await git(directory, "rev-parse", "refs/notes/reveries");
  await writeFile(join(directory, "state.txt"), "second\n", "utf8");
  await git(directory, "add", "state.txt");

  const commit = await reveries.commitWithSummary({ message: "atomic summary", summary: summary() });

  assert.equal(await git(directory, "rev-parse", "HEAD"), commit);
  assert.equal(await git(directory, "rev-parse", `${commit}^`), base);
  assert.equal(await git(directory, "show", `${commit}:state.txt`), "second");
  assert.equal(await git(directory, "show", "-s", "--format=%s", commit), "atomic summary");
  assert.notEqual(await git(directory, "rev-parse", "refs/notes/reveries"), previousNotes);
  assert.equal(await git(directory, "for-each-ref", "--format=%(refname)", "refs/notes/reveries-txn"), "");
  await assert.rejects(access(reveries.repository.writeLockPath()), { code: "ENOENT" });
  const evidence = await reveries.show({ target: commit });
  assert.deepEqual(evidence.records, [summary()]);
  const check = await reveries.checkCommit(commit);
  assert.equal(check.ok, true, JSON.stringify(check.diagnostics));
});

test("post-commit hook sees the published summary and cannot undo the commit", async () => {
  const directory = await createRepository();
  const hookPath = join(directory, ".git", "hooks", "post-commit");
  const markerPath = join(directory, "post-commit-state");
  await writeFile(
    hookPath,
    `#!/bin/sh\n{ git rev-parse HEAD; git notes --ref=refs/notes/reveries show HEAD; } > '${markerPath}'\nexit 1\n`,
    "utf8",
  );
  await execFileAsync("chmod", ["+x", hookPath]);
  const reveries = await Reveries.open(directory);

  const commit = await reveries.commitWithSummary({ message: "post-commit check", summary: summary() });

  assert.equal(await git(directory, "rev-parse", "HEAD"), commit);
  const hookOutput = await readFile(markerPath, "utf8");
  assert.match(hookOutput, new RegExp(`^${commit}\\n`));
  assert.match(hookOutput, /"type":"session-summary"/);
});

test("a rejecting commit-msg hook leaves the branch and notes refs unchanged", async () => {
  const directory = await createRepository();
  const hookPath = join(directory, ".git", "hooks", "commit-msg");
  const markerPath = join(directory, "commit-msg-ran");
  await writeFile(hookPath, `#!/bin/sh\nprintf invoked > '${markerPath}'\nexit 1\n`, "utf8");
  await execFileAsync("chmod", ["+x", hookPath]);
  const reveries = await Reveries.open(directory);
  const branchBefore = await git(directory, "rev-parse", "HEAD");
  const notesBefore = await reveries.repository.notesTip();

  await assert.rejects(
    reveries.commitWithSummary({ message: "rejected", summary: summary() }),
    /commit-msg/i,
  );

  assert.equal(await git(directory, "rev-parse", "HEAD"), branchBefore);
  assert.equal(await reveries.repository.notesTip(), notesBefore);
  assert.equal(await readFile(markerPath, "utf8"), "invoked");
  assert.equal(await git(directory, "for-each-ref", "--format=%(refname)", "refs/notes/reveries-txn"), "");
  await assert.rejects(access(reveries.repository.writeLockPath()), { code: "ENOENT" });
});

test("prepare-commit-msg can edit the message before atomic commit creation", async () => {
  const directory = await createRepository();
  const hookPath = join(directory, ".git", "hooks", "prepare-commit-msg");
  await writeFile(hookPath, "#!/bin/sh\nprintf 'prepared by hook\\n' >> \"$1\"\n", "utf8");
  await execFileAsync("chmod", ["+x", hookPath]);
  const reveries = await Reveries.open(directory);

  const commit = await reveries.commitWithSummary({ message: "original message", summary: summary() });

  assert.equal(await git(directory, "show", "-s", "--format=%B", commit), "original message\nprepared by hook");
});

test("atomic commit creation preserves merge parents", async () => {
  const directory = await createRepository();
  await git(directory, "branch", "side");
  await git(directory, "checkout", "side");
  await writeFile(join(directory, "side.txt"), "side\n", "utf8");
  await git(directory, "add", "side.txt");
  await git(directory, "commit", "-m", "side change");
  const side = await git(directory, "rev-parse", "HEAD");

  await git(directory, "checkout", "main");
  await writeFile(join(directory, "main.txt"), "main\n", "utf8");
  await git(directory, "add", "main.txt");
  await git(directory, "commit", "-m", "main change");
  const main = await git(directory, "rev-parse", "HEAD");
  await git(directory, "merge", "--no-commit", "side");
  assert.equal(await git(directory, "rev-parse", "MERGE_HEAD"), side);
  const mergeHead = await gitPath(directory, "MERGE_HEAD");
  const mergeMessage = await gitPath(directory, "MERGE_MSG");
  const mergeMode = await gitPath(directory, "MERGE_MODE");
  const cherryPickHead = await gitPath(directory, "CHERRY_PICK_HEAD");
  await writeFile(mergeMode, "no-ff\n", "utf8");
  await writeFile(cherryPickHead, `${side}\n`, "utf8");

  const commit = await (await Reveries.open(directory)).commitWithSummary({
    message: "merge with summary",
    summary: summary(),
  });

  assert.equal(await git(directory, "show", "-s", "--format=%P", commit), `${main} ${side}`);
  await assert.rejects(access(mergeHead), { code: "ENOENT" });
  await assert.rejects(access(mergeMessage), { code: "ENOENT" });
  await assert.rejects(access(mergeMode), { code: "ENOENT" });
  assert.equal(await readFile(cherryPickHead, "utf8"), `${side}\n`);
});

test("rejected atomic merge publication preserves MERGE_HEAD, MERGE_MSG, and MERGE_MODE", async () => {
  const directory = await createRepository();
  await git(directory, "branch", "side");
  await git(directory, "checkout", "side");
  await writeFile(join(directory, "side.txt"), "side\n", "utf8");
  await git(directory, "add", "side.txt");
  await git(directory, "commit", "-m", "side change");
  await git(directory, "checkout", "main");
  await writeFile(join(directory, "main.txt"), "main\n", "utf8");
  await git(directory, "add", "main.txt");
  await git(directory, "commit", "-m", "main change");
  await git(directory, "merge", "--no-commit", "side");
  const mergeHead = await gitPath(directory, "MERGE_HEAD");
  const mergeMessage = await gitPath(directory, "MERGE_MSG");
  const mergeMode = await gitPath(directory, "MERGE_MODE");
  await writeFile(mergeMode, "no-ff\n", "utf8");
  const hookPath = join(directory, ".git", "hooks", "commit-msg");
  await writeFile(hookPath, "#!/bin/sh\ngit notes --ref=refs/notes/reveries add -f -m concurrent HEAD\n", "utf8");
  await execFileAsync("chmod", ["+x", hookPath]);
  const reveries = await Reveries.open(directory);

  await assert.rejects(
    reveries.commitWithSummary({ message: "stale merge notes", summary: summary() }),
    /update-ref|lock ref|transaction|changed concurrently/i,
  );

  await access(mergeHead);
  await access(mergeMessage);
  assert.equal(await readFile(mergeMode, "utf8"), "no-ff\n");
  assert.equal(await git(directory, "symbolic-ref", "--short", "HEAD"), "main");
});

test("a stale notes tip prevents the branch update in the same ref transaction", async () => {
  const directory = await createRepository();
  const hookPath = join(directory, ".git", "hooks", "commit-msg");
  const postCommitPath = join(directory, ".git", "hooks", "post-commit");
  const postCommitMarker = join(directory, "post-commit-ran");
  await writeFile(hookPath, "#!/bin/sh\ngit notes --ref=refs/notes/reveries add -f -m concurrent HEAD\n", "utf8");
  await writeFile(postCommitPath, `#!/bin/sh\nprintf invoked > '${postCommitMarker}'\n`, "utf8");
  await execFileAsync("chmod", ["+x", hookPath]);
  await execFileAsync("chmod", ["+x", postCommitPath]);
  const reveries = await Reveries.open(directory);
  const branchBefore = await git(directory, "rev-parse", "HEAD");
  assert.equal(await reveries.repository.notesTip(), null);

  await assert.rejects(
    reveries.commitWithSummary({ message: "stale notes", summary: summary() }),
    /update-ref|lock ref|transaction|changed concurrently/i,
  );

  assert.equal(await git(directory, "rev-parse", "HEAD"), branchBefore);
  assert.notEqual(await reveries.repository.notesTip(), null);
  await assert.rejects(access(postCommitMarker), { code: "ENOENT" });
});

test("a stale branch tip prevents the notes update in the same ref transaction", async () => {
  const directory = await createRepository();
  const hookPath = join(directory, ".git", "hooks", "commit-msg");
  await writeFile(
    hookPath,
    "#!/bin/sh\nparent=$(git rev-parse HEAD)\ntree=$(git write-tree)\nother=$(printf external | git commit-tree \"$tree\" -p \"$parent\")\ngit update-ref refs/heads/main \"$other\" \"$parent\"\n",
    "utf8",
  );
  await execFileAsync("chmod", ["+x", hookPath]);
  const reveries = await Reveries.open(directory);
  const branchBefore = await git(directory, "rev-parse", "HEAD");

  await assert.rejects(
    reveries.commitWithSummary({ message: "stale branch", summary: summary() }),
    /update-ref|lock ref|transaction|changed concurrently/i,
  );

  assert.notEqual(await git(directory, "rev-parse", "HEAD"), branchBefore);
  assert.equal(await reveries.repository.notesTip(), null);
});

test("a branch switch during message preparation aborts without advancing the original branch", async () => {
  const directory = await createRepository();
  const hookPath = join(directory, ".git", "hooks", "prepare-commit-msg");
  await writeFile(hookPath, "#!/bin/sh\ngit checkout -b parallel-work >/dev/null 2>&1\n", "utf8");
  await execFileAsync("chmod", ["+x", hookPath]);
  const reveries = await Reveries.open(directory);
  const branchBefore = await git(directory, "rev-parse", "refs/heads/main");

  await assert.rejects(
    reveries.commitWithSummary({ message: "branch changed", summary: summary() }),
    /branch changed|concurrent/i,
  );

  assert.equal(await git(directory, "rev-parse", "refs/heads/main"), branchBefore);
  assert.equal(await reveries.repository.notesTip(), null);
  assert.equal(await git(directory, "symbolic-ref", "--short", "HEAD"), "parallel-work");
});

test("atomic commit creation preserves author and committer environment metadata", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const identity = {
    GIT_AUTHOR_NAME: "Original Author",
    GIT_AUTHOR_EMAIL: "author@example.test",
    GIT_AUTHOR_DATE: "2001-02-03T04:05:06+00:00",
    GIT_COMMITTER_NAME: "Original Committer",
    GIT_COMMITTER_EMAIL: "committer@example.test",
    GIT_COMMITTER_DATE: "2002-03-04T05:06:07+00:00",
  };
  const previous = new Map(Object.keys(identity).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(identity)) process.env[key] = value;
  let commit: string;
  try {
    commit = await reveries.commitWithSummary({ message: "preserve identity", summary: summary() });
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  assert.equal(
    await git(directory, "show", "-s", "--format=%an <%ae> %aI|%cn <%ce> %cI", commit),
    "Original Author <author@example.test> 2001-02-03T04:05:06+00:00|Original Committer <committer@example.test> 2002-03-04T05:06:07+00:00",
  );
});

test("configured commit signing runs before either canonical ref moves", async () => {
  const directory = await createRepository();
  const signerPath = join(directory, "fake-gpg");
  const markerPath = join(directory, "signer-ran");
  await writeFile(signerPath, `#!/bin/sh\nprintf called > '${markerPath}'\ncat >/dev/null\nexit 1\n`, "utf8");
  await execFileAsync("chmod", ["+x", signerPath]);
  await git(directory, "config", "gpg.format", "openpgp");
  await git(directory, "config", "commit.gpgSign", "true");
  await git(directory, "config", "gpg.program", signerPath);
  const reveries = await Reveries.open(directory);
  const branchBefore = await git(directory, "rev-parse", "HEAD");

  await assert.rejects(
    reveries.commitWithSummary({ message: "signed commit", summary: summary() }),
    /sign|gpg/i,
  );

  assert.equal(await git(directory, "rev-parse", "HEAD"), branchBefore);
  assert.equal(await reveries.repository.notesTip(), null);
  assert.equal(await readFile(markerPath, "utf8"), "called");
});

test("atomic commit-and-summary creation supports SHA-256 repositories", async () => {
  const directory = await createRepository("sha256");
  const reveries = await Reveries.open(directory);

  const commit = await reveries.commitWithSummary({ message: "sha256 commit", summary: summary() });

  assert.equal(commit.length, 64);
  assert.equal(await git(directory, "rev-parse", "HEAD"), commit);
  assert.equal((await reveries.show({ target: commit })).records.length, 1);
});

test("atomic commit-and-summary creation supports an unborn branch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reveries-ops-unborn-"));
  temporaryRepositories.push(directory);
  await git(directory, "init", "-b", "main");
  await git(directory, "config", "user.name", "Reveries Test");
  await git(directory, "config", "user.email", "reveries@example.com");
  await writeFile(join(directory, "state.txt"), "first\n", "utf8");
  await git(directory, "add", "state.txt");
  const reveries = await Reveries.open(directory);

  const commit = await reveries.commitWithSummary({ message: "initial summarized commit", summary: summary() });

  assert.equal(await git(directory, "rev-parse", "HEAD"), commit);
  assert.equal(await git(directory, "show", "-s", "--format=%P", commit), "");
  assert.equal((await reveries.show({ target: commit })).records.length, 1);
});
