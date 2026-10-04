import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";

import { runCli, type CliIo } from "../src/cli.ts";
import { Reveries } from "../src/operations.ts";
import type { ReveriesInit, SessionSummary } from "../src/protocol.ts";

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

function adoptionSummary(): SessionSummary {
  return {
    v: 1,
    type: "session-summary",
    author_email: "reveries@example.com",
    session: "codex:test",
    created_at: "2026-08-25T03:05:00Z",
    entries: [{
      driving_event: "The repository adopted durable engineering memory.",
      decision: "Initialize Reveries because future commits require causal accounts.",
      impact: "Published descendants require one session summary.",
      recurrence_control: "The pre-push checker validates outgoing commits.",
      alternatives: [],
      sources: [],
      reveries: [],
      retirements: [],
    }],
  };
}

async function adopt(directory: string): Promise<{ readonly commit: string; readonly notes: string }> {
  const reveries = await Reveries.open(directory);
  const commit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" })).stdout.trim();
  await reveries.summarize({ commit, summary: adoptionSummary() });
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
  await reveries.attachInitialization({ commit, record: init });
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

test("summarize completes a partial draft from stdin and overlays entry flags", async () => {
  const directory = await createRepository();
  const input = JSON.stringify({ entries: [{
    driving_event: "An API needs a causal account.",
    decision: "Capture the choice in a session summary.",
    impact: "The commit can be reviewed from its evidence.",
  }] });
  const output = captureIo(directory, input, { REVERIES_SESSION: "env:summary-test" });

  assert.equal(await runCli([
    "summarize", "HEAD", "--from", "-", "--session", "cli:summary-test",
    "--alternative", "Rely on the commit message alone",
    "--source", "caused-by:issue:github:phynics/reveries#32",
    "--json",
  ], output.io), 0, `${output.stdout()}${output.stderr()}`);
  const commit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" })).stdout.trim();
  const note = await (await Reveries.open(directory)).show({ target: commit });
  const summary = note.records.find((record): record is SessionSummary => record.type === "session-summary");

  assert.ok(summary);
  assert.equal(summary.author_email, "reveries@example.com");
  assert.match(summary.created_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/);
  assert.equal(summary.session, "cli:summary-test");
  assert.deepEqual(summary.entries[0]?.alternatives, ["Rely on the commit message alone"]);
  assert.deepEqual(summary.entries[0]?.sources, [{
    relation: "caused-by",
    kind: "issue",
    ref: "github:phynics/reveries#32",
  }]);
});

test("summary metadata falls back to REVERIES_SESSION and then null", async () => {
  const directory = await createRepository();
  const draft = JSON.stringify({
    entries: [{ driving_event: "Event.", decision: "Decision.", impact: "Impact." }],
  });
  const draftPath = join(directory, "summary-draft.json");
  await writeFile(draftPath, draft, "utf8");
  const fromEnvironment = captureIo(directory, "", { REVERIES_SESSION: "env:session" });

  assert.equal(await runCli(["summarize", "HEAD", "--from", draftPath, "--json"], fromEnvironment.io), 0);
  const commit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" })).stdout.trim();
  const notes = await Reveries.open(directory);
  const withEnvironment = (await notes.show({ target: commit })).records.find(
    (record): record is SessionSummary => record.type === "session-summary",
  );
  assert.equal(withEnvironment?.session, "env:session");

  const withoutSession = captureIo(directory, JSON.stringify({
    session: null,
    entries: [{ driving_event: "Second event.", decision: "Second decision.", impact: "Second impact." }],
  }), { REVERIES_SESSION: "env:must-not-overwrite-explicit-null" });
  assert.equal(await runCli(["summarize", "HEAD", "--from", "-", "--replace", "--json"], withoutSession.io), 0);
  const withoutEnvironment = (await notes.show({ target: commit })).records.find(
    (record): record is SessionSummary => record.type === "session-summary",
  );
  assert.equal(withoutEnvironment?.session, null);
});

test("causal flags cover recurrence control, path sources, reveries, and retirements", async () => {
  const directory = await createRepository();
  const commit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" })).stdout.trim();
  const blob = (await execFileAsync("git", ["rev-parse", "HEAD:state.txt"], { cwd: directory, encoding: "utf8" })).stdout.trim();
  const reverieId = `rv:${"a".repeat(40)}`;
  const input = JSON.stringify({ entries: [{
    driving_event: "A source path needs a revision.",
    decision: "Bind the path reference to a commit.",
    impact: "The reference remains reproducible.",
    recurrence_control: "Draft recurrence statement.",
  }] });
  const output = captureIo(directory, input, {});

  assert.equal(await runCli([
    "summarize", "HEAD", "--from", "-", "--no-recurrence-control",
    "--source", `derived-from:path:state.txt@${commit}`,
    "--reverie", reverieId,
    "--retire", `${reverieId}:${blob}:The decision was replaced: use the new source.`,
    "--json",
  ], output.io), 0, `${output.stdout()}${output.stderr()}`);
  const note = await (await Reveries.open(directory)).show({ target: commit });
  const summary = note.records.find((record): record is SessionSummary => record.type === "session-summary");

  assert.equal(summary?.entries[0]?.recurrence_control, null);
  assert.deepEqual(summary?.entries[0]?.sources, [{
    relation: "derived-from",
    kind: "path",
    ref: "state.txt",
    at: commit,
  }]);
  assert.deepEqual(summary?.entries[0]?.reveries, [reverieId]);
  assert.deepEqual(summary?.entries[0]?.retirements, [{
    reverie: reverieId,
    from_blob: blob,
    reason: "The decision was replaced: use the new source.",
  }]);
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

test("summarize --init remains a separate full initialization-record path", async () => {
  const directory = await createRepository();
  const commit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" })).stdout.trim();
  await (await Reveries.open(directory)).summarize({ commit, summary: adoptionSummary() });
  const input = JSON.stringify({
    v: 1,
    type: "reveries-init",
    protocol: 1,
    notes_ref: "refs/notes/reveries",
    publishing_remotes: [],
    hosts: [],
    author_email: "reveries@example.com",
    created_at: "2026-08-25T03:05:00Z",
  });
  const output = captureIo(directory, input, {});

  assert.equal(await runCli(["summarize", "HEAD", "--from", "-", "--init", "--json"], output.io), 0, `${output.stdout()}${output.stderr()}`);
  const records = (await Reveries.open(directory)).show({ target: commit });
  assert.deepEqual((await records).records.map((record) => record.type).sort(), ["reveries-init", "session-summary"]);
});

test("summarize opens VISUAL and records a valid edited draft", async () => {
  const directory = await createRepository();
  const editor = join(directory, "editor.mjs");
  await writeFile(editor, `import { writeFile } from "node:fs/promises";
await writeFile(process.argv[2], JSON.stringify({ entries: [{
  driving_event: "The editor supplied the causal event.",
  decision: "Summarize the decision after editing.",
  impact: "The edited draft becomes commit evidence."
}] }));
`, "utf8");
  const output = captureIo(directory, "", {
    VISUAL: `${process.execPath} ${editor}`,
    EDITOR: "missing-editor-should-not-run",
  });

  assert.equal(await runCli(["summarize", "HEAD", "--edit", "--json"], output.io), 0, `${output.stdout()}${output.stderr()}`);
  const commit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" })).stdout.trim();
  const summary = (await (await Reveries.open(directory)).show({ target: commit })).records.find(
    (record): record is SessionSummary => record.type === "session-summary",
  );
  assert.equal(summary?.entries[0]?.decision, "Summarize the decision after editing.");
});

test("an empty editor result aborts without changing notes", async () => {
  const directory = await createRepository();
  const editor = join(directory, "empty-editor.mjs");
  await writeFile(editor, `import { writeFile } from "node:fs/promises";
await writeFile(process.argv[2], "  ");
`, "utf8");
  const output = captureIo(directory, "", { EDITOR: `${process.execPath} ${editor}` });

  assert.equal(await runCli(["summarize", "HEAD", "--edit"], output.io), 1);
  assert.match(output.stderr(), /empty|cancel/i);
  assert.equal((await execFileAsync("git", ["notes", "--ref=refs/notes/reveries", "list"], {
    cwd: directory,
    encoding: "utf8",
  })).stdout, "");
});

test("an invalid edited draft is retained with its repair path", async () => {
  const directory = await createRepository();
  const editor = join(directory, "invalid-editor.mjs");
  await writeFile(editor, `import { writeFile } from "node:fs/promises";
await writeFile(process.argv[2], JSON.stringify({ entries: [{
  driving_event: "The event is present.",
  decision: "The decision is present."
}] }));
`, "utf8");
  const output = captureIo(directory, "", { EDITOR: `${process.execPath} ${editor}` });

  assert.equal(await runCli(["summarize", "HEAD", "--edit"], output.io), 3);
  const retained = /Draft retained at (.+?draft\.json):/i.exec(output.stderr())?.[1];
  assert.ok(retained, output.stderr());
  const retainedContent = await readFile(retained, "utf8");
  assert.match(retainedContent, /The decision is present/);
  await rm(dirname(retained), { recursive: true, force: true });
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

  const check = captureIo(directory);
  assert.equal(await runCli(["check", "HEAD"], check.io), 0);
  assert.match(check.stdout(), /continuity check passed/i);
  assert.doesNotMatch(check.stdout(), /^\{/m);

  const doctor = captureIo(directory);
  await runCli(["doctor"], doctor.io);
  assert.match(doctor.stdout(), /reveries.*(prepared|adopted|damaged|doctor)/i);
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

test("record and summarize report readable success by default", async () => {
  const directory = await createRepository();
  const record = captureIo(directory);
  assert.equal(await runCli([
    "record", "new", "state.txt", "--committed",
    "--driving-event", "A user needs to understand the CLI result.",
    "--decision", "Report the created reverie in plain text.",
    "--impact", "Users can continue without reading JSON.",
  ], record.io), 0);
  assert.match(record.stdout(), /recorded reverie rv:/i);

  const summary = captureIo(directory, JSON.stringify({
    entries: [{ driving_event: "Event.", decision: "Decision.", impact: "Impact." }],
  }), {});
  assert.equal(await runCli(["summarize", "HEAD", "--from", "-"], summary.io), 0);
  assert.match(summary.stdout(), /summarized commit/i);
  assert.doesNotMatch(summary.stdout(), /^\{/m);
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

test("semantic failures use exit code 1 and usage errors use exit code 3", async () => {
  const directory = await createRepository();
  const check = captureIo(directory);
  assert.equal(await runCli(["check", "HEAD", "--json"], check.io), 1);
  assert.match(check.stdout(), /initialization boundary/i);

  const usage = captureIo(directory);
  assert.equal(await runCli(["record", "unknown"], usage.io), 3);
  assert.match(usage.stderr(), /usage/i);
});

test("init requires a complete Skill setup choice", async () => {
  const directory = await createRepository();

  const missing = captureIo(directory);
  assert.equal(await runCli([
    "init",
    "--hosts", "codex",
    "--remote", "origin",
    "--directive-email", "user@example.com",
  ], missing.io), 3);
  assert.match(missing.stderr(), /skill-setup/i);

  const incompletePull = captureIo(directory);
  assert.equal(await runCli([
    "init",
    "--hosts", "codex",
    "--remote", "origin",
    "--directive-email", "user@example.com",
    "--skill-setup", "pull",
  ], incompletePull.io), 3);
  assert.match(incompletePull.stderr(), /skill-repository/i);

  const incompleteSubmodule = captureIo(directory);
  assert.equal(await runCli([
    "init",
    "--hosts", "codex",
    "--remote", "origin",
    "--directive-email", "user@example.com",
    "--skill-setup", "submodule",
  ], incompleteSubmodule.io), 3);
  assert.match(incompleteSubmodule.stderr(), /skill-repository/i);
});

test("init requires an explicit directive-email choice", async () => {
  const directory = await createRepository();
  const missing = captureIo(directory);

  assert.equal(await runCli([
    "init",
    "--hosts", "codex",
    "--remote", "origin",
    "--skill-setup", "reminder",
  ], missing.io), 3);
  assert.match(missing.stderr(), /directive-email/i);
});

test("init accepts explicit local-only choices and symlink setup", async () => {
  const directory = await createRepository();
  for (const name of ["using-reveries", "reveries-git-notes-search", "reveries-git-notes-init"]) {
    await execFileAsync("mkdir", ["-p", join(directory, "skills", name)]);
    await writeFile(join(directory, "skills", name, "SKILL.md"), `---\nname: ${name}\n---\n`, "utf8");
  }
  await git(directory, "add", "skills");
  await git(directory, "commit", "-m", "add skill sources");
  const init = captureIo(directory);

  assert.equal(await runCli([
    "init",
    "--no-hosts",
    "--no-publish",
    "--no-directive-email",
    "--skill-setup", "symlink",
    "--skill-source", "skills",
    "--json",
  ], init.io), 0);
  assert.match(init.stdout(), /"state":"prepared"/);
  assert.match(init.stdout(), /\.agents\/skills\/using-reveries/);
});

test("adopt verifies the plan and excludes unrelated staged work", async () => {
  const directory = await createRepository();
  const init = captureIo(directory);
  assert.equal(await runCli([
    "init",
    "--hosts", "codex",
    "--no-publish",
    "--no-directive-email",
    "--skill-setup", "reminder",
    "--json",
  ], init.io), 0);
  const initialized = JSON.parse(init.stdout()) as { result: { templatePaths: { plan: string } } };
  await writeFile(join(directory, "unrelated.txt"), "unrelated\n", "utf8");
  await git(directory, "add", "unrelated.txt");
  const adoptIo = captureIo(directory);

  assert.equal(await runCli([
    "adopt",
    "--plan", initialized.result.templatePaths.plan,
    "--message", "Adopt Reveries",
    "--json",
  ], adoptIo.io), 0);
  assert.match(adoptIo.stdout(), /"commit":"[0-9a-f]{40}"/);
  const adopted = JSON.parse(adoptIo.stdout()) as { result: { commit: string } };
  const note = await (await Reveries.open(directory)).show({ target: adopted.result.commit });
  assert.deepEqual(note.records.map((record) => record.type).sort(), ["reveries-init", "session-summary"]);
  const staged = (await execFileAsync("git", ["diff", "--cached", "--name-only"], { cwd: directory, encoding: "utf8" })).stdout.trim();
  assert.equal(staged, "unrelated.txt");
});

test("post-commit stays quiet while initialization is prepared", async () => {
  const directory = await createRepository();
  const init = captureIo(directory);
  assert.equal(await runCli([
    "init",
    "--hosts", "codex",
    "--no-publish",
    "--no-directive-email",
    "--skill-setup", "reminder",
  ], init.io), 0);

  const hook = captureIo(directory);
  assert.equal(await runCli(["post-commit"], hook.io), 0);
  assert.equal(hook.stdout(), "");
  assert.equal(hook.stderr(), "");
});

test("post-commit stays quiet on a branch that predates an existing adoption boundary", async () => {
  const directory = await createRepository();
  await git(directory, "branch", "legacy");
  await writeFile(join(directory, "adoption.txt"), "adopt\n", "utf8");
  await git(directory, "add", "adoption.txt");
  await git(directory, "commit", "-m", "adopt reveries");
  await adopt(directory);
  await git(directory, "checkout", "legacy");
  const hook = captureIo(directory);

  assert.equal(await runCli(["post-commit"], hook.io), 0);
  assert.equal(hook.stderr(), "");
});

test("pre-push validates every pushed branch tip rather than HEAD", async () => {
  const directory = await createRepository();
  const adoption = await adopt(directory);
  await git(directory, "checkout", "-b", "topic");
  await writeFile(join(directory, "state.txt"), "topic\n", "utf8");
  await git(directory, "add", "state.txt");
  await git(directory, "commit", "-m", "unsummarized topic");
  const topic = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" })).stdout.trim();
  await git(directory, "checkout", "main");

  const zero = "0".repeat(40);
  const stdin = [
    `refs/heads/topic ${topic} refs/heads/topic ${zero}`,
    `refs/notes/reveries ${adoption.notes} refs/notes/reveries ${zero}`,
    "",
  ].join("\n");
  const prePush = captureIo(directory, stdin, { REVERIES_INTERNAL_ATOMIC_PUSH: "1" });

  assert.equal(await runCli(["pre-push", "origin"], prePush.io), 1);
  assert.match(prePush.stderr(), /session summary/i);
});

test("pre-push rejects raw branch-and-notes publication without the helper marker", async () => {
  const directory = await createRepository();
  const adoption = await adopt(directory);
  const zero = "0".repeat(40);
  const stdin = [
    `refs/heads/main ${adoption.commit} refs/heads/main ${zero}`,
    `refs/notes/reveries ${adoption.notes} refs/notes/reveries ${zero}`,
    "",
  ].join("\n");

  const rawPush = captureIo(directory, stdin, {});
  assert.equal(await runCli(["pre-push", "origin"], rawPush.io), 1);
  assert.match(rawPush.stderr(), /reveries push|non-atomic|raw push/i);

  const helperPush = captureIo(directory, stdin, { REVERIES_INTERNAL_ATOMIC_PUSH: "1" });
  assert.equal(await runCli(["pre-push", "origin"], helperPush.io), 0);
  assert.equal(helperPush.stderr(), "");
});

test("pre-push rejects a remote notes history not incorporated locally", async () => {
  const directory = await createRepository();
  const adoption = await adopt(directory);
  const blob = (await execFileAsync("git", ["rev-parse", "HEAD:state.txt"], { cwd: directory, encoding: "utf8" })).stdout.trim();
  await git(directory, "notes", "--ref=refs/notes/remote-simulated", "add", "-m", "remote", blob);
  const remoteNotes = (await execFileAsync("git", ["rev-parse", "refs/notes/remote-simulated"], { cwd: directory, encoding: "utf8" })).stdout.trim();

  const stdin = [
    `refs/heads/main ${adoption.commit} refs/heads/main ${adoption.commit}`,
    `refs/notes/reveries ${adoption.notes} refs/notes/reveries ${remoteNotes}`,
    "",
  ].join("\n");
  const prePush = captureIo(directory, stdin, { REVERIES_INTERNAL_ATOMIC_PUSH: "1" });

  assert.equal(await runCli(["pre-push", "origin"], prePush.io), 1);
  assert.match(prePush.stderr(), /remote notes|incorporated/i);
});

test("pre-push does not treat a disappeared established remote notes ref as first publication", async () => {
  const directory = await createRepository();
  const adoption = await adopt(directory);
  await git(directory, "update-ref", "refs/notes/remotes/origin/reveries", adoption.notes);
  const zero = "0".repeat(40);
  const stdin = [
    `refs/heads/main ${adoption.commit} refs/heads/main ${adoption.commit}`,
    `refs/notes/reveries ${adoption.notes} refs/notes/reveries ${zero}`,
    "",
  ].join("\n");
  const prePush = captureIo(directory, stdin, { REVERIES_INTERNAL_ATOMIC_PUSH: "1" });

  assert.equal(await runCli(["pre-push", "origin"], prePush.io), 1);
  assert.match(prePush.stderr(), /remote notes ref is absent|established remote notes/i);
});

test("ledger status reports an absent envelope without failing", async () => {
  const directory = await createRepository();
  const status = captureIo(directory);

  assert.equal(await runCli(["ledger", "status"], status.io), 0);
  assert.match(status.stdout(), /^Ledger: absent/m);
  assert.doesNotMatch(status.stdout(), /^\{/m);
});

test("ledger status has stable machine output", async () => {
  const directory = await createRepository();
  const status = captureIo(directory);

  assert.equal(await runCli(["ledger", "status", "--json"], status.io), 0);
  const payload = JSON.parse(status.stdout()) as { command: string; ok: boolean; result: { state: string } };
  assert.equal(payload.command, "ledger status");
  assert.equal(payload.ok, true);
  assert.equal(payload.result.state, "absent");
});

test("ledger requires a known action", async () => {
  const directory = await createRepository();

  const missing = captureIo(directory);
  assert.equal(await runCli(["ledger"], missing.io), 3);
  assert.match(missing.stderr(), /status, build, materialize, or quarantine/);

  const unknown = captureIo(directory);
  assert.equal(await runCli(["ledger", "frobnicate"], unknown.io), 3);
  assert.match(unknown.stderr(), /status, build, materialize, or quarantine/);
});

test("help documents the ledger command", async () => {
  const directory = await createRepository();
  const general = captureIo(directory);
  assert.equal(await runCli(["help"], general.io), 0);
  assert.match(general.stdout(), /^ {2}ledger {3}/m);

  const topic = captureIo(directory);
  assert.equal(await runCli(["help", "ledger"], topic.io), 0);
  assert.match(topic.stdout(), /reveries ledger <status\|build\|materialize\|quarantine>/);
  // The help names the namespace hazard, because an operator who reaches for
  // `git notes --ref=` on a quarantine ref gets a silent false negative.
  assert.match(topic.stdout(), /not a notes ref/);
  assert.match(topic.stdout(), /reveries ledger quarantine show/);
});

test("ledger build advances the envelope over the current notes", async () => {
  const directory = await createRepository();
  await adopt(directory);
  const build = captureIo(directory);

  assert.equal(await runCli(["ledger", "build"], build.io), 0);
  assert.match(build.stdout(), /Ledger checkpoint/);
  await git(directory, "rev-parse", "--verify", "refs/heads/reveries-ledger");
  const first = (await (await Reveries.open(directory)).ledgerStatus()).tip;

  // A second build with no new evidence still advances the branch: the manifest
  // names the previous checkpoint as its own parent, so a rebuild is never
  // byte-identical to its predecessor. That is append-only and always valid, but
  // it means `ledger build` must not be run unconditionally from a hook.
  const again = captureIo(directory);
  assert.equal(await runCli(["ledger", "build", "--json"], again.io), 0);
  const payload = JSON.parse(again.stdout()) as { result: { state: string; checkpoint: string } };
  assert.equal(payload.result.state, "created");
  const status = await (await Reveries.open(directory)).ledgerStatus();
  assert.equal(status.state, "valid", status.diagnostics.join("; "));
  assert.notEqual(status.tip, first, "the second build did not advance the branch");
  assert.equal(await (await Reveries.open(directory)).verifyLedgerEnvelope().then((r) => r.ok), true);
});

test("ledger status reports a valid envelope after a build", async () => {
  const directory = await createRepository();
  await adopt(directory);
  await runCli(["ledger", "build"], captureIo(directory).io);

  const status = captureIo(directory);
  assert.equal(await runCli(["ledger", "status"], status.io), 0);
  assert.match(status.stdout(), /^Ledger: valid/m);
});

test("doctor reads the ledger block as its own line", async () => {
  const directory = await createRepository();
  await adopt(directory);
  await runCli(["ledger", "build"], captureIo(directory).io);

  const doctor = captureIo(directory);
  await runCli(["doctor"], doctor.io);
  const lines = doctor.stdout().split("\n");
  const ledger = lines.find((line) => line.startsWith("Ledger: "));
  assert.ok(ledger !== undefined, `doctor has no Ledger line:\n${doctor.stdout()}`);
  assert.match(ledger, /^Ledger: valid; tip [0-9a-f]{40}/);
  // The generic notice loop must not also print it as "Notice: Ledger:".
  assert.equal(
    lines.some((line) => line.startsWith("Notice: Ledger:") || line.includes("Notice: Ledger:")),
    false,
    `the ledger line is still emitted as a generic notice:\n${doctor.stdout()}`,
  );
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

test("the signing, trust, and authority commands are reachable and refuse unknown actions", async () => {
  const directory = await createRepository();
  await adopt(directory);

  for (const command of ["sign", "verify", "trust", "role", "policy"]) {
    const unknown = captureIo(directory);
    assert.equal(await runCli([command, "not-an-action"], unknown.io), 3, `${command} accepted an unknown action`);
    assert.match(unknown.stderr(), /Usage error/, command);
  }
  const trustAction = captureIo(directory);
  assert.equal(await runCli(["trust", "invent"], trustAction.io), 3);
  assert.match(trustAction.stderr(), /init, list, add, remove, revoke, restore/);
  const noAction = captureIo(directory);
  assert.equal(await runCli(["trust"], noAction.io), 3);
  assert.match(noAction.stderr(), /trust requires an action/);
});

test("an unknown remote role and an unknown signing role are both usage errors naming the valid set", async () => {
  const directory = await createRepository();
  await adopt(directory);
  await git(directory, "remote", "add", "origin", directory);

  const role = captureIo(directory);
  assert.equal(await runCli(["role", "set", "origin", "sovereign"], role.io), 3);
  assert.match(role.stderr(), /primary, mirror, archive, import-only/);

  const policy = captureIo(directory);
  assert.equal(await runCli(["policy", "set", "author,auditor"], policy.io), 3);
  assert.match(policy.stderr(), /author, reviewer, publisher/);
  assert.match(policy.stderr(), /found auditor/);
});

test("verify with no signatures reports the absent state rather than failing", async () => {
  const directory = await createRepository();
  await adopt(directory);

  const plain = captureIo(directory);
  assert.equal(await runCli(["verify"], plain.io), 0, plain.stderr());
  assert.match(plain.stdout(), /^Signatures: absent; 0 shown; 0 unknown, 0 valid, 0 trusted, 0 policy-satisfying, 0 invalid, 0 revoked\.$/m);

  const required = captureIo(directory);
  assert.equal(await runCli(["verify", "--require-policy"], required.io), 1);
  assert.match(required.stderr(), /No signature reaches policy-satisfying/);
});

test("the CLI reports that removal preserved the trust store", async () => {
  const directory = await createRepository();
  await adopt(directory);
  // Removal clears configuration and never deletes trust material, so the fact
  // worth reporting is that the file is still there and where.
  const shared = join(await mkdtemp(join(tmpdir(), "reveries-cli-trust-")), "trust.json");
  const body = `${JSON.stringify({ keys: [{ key_id: "SHA256:aa", signer: "team@example.test", revoked: false, public_key: "pem" }] }, null, 2)}\n`;
  await writeFile(shared, body, "utf8");
  await git(directory, "config", "reveries.trustStore", shared);

  const json = captureIo(directory);
  const code = await runCli(["remove", "--json"], json.io);

  const parsed = JSON.parse(json.stdout()) as {
    result: { trustStore: { preserved: readonly string[]; reason: string; path: string | null } };
    notices?: readonly string[];
  };
  assert.equal(code, 0, json.stderr());
  assert.deepEqual(parsed.result.trustStore.preserved, [shared]);
  assert.equal(parsed.result.trustStore.path, shared);
  assert.match(parsed.result.trustStore.reason, /never deletes trust material/);
  assert.match((parsed.notices ?? []).join(" "), /never deletes trust material/);
  assert.equal(await readFile(shared, "utf8"), body, "removal must leave trust material byte for byte");

  // A second removal, with the configured key already cleared, reports the
  // default location honestly rather than claiming something was preserved.
  const human = captureIo(directory);
  await runCli(["remove"], human.io);
  assert.match(human.stdout(), /No trust store exists/);
});
