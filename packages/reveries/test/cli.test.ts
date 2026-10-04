import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";

import { runCli, type CliIo } from "../src/cli.ts";

const execFileAsync = promisify(execFile);
const temporaryRepositories: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function createRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "reveries-cli-"));
  temporaryRepositories.push(directory);
  await git(directory, "init", "-b", "main");
  await git(directory, "config", "user.name", "Reveries Test");
  await git(directory, "config", "user.email", "reveries@example.com");
  await writeFile(join(directory, "state.txt"), "first\n", "utf8");
  await git(directory, "add", "state.txt");
  await git(directory, "commit", "-m", "initial");
  return directory;
}

function captureIo(
  cwd: string,
  stdin = "",
  environment?: Readonly<Record<string, string | undefined>>,
): { readonly io: CliIo; readonly stdout: () => string; readonly stderr: () => string } {
  let out = "";
  let error = "";
  return {
    io: {
      cwd,
      stdin: async () => stdin,
      stdout: (text) => { out += text; },
      stderr: (text) => { error += text; },
      ...(environment === undefined ? {} : { environment }),
    },
    stdout: () => out,
    stderr: () => error,
  };
}

/**
 * Prepare a repository the way `reveries init` does: the notes merge strategy
 * is set so two clones' notes refs union, and nothing else. It used to commit an
 * adoption boundary through `summarize` and `attachInitialization`; those
 * commands required a session summary before a commit could be published, and
 * that requirement is exactly what this version removes.
 */
async function adopt(directory: string): Promise<{ readonly commit: string; readonly notes: string | null }> {
  await git(directory, "config", "notes.reveries.mergeStrategy", "cat_sort_uniq");
  const io = captureIo(directory);
  await runCli([
    "record", "new", "state.txt", "--committed",
    "--driving-event", "The repository adopted durable engineering memory.",
    "--decision", "Prepare the notes ref for evidence.",
    "--impact", "Future decisions attach to the exact content they explain.",
  ], io.io);
  const commit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" })).stdout.trim();
  const notes = (await execFileAsync("git", ["rev-parse", "refs/notes/reveries"], { cwd: directory, encoding: "utf8" })).stdout.trim();
  return { commit, notes };
}

afterEach(async () => {
  await Promise.all(temporaryRepositories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("version output supports hook preflight without opening a repository", async () => {
  const io = captureIo("/tmp");
  assert.equal(await runCli(["--version"], io.io), 0);
  assert.match(io.stdout(), /^reveries 1\.0\.2\n$/);
});

test("record and show expose stable JSON output", async () => {
  const directory = await createRepository();
  const draftPath = join(directory, "reverie.json");
  await writeFile(draftPath, JSON.stringify({
    v: 1,
    driving_event: "Two writers could accept incompatible state transitions.",
    decision: "Use one guarded mutation boundary because transition validity needs one owner.",
    impact: "Every transition writer must use the guarded boundary.",
    recurrence_control: "The concurrency test rejects a stale predecessor.",
    alternatives: [],
    sources: [],
    supersedes: [],
    author_email: "reveries@example.com",
    session: "codex:test",
    created_at: "2026-08-25T03:00:00Z"
  }), "utf8");

  const record = captureIo(directory);
  assert.equal(await runCli(["record", "new", "state.txt", "--committed", "--from", draftPath, "--json"], record.io), 0);
  const recorded = JSON.parse(record.stdout()) as { ok: boolean; result: { record: { id: string } } };
  assert.equal(recorded.ok, true);
  assert.match(recorded.result.record.id, /^rv:[0-9a-f]{40}$/);

  const show = captureIo(directory);
  assert.equal(await runCli(["show", "state.txt", "--json"], show.io), 0);
  const shown = JSON.parse(show.stdout()) as { result: { active: Array<{ id: string }> } };
  assert.equal(shown.result.active[0]?.id, recorded.result.record.id);
});

test("record completes a partial JSON draft and overlays causal flags", async () => {
  const directory = await createRepository();
  const draftPath = join(directory, "partial-reverie.json");
  await writeFile(draftPath, JSON.stringify({
    driving_event: "A repeated state transition needs one decision.",
    decision: "Use a guarded mutation boundary.",
    impact: "Every transition uses the same guard.",
  }), "utf8");
  const output = captureIo(directory, "", {});

  assert.equal(await runCli([
    "record", "new", "state.txt", "--committed", "--from", draftPath,
    "--session", "cli:record-test",
    "--alternative", "Keep the guard in each caller",
    "--alternative", "Allow unguarded transitions",
    "--source", "implements:issue:github:phynics/reveries#32",
    "--json",
  ], output.io), 0, `${output.stdout()}${output.stderr()}`);
  const recorded = JSON.parse(output.stdout()) as {
    result: { record: {
      author_email: string;
      created_at: string;
      session: string | null;
      alternatives: string[];
      sources: Array<{ relation: string; kind: string; ref: string }>;
      supersedes: string[];
    } };
  };

  assert.equal(recorded.result.record.author_email, "reveries@example.com");
  assert.match(recorded.result.record.created_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/);
  assert.equal(recorded.result.record.session, "cli:record-test");
  assert.deepEqual(recorded.result.record.alternatives, [
    "Allow unguarded transitions",
    "Keep the guard in each caller",
  ]);
  assert.deepEqual(recorded.result.record.sources, [{
    relation: "implements",
    kind: "issue",
    ref: "github:phynics/reveries#32",
  }]);
  assert.deepEqual(recorded.result.record.supersedes, []);
});

test("record supersede accepts a partial draft and links the predecessor", async () => {
  const directory = await createRepository();
  const firstDraft = JSON.stringify({
    driving_event: "The current decision needs a successor.",
    decision: "Use the original guard.",
    impact: "Existing callers share one check.",
  });
  const first = captureIo(directory, firstDraft, {});
  assert.equal(await runCli(["record", "new", "state.txt", "--committed", "--from", "-", "--json"], first.io), 0);
  const oldId = (JSON.parse(first.stdout()) as { result: { record: { id: string } } }).result.record.id;

  const successor = captureIo(directory, JSON.stringify({
    driving_event: "A second invariant must also be guarded.",
    decision: "Extend the existing guard.",
    impact: "The single mutation boundary covers both invariants.",
  }), {});
  assert.equal(await runCli([
    "record", "supersede", "state.txt", "--committed", "--from", "-", "--old", oldId, "--json",
  ], successor.io), 0, `${successor.stdout()}${successor.stderr()}`);
  const result = JSON.parse(successor.stdout()) as { result: { record: { supersedes: string[] } } };
  assert.deepEqual(result.result.record.supersedes, [oldId]);
});

test("record supports flags without a draft and rejects contradictory recurrence flags", async () => {
  const directory = await createRepository();
  const record = captureIo(directory, "", {});

  assert.equal(await runCli([
    "record", "new", "state.txt", "--committed",
    "--driving-event", "A CLI flag supplies the event.",
    "--decision", "Use the CLI as a draft editor.",
    "--impact", "Users can record without a JSON file.",
    "--recurrence-control", "A focused CLI test verifies the invariant.",
    "--source", "requested-by:git-email:reviewer@example.com",
    "--json",
  ], record.io), 0, `${record.stdout()}${record.stderr()}`);
  const created = JSON.parse(record.stdout()) as { result: { record: { sources: Array<{ ref: string }> } } };
  assert.deepEqual(created.result.record.sources, [{
    relation: "requested-by",
    kind: "git-email",
    ref: "reviewer@example.com",
  }]);

  const contradictory = captureIo(directory);
  assert.equal(await runCli([
    "record", "new", "state.txt", "--committed",
    "--driving-event", "Event.", "--decision", "Decision.", "--impact", "Impact.",
    "--recurrence-control", "Control.", "--no-recurrence-control",
  ], contradictory.io), 3);
  assert.match(contradictory.stderr(), /choose only one/i);
});

test("sync defaults to the upstream before configured publishers", async () => {
  const directory = await createRepository();
  const upstreamTip = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" })).stdout.trim();
  await git(directory, "commit", "--allow-empty", "-m", "second commit");
  const publisherTip = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" })).stdout.trim();
  await git(directory, "config", "branch.main.remote", "upstream");
  await git(directory, "config", "--add", "reveries.publishingRemote", "publisher");
  await git(directory, "update-ref", "refs/notes/remotes/upstream/reveries", upstreamTip);
  await git(directory, "update-ref", "refs/notes/remotes/publisher/reveries", publisherTip);
  const output = captureIo(directory);

  assert.equal(await runCli(["sync", "--status", "--json"], output.io), 0, `${output.stdout()}${output.stderr()}`);
  const status = JSON.parse(output.stdout()) as { result: { remote: string } };
  assert.equal(status.result.remote, upstreamTip);
});

test("push defaults to upstream even when a different publisher is configured", async () => {
  const directory = await createRepository();
  await adopt(directory);
  const upstream = join(directory, "upstream.git");
  const publisher = join(directory, "publisher.git");
  await git(directory, "init", "--bare", upstream);
  await git(directory, "init", "--bare", publisher);
  await git(directory, "remote", "add", "upstream", upstream);
  await git(directory, "remote", "add", "publisher", publisher);
  await git(directory, "push", "-u", "upstream", "main");
  await git(directory, "config", "--add", "reveries.publishingRemote", "publisher");
  const output = captureIo(directory);

  assert.equal(await runCli(["push", "--json"], output.io), 0, `${output.stdout()}${output.stderr()}`);
  const upstreamRefs = (await execFileAsync("git", ["--git-dir", upstream, "for-each-ref", "--format=%(refname)"], {
    cwd: directory,
    encoding: "utf8",
  })).stdout;
  const publisherRefs = (await execFileAsync("git", ["--git-dir", publisher, "for-each-ref", "--format=%(refname)"], {
    cwd: directory,
    encoding: "utf8",
  })).stdout;
  assert.match(upstreamRefs, /refs\/notes\/reveries/);
  assert.doesNotMatch(publisherRefs, /refs\/notes\/reveries/);
});

test("push defaults to the sole configured publisher without an upstream", async () => {
  const directory = await createRepository();
  await adopt(directory);
  const publisher = join(directory, "publisher.git");
  await git(directory, "init", "--bare", publisher);
  await git(directory, "remote", "add", "publisher", publisher);
  await git(directory, "config", "--add", "reveries.publishingRemote", "publisher");
  const output = captureIo(directory);

  assert.equal(await runCli(["push", "--json"], output.io), 0, `${output.stdout()}${output.stderr()}`);
  const refs = (await execFileAsync("git", ["--git-dir", publisher, "for-each-ref", "--format=%(refname)"], {
    cwd: directory,
    encoding: "utf8",
  })).stdout;
  assert.match(refs, /refs\/notes\/reveries/);
  assert.match(refs, /refs\/heads\/main/);
});

test("sync explains missing and ambiguous default publishers", async () => {
  const directory = await createRepository();
  const missing = captureIo(directory);
  assert.equal(await runCli(["sync", "--status"], missing.io), 3);
  assert.match(missing.stderr(), /upstream|publishing remote|pass a remote/i);

  await git(directory, "config", "--add", "reveries.publishingRemote", "alpha");
  await git(directory, "config", "--add", "reveries.publishingRemote", "beta");
  const ambiguous = captureIo(directory);
  assert.equal(await runCli(["sync", "--status"], ambiguous.io), 3);
  assert.match(ambiguous.stderr(), /alpha.*beta|beta.*alpha/i);
  assert.match(ambiguous.stderr(), /ambiguous|pass a remote|upstream/i);
});

test("search --json keeps its exact serialized envelope", async () => {
  const directory = await createRepository();
  const output = captureIo(directory);

  assert.equal(await runCli(["search", "no matching record", "--json"], output.io), 0);
  assert.equal(output.stdout(), '{"ok":true,"command":"search","result":[],"diagnostics":[]}\n');
});

test("inspection and publication commands use readable default output", async () => {
  const directory = await createRepository();
  await adopt(directory);
  const remote = join(directory, "origin.git");
  await git(directory, "init", "--bare", remote);
  await git(directory, "remote", "add", "origin", remote);
  await git(directory, "push", "-u", "origin", "main");

  const doctor = captureIo(directory);
  await runCli(["doctor"], doctor.io);
  assert.match(doctor.stdout(), /Reveries doctor: (healthy|damaged)/i);
  assert.doesNotMatch(doctor.stdout(), /^\{/m);

  const show = captureIo(directory);
  assert.equal(await runCli(["show", "state.txt"], show.io), 0);
  assert.match(show.stdout(), /state\.txt|evidence/i);
  assert.doesNotMatch(show.stdout(), /^\{/m);

  const record = captureIo(directory);
  assert.equal(await runCli([
    "record", "new", "state.txt", "--committed",
    "--driving-event", "The user needs a human-readable result.",
    "--decision", "Render the evidence as plain text.",
    "--impact", "Search and history show the decision without JSON.",
  ], record.io), 0);
  assert.match(record.stdout(), /recorded reverie rv:/i);

  const evidence = captureIo(directory);
  assert.equal(await runCli(["show", "state.txt"], evidence.io), 0);
  assert.match(evidence.stdout(), /Render the evidence as plain text/i);

  const push = captureIo(directory);
  assert.equal(await runCli(["push", "origin"], push.io), 0, `${push.stdout()}${push.stderr()}`);
  assert.match(push.stdout(), /origin.*atomically|atomically.*origin/i);
  assert.doesNotMatch(push.stdout(), /^\{/m);

  const sync = captureIo(directory);
  assert.equal(await runCli(["sync", "--status", "origin"], sync.io), 0);
  assert.match(sync.stdout(), /origin/i);
  assert.doesNotMatch(sync.stdout(), /^\{/m);

  const search = captureIo(directory);
  assert.equal(await runCli(["search", "human-readable result"], search.io), 0);
  assert.match(search.stdout(), /found 1 matching record/i);
  assert.match(search.stdout(), /Render the evidence as plain text/i);
  assert.doesNotMatch(search.stdout(), /^\{/m);

  const history = captureIo(directory);
  assert.equal(await runCli(["history", "state.txt"], history.io), 0);
  assert.match(history.stdout(), /history.*state\.txt/i);
  assert.match(history.stdout(), /Render the evidence as plain text/i);
  assert.doesNotMatch(history.stdout(), /^\{/m);
});

test("command help includes a synopsis, options, and examples", async () => {
  const output = captureIo("/tmp");
  assert.equal(await runCli(["help", "record"], output.io), 0);
  assert.match(output.stdout(), /Usage: reveries record/);
  assert.match(output.stdout(), /--from|--driving-event/);
  assert.match(output.stdout(), /Examples:/);
});

test("usage errors include command-specific help", async () => {
  const directory = await createRepository();
  const output = captureIo(directory);
  assert.equal(await runCli(["record", "new", "state.txt", "--unknown"], output.io), 3);
  assert.match(output.stderr(), /reveries help record/i);
});

test("help snapshot lists only the lean command surface", async () => {
  const listed = captureIo("/tmp");
  assert.equal(await runCli(["help"], listed.io), 0);
  const help = listed.stdout();
  const commands = [...help.matchAll(/^ {2}(\S+)\s{2,}\S/gm)].map((match) => match[1] ?? "");
  assert.deepEqual(
    [...commands].sort(),
    ["doctor", "help", "history", "init", "link", "push", "record", "retain", "search", "show", "sync"].sort(),
  );

  // Every command the lean core removed must be absent from the index and must
  // not answer with usage. A leftover name would promise a command that no
  // longer exists.
  const removed = [
    "summarize", "check", "adopt", "hooks", "ledger", "sign", "authority",
    "redact", "transition", "receive", "quarantine", "repair", "mirror", "import",
  ];
  for (const command of removed) {
    assert.doesNotMatch(help, new RegExp(`^ {2}${command}\\b`, "m"), `help still lists removed command ${command}`);
    const topic = captureIo("/tmp");
    assert.equal(await runCli(["help", command], topic.io), 3, `help for removed command ${command}`);
  }
});

test("every command the help index lists has usage of its own", async () => {
  const listed = captureIo("/tmp");
  assert.equal(await runCli(["help"], listed.io), 0);
  const commands = [...listed.stdout().matchAll(/^ {2}(\S+)\s{2,}\S/gm)].map((match) => match[1] ?? "");

  // The index and the per-command help are one contract: a command that appears
  // in `reveries help` with no `reveries help <command>` is a dead end an
  // operator discovers only after guessing the name.
  for (const command of commands) {
    const topic = captureIo("/tmp");
    assert.equal(await runCli(["help", command], topic.io), 0, `reveries help ${command}`);
    // A renamed command still answers with usage, under its new name.
    assert.match(topic.stdout(), /^Usage: reveries /m, `reveries help ${command} has no usage line`);
  }
});
