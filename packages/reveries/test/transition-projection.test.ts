import assert from "node:assert/strict";
import { test } from "node:test";

import { hashBlobContent } from "../src/git.ts";
import {
  projectTransitionAttestation,
} from "../src/projection.ts";
import {
  commitId,
  createTransition,
  type HashObject,
  type ObjectId,
  type PublicationAttestation,
  type TransitionSummary,
} from "../src/protocol.ts";

const sha1: HashObject = (bytes) => hashBlobContent(bytes, "sha1");

const PARENT = "a".repeat(40) as ObjectId;
const RESULT = "b".repeat(40) as ObjectId;
const COMMIT = commitId("c".repeat(40));

function transition(): TransitionSummary {
  return createTransition(
    {
      parents: [PARENT],
      result: RESULT,
      driving_event: "The merge queue creates final commit IDs after review.",
      decision: "Anchor causality to tree transitions because commit IDs change during publication.",
      impact: "Evidence stays stable across amends and squash merges.",
      recurrence_control: "Transition fixtures fail when the identity changes unexpectedly.",
      alternatives: [],
      sources: [],
      reveries: [],
      retirements: [],
    },
    { author_email: "reveries@example.com", session: null, created_at: "2026-09-29T07:00:00Z" },
    sha1,
  );
}

function attestation(transition: TransitionSummary): PublicationAttestation {
  return {
    v: 1,
    type: "publication-attestation",
    author_email: "reveries@example.com",
    session: null,
    created_at: "2026-09-29T07:00:00Z",
    commit: COMMIT,
    transition: transition.id,
    publisher: "reveries@example.com",
  };
}

test("an exact attestation resolves its transition", () => {
  const record = transition();
  const projection = projectTransitionAttestation({
    commit: COMMIT,
    parents: [PARENT],
    result: RESULT,
    attestations: [attestation(record)],
    transitions: [record],
  });
  assert.equal(projection.transition?.id, record.id);
  assert.deepEqual(projection.diagnostics, []);
});

test("a missing attestation is reported, not resolved", () => {
  const record = transition();
  const projection = projectTransitionAttestation({
    commit: COMMIT,
    parents: [PARENT],
    result: RESULT,
    attestations: [],
    transitions: [record],
  });
  assert.equal(projection.transition, null);
  assert.match(projection.diagnostics.join("; "), /no publication attestation/);
});

test("an attestation without a stored transition record fails closed", () => {
  const record = transition();
  const projection = projectTransitionAttestation({
    commit: COMMIT,
    parents: [PARENT],
    result: RESULT,
    attestations: [attestation(record)],
    transitions: [],
  });
  assert.equal(projection.transition, null);
  assert.match(projection.diagnostics.join("; "), /has no transition record/);
});

test("an attestation naming a different tree pair fails closed", () => {
  const record = transition();
  const projection = projectTransitionAttestation({
    commit: COMMIT,
    parents: [RESULT],
    result: PARENT,
    attestations: [attestation(record)],
    transitions: [record],
  });
  assert.equal(projection.transition, null);
  assert.match(projection.diagnostics.join("; "), /does not match/);
});

test("competing attestations for one commit are ambiguous", () => {
  const first = transition();
  const second = createTransition(
    {
      parents: [],
      result: RESULT,
      driving_event: "A root commit carries its own history.",
      decision: "Record the root transition because adoption starts here.",
      impact: "Later transitions can name this root as their base.",
      recurrence_control: "The root fixture fails when parents are not empty.",
      alternatives: [],
      sources: [],
      reveries: [],
      retirements: [],
    },
    { author_email: "reveries@example.com", session: null, created_at: "2026-09-29T07:00:00Z" },
    sha1,
  );
  const projection = projectTransitionAttestation({
    commit: COMMIT,
    parents: [PARENT],
    result: RESULT,
    attestations: [attestation(first), attestation(second)],
    transitions: [first, second],
  });
  assert.equal(projection.transition, null);
  assert.match(projection.diagnostics.join("; "), /more than one transition/);
});
