import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { coordinateKey, deriveLineage, parseSimilarityCandidates } from "../src/operations.ts";
import type { OccurrenceDerivation } from "../src/operations.ts";
import { SUGGESTION_NOTICE, suggestLineage, suggestionCommand } from "../src/lineage.ts";

import {
  canonicalRecord,
  createLineage,
  createOccurrence,
  createReverie,
  factHeadId,
  factTargetId,
  lineageId,
  objectId,
  occurrenceId,
  parseNote,
  recordFactId,
  semanticPayload,
  transitionId,
  validateNote,
  type CommitId,
  type LineageInput,
  type LineageRecord,
  type OccurrenceRecord,
  type ObjectId,
  type ReverieRecord,
  type SubjectId,
} from "../src/protocol.ts";

const blobA = objectId("0123456789012345678901234567890123456789");
const blobB = objectId("abcdefabcdefabcdefabcdefabcdefabcdefabcd");
const treeA = objectId("1111111111111111111111111111111111111111");
const treeB = objectId("2222222222222222222222222222222222222222");
const commit = objectId("3333333333333333333333333333333333333333") as CommitId;
const parent = objectId("4444444444444444444444444444444444444444") as CommitId;
const otherCommit = objectId("5555555555555555555555555555555555555555") as CommitId;
const transition = transitionId("tr:6666666666666666666666666666666666666666");

function gitSha1(bytes: Uint8Array): ObjectId {
  return objectId(createHash("sha1").update(Buffer.from(`blob ${bytes.byteLength}\0`)).update(bytes).digest("hex"));
}

const metadata = {
  author_email: "engineer@example.com",
  session: "codex:occurrence-lineage",
  created_at: "2026-10-03T00:00:00Z",
};

const causal = {
  driving_event: "One blob is vendored, generated, and hand-written in the same repository.",
  decision: "Record the vendored occurrence separately because vendoring is not authoring.",
  impact: "Only the vendored path carries this rationale; the authored path keeps universal evidence.",
  recurrence_control: "The occurrence fixture fails when an anchored record reads as universal.",
  alternatives: [],
  sources: [],
};

function occurrenceInput(overrides: Partial<Parameters<typeof createOccurrence>[0]> = {}) {
  return {
    v: 1 as const,
    occurrence: { commit, path: "vendor/x.ts", subject: blobA },
    ...causal,
    ...overrides,
  };
}

function lineageInput(overrides: Partial<LineageInput> = {}): LineageInput {
  return {
    v: 1,
    kind: "preserve",
    parent,
    commit,
    from: [{ path: "mod", subject: treeA }],
    to: [{ path: "moved", subject: treeB }],
    transition: null,
    ...causal,
    ...overrides,
  };
}

test("two occurrences of one blob are two records with distinct identities", () => {
  const vendored = createOccurrence(occurrenceInput(), metadata, gitSha1);
  const authored = createOccurrence(
    occurrenceInput({ occurrence: { commit, path: "src/x.ts", subject: blobA } }),
    metadata,
    gitSha1,
  );
  const later = createOccurrence(
    occurrenceInput({ occurrence: { commit: otherCommit, path: "vendor/x.ts", subject: blobA } }),
    metadata,
    gitSha1,
  );

  assert.notEqual(vendored.id, authored.id);
  assert.notEqual(vendored.id, later.id);
  assert.equal(vendored.occurrence.subject, blobA);
  assert.equal(vendored.occurrence.path, "vendor/x.ts");
  assert.throws(() => occurrenceId("oc:not-a-hash"), /Invalid occurrence ID/);
  assert.equal(factHeadId(vendored.id), vendored.id);
  assert.equal(factTargetId(vendored.id), vendored.id);
  assert.equal(recordFactId(vendored), vendored.id);
});

test("an occurrence with identical prose at another coordinate is a different decision", () => {
  // The prose is deliberately identical: only the coordinate separates them.
  const here = createOccurrence(occurrenceInput(), metadata, gitSha1);
  const there = createOccurrence(
    occurrenceInput({ occurrence: { commit, path: "src/x.ts", subject: blobA } }),
    metadata,
    gitSha1,
  );
  assert.equal(here.decision, there.decision);
  assert.notEqual(here.id, there.id);
});

test("occurrence canonical bytes are exact and stable", () => {
  const record = createOccurrence(occurrenceInput(), metadata, gitSha1);
  const line = canonicalRecord(record);
  assert.equal(
    line,
    `${JSON.stringify({
      v: 1,
      type: "occurrence",
      id: record.id,
      occurrence: { commit, path: "vendor/x.ts", subject: blobA },
      driving_event: causal.driving_event,
      decision: causal.decision,
      impact: causal.impact,
      recurrence_control: causal.recurrence_control,
      alternatives: [],
      sources: [],
      author_email: metadata.author_email,
      session: metadata.session,
      created_at: metadata.created_at,
    })}\n`,
  );
  const reparsed = parseNote(line, "strict", { hashObject: gitSha1 });
  assert.equal(reparsed.records.length, 1);
  assert.equal(canonicalRecord(reparsed.records[0] as OccurrenceRecord), line);
  assert.equal(validateNote(reparsed.records, { hashObject: gitSha1 }).length, 1);
});

test("an occurrence never rewrites universal reverie identity or bytes", () => {
  const universal = createReverie(
    {
      v: 1,
      ...causal,
      decision: "Keep the exact content rule because it holds for every occurrence.",
      supersedes: [],
    },
    metadata,
    gitSha1,
  );
  const before = canonicalRecord(universal);
  const narrowed = createOccurrence(occurrenceInput(), metadata, gitSha1);
  assert.ok(canonicalRecord(universal).startsWith(before.slice(0, before.length)));
  assert.equal(
    canonicalRecord(universal),
    before,
    "adding an occurrence record must not change a universal record's canonical bytes",
  );
  assert.equal(semanticPayload(universal).includes("vendor/x.ts"), false);
  // Both records may share one blob note; neither changes the other's identity.
  const shared = validateNote([universal, narrowed], { hashObject: gitSha1 });
  assert.equal(shared.length, 2);
  assert.equal((shared[0] as ReverieRecord).id, universal.id);
});

test("an occurrence coordinate must be a resolvable-looking repository path", () => {
  assert.throws(
    () => createOccurrence(occurrenceInput({ occurrence: { commit, path: "/abs/x.ts", subject: blobA } }), metadata, gitSha1),
    /must be relative to the repository root/,
  );
  assert.throws(
    () => createOccurrence(occurrenceInput({ occurrence: { commit, path: "../x.ts", subject: blobA } }), metadata, gitSha1),
    /cannot contain a "\.\." segment/,
  );
  assert.throws(
    () => createOccurrence(occurrenceInput({ occurrence: { commit, path: "", subject: blobA } }), metadata, gitSha1),
    /nonempty repository path/,
  );
  assert.throws(
    () => createOccurrence(occurrenceInput({ occurrence: { commit, path: "x.ts", subject: "nope" as SubjectId } }), metadata, gitSha1),
    /Invalid Git object ID/,
  );
  // The root tree's display path is a legal coordinate.
  const root = createOccurrence(
    occurrenceInput({ occurrence: { commit, path: ".", subject: treeA } }),
    metadata,
    gitSha1,
  );
  assert.equal(root.occurrence.path, ".");
});

test("an occurrence ID that does not match its canonical content is refused", () => {
  const record = createOccurrence(occurrenceInput(), metadata, gitSha1);
  assert.throws(
    () => validateNote([{ ...record, decision: `${record.decision} tampered` }], { hashObject: gitSha1 }),
    /occurrence ID mismatch/,
  );
});

test("a conflicting duplicate occurrence ID fails closed", () => {
  const record = createOccurrence(occurrenceInput(), metadata, gitSha1);
  const impostor = { ...record, decision: "Different prose under one identity." } as OccurrenceRecord;
  assert.throws(
    () => validateNote([record, impostor], { verifyIds: false, forkPolicy: "reject" }),
    /conflicting duplicate occurrence ID/,
  );
});

test("every lineage kind declares its own shape", () => {
  const one: LineageInput["from"] = [{ path: "a", subject: treeA }];
  const two: LineageInput["from"] = [{ path: "a", subject: treeA }, { path: "b", subject: treeB }];
  const three: LineageInput["from"] = [{ path: "a", subject: treeA }, { path: "b", subject: treeB }, { path: "c", subject: blobB }];

  const preserve = createLineage(lineageInput({ kind: "preserve", from: one, to: [{ path: "b", subject: treeB }] }), metadata, gitSha1);
  assert.equal(preserve.kind, "preserve");

  const split = createLineage(
    lineageInput({ kind: "split", from: one, to: [{ path: "b", subject: treeB }, { path: "c", subject: blobB }] }),
    metadata,
    gitSha1,
  );
  assert.equal(split.to.length, 2);

  const merge = createLineage(
    lineageInput({ kind: "merge", from: two, to: [{ path: "c", subject: treeB }] }),
    metadata,
    gitSha1,
  );
  assert.equal(merge.from.length, 2);

  const retire = createLineage(lineageInput({ kind: "retire", from: one, to: [] }), metadata, gitSha1);
  assert.equal(retire.to.length, 0);

  // A true N-to-M relation needs no similarity and no rounding to a split.
  const derive = createLineage(
    lineageInput({ kind: "derive", from: two, to: [{ path: "c", subject: treeB }, { path: "d", subject: blobB }] }),
    metadata,
    gitSha1,
  );
  assert.equal(derive.from.length * derive.to.length, 4);
  const deriveThree = createLineage(
    lineageInput({ kind: "derive", from: two, to: three.map((entry) => ({ path: entry.path, subject: entry.subject })) }),
    metadata,
    gitSha1,
  );
  assert.equal(deriveThree.to.length, 3);
});

test("a lineage kind whose shape contradicts itself is refused", () => {
  const one: LineageInput["from"] = [{ path: "a", subject: treeA }];
  const two: LineageInput["from"] = [{ path: "a", subject: treeA }, { path: "b", subject: treeB }];
  assert.throws(
    () => createLineage(lineageInput({ kind: "split", from: one, to: [{ path: "b", subject: treeB }] }), metadata, gitSha1),
    /split lineage edge must be one to many/,
  );
  assert.throws(
    () => createLineage(lineageInput({ kind: "merge", from: two, to: [{ path: "b", subject: treeB }, { path: "c", subject: blobB }] }), metadata, gitSha1),
    /merge lineage edge must be many to one/,
  );
  assert.throws(
    () => createLineage(lineageInput({ kind: "preserve", from: two, to: [{ path: "c", subject: treeB }] }), metadata, gitSha1),
    /preserve lineage edge must be one to one/,
  );
  assert.throws(
    () => createLineage(lineageInput({ kind: "retire", from: one, to: [{ path: "b", subject: treeB }] }), metadata, gitSha1),
    /retire lineage edge must have no successor/,
  );
  assert.throws(
    () => createLineage(lineageInput({ kind: "derive", from: one, to: [] }), metadata, gitSha1),
    /derive lineage edge must name at least one successor/,
  );
  assert.throws(() => createLineage(lineageInput({ kind: "extract" as never }), metadata, gitSha1), /lineage kind must be one of/);
  assert.throws(
    () => createLineage(lineageInput({ from: [] }), metadata, gitSha1),
    /from must name at least one occurrence/,
  );
});

test("lineage identity is order-independent and bound to the parent and commit", () => {
  const forward = createLineage(
    lineageInput({ kind: "split", from: [{ path: "a", subject: treeA }], to: [{ path: "z", subject: treeB }, { path: "b", subject: blobB }] }),
    metadata,
    gitSha1,
  );
  const reversed = createLineage(
    lineageInput({ kind: "split", from: [{ path: "a", subject: treeA }], to: [{ path: "b", subject: blobB }, { path: "z", subject: treeB }] }),
    metadata,
    gitSha1,
  );
  assert.equal(forward.id, reversed.id);
  assert.equal(canonicalRecord(forward), canonicalRecord(reversed));

  const otherParent = createLineage(lineageInput({ parent: otherCommit }), metadata, gitSha1);
  const otherResult = createLineage(lineageInput({ commit: otherCommit }), metadata, gitSha1);
  const linked = createLineage(lineageInput({ transition }), metadata, gitSha1);
  assert.notEqual(forward.id, otherParent.id);
  assert.notEqual(forward.id, otherResult.id);
  assert.notEqual(forward.id, linked.id);
  assert.equal(linked.transition, transition);
  assert.throws(() => lineageId("lg:nope"), /Invalid lineage ID/);
  assert.equal(factHeadId(forward.id), forward.id);
  assert.equal(recordFactId(forward), forward.id);
});

test("a lineage edge refuses a duplicated endpoint", () => {
  assert.throws(
    () => createLineage(
      lineageInput({ kind: "split", from: [{ path: "a", subject: treeA }], to: [{ path: "b", subject: treeB }, { path: "b", subject: treeB }] }),
      metadata,
      gitSha1,
    ),
    /lists the same endpoint twice/,
  );
});

test("lineage endpoint fan-out is bounded", () => {
  const many = Array.from({ length: 5 }, (_, index) => ({
    path: `p${index}`,
    subject: objectId(String(index).repeat(40)),
  }));
  assert.throws(
    () => createLineage(lineageInput({ kind: "split", from: [{ path: "a", subject: treeA }], to: many }), metadata, gitSha1, { maxLineageRefs: 4 }),
    /maxLineageRefs/,
  );
  assert.doesNotThrow(
    () => createLineage(lineageInput({ kind: "split", from: [{ path: "a", subject: treeA }], to: many }), metadata, gitSha1, { maxLineageRefs: 5 }),
  );
});

test("lineage canonical bytes are exact and stable", () => {
  const record = createLineage(lineageInput({ transition }), metadata, gitSha1);
  const line = canonicalRecord(record);
  assert.equal(
    line,
    `${JSON.stringify({
      v: 1,
      type: "lineage",
      id: record.id,
      kind: "preserve",
      parent,
      commit,
      from: [{ path: "mod", subject: treeA }],
      to: [{ path: "moved", subject: treeB }],
      transition,
      driving_event: causal.driving_event,
      decision: causal.decision,
      impact: causal.impact,
      recurrence_control: causal.recurrence_control,
      alternatives: [],
      sources: [],
      author_email: metadata.author_email,
      session: metadata.session,
      created_at: metadata.created_at,
    })}\n`,
  );
  const reparsed = parseNote(line, "strict", { hashObject: gitSha1 });
  assert.equal(canonicalRecord(reparsed.records[0] as LineageRecord), line);
});

test("a conflicting duplicate lineage ID fails closed", () => {
  const record = createLineage(lineageInput(), metadata, gitSha1);
  const impostor = { ...record, decision: "Different prose under one pairing identity." } as LineageRecord;
  assert.throws(
    () => validateNote([record, impostor], { verifyIds: false, forkPolicy: "reject" }),
    /conflicting duplicate lineage ID/,
  );
});

test("occurrence count on one note is bounded", () => {
  const records: OccurrenceRecord[] = [
    createOccurrence(occurrenceInput({ occurrence: { commit, path: "vendor/x.ts", subject: blobA } }), metadata, gitSha1),
    createOccurrence(occurrenceInput({ occurrence: { commit, path: "src/x.ts", subject: blobA } }), metadata, gitSha1),
  ];
  assert.doesNotThrow(() => validateNote(records, { hashObject: gitSha1, limits: { maxOccurrences: 2 } }));
  assert.throws(
    () => validateNote(records, { hashObject: gitSha1, limits: { maxOccurrences: 1 } }),
    /maxOccurrences/,
  );
});

/**
 * The published schemas must describe exactly the records the protocol
 * produces: same key set, same required set, no extra properties. There is no
 * schema validator in this repository, so drift is caught here instead, the
 * same way the signature and ledger manifest schemas are checked.
 */
test("the published occurrence schema describes exactly the canonical record", async () => {
  const schema = JSON.parse(await readFile(
    fileURLToPath(new URL("../../../protocol/schemas/occurrence.schema.json", import.meta.url)),
    "utf8",
  )) as { properties: Record<string, { const?: unknown }>; required: string[]; additionalProperties: boolean };
  const canonical = JSON.parse(canonicalRecord(createOccurrence(occurrenceInput(), metadata, gitSha1))) as Record<string, unknown>;
  assert.equal(schema.properties.type?.const, "occurrence");
  assert.deepEqual(Object.keys(canonical).sort(), Object.keys(schema.properties).sort());
  assert.deepEqual(Object.keys(canonical).sort(), [...schema.required].sort());
  assert.equal(schema.additionalProperties, false);
});

test("the published lineage schema describes exactly the canonical record", async () => {
  const schema = JSON.parse(await readFile(
    fileURLToPath(new URL("../../../protocol/schemas/lineage.schema.json", import.meta.url)),
    "utf8",
  )) as { properties: Record<string, { const?: unknown }>; required: string[]; additionalProperties: boolean };
  const canonical = JSON.parse(canonicalRecord(createLineage(lineageInput({ transition }), metadata, gitSha1))) as Record<string, unknown>;
  assert.equal(schema.properties.type?.const, "lineage");
  assert.deepEqual(Object.keys(canonical).sort(), Object.keys(schema.properties).sort());
  assert.deepEqual(Object.keys(canonical).sort(), [...schema.required].sort());
  assert.equal(schema.additionalProperties, false);
});

test("the suggestion surface never produces a confirmed edge", () => {
  // The pure projection is the only similarity consumer, and it cannot emit
  // anything a continuity check would accept.
  const suggestion = suggestLineage({
    from: { path: "src/a.ts", subject: blobA },
    to: { path: "lib/a.ts", subject: blobB },
    score: 97,
  });
  assert.equal(suggestion.length, 1);
  assert.equal(suggestion[0]?.confirmed, false);
  assert.equal(suggestion[0]?.basis, "git-similarity");
  assert.equal(suggestion[0]?.kind, "derive");
  assert.match(SUGGESTION_NOTICE, /never evidence/);

  // Identical content is not a lineage question at all.
  assert.deepEqual(suggestLineage({
    from: { path: "src/a.ts", subject: blobA },
    to: { path: "lib/a.ts", subject: blobA },
    score: 100,
  }), []);
  // An in-place edit needs no pairing, and a weak score is not a proposal.
  assert.deepEqual(suggestLineage({
    from: { path: "a.ts", subject: blobA },
    to: { path: "a.ts", subject: blobB },
    score: 100,
  }), []);
  assert.deepEqual(suggestLineage({
    from: { path: "a.ts", subject: blobA },
    to: { path: "b.ts", subject: blobB },
    score: 20,
  }), []);
  assert.match(suggestionCommand(suggestion[0]!, "abc123"), /reveries link --kind derive/);
});

test("Git's rename candidates parse as suggestions only", () => {  const raw = [
    ":100644 100644 abc123abc123abc123abc123abc123abc123abcd def456def456def456def456def456def4567890 R095\0old/name.ts\0new/name.ts\0",
    ":000000 100644 0000000000000000000000000000000000000000 def456def456def456def456def456def4567890 A\0added.ts\0",
    ":100644 000000 abc123abc123abc123abc123abc123abc123abcd 0000000000000000000000000000000000000000 D\0gone.ts\0",
  ].join("");
  const candidates = parseSimilarityCandidates(raw);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.from.path, "old/name.ts");
  assert.equal(candidates[0]?.to.path, "new/name.ts");
  assert.equal(candidates[0]?.score, 95);
  assert.notEqual(candidates[0]?.from.subject, candidates[0]?.to.subject);
});

test("a multi-hop derivation names every link, not only the farthest edge", () => {
  const first = lineageId("lg:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  const second = lineageId("lg:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  const middle = { commit, path: "b.ts", subject: blobB };
  const derivation: OccurrenceDerivation = new Map([
    [coordinateKey(otherCommit, "c.ts", treeB), [{
      coordinate: middle,
      lineage: second,
    }]],
    [coordinateKey(commit, "b.ts", blobB), [{
      coordinate: { commit: parent, path: "a.ts", subject: blobA },
      lineage: first,
    }]],
  ]);
  const via = deriveLineage(
    derivation,
    { commit: otherCommit, path: "c.ts", subject: treeB },
    { commit: parent, path: "a.ts", subject: blobA },
  );
  assert.deepEqual([...via].sort(), [first, second].sort());
});
