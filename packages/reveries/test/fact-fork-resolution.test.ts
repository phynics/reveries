import assert from "node:assert/strict";
import { test } from "node:test";

import { hashBlobContent } from "../src/git.ts";
import {
  factGraphDiagnostics,
  projectFactGraph,
  projectTransitionAttestation,
} from "../src/projection.ts";
import {
  createCorrection,
  createResolution,
  createReverie,
  createTransition,
  commitId,
  recordFactId,
  unionFacts,
  type CorrectionInput,
  type CorrectionRecord,
  type HashObject,
  type NoteRecord,
  type ResolutionRecord,
  type ReverieMetadata,
  type ReverieRecord,
} from "../src/protocol.ts";

const sha1: HashObject = (bytes) => hashBlobContent(bytes, "sha1");

const metadata: ReverieMetadata = {
  author_email: "reveries@example.com",
  session: "codex:fact-fork",
  created_at: "2026-09-29T07:00:00Z",
};

function reverie(decision: string): ReverieRecord {
  return createReverie(
    {
      v: 1,
      driving_event: "Two replicas recorded concurrent corrections.",
      decision,
      impact: "The projection must show the fork until a resolution names every head.",
      recurrence_control: "The fork test fails when concurrent corrections converge silently.",
      alternatives: [],
      sources: [],
      supersedes: [],
    },
    metadata,
    sha1,
  );
}

function correction(heads: CorrectionInput["supersedes"], decision: string): CorrectionRecord {
  return createCorrection(
    {
      v: 1,
      driving_event: "Two replicas recorded concurrent corrections.",
      decision,
      impact: "The projection must show the fork until a resolution names every head.",
      recurrence_control: "The fork test fails when concurrent corrections converge silently.",
      alternatives: [],
      sources: [],
      supersedes: [...heads],
    },
    metadata,
    sha1,
  );
}

function resolution(heads: ResolutionRecord["resolves"], decision: string): ResolutionRecord {
  return createResolution(
    {
      v: 1,
      driving_event: "Two replicas recorded concurrent corrections.",
      decision,
      impact: "Naming every head converges the fork to one active result.",
      recurrence_control: "The resolution test fails when a partial resolution converges.",
      alternatives: [],
      sources: [],
      resolves: [...heads],
    },
    metadata,
    sha1,
  );
}

function activeIds(graph: { active: NoteRecord[] }): string[] {
  return graph.active
    .map((record) => recordFactId(record))
    .filter((id): id is string => id !== null)
    .sort();
}

test("concurrent corrections produce one deterministic visible fork", () => {
  const base = reverie("Use the guarded boundary because it owns the transition.");
  const left = correction([base.id], "Use the left owner because it guards writes.");
  const right = correction([base.id], "Use the right owner because it guards reads.");
  const graph = projectFactGraph(unionFacts([base, left], [right]));
  assert.deepEqual(activeIds(graph), [left.id, right.id].sort());
  assert.equal(graph.forks.length, 1);
  const [predecessor, ...terminals] = graph.forks[0] as string[];
  assert.equal(predecessor, base.id);
  assert.deepEqual(terminals, [left.id, right.id].sort());
  assert.equal(graph.cycles.length, 0);
  assert.ok(factGraphDiagnostics(graph).some((diagnostic) => /supersession fork/.test(diagnostic)));
});

test("a partial resolution naming one of two heads leaves the fork visible", () => {
  const base = reverie("Use the guarded boundary because it owns the transition.");
  const left = correction([base.id], "Use the left owner because it guards writes.");
  const right = correction([base.id], "Use the right owner because it guards reads.");
  const partial = resolution([left.id], "Converge on the left owner alone.");
  const graph = projectFactGraph([base, left, right, partial]);
  assert.equal(graph.forks.length, 1);
  assert.ok(activeIds(graph).includes(right.id));
  assert.ok(activeIds(graph).includes(partial.id));
  assert.ok(!activeIds(graph).includes(left.id));
});

test("a resolution naming both heads produces one active result", () => {
  const base = reverie("Use the guarded boundary because it owns the transition.");
  const left = correction([base.id], "Use the left owner because it guards writes.");
  const right = correction([base.id], "Use the right owner because it guards reads.");
  const resolve = resolution([left.id, right.id], "Converge on the guarded boundary.");
  const graph = projectFactGraph([base, left, right, resolve]);
  assert.equal(graph.forks.length, 0);
  assert.deepEqual(activeIds(graph), [resolve.id]);
  assert.deepEqual(factGraphDiagnostics(graph), []);
});

test("a three-way fork needs every head named before it converges", () => {
  const base = reverie("Use the guarded boundary because it owns the transition.");
  const heads = ["writes", "reads", "migrations"].map((scope) =>
    correction([base.id], `Use the ${scope} owner because it guards ${scope}.`),
  );
  const partial = resolution(
    heads.slice(0, 2).map((head) => head.id),
    "Converge on two of three owners.",
  );
  assert.equal(projectFactGraph([base, ...heads, partial]).forks.length, 1);
  const full = resolution(
    heads.map((head) => head.id),
    "Converge on every owner.",
  );
  const converged = projectFactGraph([base, ...heads, full]);
  assert.equal(converged.forks.length, 0);
  assert.deepEqual(activeIds(converged), [full.id]);
});

test("a resolution naming only the fork root does not converge the terminals", () => {
  const base = reverie("Use the guarded boundary because it owns the transition.");
  const left = correction([base.id], "Use the left owner because it guards writes.");
  const right = correction([base.id], "Use the right owner because it guards reads.");
  const rootOnly = resolution([base.id], "Restate the root without naming the terminals.");
  const graph = projectFactGraph([base, left, right, rootOnly]);
  assert.equal(graph.forks.length, 1);
  assert.ok(activeIds(graph).includes(left.id));
  assert.ok(activeIds(graph).includes(right.id));
});

test("duplicate identical attestations collapse in the union; competing ones stay ambiguous", () => {
  const parent = "a".repeat(40) as import("../src/protocol.ts").ObjectId;
  const otherParent = "d".repeat(40) as import("../src/protocol.ts").ObjectId;
  const result = "b".repeat(40) as import("../src/protocol.ts").ObjectId;
  const commit = commitId("c".repeat(40));
  const causal = {
    driving_event: "The merge queue creates final commit IDs after review.",
    decision: "Anchor causality to tree transitions because commit IDs change during publication.",
    impact: "Evidence stays stable across amends and squash merges.",
    recurrence_control: "Transition fixtures fail when the identity changes unexpectedly.",
    alternatives: [] as string[],
    sources: [],
    reveries: [],
    retirements: [],
  };
  const first = createTransition(
    { ...causal, parents: [parent], result },
    metadata,
    sha1,
  );
  const second = createTransition(
    { ...causal, parents: [otherParent], result },
    metadata,
    sha1,
  );
  const attestationFor = (transition: typeof first) => ({
    v: 1 as const,
    type: "publication-attestation" as const,
    author_email: "reveries@example.com",
    session: null as string | null,
    created_at: "2026-09-29T07:00:00Z",
    commit,
    transition: transition.id,
    publisher: "reveries@example.com",
  });
  const attestation = attestationFor(first);
  assert.equal(unionFacts([attestation], [attestation]).length, 1);
  const ambiguous = projectTransitionAttestation({
    commit,
    parents: [parent],
    result,
    attestations: [attestation, attestationFor(second)],
    transitions: [first, second],
  });
  assert.equal(ambiguous.transition, null);
  assert.match(ambiguous.diagnostics.join("; "), /more than one transition/);
});
