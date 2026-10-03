import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";

import { GitRepository } from "../src/git.ts";
import { Reveries } from "../src/operations.ts";
import {
  blobId,
  objectId,
  reverieId,
  type ReverieInput,
  type ReverieMetadata,
  type ReveriesInit,
  type SessionSummary,
  type SummaryEntry,
} from "../src/protocol.ts";

const execFileAsync = promisify(execFile);
const temporaryRepositories: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

async function createRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "reveries-hosted-"));
  temporaryRepositories.push(directory);
  await git(directory, "init", "-b", "main");
  await git(directory, "config", "user.name", "Reveries Test");
  await git(directory, "config", "user.email", "reveries@example.com");
  await writeFile(join(directory, "state.txt"), "first\n", "utf8");
  await git(directory, "add", "state.txt");
  await git(directory, "commit", "-m", "initial");
  return directory;
}

const semantic: ReverieInput = {
  v: 1,
  driving_event: "The recorded boundary no longer explains the transition.",
  decision: "Retire the recorded boundary because the replacement owns the transition.",
  impact: "The annotated blob no longer carries an active decision.",
  recurrence_control: "The retirement fixture fails when the disposition is missing.",
  alternatives: ["Keep the superseded decision active beside its replacement"],
  sources: [],
  supersedes: [],
};

const metadata: ReverieMetadata = {
  author_email: "reveries@example.com",
  session: "codex:hosted",
  created_at: "2026-08-25T03:00:00Z",
};

function summary(decision: string): SessionSummary {
  return {
    v: 1,
    type: "session-summary",
    author_email: "reveries@example.com",
    session: "codex:hosted",
    created_at: "2026-08-25T03:05:00Z",
    entries: [{
      driving_event: "The pull request changed the transition boundary.",
      decision,
      impact: "Reviewers read the change beside its causal account.",
      recurrence_control: "The publication check requires one summary per descendant commit.",
      alternatives: [],
      sources: [],
      reveries: [],
      retirements: [],
    }],
  };
}

function retirementSummary(reverie: string, fromBlob: string, include: boolean): SessionSummary {
  const base = summary("Retire the boundary because the replacement owns the transition.");
  return {
    ...base,
    entries: [{
      ...base.entries[0]!,
      reveries: [reverieId(reverie)],
      retirements: include ? [{
        reverie: reverieId(reverie),
        from_blob: blobId(fromBlob),
        reason: "The transition boundary was replaced by the pull request.",
      }] : [],
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
    hosts: ["codex"],
    author_email: "reveries@example.com",
    created_at: "2026-08-25T03:05:00Z",
  };
}

async function adopt(directory: string): Promise<string> {
  const reveries = await Reveries.open(directory);
  const commit = await git(directory, "rev-parse", "HEAD");
  await reveries.summarize({ commit, summary: summary("Adopt Reveries so blob decisions survive review.") });
  await reveries.attachInitialization({ commit, record: initialization() });
  return commit;
}

function hostedSummary(entries: readonly SummaryEntry[]): SessionSummary {
  return {
    v: 1,
    type: "session-summary",
    author_email: "41898282+github-actions[bot]@users.noreply.github.com",
    session: "github-actions:post-merge:1717171717",
    created_at: "2026-08-25T04:00:00Z",
    entries: entries.map((entry) => ({
      ...entry,
      sources: [
        ...entry.sources,
        { relation: "requested-by", kind: "issue", ref: "github:phynics/reveries#28" },
      ],
    })),
  };
}

async function commitChange(directory: string, path: string, content: string, message: string): Promise<string> {
  await writeFile(join(directory, path), content, "utf8");
  await git(directory, "add", path);
  await git(directory, "commit", "-m", message);
  return git(directory, "rev-parse", "HEAD");
}

async function cloneFrom(source: string, remote: string, prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryRepositories.push(directory);
  await git(directory, "clone", source, ".");
  await git(directory, "remote", "set-url", "origin", remote);
  await git(directory, "config", "user.name", "Reveries Test");
  await git(directory, "config", "user.email", "reveries@example.com");
  const reveries = await Reveries.open(directory);
  const synced = await reveries.syncPull("origin");
  assert.equal(synced.ok, true, JSON.stringify(synced));
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryRepositories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("a host-created merge commit receives one entry per pull request commit", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  await adopt(directory);
  await git(directory, "checkout", "-b", "topic");
  const first = await commitChange(directory, "one.txt", "one\n", "first pull request change");
  await reveries.summarize({ commit: first, summary: summary("Add the first pull request change.") });
  const second = await commitChange(directory, "two.txt", "two\n", "second pull request change");
  await reveries.summarize({ commit: second, summary: summary("Add the second pull request change.") });
  await git(directory, "checkout", "main");
  await git(directory, "merge", "--no-ff", "-m", "Merge pull request #28 from phynics/topic", "topic");
  const merge = await git(directory, "rev-parse", "HEAD");

  const plan = await reveries.synthesizeHostedSummary({ commit: merge, sourceCommits: [first, second] });

  assert.equal(plan.state, "ready", JSON.stringify(plan));
  assert.deepEqual(plan.diagnostics, []);
  assert.deepEqual(
    plan.entries.map((entry) => entry.sources.filter((source) => source.relation === "derived-from").map((source) => source.ref)),
    [[first], [second]],
  );
  assert.deepEqual(plan.entries.map((entry) => entry.decision), [
    "Add the first pull request change.",
    "Add the second pull request change.",
  ]);

  const write = await reveries.attachHostedSummary({ commit: merge, summary: hostedSummary(plan.entries) });
  assert.equal(write.state, "attached");
  assert.equal((await reveries.checkCommit(merge)).ok, true, JSON.stringify(await reveries.checkCommit(merge)));
  const shown = await reveries.show({ target: merge });
  assert.equal(shown.records.filter((record) => record.type === "session-summary").length, 1);
  const attached = (shown.records[0] as SessionSummary);
  assert.equal(attached.author_email, "41898282+github-actions[bot]@users.noreply.github.com");
  assert.equal(attached.session, "github-actions:post-merge:1717171717");
  assert.ok(
    attached.entries.every((entry) => entry.sources.some(
      (source) => source.kind === "issue" && source.ref === "github:phynics/reveries#28",
    )),
  );
});

test("a squashed pull request keeps the retirement evidence recorded on its commits", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  await adopt(directory);
  const predecessor = await reveries.recordNew({ path: "state.txt", revision: "HEAD", semantic, metadata });
  await git(directory, "checkout", "-b", "topic");
  await writeFile(join(directory, "state.txt"), "second\n", "utf8");
  await git(directory, "add", "state.txt");
  await git(directory, "commit", "-m", "replace the recorded boundary");
  const topic = await git(directory, "rev-parse", "HEAD");
  await reveries.summarize({
    commit: topic,
    summary: retirementSummary(predecessor.record.id, predecessor.object, true),
  });
  await git(directory, "checkout", "main");
  await git(directory, "merge", "--squash", "topic");
  await git(directory, "commit", "-m", "Squashed pull request #28");
  const squash = await git(directory, "rev-parse", "HEAD");

  const plan = await reveries.synthesizeHostedSummary({ commit: squash, sourceCommits: [topic] });

  assert.equal(plan.state, "ready", JSON.stringify(plan));
  assert.equal(plan.entries.length, 1);
  assert.deepEqual(plan.entries[0]?.reveries, [predecessor.record.id]);
  assert.equal(plan.entries[0]?.retirements.length, 1);
  assert.equal(plan.entries[0]?.retirements[0]?.from_blob, predecessor.object);

  const attached = await reveries.attachHostedSummary({ commit: squash, summary: hostedSummary(plan.entries) });
  assert.equal(attached.state, "attached");
  assert.equal((await reveries.checkCommit(squash)).ok, true, JSON.stringify(await reveries.checkCommit(squash)));
});

test("a synthesized summary that fails strict validation is never written", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  await adopt(directory);
  const predecessor = await reveries.recordNew({ path: "state.txt", revision: "HEAD", semantic, metadata });
  await git(directory, "checkout", "-b", "topic");
  await writeFile(join(directory, "state.txt"), "second\n", "utf8");
  await git(directory, "add", "state.txt");
  await git(directory, "commit", "-m", "replace the recorded boundary without a disposition");
  const topic = await git(directory, "rev-parse", "HEAD");
  await reveries.summarize({
    commit: topic,
    summary: retirementSummary(predecessor.record.id, predecessor.object, false),
  });
  await git(directory, "checkout", "main");
  await git(directory, "merge", "--squash", "topic");
  await git(directory, "commit", "-m", "Squashed pull request #28 without a disposition");
  const squash = await git(directory, "rev-parse", "HEAD");
  const notesBefore = await git(directory, "rev-parse", "refs/notes/reveries");

  const plan = await reveries.synthesizeHostedSummary({ commit: squash, sourceCommits: [topic] });
  assert.equal(plan.state, "ready", JSON.stringify(plan));
  assert.deepEqual(plan.entries[0]?.retirements, []);

  await assert.rejects(
    reveries.attachHostedSummary({ commit: squash, summary: hostedSummary(plan.entries) }),
    /missing-disposition/,
  );
  assert.equal(await git(directory, "rev-parse", "refs/notes/reveries"), notesBefore);
  assert.deepEqual((await reveries.show({ target: squash })).records, []);
});

test("a rebased pull request summarizes only the new tip commit", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const adoption = await adopt(directory);
  await git(directory, "checkout", "-b", "topic");
  const originalFirst = await commitChange(directory, "one.txt", "one\n", "first pull request change");
  await reveries.summarize({ commit: originalFirst, summary: summary("Add the first pull request change.") });
  const originalSecond = await commitChange(directory, "two.txt", "two\n", "second pull request change");
  await reveries.summarize({ commit: originalSecond, summary: summary("Add the second pull request change.") });
  await git(directory, "checkout", "main");
  const base = await commitChange(directory, "base.txt", "base\n", "base moved after the branch was written");
  await git(directory, "checkout", "topic");
  await git(directory, "rebase", "main");
  const rewritten = (await git(directory, "rev-list", "--first-parent", "--reverse", `${base}..HEAD`))
    .split("\n")
    .filter((line) => line.length > 0);
  assert.equal(rewritten.length, 2);
  await git(directory, "checkout", "main");
  await git(directory, "merge", "--ff-only", "topic");
  const tip = await git(directory, "rev-parse", "HEAD");
  assert.equal(tip, rewritten[1]);
  assert.notEqual(adoption, tip);

  const plan = await reveries.synthesizeHostedSummary({ commit: tip, sourceCommits: [originalSecond] });

  assert.equal(plan.state, "ready", JSON.stringify(plan));
  assert.equal(plan.entries.length, 1);
  assert.equal(plan.entries[0]?.decision, "Add the second pull request change.");
  assert.deepEqual(
    plan.entries[0]?.sources.filter((source) => source.relation === "derived-from").map((source) => source.ref),
    [originalSecond],
  );

  const attached = await reveries.attachHostedSummary({ commit: tip, summary: hostedSummary(plan.entries) });
  assert.equal(attached.state, "attached");
  assert.equal((await reveries.checkCommit(tip)).ok, true, JSON.stringify(await reveries.checkCommit(tip)));
  assert.deepEqual((await reveries.show({ target: rewritten[0]! })).records, []);
});

test("a repeated run leaves the notes ref unchanged", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  await adopt(directory);
  await git(directory, "checkout", "-b", "topic");
  const topic = await commitChange(directory, "one.txt", "one\n", "pull request change");
  await reveries.summarize({ commit: topic, summary: summary("Add the pull request change.") });
  await git(directory, "checkout", "main");
  await git(directory, "merge", "--no-ff", "-m", "Merge pull request #28 from phynics/topic", "topic");
  const merge = await git(directory, "rev-parse", "HEAD");
  const first = await reveries.synthesizeHostedSummary({ commit: merge, sourceCommits: [topic] });
  await reveries.attachHostedSummary({ commit: merge, summary: hostedSummary(first.entries) });
  const notesAfterFirstRun = await git(directory, "rev-parse", "refs/notes/reveries");

  const second = await reveries.synthesizeHostedSummary({ commit: merge, sourceCommits: [topic] });

  assert.equal(second.state, "already-summarized");
  assert.deepEqual(second.entries, []);
  const attach = await reveries.attachHostedSummary({ commit: merge, summary: hostedSummary(first.entries) });
  assert.equal(attach.state, "already-summarized");
  assert.equal(await git(directory, "rev-parse", "refs/notes/reveries"), notesAfterFirstRun);
  const shown = await reveries.show({ target: merge });
  assert.equal(shown.records.filter((record) => record.type === "session-summary").length, 1);
});

test("a concurrently attached human summary wins over a synthesized summary", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  await adopt(directory);
  await git(directory, "checkout", "-b", "topic");
  const topic = await commitChange(directory, "one.txt", "one\n", "pull request change");
  await reveries.summarize({ commit: topic, summary: summary("Add the pull request change.") });
  await git(directory, "checkout", "main");
  await git(directory, "merge", "--no-ff", "-m", "Merge pull request #28 from phynics/topic", "topic");
  const merge = await git(directory, "rev-parse", "HEAD");
  const plan = await reveries.synthesizeHostedSummary({ commit: merge, sourceCommits: [topic] });
  assert.equal(plan.state, "ready", JSON.stringify(plan));
  const human: SessionSummary = {
    v: 1,
    type: "session-summary",
    author_email: "maintainer@example.com",
    session: "pi:manual",
    created_at: "2026-08-25T03:30:00Z",
    entries: [{
      driving_event: "A maintainer reviewed the merge by hand.",
      decision: "Keep the maintainer account because a person reviewed this merge.",
      impact: "The merge carries a human-authored causal account.",
      recurrence_control: "The post-merge workflow skips commits that already have a valid summary.",
      alternatives: [],
      sources: [],
      reveries: [],
      retirements: [],
    }],
  };
  await reveries.summarize({ commit: merge, summary: human });
  const notesAfterHuman = await git(directory, "rev-parse", "refs/notes/reveries");

  const attach = await reveries.attachHostedSummary({ commit: merge, summary: hostedSummary(plan.entries) });

  assert.equal(attach.state, "already-summarized");
  assert.equal(attach.summary.author_email, "maintainer@example.com");
  assert.equal(await git(directory, "rev-parse", "refs/notes/reveries"), notesAfterHuman);
  const shown = await reveries.show({ target: merge });
  assert.equal(shown.records.filter((record) => record.type === "session-summary").length, 1);
  assert.equal((shown.records[0] as SessionSummary).author_email, "maintainer@example.com");
});

test("notes publication incorporates a concurrent writer before its compare-and-swap push", async () => {
  const source = await createRepository();
  const bare = await mkdtemp(join(tmpdir(), "reveries-hosted-bare-"));
  temporaryRepositories.push(bare);
  await git(bare, "init", "--bare");
  const adoption = await adopt(source);
  const published = await commitChange(source, "change.txt", "change\n", "published change");
  const sourceReveries = await Reveries.open(source);
  await sourceReveries.summarize({ commit: published, summary: summary("Publish the change with its account.") });
  await git(source, "remote", "add", "origin", bare);
  assert.equal((await sourceReveries.push("origin")).ok, true);

  const writer = await cloneFrom(source, bare, "reveries-hosted-writer-");
  const writerReveries = await Reveries.open(writer);
  await writerReveries.recordNew({
    path: "change.txt",
    revision: "HEAD",
    semantic: { ...semantic, decision: "Record the writer's own decision because it applies to the same file." },
    metadata,
  });
  assert.equal((await writerReveries.push("origin")).ok, true);
  const writerBlob = await (await GitRepository.open(writer)).resolvePath({
    path: "change.txt",
    revision: "HEAD",
  });

  const local = await cloneFrom(source, bare, "reveries-hosted-local-");
  const localReveries = await Reveries.open(local);
  const localCommit = await commitChange(local, "local.txt", "local\n", "host-created local change");
  await localReveries.summarize({ commit: localCommit, summary: summary("Attach the host-created summary.") });

  const result = await localReveries.publishNotes({ remote: "origin", attempts: 3 });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.attempts >= 1);
  const remoteNotes = await git(bare, "rev-parse", "refs/notes/reveries");
  assert.equal(result.remoteTip, remoteNotes);
  assert.match(await git(bare, "notes", "--ref=refs/notes/reveries", "show", localCommit), /session-summary/);
  assert.match(await git(bare, "notes", "--ref=refs/notes/reveries", "show", writerBlob), /"type":"reverie"/);
  assert.match(await git(bare, "notes", "--ref=refs/notes/reveries", "show", adoption), /reveries-init/);
  assert.equal(await git(bare, "rev-parse", "refs/heads/main"), published);
});

test("notes publication fails closed on an invalid concurrent union and leaves the remote untouched", async () => {
  const source = await createRepository();
  const bare = await mkdtemp(join(tmpdir(), "reveries-hosted-bare-invalid-"));
  temporaryRepositories.push(bare);
  await git(bare, "init", "--bare");
  const adoption = await adopt(source);
  await git(source, "remote", "add", "origin", bare);
  assert.equal((await (await Reveries.open(source)).push("origin")).ok, true);

  const writer = await cloneFrom(source, bare, "reveries-hosted-conflict-writer-");
  const local = await cloneFrom(source, bare, "reveries-hosted-conflict-local-");
  const localReveries = await Reveries.open(local);
  const localCommit = await commitChange(local, "local.txt", "local\n", "host-created local change");
  await localReveries.summarize({ commit: localCommit, summary: summary("Attach the host-created summary.") });

  const writerRepository = await GitRepository.open(writer);
  const conflicting = summary("Keep the second account because a second writer attached it.");
  await writerRepository.withNotesWrite((notes) => notes.append(objectId(adoption), `${JSON.stringify({
    ...conflicting,
    author_email: "conflicting@example.com",
  })}\n`));
  await writerRepository.pushAtomically("origin");
  const remoteNotesBefore = await git(bare, "rev-parse", "refs/notes/reveries");

  const result = await localReveries.publishNotes({ remote: "origin", attempts: 2 });

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.match(result.diagnostics.join("\n"), /more than one session summary/i);
  assert.equal(await git(bare, "rev-parse", "refs/notes/reveries"), remoteNotesBefore);
  assert.equal(await git(bare, "rev-parse", "refs/heads/main"), adoption);
  assert.match(
    await git(local, "for-each-ref", "--format=%(refname)", "refs/reveries/quarantine/origin"),
    /^refs\/reveries\/quarantine\/origin\/[0-9a-f]{40}$/,
  );
});
