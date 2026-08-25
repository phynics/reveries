import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  blobId,
  canonicalRecord,
  createReverie,
  objectId,
  type ObjectId,
  type ReverieRecord,
} from "../src/protocol.ts";
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

async function setup(marker = true): Promise<{ repository: FakeRepository; record: ReverieRecord }> {
  const root = await mkdtemp(join(tmpdir(), "reveries-hooks-"));
  if (marker) await writeFile(join(root, "AGENTS.md"), "<!-- reveries:begin -->\n## Reveries\n<!-- reveries:end -->\n", "utf8");
  const repository = new FakeRepository(root);
  const record = makeRecord();
  repository.notes.set(BLOB_A, canonicalRecord(record));
  return { repository, record };
}

test("inactive repositories receive no automatic context", async () => {
  const { repository } = await setup(false);
  const result = await handleHookEvent(event(), { repository });
  assert.deepEqual(result, { context: null, user_message: null, block: false, reason: null });
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
  const after = await handleHookEvent(event({ tool: "edit", output: { changed: true } }), { repository, state });
  assert.match(after.user_message ?? "", /continue, supersede, or retire/i);
  assert.match(after.user_message ?? "", new RegExp(record.id));
  assert.equal(repository.notes.size, 1);
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
