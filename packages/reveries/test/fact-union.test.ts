import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { hashBlobContent } from "../src/git.ts";
import {
  canonicalRecord,
  createCorrection,
  createRedaction,
  createResolution,
  createReverie,
  parseNote,
  reverieId,
  unionFacts,
  validateNote,
  type CorrectionInput,
  type CorrectionRecord,
  type HashObject,
  type NoteRecord,
  type RedactionRecord,
  type ResolutionRecord,
  type ReverieMetadata,
  type ReverieRecord,
} from "../src/protocol.ts";

const sha1: HashObject = (bytes) => hashBlobContent(bytes, "sha1");

const metadata: ReverieMetadata = {
  author_email: "reveries@example.com",
  session: "codex:fact-union",
  created_at: "2026-09-29T07:00:00Z",
};

function reverie(decision: string): ReverieRecord {
  return createReverie(
    {
      v: 1,
      driving_event: "Two replicas recorded concurrent corrections.",
      decision,
      impact: "The union must hold both corrections as a visible fork.",
      recurrence_control: "The union test fails when merge order changes the fact set.",
      alternatives: [],
      sources: [],
      supersedes: [],
    },
    metadata,
    sha1,
  );
}

function correction(supersedes: CorrectionInput["supersedes"], decision: string): CorrectionRecord {
  return createCorrection(
    {
      v: 1,
      driving_event: "Two replicas recorded concurrent corrections.",
      decision,
      impact: "The union must hold both corrections as a visible fork.",
      recurrence_control: "The union test fails when merge order changes the fact set.",
      alternatives: [],
      sources: [],
      supersedes: [...supersedes],
    },
    metadata,
    sha1,
  );
}

function resolution(
  resolves: ResolutionRecord["resolves"],
  decision: string,
): ResolutionRecord {
  return createResolution(
    {
      v: 1,
      driving_event: "Two replicas recorded concurrent corrections.",
      decision,
      impact: "Naming every head converges the fork to one active result.",
      recurrence_control: "The resolution test fails when a partial resolution converges.",
      alternatives: [],
      sources: [],
      resolves: [...resolves],
    },
    metadata,
    sha1,
  );
}

function redaction(target: RedactionRecord["target"]): RedactionRecord {
  return createRedaction(
    { v: 1, target, reason: "The narrative pasted a credential that must not render." },
    metadata,
    sha1,
  );
}

test("correction derives a stable cr: identity from content, not metadata", () => {
  const base = reverie("Use the guarded boundary because it owns the transition.");
  const first = correction([base.id], "Use the guarded boundary because it owns the transition.");
  const second = correction([base.id], "Use the guarded boundary because it owns the transition.");
  assert.match(first.id, /^cr:[0-9a-f]{40}$/);
  assert.equal(first.id, second.id);
  const otherAuthor = correction([base.id], "Use the guarded boundary because it owns the transition.");
  assert.equal(
    createCorrection(
      {
        v: 1,
        driving_event: "Two replicas recorded concurrent corrections.",
        decision: "Use the guarded boundary because it owns the transition.",
        impact: "The union must hold both corrections as a visible fork.",
        recurrence_control: "The union test fails when merge order changes the fact set.",
        alternatives: [],
        sources: [],
        supersedes: [base.id],
      },
      { author_email: "other@example.com", session: null, created_at: "2030-01-01T00:00:00Z" },
      sha1,
    ).id,
    otherAuthor.id,
  );
  const changed = correction([base.id], "Keep the state machine because it owns the legacy contract.");
  assert.notEqual(first.id, changed.id);
});

test("correction requires at least one superseded head", () => {
  assert.throws(() => correction([], "A correction with no head."), /supersedes must be nonempty/);
});

test("resolution and redaction derive stable rs: and rd: identities", () => {
  const base = reverie("Use the guarded boundary because it owns the transition.");
  const left = correction([base.id], "Use the left owner because it guards writes.");
  const right = correction([base.id], "Use the right owner because it guards reads.");
  const firstResolution = resolution([left.id, right.id], "Converge on the guarded boundary.");
  assert.match(firstResolution.id, /^rs:[0-9a-f]{40}$/);
  assert.equal(
    firstResolution.id,
    resolution([right.id, left.id], "Converge on the guarded boundary.").id,
  );
  const firstRedaction = redaction(base.id);
  assert.match(firstRedaction.id, /^rd:[0-9a-f]{40}$/);
  assert.equal(firstRedaction.id, redaction(base.id).id);
});

test("unionFacts is commutative across replicas", () => {
  const base = reverie("Use the guarded boundary because it owns the transition.");
  const left = correction([base.id], "Use the left owner because it guards writes.");
  const right = correction([base.id], "Use the right owner because it guards reads.");
  assert.deepEqual(unionFacts([base, left], [right]), unionFacts([right], [base, left]));
});

test("unionFacts is associative across three replicas", () => {
  const base = reverie("Use the guarded boundary because it owns the transition.");
  const left = correction([base.id], "Use the left owner because it guards writes.");
  const right = correction([base.id], "Use the right owner because it guards reads.");
  const resolve = resolution([left.id, right.id], "Converge on the guarded boundary.");
  assert.deepEqual(
    unionFacts(unionFacts([base], [left]), [right], [resolve]),
    unionFacts([base], unionFacts([left], unionFacts([right], [resolve]))),
  );
});

test("unionFacts is idempotent and deduplicates exact lines", () => {
  const base = reverie("Use the guarded boundary because it owns the transition.");
  const left = correction([base.id], "Use the left owner because it guards writes.");
  assert.deepEqual(unionFacts([base, left], [base, left]), unionFacts([base, left]));
  assert.deepEqual(unionFacts([base, base], [left, left]).length, 2);
});

test("unionFacts is deterministic under every permutation", () => {
  const base = reverie("Use the guarded boundary because it owns the transition.");
  const left = correction([base.id], "Use the left owner because it guards writes.");
  const hide = redaction(base.id);
  const orders: NoteRecord[][] = [
    [base, left, hide],
    [base, hide, left],
    [left, base, hide],
    [left, hide, base],
    [hide, base, left],
    [hide, left, base],
  ];
  const first = unionFacts(orders[0] as NoteRecord[]);
  for (const order of orders.slice(1)) {
    assert.deepEqual(unionFacts(order), first);
  }
});

test("validateNote rejects conflicting correction IDs by default", () => {
  const base = reverie("Use the guarded boundary because it owns the transition.");
  const record = correction([base.id], "Use the left owner because it guards writes.");
  const conflict: CorrectionRecord = {
    ...record,
    decision: "A different decision with the same stolen correction identity.",
  };
  assert.throws(
    () => validateNote([record, conflict], { verifyIds: false }),
    /conflicting duplicate correction ID/,
  );
});

test("validateNote with forkPolicy project keeps conflicting corrections visible", () => {
  const base = reverie("Use the guarded boundary because it owns the transition.");
  const record = correction([base.id], "Use the left owner because it guards writes.");
  const conflict: CorrectionRecord = {
    ...record,
    decision: "A different decision with the same stolen correction identity.",
  };
  const kept = validateNote([record, conflict], { verifyIds: false, forkPolicy: "project" });
  assert.equal(kept.length, 2);
});

test("validateNote keeps rejecting conflicting reverie IDs unless projecting", () => {
  const record = reverie("Use the guarded boundary because it owns the transition.");
  const conflict = { ...record, decision: "A different decision with the same stolen identity." };
  assert.throws(() => validateNote([record, conflict], { verifyIds: false }), /conflicting duplicate reverie ID/);
  const kept = validateNote([record, conflict], { verifyIds: false, forkPolicy: "project" });
  assert.equal(kept.length, 2);
});

test("validateNote project mode surfaces concurrent session summaries as a fork", () => {
  const summary = {
    v: 1 as const,
    type: "session-summary" as const,
    author_email: "reveries@example.com",
    session: "codex:fact-union",
    created_at: "2026-09-29T07:00:00Z",
    entries: [{
      driving_event: "The left replica summarized the transition.",
      decision: "Record the left summary because it explains the transition.",
      impact: "Reviewers read the left account.",
      recurrence_control: null,
      alternatives: [] as string[],
      sources: [],
      reveries: [] as ReturnType<typeof reverieId>[],
      retirements: [],
    }],
  };
  const other = {
    ...summary,
    entries: [{
      ...summary.entries[0]!,
      decision: "Record the right summary because it explains the transition.",
    }],
  };
  assert.throws(
    () => validateNote([summary, other], { verifyIds: false }),
    /more than one session summary/,
  );
  const kept = validateNote([summary, other], { verifyIds: false, forkPolicy: "project" });
  assert.equal(kept.length, 2);
});

test("new facts serialize canonically and round-trip through strict parsing", () => {
  const base = reverie("Use the guarded boundary because it owns the transition.");
  const left = correction([base.id], "Use the left owner because it guards writes.");
  const resolve = resolution([left.id, base.id], "Converge on the guarded boundary.");
  const hide = redaction(base.id);
  for (const record of [left, resolve, hide] as const) {
    const line = canonicalRecord(record);
    assert.ok(line.endsWith("\n"));
    const parsed = parseNote(line, "strict", { hashObject: sha1 });
    assert.equal(parsed.records.length, 1);
    assert.equal(parsed.records[0]?.type, record.type);
  }
});

/**
 * The published schemas must describe exactly the records the protocol
 * produces: same key set, same required fields, same ID patterns. There is no
 * schema validator in this repository, so drift is caught here instead.
 */
test("published schemas describe exactly the canonical fact records", async () => {
  const base = reverie("Use the guarded boundary because it owns the transition.");
  const left = correction([base.id], "Use the left owner because it guards writes.");
  const resolve = resolution([left.id], "Converge on the guarded boundary.");
  const hide = redaction(base.id);
  const cases = [
    { file: "correction.schema.json", record: left, required: "supersedes" },
    { file: "resolution.schema.json", record: resolve, required: "resolves" },
    { file: "redaction.schema.json", record: hide, required: "target" },
  ] as const;
  for (const { file, record, required } of cases) {
    const path = fileURLToPath(new URL(`../../../protocol/schemas/${file}`, import.meta.url));
    const schema = JSON.parse(await readFile(path, "utf8")) as {
      properties: Record<string, { const?: unknown }>;
      required: string[];
    };
    assert.equal(schema.properties.type?.const, record.type, file);
    const canonical = JSON.parse(canonicalRecord(record)) as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(canonical).sort(),
      Object.keys(schema.properties).sort(),
      `${file} property set`,
    );
    assert.deepEqual(
      Object.keys(canonical).sort(),
      [...schema.required].sort(),
      `${file} required set`,
    );
    assert.ok(required in schema.properties, `${file} declares ${required}`);
  }
});
