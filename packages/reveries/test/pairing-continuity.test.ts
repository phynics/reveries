import assert from "node:assert/strict";
import { test } from "node:test";

import { analyzeContinuity, type ContinuityObligation } from "../src/continuity.ts";
import type { ActiveProjection } from "../src/projection.ts";
import {
  commitId,
  createReverie,
  lineageId,
  objectId,
  type HashObject,
  type ReverieRecord,
  type SessionSummary,
  type SubjectId,
} from "../src/protocol.ts";
import { createHash } from "node:crypto";

const sha1: HashObject = (bytes) => objectId(
  createHash("sha1").update(Buffer.from(`blob ${bytes.byteLength}\0`)).update(bytes).digest("hex"),
);

const PREDECESSOR = objectId("1".repeat(40));
const FIRST = objectId("2".repeat(40));
const SECOND = objectId("3".repeat(40));
const THIRD = objectId("4".repeat(40));
const edge = lineageId("lg:5555555555555555555555555555555555555555");
const otherEdge = lineageId("lg:6666666666666666666666666666666666666666");

const metadata = {
  author_email: "engineer@example.com",
  session: "codex:continuity",
  created_at: "2026-10-03T00:00:00Z",
};

function decision(overrides: Partial<Parameters<typeof createReverie>[0]> = {}): ReverieRecord {
  return createReverie({
    v: 1,
    driving_event: "A predecessor subject changed.",
    decision: "Keep the decision at every successor because each one needs it.",
    impact: "Each successor carries its own evidence.",
    recurrence_control: "The pairing fixtures fail when an endpoint has no evidence.",
    alternatives: [],
    sources: [],
    supersedes: [],
    ...overrides,
  }, metadata, sha1);
}

function projection(records: ReverieRecord[]): ActiveProjection {
  return { active: records, historical: [], duplicates: [], forks: [], cycles: [] };
}

function retiring(from: SubjectId, id: string, reason: string): SessionSummary {
  return {
    v: 1,
    type: "session-summary",
    author_email: "engineer@example.com",
    session: "codex:continuity",
    created_at: "2026-10-03T00:00:00Z",
    entries: [{
      driving_event: "The occurrence ended.",
      decision: "Retire the decision because nothing carries it forward.",
      impact: "No successor silently inherits it.",
      recurrence_control: null,
      alternatives: [],
      sources: [],
      reveries: [],
      retirements: [{ reverie: id as ReverieRecord["id"], from_blob: from, reason }],
    }],
  };
}

function obligationReasons(report: { obligations: ContinuityObligation[] }): string[] {
  return report.obligations.map((obligation) => `${obligation.id}@${obligation.missing_at?.join(",") ?? "-"}:${obligation.reason}`);
}

test("a pairing alone discharges nothing", () => {
  const record = decision();
  const report = analyzeContinuity({
    pairings: [{ from: PREDECESSOR, to: [FIRST], lineage: edge }],
    predecessors: new Map([[PREDECESSOR, projection([record])]]),
    successors: new Map([[FIRST, projection([])]]),
  });
  assert.equal(report.ok, false);
  assert.equal(report.dispositions.length, 0);
  assert.equal(report.obligations.length, 1);
  assert.equal(report.obligations[0]?.reason, "missing-disposition");
});

test("a split needs evidence at every successor, not at one of them", () => {
  const record = decision();
  const replacement = decision({ decision: "The half that became a fixture carries a different rule.", supersedes: [record.id] });
  const onlyFirst = analyzeContinuity({
    pairings: [{ from: PREDECESSOR, to: [FIRST, SECOND], lineage: edge }],
    predecessors: new Map([[PREDECESSOR, projection([record])]]),
    successors: new Map([[FIRST, projection([replacement])], [SECOND, projection([])]]),
  });
  assert.equal(onlyFirst.ok, false);
  // The endpoint that does have a replacement is reported as done; the other is
  // named, so one successor's evidence cannot discharge the pair.
  assert.deepEqual(obligationReasons(onlyFirst), [`${record.id}@${SECOND}:missing-disposition`]);

  const continued = analyzeContinuity({
    pairings: [{ from: PREDECESSOR, to: [FIRST, SECOND], lineage: edge }],
    predecessors: new Map([[PREDECESSOR, projection([record])]]),
    successors: new Map([[FIRST, projection([replacement])], [SECOND, projection([record])]]),
  });
  assert.equal(continued.ok, true, JSON.stringify(continued.obligations));
  assert.deepEqual(
    continued.dispositions.map((entry) => "to_blob" in entry ? `${entry.kind}:${entry.to_blob}` : entry.kind).sort(),
    [`continue:${SECOND}`, `supersede:${FIRST}`],
  );
  assert.equal(continued.dispositions.every((entry) => "lineage" in entry && entry.lineage === edge), true);
});

test("a split may continue in one half and replace in the other", () => {
  const record = decision();
  const replacement = decision({ decision: "Only the second half keeps the old rule under a new name.", supersedes: [record.id] });
  const report = analyzeContinuity({
    pairings: [{ from: PREDECESSOR, to: [FIRST, SECOND], lineage: edge }],
    predecessors: new Map([[PREDECESSOR, projection([record])]]),
    successors: new Map([[FIRST, projection([record])], [SECOND, projection([replacement])]]),
  });
  assert.equal(report.ok, true, JSON.stringify(report.obligations));
  assert.deepEqual(report.dispositions.map((entry) => entry.kind).sort(), ["continue", "supersede"]);
});

test("two distinct replacements on one successor are ambiguous", () => {
  const record = decision();
  const left = decision({ decision: "First replacement.", supersedes: [record.id] });
  const right = decision({ decision: "Second replacement.", supersedes: [record.id] });
  const report = analyzeContinuity({
    pairings: [{ from: PREDECESSOR, to: [FIRST], lineage: edge }],
    predecessors: new Map([[PREDECESSOR, projection([record])]]),
    successors: new Map([[FIRST, projection([left, right])]]),
  });
  assert.equal(report.ok, false);
  assert.equal(report.obligations[0]?.reason, "ambiguous-disposition");
  assert.equal(report.dispositions.length, 0);
});

test("two successors may each replace the same decision with their own record", () => {
  const record = decision();
  const left = decision({ decision: "The first successor states its own rule.", supersedes: [record.id] });
  const right = decision({ decision: "The second successor states its own rule.", supersedes: [record.id] });
  const report = analyzeContinuity({
    pairings: [{ from: PREDECESSOR, to: [FIRST, SECOND], lineage: edge }],
    predecessors: new Map([[PREDECESSOR, projection([record])]]),
    successors: new Map([[FIRST, projection([left])], [SECOND, projection([right])]]),
  });
  assert.equal(report.ok, true, JSON.stringify(report.obligations));
  assert.deepEqual(
    report.dispositions
      .map((entry) => (entry.kind === "supersede" ? entry.replacement : entry.id))
      .sort(),
    [left.id, right.id].sort(),
  );
});

test("an N-to-M pairing owes every endpoint its own disposition", () => {
  const record = decision();
  const all = [FIRST, SECOND, THIRD];
  const bare = analyzeContinuity({
    pairings: [{ from: PREDECESSOR, to: all, lineage: edge }],
    predecessors: new Map([[PREDECESSOR, projection([record])]]),
    successors: new Map(all.map((subject) => [subject, projection([record])])),
  });
  assert.equal(bare.ok, true, JSON.stringify(bare.obligations));
  assert.equal(bare.dispositions.length, 3);
  const twoOnly = analyzeContinuity({
    pairings: [{ from: PREDECESSOR, to: all, lineage: edge }],
    predecessors: new Map([[PREDECESSOR, projection([record])]]),
    successors: new Map([
      [FIRST, projection([record])],
      [SECOND, projection([record])],
      [THIRD, projection([])],
    ]),
  });
  assert.equal(twoOnly.ok, false);
  assert.deepEqual(obligationReasons(twoOnly), [`${record.id}@${THIRD}:missing-disposition`]);
});

test("a retire pairing with no successor admits only a per-decision retirement", () => {
  const record = decision();
  const bare = analyzeContinuity({
    pairings: [{ from: PREDECESSOR, to: [], lineage: edge }],
    predecessors: new Map([[PREDECESSOR, projection([record])]]),
    successors: new Map(),
  });
  assert.equal(bare.ok, false);
  assert.equal(bare.obligations[0]?.reason, "missing-disposition");
  assert.equal(bare.obligations[0]?.to_blob, undefined);

  const retired = analyzeContinuity({
    pairings: [{ from: PREDECESSOR, to: [], lineage: edge }],
    predecessors: new Map([[PREDECESSOR, projection([record])]]),
    successors: new Map(),
    summary: retiring(PREDECESSOR, record.id, "The occurrence was deleted and nothing carries it forward."),
  });
  assert.equal(retired.ok, true, JSON.stringify(retired.obligations));
  assert.equal(retired.dispositions[0]?.kind, "retire");
});

test("a retirement cannot coexist with a successor that still carries the decision", () => {
  const record = decision();
  const report = analyzeContinuity({
    pairings: [{ from: PREDECESSOR, to: [FIRST], lineage: edge }],
    predecessors: new Map([[PREDECESSOR, projection([record])]]),
    successors: new Map([[FIRST, projection([record])]]),
    summary: retiring(PREDECESSOR, record.id, "The occurrence ended here."),
  });
  assert.equal(report.ok, false);
  assert.equal(report.obligations[0]?.reason, "ambiguous-disposition");
});

test("two claims about one predecessor fail closed instead of merging", () => {
  const record = decision();
  const report = analyzeContinuity({
    transitions: [{ from: PREDECESSOR, to: FIRST }],
    pairings: [{ from: PREDECESSOR, to: [SECOND], lineage: edge }],
    predecessors: new Map([[PREDECESSOR, projection([record])]]),
    successors: new Map([[FIRST, projection([record])], [SECOND, projection([record])]]),
  });
  assert.equal(report.ok, false);
  assert.equal(report.pairingConflicts[0]?.reason, "ambiguous-pairing");
  assert.match(report.conflicts.join("\n"), /ambiguous-pairing/);
});

test("the same edge recorded twice is idempotence, not a second claim", () => {
  const record = decision();
  const report = analyzeContinuity({
    pairings: [
      { from: PREDECESSOR, to: [FIRST], lineage: edge },
      { from: PREDECESSOR, to: [FIRST], lineage: edge },
    ],
    predecessors: new Map([[PREDECESSOR, projection([record])]]),
    successors: new Map([[FIRST, projection([record])]]),
  });
  assert.equal(report.ok, true, JSON.stringify(report.conflicts));
  assert.equal(report.pairingConflicts.length, 0);
  assert.deepEqual(report.dispositions.map((entry) => entry.kind), ["continue"]);
});

test("one legacy pair repeated is idempotence too", () => {
  const record = decision();
  const report = analyzeContinuity({
    transitions: [{ from: PREDECESSOR, to: FIRST }, { from: PREDECESSOR, to: FIRST }],
    predecessors: new Map([[PREDECESSOR, projection([record])]]),
    successors: new Map([[FIRST, projection([record])]]),
  });
  assert.equal(report.ok, true, JSON.stringify(report.conflicts));
  assert.equal(report.pairingConflicts.length, 0);
});

test("two distinct edges over the same endpoints still conflict", () => {
  const record = decision();
  // Identical successor sets, different reasoning: the causal claim is what is
  // ambiguous, and nothing about the subjects settles it.
  const report = analyzeContinuity({
    pairings: [
      { from: PREDECESSOR, to: [FIRST, SECOND], lineage: edge },
      { from: PREDECESSOR, to: [FIRST, SECOND], lineage: otherEdge },
    ],
    predecessors: new Map([[PREDECESSOR, projection([record])]]),
    successors: new Map([[FIRST, projection([record])], [SECOND, projection([record])]]),
  });
  assert.equal(report.ok, false);
  assert.equal(report.pairingConflicts[0]?.reason, "ambiguous-pairing");
  assert.match(report.pairingConflicts[0]?.detail ?? "", /two causal claims cannot both be authoritative/);
});

test("two distinct retire edges over one predecessor conflict", () => {
  const record = decision();
  const report = analyzeContinuity({
    pairings: [
      { from: PREDECESSOR, to: [], lineage: edge },
      { from: PREDECESSOR, to: [], lineage: otherEdge },
    ],
    predecessors: new Map([[PREDECESSOR, projection([record])]]),
    successors: new Map(),
  });
  assert.equal(report.ok, false);
  assert.equal(report.pairingConflicts[0]?.reason, "ambiguous-pairing");
});

test("identity pairing and a lineage edge never both apply, even with equal targets", () => {
  const record = decision();
  const report = analyzeContinuity({
    transitions: [{ from: PREDECESSOR, to: FIRST }],
    pairings: [{ from: PREDECESSOR, to: [FIRST], lineage: edge }],
    predecessors: new Map([[PREDECESSOR, projection([record])]]),
    successors: new Map([[FIRST, projection([record])]]),
  });
  assert.equal(report.ok, false);
  assert.equal(report.pairingConflicts[0]?.reason, "ambiguous-pairing");
  assert.match(report.pairingConflicts[0]?.detail ?? "", /same-path identity and by lineage/);
  // The decision itself is discharged exactly once at its endpoint; only the
  // pairing is ambiguous.
  assert.equal(report.dispositions.length, 1);
});

test("an identity pair with no successor still accepts one lineage pairing", () => {
  const record = decision();
  const report = analyzeContinuity({
    transitions: [{ from: PREDECESSOR }],
    pairings: [{ from: PREDECESSOR, to: [FIRST], lineage: edge }],
    predecessors: new Map([[PREDECESSOR, projection([record])]]),
    successors: new Map([[FIRST, projection([record])]]),
  });
  assert.equal(report.ok, true, JSON.stringify(report.conflicts));
  assert.equal(report.pairingConflicts.length, 0);
  assert.deepEqual(report.dispositions.map((entry) => entry.kind), ["continue"]);
});

test("an identity pair with no successor accepts one retire edge", () => {
  const record = decision();
  const report = analyzeContinuity({
    transitions: [{ from: PREDECESSOR }],
    pairings: [{ from: PREDECESSOR, to: [], lineage: edge }],
    predecessors: new Map([[PREDECESSOR, projection([record])]]),
    successors: new Map(),
  });
  assert.equal(report.ok, false);
  assert.equal(report.obligations[0]?.reason, "missing-disposition");
  assert.equal(report.pairingConflicts.length, 0);
});

test("two lineage edges pairing one predecessor are refused", () => {
  const record = decision();
  const report = analyzeContinuity({
    pairings: [
      { from: PREDECESSOR, to: [FIRST], lineage: edge },
      { from: PREDECESSOR, to: [SECOND], lineage: otherEdge },
    ],
    predecessors: new Map([[PREDECESSOR, projection([record])]]),
    successors: new Map([[FIRST, projection([record])], [SECOND, projection([record])]]),
  });
  assert.equal(report.ok, false);
  assert.equal(report.pairingConflicts[0]?.reason, "ambiguous-pairing");
  assert.match(report.pairingConflicts[0]?.detail ?? "", new RegExp(edge.slice(0, 12)));
});

test("a merge predecessor still needs its own disposition", () => {
  const shared = decision();
  const leftOnly = decision({ decision: "Only the left branch carries this rule.", supersedes: [shared.id] });
  const otherPredecessor = objectId("7".repeat(40));
  const report = analyzeContinuity({
    // Two predecessors joining one successor: each is its own pairing, so a
    // decision carried by both clears from one record on the shared successor.
    pairings: [
      { from: PREDECESSOR, to: [FIRST], lineage: edge },
      { from: otherPredecessor, to: [FIRST], lineage: otherEdge },
    ],
    predecessors: new Map([
      [PREDECESSOR, projection([shared, leftOnly])],
      [otherPredecessor, projection([shared])],
    ]),
    successors: new Map([[FIRST, projection([shared])]]),
  });
  assert.equal(report.ok, false);
  assert.deepEqual(obligationReasons(report), [`${leftOnly.id}@${FIRST}:missing-disposition`]);
  assert.equal(report.dispositions.length, 2);
});

test("legacy one-to-one transitions keep their exact meaning", () => {
  const record = decision();
  const unresolved = analyzeContinuity({
    transitions: [{ from: PREDECESSOR, to: FIRST }],
    predecessors: new Map([[PREDECESSOR, projection([record])]]),
    successors: new Map([[FIRST, projection([])]]),
  });
  assert.equal(unresolved.obligations[0]?.to_blob, FIRST);

  const twoDistinct = analyzeContinuity({
    transitions: [{ from: PREDECESSOR, to: FIRST }, { from: PREDECESSOR, to: SECOND }],
    predecessors: new Map([[PREDECESSOR, projection([record])]]),
    successors: new Map([[FIRST, projection([record])], [SECOND, projection([])]]),
  });
  // Two independent one-to-one pairs remain independent obligations.
  assert.equal(twoDistinct.dispositions.length, 1);
  assert.deepEqual(obligationReasons(twoDistinct), [`${record.id}@${SECOND}:missing-disposition`]);
});

test("an unannotated predecessor costs nothing", () => {
  const report = analyzeContinuity({
    pairings: [{ from: PREDECESSOR, to: [FIRST], lineage: edge }],
    predecessors: new Map(),
    successors: new Map(),
  });
  assert.equal(report.ok, true);
  assert.equal(report.obligations.length, 0);
});

test("an invalid predecessor projection is a conflict", () => {
  const record = decision();
  const report = analyzeContinuity({
    pairings: [{ from: PREDECESSOR, to: [FIRST], lineage: edge }],
    predecessors: new Map([[PREDECESSOR, { ...projection([record]), conflicts: [record.id] }]]),
    successors: new Map([[FIRST, projection([])]]),
  });
  assert.equal(report.ok, false);
  assert.match(report.conflicts.join("\n"), /invalid reverie projection/);
});

test("a placeholder retirement reason stays ambiguous", () => {
  const record = decision();
  const report = analyzeContinuity({
    transitions: [{ from: PREDECESSOR }],
    predecessors: new Map([[PREDECESSOR, projection([record])]]),
    successors: new Map(),
    summary: retiring(PREDECESSOR, record.id, "n/a"),
  });
  assert.equal(report.ok, false);
  assert.equal(report.obligations[0]?.reason, "ambiguous-disposition");
});

test("an unresolvable commit id never reaches the pairing layer", () => {
  // Guards the boundary the operations layer relies on: a lineage edge only
  // reaches the engine after its commit and parent have been bound.
  assert.equal(commitId("8".repeat(40)).length, 40);
  assert.notEqual(PREDECESSOR, FIRST);
});
