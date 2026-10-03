import assert from "node:assert/strict";
import { test } from "node:test";

import { hashBlobContent } from "../src/git.ts";
import {
  canonicalRecord,
  commitId,
  createTransition,
  parseNote,
  transitionId,
  transitionPayload,
  validateNote,
  type CommitId,
  type HashObject,
  type ObjectId,
  type TransitionInput,
  type TransitionMetadata,
} from "../src/protocol.ts";

const sha1: HashObject = (bytes) => hashBlobContent(bytes, "sha1");

const PARENT_A = "a".repeat(40);
const PARENT_B = "b".repeat(40);
const RESULT = "c".repeat(40);

const causal = {
  driving_event: "The merge queue creates final commit IDs after review.",
  decision: "Anchor causality to tree transitions because commit IDs change during publication.",
  impact: "Evidence stays stable across amends and squash merges.",
  recurrence_control: "Transition fixtures fail when the identity changes unexpectedly.",
  alternatives: ["Anchor evidence to commit IDs"],
  sources: [],
  reveries: [],
  retirements: [],
} as const;

function input(overrides: Partial<TransitionInput> = {}): TransitionInput {
  return {
    parents: [PARENT_A as ObjectId, PARENT_B as ObjectId],
    result: RESULT as ObjectId,
    driving_event: causal.driving_event,
    decision: causal.decision,
    impact: causal.impact,
    recurrence_control: causal.recurrence_control,
    alternatives: [...causal.alternatives],
    sources: [],
    reveries: [],
    retirements: [],
    ...overrides,
  };
}

const metadata: TransitionMetadata = {
  author_email: "reveries@example.com",
  session: "codex:transition",
  created_at: "2026-09-29T07:00:00Z",
};

test("transitionId accepts tr-prefixed object IDs and rejects other shapes", () => {
  assert.equal(transitionId(`tr:${"a".repeat(40)}`), `tr:${"a".repeat(40)}`);
  assert.equal(transitionId(`tr:${"b".repeat(64)}`), `tr:${"b".repeat(64)}`);
  assert.throws(() => transitionId("a".repeat(40)), /Invalid transition ID/);
  assert.throws(() => transitionId(`rv:${"a".repeat(40)}`), /Invalid transition ID/);
  assert.throws(() => transitionId("tr:short"), /Invalid transition ID/);
});

test("createTransition derives a stable tr: identity from parents, result, and causal fields", () => {
  const first = createTransition(input(), metadata, sha1);
  const second = createTransition(input(), metadata, sha1);
  assert.equal(first.type, "transition-summary");
  assert.equal(first.id, second.id);
  assert.match(first.id, /^tr:[0-9a-f]{40}$/);
  assert.deepEqual([...first.parents], [PARENT_A, PARENT_B]);
  assert.equal(first.result, RESULT);
});

test("transition identity excludes author metadata", () => {
  const first = createTransition(input(), metadata, sha1);
  const second = createTransition(input(), {
    author_email: "other@example.com",
    session: null,
    created_at: "2026-09-30T00:00:00Z",
  }, sha1);
  assert.equal(first.id, second.id);
});

test("transition identity is sensitive to parent order", () => {
  const first = createTransition(input(), metadata, sha1);
  const swapped = createTransition(
    input({ parents: [PARENT_B as ObjectId, PARENT_A as ObjectId] }),
    metadata,
    sha1,
  );
  assert.notEqual(first.id, swapped.id);
});

test("transition identity supports root commits with an empty parent list", () => {
  const root = createTransition(input({ parents: [] }), metadata, sha1);
  assert.deepEqual([...root.parents], []);
  assert.match(root.id, /^tr:[0-9a-f]{40}$/);
});

test("transition identity changes when causal content changes", () => {
  const first = createTransition(input(), metadata, sha1);
  const changed = createTransition(
    input({ decision: "Anchor causality elsewhere because the base moved." }),
    metadata,
    sha1,
  );
  assert.notEqual(first.id, changed.id);
});

test("transition identity normalizes set-like causal arrays", () => {
  const first = createTransition(
    input({ alternatives: ["Second rejected path", "First rejected path"] }),
    metadata,
    sha1,
  );
  const second = createTransition(
    input({ alternatives: ["First rejected path", "Second rejected path"] }),
    metadata,
    sha1,
  );
  assert.equal(first.id, second.id);
});

test("transitionPayload documents the exact hashed bytes", () => {
  const record = createTransition(input({ parents: [] }), metadata, sha1);
  const payload = transitionPayload(record);
  const parsed = JSON.parse(payload) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed), [
    "v",
    "parents",
    "result",
    "driving_event",
    "decision",
    "impact",
    "recurrence_control",
    "alternatives",
    "sources",
    "reveries",
    "retirements",
  ]);
  assert.equal(`tr:${sha1(Buffer.from(`${payload}\n`, "utf8"))}`, record.id);
});

test("transition records serialize canonically and round-trip through strict parsing", () => {
  const record = createTransition(input(), metadata, sha1);
  const line = canonicalRecord(record);
  assert.ok(line.endsWith("\n"));
  const parsed = parseNote(line, "strict", { hashObject: sha1 });
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.records[0]?.type, "transition-summary");
});

test("validateNote accepts transition and attestation records together", () => {
  const transition = createTransition(input(), metadata, sha1);
  const attestation = {
    v: 1 as const,
    type: "publication-attestation" as const,
    author_email: "reveries@example.com",
    session: "codex:transition",
    created_at: "2026-09-29T07:00:00Z",
    commit: commitId(PARENT_A),
    transition: transition.id,
    publisher: "reveries@example.com",
  };
  const records = validateNote([transition, attestation], { hashObject: sha1 });
  assert.equal(records.length, 2);
});

test("validateNote rejects conflicting duplicate transition IDs", () => {
  const record = createTransition(input(), metadata, sha1);
  const conflict = {
    ...record,
    decision: "A different decision with the same stolen identity.",
  };
  assert.throws(() => validateNote([record, conflict], { verifyIds: false }), /conflicting duplicate transition ID/);
});

test("createTransition rejects malformed parents, results, and causal placeholders", () => {
  assert.throws(() => createTransition(input({ parents: ["nope"] as unknown as ObjectId[] }), metadata, sha1));
  assert.throws(() => createTransition(input({ result: "short" as ObjectId }), metadata, sha1));
  assert.throws(() => createTransition(input({ recurrence_control: "N/A" }), metadata, sha1));
  assert.throws(() => createTransition(
    input({ parents: Array.from({ length: 65 }, (_, index) => `${index.toString(16).padStart(40, "0")}`) as ObjectId[] }),
    metadata,
    sha1,
  ), /maxParents/);
});

test("transition summaries reject malformed created_at timestamps", () => {
  const record = createTransition(input(), metadata, sha1);
  assert.throws(
    () => validateNote([{ ...record, created_at: "2026-09-29 07:00:00" }], { verifyIds: false }),
    /created_at must be a canonical UTC RFC 3339 timestamp/,
  );
  assert.throws(
    () => createTransition(input(), { ...metadata, created_at: "yesterday" }, sha1),
    /created_at must be a canonical UTC RFC 3339 timestamp/,
  );
});

test("validateNote rejects malformed publication attestations", () => {
  const transition = createTransition(input(), metadata, sha1);
  const base = {
    v: 1 as const,
    type: "publication-attestation" as const,
    author_email: "reveries@example.com",
    session: null as string | null,
    created_at: "2026-09-29T07:00:00Z",
    commit: commitId(PARENT_A),
    transition: transition.id,
    publisher: "reveries@example.com",
  };
  assert.throws(() => validateNote([{ ...base, commit: "short" as CommitId }], { hashObject: sha1 }));
  assert.throws(() => validateNote([{ ...base, transition: `rv:${"a".repeat(40)}` as unknown as typeof base.transition }], { hashObject: sha1 }));
  assert.throws(() => validateNote([{ ...base, publisher: "   " }], { hashObject: sha1 }));
});
