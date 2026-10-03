import assert from "node:assert/strict";
import { test } from "node:test";

import { hashBlobContent } from "../src/git.ts";
import { projectFactGraph } from "../src/projection.ts";
import {
  createCorrection,
  createRedaction,
  createReverie,
  recordFactId,
  type HashObject,
  type ReverieMetadata,
} from "../src/protocol.ts";

const sha1: HashObject = (bytes) => hashBlobContent(bytes, "sha1");

const metadata: ReverieMetadata = {
  author_email: "reveries@example.com",
  session: "codex:fact-redaction",
  created_at: "2026-09-29T07:00:00Z",
};

test("recordFactId identifies every fact and skips records without one", () => {
  const base = createReverie(
    {
      v: 1,
      driving_event: "A narrative pasted a credential.",
      decision: "Redact the narrative because it must not render.",
      impact: "Normal display skips the target while bytes remain.",
      recurrence_control: "The redaction test fails when the target still renders.",
      alternatives: [],
      sources: [],
      supersedes: [],
    },
    metadata,
    sha1,
  );
  const fix = createCorrection(
    {
      v: 1,
      driving_event: "A narrative pasted a credential.",
      decision: "Correct the narrative because it must not render.",
      impact: "The fork stays visible until resolved.",
      recurrence_control: "The redaction test fails when the target still renders.",
      alternatives: [],
      sources: [],
      supersedes: [base.id],
    },
    metadata,
    sha1,
  );
  const hide = createRedaction(
    { v: 1, target: base.id, reason: "The narrative pasted a credential that must not render." },
    metadata,
    sha1,
  );
  assert.equal(recordFactId(base), base.id);
  assert.equal(recordFactId(fix), fix.id);
  assert.equal(recordFactId(hide), hide.id);
  assert.equal(
    recordFactId({
      v: 1,
      type: "session-summary",
      author_email: "reveries@example.com",
      session: null,
      created_at: "2026-09-29T07:00:00Z",
      entries: [{
        driving_event: "A summary cannot be redacted by ID.",
        decision: "Summaries carry no fact ID.",
        impact: "recordFactId returns null.",
        recurrence_control: null,
        alternatives: [],
        sources: [],
        reveries: [],
        retirements: [],
      }],
    }),
    null,
  );
});

test("a redaction marks its target while the record stays inspectable", () => {
  const base = createReverie(
    {
      v: 1,
      driving_event: "A narrative pasted a credential.",
      decision: "Redact the narrative because it must not render.",
      impact: "Normal display skips the target while bytes remain.",
      recurrence_control: "The redaction test fails when the target still renders.",
      alternatives: [],
      sources: [],
      supersedes: [],
    },
    metadata,
    sha1,
  );
  const hide = createRedaction(
    { v: 1, target: base.id, reason: "The narrative pasted a credential that must not render." },
    metadata,
    sha1,
  );
  const graph = projectFactGraph([base, hide]);
  assert.deepEqual(graph.redacted, [base.id]);
  assert.ok(graph.active.some((record) => recordFactId(record) === base.id));
});

test("redacting an unknown target is a harmless no-op filter", () => {
  const missing = "rv:ffffffffffffffffffffffffffffffffffffffff";
  const hide = createRedaction(
    { v: 1, target: missing as never, reason: "Suppress a fact that never arrived." },
    metadata,
    sha1,
  );
  const graph = projectFactGraph([hide]);
  assert.deepEqual(graph.redacted, [missing]);
  assert.deepEqual(graph.forks, []);
  assert.deepEqual(graph.cycles, []);
});

test("repeated redactions of one target stay idempotent", () => {
  const base = createReverie(
    {
      v: 1,
      driving_event: "A narrative pasted a credential.",
      decision: "Redact the narrative because it must not render.",
      impact: "Normal display skips the target while bytes remain.",
      recurrence_control: "The redaction test fails when the target still renders.",
      alternatives: [],
      sources: [],
      supersedes: [],
    },
    metadata,
    sha1,
  );
  const first = createRedaction(
    { v: 1, target: base.id, reason: "The narrative pasted a credential that must not render." },
    metadata,
    sha1,
  );
  const graph = projectFactGraph([base, first, first]);
  assert.deepEqual(graph.redacted, [base.id]);
  assert.deepEqual(graph.duplicates, [first.id]);
});
