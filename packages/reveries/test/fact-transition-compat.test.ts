import assert from "node:assert/strict";
import { test } from "node:test";

import { hashBlobContent } from "../src/git.ts";
import {
  factGraphDiagnostics,
  projectFactGraph,
  projectTransitionAttestation,
} from "../src/projection.ts";
import {
  createReverie,
  createTransition,
  commitId,
  transitionPayload,
  unionFacts,
  validateNote,
  type HashObject,
  type ObjectId,
  type ReverieMetadata,
  type ReverieRecord,
  type SessionSummary,
  type TransitionCausal,
  type TransitionMetadata,
} from "../src/protocol.ts";

const sha1: HashObject = (bytes) => hashBlobContent(bytes, "sha1");

const PARENT = "a".repeat(40) as ObjectId;
const OTHER_PARENT = "d".repeat(40) as ObjectId;
const RESULT = "b".repeat(40) as ObjectId;
const COMMIT = commitId("c".repeat(40));

const metadata = {
  author_email: "reveries@example.com",
  session: "codex:fact-compat",
  created_at: "2026-09-29T07:00:00Z",
} satisfies TransitionMetadata & ReverieMetadata;

const causal: TransitionCausal = {
  driving_event: "The merge queue creates final commit IDs after review.",
  decision: "Anchor causality to tree transitions because commit IDs change during publication.",
  impact: "Evidence stays stable across amends and squash merges.",
  recurrence_control: "Transition fixtures fail when the identity changes unexpectedly.",
  alternatives: ["Anchor evidence to commit IDs"],
  sources: [],
  reveries: [],
  retirements: [],
};

function transition(overrides: Partial<typeof causal> = {}, parents: ObjectId[] = [PARENT]) {
  return createTransition({ ...causal, parents, result: RESULT }, metadata, sha1);
}

function attestationFor(transitionId: string) {
  return {
    v: 1 as const,
    type: "publication-attestation" as const,
    author_email: "reveries@example.com",
    session: null as string | null,
    created_at: "2026-09-29T07:00:00Z",
    commit: COMMIT,
    transition: transitionId as never,
    publisher: "reveries@example.com",
  };
}

test("RVR-004 transitionPayload key order and hashed bytes are unchanged", () => {
  const record = transition();
  const parsed = JSON.parse(transitionPayload(record)) as Record<string, unknown>;
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
  assert.equal(`tr:${sha1(Buffer.from(`${transitionPayload(record)}\n`, "utf8"))}`, record.id);
});

test("RVR-004 transition identity stays metadata-free and order-sensitive", () => {
  const base = transition();
  const reauthored = createTransition({ ...causal, parents: [PARENT], result: RESULT }, {
    author_email: "other@example.com",
    session: null,
    created_at: "2030-01-01T00:00:00Z",
  }, sha1);
  assert.equal(base.id, reauthored.id);
  const swapped = transition({}, [OTHER_PARENT, PARENT]);
  assert.notEqual(base.id, swapped.id);
  const root = transition({}, []);
  assert.deepEqual([...root.parents], []);
  assert.notEqual(base.id, root.id);
});

test("projectTransitionAttestation still fails closed exactly as RVR-004 defined", () => {
  const record = transition();
  const exact = projectTransitionAttestation({
    commit: COMMIT,
    parents: [PARENT],
    result: RESULT,
    attestations: [attestationFor(record.id)],
    transitions: [record],
  });
  assert.equal(exact.transition?.id, record.id);
  assert.deepEqual(exact.diagnostics, []);

  const missingAttestation = projectTransitionAttestation({
    commit: COMMIT,
    parents: [PARENT],
    result: RESULT,
    attestations: [],
    transitions: [record],
  });
  assert.equal(missingAttestation.transition, null);
  assert.match(missingAttestation.diagnostics.join("; "), /no publication attestation/);

  const missingRecord = projectTransitionAttestation({
    commit: COMMIT,
    parents: [PARENT],
    result: RESULT,
    attestations: [attestationFor(record.id)],
    transitions: [],
  });
  assert.equal(missingRecord.transition, null);
  assert.match(missingRecord.diagnostics.join("; "), /has no transition record/);

  const wrongTrees = projectTransitionAttestation({
    commit: COMMIT,
    parents: [RESULT],
    result: PARENT,
    attestations: [attestationFor(record.id)],
    transitions: [record],
  });
  assert.equal(wrongTrees.transition, null);
  assert.match(wrongTrees.diagnostics.join("; "), /does not match/);
});

test("V1 session summaries stay readable and never report a fact-graph fork", () => {
  const summary: SessionSummary = {
    v: 1,
    type: "session-summary",
    author_email: "reveries@example.com",
    session: "codex:fact-compat",
    created_at: "2026-09-29T07:00:00Z",
    entries: [{
      driving_event: "The pull request changed the transition boundary.",
      decision: "Record the transition because reviewers need its causal account.",
      impact: "Reviewers read the change beside its causal account.",
      recurrence_control: "The publication check requires one summary per descendant commit.",
      alternatives: [],
      sources: [],
      reveries: [],
      retirements: [],
    }],
  };
  const graph = projectFactGraph([summary]);
  assert.equal(graph.summaryFork, false);
  assert.deepEqual(graph.active, []);
  assert.deepEqual(graph.redacted, []);
  assert.deepEqual(factGraphDiagnostics(graph), []);
  assert.equal(validateNote([summary], { verifyIds: false }).length, 1);
});

test("V1 reverie supersession projects identically through the fact graph", () => {
  const base: ReverieRecord = createReverie({
    v: 1,
    driving_event: "A defect exposed two transition owners.",
    decision: "Use one guarded boundary because it owns transition validity.",
    impact: "All writers must use the guarded boundary.",
    recurrence_control: "A concurrency test rejects stale predecessors.",
    alternatives: [],
    sources: [],
    supersedes: [],
  }, metadata, sha1);
  const next = createReverie({
    v: 1,
    driving_event: "A defect exposed two transition owners.",
    decision: "Use the guarded boundary because it now owns writes.",
    impact: "All writers use the guarded boundary.",
    recurrence_control: "A concurrency test rejects stale predecessors.",
    alternatives: [],
    sources: [],
    supersedes: [base.id],
  }, metadata, sha1);

  const graph = projectFactGraph([base, next]);
  assert.deepEqual(graph.active.map((record) => (record as ReverieRecord).id), [next.id]);
  assert.deepEqual(graph.historical.map((record) => (record as ReverieRecord).id), [base.id]);
  assert.deepEqual(graph.forks, []);
  assert.deepEqual(graph.cycles, []);
  // A pure-V1 fork is reported by the existing projection, not the new kinds.
  const fork = createReverie({
    v: 1,
    driving_event: "A defect exposed two transition owners.",
    decision: "Keep the state machine because it owns the legacy contract.",
    impact: "The legacy contract keeps its owner.",
    recurrence_control: "A concurrency test rejects stale predecessors.",
    alternatives: [],
    sources: [],
    supersedes: [base.id],
  }, metadata, sha1);
  const forked = projectFactGraph([base, next, fork]);
  assert.equal(forked.forks.length, 1);
  assert.deepEqual(factGraphDiagnostics(forked), []);
});

test("union over V1 and RVR-004 records is order-independent and lossless", () => {
  const record = transition();
  const reverie = createReverie({
    v: 1,
    driving_event: "A defect exposed two transition owners.",
    decision: "Use one guarded boundary because it owns transition validity.",
    impact: "All writers must use the guarded boundary.",
    recurrence_control: "A concurrency test rejects stale predecessors.",
    alternatives: [],
    sources: [],
    supersedes: [],
  }, metadata, sha1);
  const summary: SessionSummary = {
    v: 1,
    type: "session-summary",
    author_email: "reveries@example.com",
    session: null,
    created_at: "2026-09-29T07:00:00Z",
    entries: [{
      driving_event: "The pull request changed the transition boundary.",
      decision: "Record the transition because reviewers need its causal account.",
      impact: "Reviewers read the change beside its causal account.",
      recurrence_control: null,
      alternatives: [],
      sources: [],
      reveries: [],
      retirements: [],
    }],
  };
  const records = [record, reverie, summary];
  const forward = unionFacts(records);
  assert.deepEqual(unionFacts([summary], [reverie, record]), forward);
  assert.deepEqual(unionFacts([reverie], [summary], [record]), forward);
  assert.deepEqual(unionFacts([record, record, summary, reverie]), forward);
  assert.equal(forward.length, 3);
});
