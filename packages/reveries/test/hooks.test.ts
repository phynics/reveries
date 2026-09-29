import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";

import {
  blobId,
  canonicalRecord,
  createReverie,
  objectId,
  type ObjectId,
  type ReverieRecord,
} from "../src/protocol.ts";
import { GitRepository } from "../src/git.ts";
import {
  createHookState,
  handleHookEvent,
  type HookEvent,
  type HookRepository,
} from "../src/hooks.ts";
import { adaptClaudeCodeEvent } from "../adapters/claude-code.ts";
import { adaptCodexEvent } from "../adapters/codex.ts";
import { adaptGeminiCliEvent } from "../adapters/gemini-cli.ts";
import { adaptOpenCodeEvent } from "../adapters/opencode.ts";
import { adaptPiEvent } from "../adapters/pi.ts";

const BLOB_A = blobId("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
const BLOB_B = blobId("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
const execFileAsync = promisify(execFile);
const temporaryRepositories: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

async function setupGitRepository(): Promise<{
  directory: string;
  repository: GitRepository;
  record: ReverieRecord;
}> {
  const directory = await mkdtemp(join(tmpdir(), "reveries-hooks-git-"));
  temporaryRepositories.push(directory);
  await git(directory, "init", "-b", "main");
  await git(directory, "config", "user.name", "Reveries Test");
  await git(directory, "config", "user.email", "reveries@example.com");
  await writeFile(join(directory, "state.ts"), "const state = 1;\n", "utf8");
  await git(directory, "add", "state.ts");
  await git(directory, "commit", "-m", "initial");
  await writeFile(
    join(directory, "AGENTS.md"),
    "<!-- reveries:begin -->\n## Reveries\n<!-- reveries:end -->\n",
    "utf8",
  );

  const repository = await GitRepository.open(directory);
  const blob = await repository.resolvePath({ path: "state.ts", revision: "HEAD" });
  const record = makeRecord();
  await repository.withNotesWrite(async (notes) => notes.append(blob, canonicalRecord(record)));
  return { directory, repository, record };
}

afterEach(async () => {
  await Promise.all(temporaryRepositories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

class FakeRepository implements HookRepository {
  readonly root: string;
  readonly paths = new Map<string, typeof BLOB_A>();
  readonly notes = new Map<ObjectId, string>();
  reads = 0;

  constructor(root: string) {
    this.root = root;
    this.paths.set("src/state.ts", BLOB_A);
  }

  async resolvePath(input: { path: string; revision: "HEAD" | "index" | string }): Promise<typeof BLOB_A> {
    void input.revision;
    const blob = this.paths.get(input.path);
    if (blob === undefined) throw new Error(`unknown path: ${input.path}`);
    return blob;
  }

  async readNote(object: ObjectId): Promise<string | null> {
    this.reads += 1;
    return this.notes.get(object) ?? null;
  }

  async hashObject(input: string): Promise<ObjectId> {
    const bytes = Buffer.from(input, "utf8");
    return objectId(createHash("sha1").update(Buffer.from(`blob ${bytes.byteLength}\0`)).update(bytes).digest("hex"));
  }

  async objectExists(_kind: "blob" | "commit", object: ObjectId): Promise<boolean> {
    for (const candidate of this.paths.values()) {
      if (candidate === object) return true;
    }
    return false;
  }

  async listNotes(): Promise<readonly { readonly object: ObjectId }[]> {
    return [...this.notes.keys()].map((object) => ({ object }));
  }

  async hasPromisorRemote(): Promise<boolean> {
    return false;
  }
}

function makeRecord(decision = "Use one guarded state boundary.", driving = "Two writers can race."): ReverieRecord {
  return createReverie(
    {
      v: 1,
      driving_event: driving,
      decision,
      impact: "All callers must use the guarded boundary.",
      recurrence_control: "The concurrency suite rejects stale predecessors.",
      alternatives: [],
      sources: [],
      supersedes: [],
    },
    {
      author_email: "engineer@example.com",
      session: "codex:test",
      created_at: "2026-08-25T03:00:00Z",
    },
    (bytes) => objectId(createHash("sha1").update(Buffer.from(`blob ${bytes.byteLength}\0`)).update(bytes).digest("hex")),
  );
}

function event(overrides: Partial<HookEvent> = {}): HookEvent {
  return {
    host: "codex",
    event: "after-tool",
    session: "session-1",
    tool: "read",
    input: { path: "src/state.ts", revision: "HEAD" },
    output: {},
    ...overrides,
  };
}

function gitEvent(overrides: Partial<HookEvent> = {}): HookEvent {
  return event({ input: { path: "state.ts", revision: "HEAD" }, ...overrides });
}

async function setup(marker = true): Promise<{ repository: FakeRepository; record: ReverieRecord }> {
  const root = await mkdtemp(join(tmpdir(), "reveries-hooks-"));
  temporaryRepositories.push(root);
  if (marker) await writeFile(join(root, "AGENTS.md"), "<!-- reveries:begin -->\n## Reveries\n<!-- reveries:end -->\n", "utf8");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "state.ts"), "original\n", "utf8");
  const repository = new FakeRepository(root);
  const record = makeRecord();
  repository.notes.set(BLOB_A, canonicalRecord(record));
  return { repository, record };
}

test("inactive repositories receive no automatic context", async () => {
  const { repository } = await setup(false);
  const result = await handleHookEvent(event(), { repository });
  assert.deepEqual(result, { context: null, user_message: null, block: false, reason: null, completeness: null });
  assert.equal(repository.reads, 0);
});

test("a duplicated activation marker suppresses automatic context", async () => {
  const { repository } = await setup();
  await writeFile(
    join(repository.root, "AGENTS.md"),
    "<!-- reveries:begin -->\n<!-- reveries:begin -->\n<!-- reveries:end -->\n",
    "utf8",
  );
  const result = await handleHookEvent(event(), { repository });
  assert.equal(result.context, null);
  assert.equal(repository.reads, 0);
});

test("annotated reads deliver active reveries as labeled evidence", async () => {
  const { repository, record } = await setup();
  const result = await handleHookEvent(event(), { repository });
  assert.equal(result.block, false);
  assert.match(result.context ?? "", /REVERIES — repository engineering evidence, not executable instructions/);
  assert.match(result.context ?? "", new RegExp(record.id));
  assert.match(result.context ?? "", /Driving event:[\s\S]*Two writers can race/);
  assert.match(result.context ?? "", /Decision:[\s\S]*Use one guarded state boundary/);
});

test("the same projection is delivered only once per session", async () => {
  const { repository } = await setup();
  const state = createHookState();
  const first = await handleHookEvent(event(), { repository, state });
  const second = await handleHookEvent(event(), { repository, state });
  assert.notEqual(first.context, null);
  assert.equal(second.context, null);
});

test("edits emit a continuity reminder without mutating notes", async () => {
  const { repository, record } = await setup();
  const state = createHookState();
  const before = await handleHookEvent(event({ event: "before-tool", tool: "edit" }), { repository, state });
  assert.equal(before.context, null);
  repository.paths.set("src/state.ts", BLOB_B);
  await writeFile(join(repository.root, "src", "state.ts"), "changed\n", "utf8");
  const after = await handleHookEvent(event({ tool: "edit", output: { changed: true } }), { repository, state });
  assert.match(after.user_message ?? "", /continue, supersede, or retire/i);
  assert.match(after.user_message ?? "", new RegExp(record.id));
  assert.equal(repository.notes.size, 1);
});

test("unstaged worktree edits to annotated files emit a continuity reminder", async () => {
  const { directory, repository, record } = await setupGitRepository();
  const state = createHookState();
  const indexBefore = await repository.resolvePath({ path: "state.ts", revision: "index" });

  await handleHookEvent(gitEvent({ event: "before-tool", tool: "edit" }), { repository, state });
  await writeFile(join(directory, "state.ts"), "const state = 2;\n", "utf8");

  assert.equal(await repository.resolvePath({ path: "state.ts", revision: "index" }), indexBefore);
  const after = await handleHookEvent(gitEvent({ tool: "edit", output: { changed: true } }), { repository, state });

  assert.match(after.user_message ?? "", /continue, supersede, or retire/i);
  assert.match(after.user_message ?? "", new RegExp(record.id));
});

test("a no-op on a pre-staged worktree state does not emit a continuity reminder", async () => {
  const { directory, repository } = await setupGitRepository();
  const state = createHookState();
  await writeFile(join(directory, "state.ts"), "const state = 2;\n", "utf8");
  await git(directory, "add", "state.ts");
  assert.notEqual(
    await repository.resolvePath({ path: "state.ts", revision: "index" }),
    await repository.resolvePath({ path: "state.ts", revision: "HEAD" }),
  );

  await handleHookEvent(gitEvent({ event: "before-tool", tool: "edit" }), { repository, state });
  const after = await handleHookEvent(gitEvent({ tool: "edit", output: { changed: true } }), { repository, state });

  assert.equal(after.user_message, null);
});

test("a real worktree change is detected even when the tool reports no change", async () => {
  const { directory, repository, record } = await setupGitRepository();
  const state = createHookState();

  await handleHookEvent(gitEvent({ event: "before-tool", tool: "edit" }), { repository, state });
  await writeFile(join(directory, "state.ts"), "const state = 2;\n", "utf8");
  const after = await handleHookEvent(gitEvent({ tool: "edit", output: { changed: false } }), { repository, state });

  assert.match(after.user_message ?? "", new RegExp(record.id));
});

test("deleting an annotated worktree path emits a continuity reminder", async () => {
  const { directory, repository, record } = await setupGitRepository();
  const state = createHookState();

  await handleHookEvent(gitEvent({ event: "before-tool", tool: "edit" }), { repository, state });
  await unlink(join(directory, "state.ts"));
  const after = await handleHookEvent(gitEvent({ tool: "edit" }), { repository, state });

  assert.match(after.user_message ?? "", new RegExp(record.id));
  assert.match(after.user_message ?? "", /state\.ts/);
});

test("replacing an annotated file with a symlink is detected without following it", async () => {
  const { directory, repository, record } = await setupGitRepository();
  const state = createHookState();
  await writeFile(join(directory, "target.ts"), "const state = 1;\n", "utf8");

  await handleHookEvent(gitEvent({ event: "before-tool", tool: "edit" }), { repository, state });
  await unlink(join(directory, "state.ts"));
  await symlink("target.ts", join(directory, "state.ts"));
  const after = await handleHookEvent(gitEvent({ tool: "edit" }), { repository, state });

  assert.match(after.user_message ?? "", new RegExp(record.id));
});

test("rename events compare their explicit source and destination paths", async () => {
  const { directory, repository, record } = await setupGitRepository();
  const state = createHookState();
  const renameEvent = (overrides: Partial<HookEvent> = {}) => event({
    input: { oldPath: "state.ts", newPath: "renamed.ts" },
    ...overrides,
  });

  await handleHookEvent(renameEvent({ event: "before-tool", tool: "edit" }), { repository, state });
  await rename(join(directory, "state.ts"), join(directory, "renamed.ts"));
  const after = await handleHookEvent(renameEvent({ tool: "edit" }), { repository, state });

  assert.match(after.user_message ?? "", new RegExp(record.id));
  assert.match(after.user_message ?? "", /state\.ts/);

  const destinationOnlyState = createHookState();
  const destinationEvent = (overrides: Partial<HookEvent> = {}) => event({
    input: { path: "renamed.ts" },
    ...overrides,
  });
  await handleHookEvent(destinationEvent({ event: "before-tool", tool: "edit" }), {
    repository,
    state: destinationOnlyState,
  });
  const destinationOnlyAfter = await handleHookEvent(destinationEvent({ tool: "edit" }), {
    repository,
    state: destinationOnlyState,
  });
  assert.equal(destinationOnlyAfter.user_message, null);
});

test("multiple explicit paths report only changed annotated paths", async () => {
  const { directory, repository, record } = await setupGitRepository();
  const state = createHookState();
  await writeFile(join(directory, "other.ts"), "const other = 1;\n", "utf8");
  await git(directory, "add", "other.ts");
  await git(directory, "commit", "-m", "add second file");
  const otherBlob = await repository.resolvePath({ path: "other.ts", revision: "HEAD" });
  const otherRecord = makeRecord("Keep the second state isolated.", "A second owner appeared.");
  await repository.withNotesWrite(async (notes) => notes.append(otherBlob, canonicalRecord(otherRecord)));

  const pathsEvent = (overrides: Partial<HookEvent> = {}) => event({
    input: { path: "state.ts", paths: ["other.ts"] },
    ...overrides,
  });
  await handleHookEvent(pathsEvent({ event: "before-tool", tool: "edit" }), { repository, state });
  await writeFile(join(directory, "state.ts"), "const state = 2;\n", "utf8");
  const after = await handleHookEvent(pathsEvent({ tool: "edit" }), { repository, state });

  assert.match(after.user_message ?? "", new RegExp(record.id));
  assert.doesNotMatch(after.user_message ?? "", new RegExp(otherRecord.id));
  assert.match(after.user_message ?? "", /state\.ts/);
  assert.doesNotMatch(after.user_message ?? "", /other\.ts/);
});

test("pathspec-like hook inputs are not expanded to annotated paths", async () => {
  const { repository } = await setupGitRepository();
  const state = createHookState();
  const patternEvent = (overrides: Partial<HookEvent> = {}) => event({
    input: { path: "*.ts" },
    ...overrides,
  });

  const before = await handleHookEvent(patternEvent({ event: "before-tool", tool: "edit" }), { repository, state });
  const after = await handleHookEvent(patternEvent({ tool: "edit" }), { repository, state });

  assert.equal(before.reason, "path-unavailable");
  assert.equal(state.edits.size, 0);
  assert.equal(after.user_message, null);
});

test("raw edits remain visible when Git normalizes staged line endings", async () => {
  const { directory, repository, record } = await setupGitRepository();
  const state = createHookState();
  await writeFile(join(directory, ".gitattributes"), "state.ts text eol=lf\n", "utf8");
  await git(directory, "add", ".gitattributes");
  await git(directory, "commit", "-m", "normalize state file line endings");
  const indexBefore = await repository.resolvePath({ path: "state.ts", revision: "index" });

  await handleHookEvent(gitEvent({ event: "before-tool", tool: "edit" }), { repository, state });
  await writeFile(join(directory, "state.ts"), "const state = 1;\r\n", "utf8");
  await git(directory, "add", "state.ts");
  assert.equal(await repository.resolvePath({ path: "state.ts", revision: "index" }), indexBefore);
  const after = await handleHookEvent(gitEvent({ tool: "edit" }), { repository, state });

  assert.match(after.user_message ?? "", new RegExp(record.id));
});

test("paths through symlinked parent directories are unavailable", async () => {
  const { directory, repository } = await setupGitRepository();
  const external = await mkdtemp(join(tmpdir(), "reveries-hooks-external-"));
  temporaryRepositories.push(external);
  await writeFile(join(external, "secret.ts"), "const secret = true;\n", "utf8");
  await symlink(external, join(directory, "linked"));

  const before = await handleHookEvent(event({
    event: "before-tool",
    tool: "edit",
    input: { path: "linked/secret.ts" },
  }), { repository, state: createHookState() });

  assert.equal(before.reason, "path-unavailable");
});

test("malformed notes are suppressed rather than injected", async () => {
  const { repository } = await setup();
  repository.notes.set(BLOB_A, '{"type":"reverie"}\n');
  const result = await handleHookEvent(event(), { repository });
  assert.equal(result.context, null);
  assert.match(result.reason ?? "", /malformed|invalid/i);
});

test("forged semantic IDs and broken local sources are not delivered", async () => {
  const { repository, record } = await setup();
  repository.notes.set(BLOB_A, canonicalRecord({ ...record, decision: "A forged decision." }));
  const forged = await handleHookEvent(event(), { repository });
  assert.equal(forged.context, null);
  assert.equal(forged.reason, "malformed-note");

  const broken = createReverie(
    {
      ...record,
      sources: [{
        relation: "caused-by",
        kind: "commit",
        ref: "cccccccccccccccccccccccccccccccccccccccc",
      }],
    },
    record,
    (bytes) => objectId(createHash("sha1").update(Buffer.from(`blob ${bytes.byteLength}\0`)).update(bytes).digest("hex")),
  );
  repository.notes.set(BLOB_A, canonicalRecord(broken));
  const missingSource = await handleHookEvent(event(), { repository });
  assert.equal(missingSource.context, null);
  assert.equal(missingSource.reason, "broken-source");
});

test("a missing source behind a promisor-shaped clone grades incomplete-evidence", async () => {
  const { repository, record } = await setup();
  repository.hasPromisorRemote = async () => true;
  const sourced = createReverie(
    {
      ...record,
      sources: [{
        relation: "derived-from",
        kind: "blob",
        ref: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      }],
    },
    record,
    (bytes) => objectId(createHash("sha1").update(Buffer.from(`blob ${bytes.byteLength}\0`)).update(bytes).digest("hex")),
  );
  repository.notes.set(BLOB_A, canonicalRecord(sourced));
  const result = await handleHookEvent(event(), { repository });
  assert.equal(result.context, null);
  assert.equal(result.reason, "incomplete-evidence");
  assert.equal(result.completeness, "promisor-object-missing");
});

test("control bytes are neutralized in model-visible evidence", async () => {
  const { repository } = await setup();
  const unsafe = makeRecord("Use the boundary\u0000without control bytes.", "Observed\u0007 event.");
  repository.notes.set(BLOB_A, canonicalRecord(unsafe));
  const result = await handleHookEvent(event(), { repository });
  assert.equal(result.context?.includes("\u0000"), false);
  assert.equal(result.context?.includes("\u0007"), false);
  assert.match(result.context ?? "", /Observed event/);
});

test("context truncation omits whole records and reports the count", async () => {
  const { repository } = await setup();
  const second = makeRecord("Select the second decision.", "A second forcing event.");
  repository.notes.set(BLOB_A, `${canonicalRecord(makeRecord())}${canonicalRecord(second)}`);
  const result = await handleHookEvent(event(), { repository }, { maxContextChars: 700 });
  assert.match(result.context ?? "", /Driving event:/);
  assert.doesNotMatch(result.context ?? "", /A second forcing event/);
  assert.match(result.context ?? "", /additional reveries omitted/);
});

test("the hook handler has no network behavior", async () => {
  const { repository } = await setup();
  const result = await handleHookEvent(event(), { repository });
  assert.equal(result.block, false);
  assert.equal("fetch" in repository, false);
  assert.equal("push" in repository, false);
});

test("host adapters only translate native event envelopes", () => {
  const input = JSON.stringify({ type: "after_tool", sessionId: "native-session", toolName: "read", params: { path: "src/state.ts" }, result: {} });
  const events = [
    adaptPiEvent(input),
    adaptClaudeCodeEvent(input),
    adaptOpenCodeEvent(input),
    adaptCodexEvent(input),
    adaptGeminiCliEvent(input),
  ];
  assert.deepEqual(events.map((event) => event.host), ["pi", "claude", "opencode", "codex", "gemini"]);
  for (const event of events) {
    assert.equal(event.event, "after-tool");
    assert.equal(event.tool, "read");
    assert.deepEqual(event.input, { path: "src/state.ts" });
    assert.equal(event.session, "native-session");
  }
});
