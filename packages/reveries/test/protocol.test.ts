import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  NOTES_REF,
  canonicalRecord,
  confidentialPointer,
  createReverie,
  parseNote,
  projectActiveReveries,
  semanticPayload,
  validateNote,
  type BlobId,
  type CommitId,
  type ReverieRecord,
  objectId,
} from "../src/protocol.ts";

const blob = "0123456789012345678901234567890123456789" as BlobId;
const successor = "abcdefabcdefabcdefabcdefabcdefabcdefabcd" as BlobId;
const commit = "1111111111111111111111111111111111111111" as CommitId;

function input(overrides: Partial<Parameters<typeof createReverie>[0]> = {}) {
  return {
    v: 1 as const,
    driving_event: " A defect exposed two transition owners. ",
    decision: " Use one guarded boundary because it owns transition validity. ",
    impact: " All writers must use the guarded boundary. ",
    recurrence_control: " A concurrency test rejects stale predecessors. ",
    alternatives: ["Keep both owners", "Keep both owners"],
    sources: [{ relation: "caused-by" as const, kind: "issue" as const, ref: "github:org/repo#7" }],
    supersedes: [],
    ...overrides,
  };
}

function gitSha1(bytes: Uint8Array) {
  return objectId(createHash("sha1").update(Buffer.from(`blob ${bytes.byteLength}\0`)).update(bytes).digest("hex"));
}

function make(overrides: Partial<Parameters<typeof createReverie>[0]> = {}): ReverieRecord {
  return createReverie(
    input(overrides),
    {
      author_email: "engineer@example.com",
      session: "codex:test",
      created_at: "2026-08-25T03:00:00Z",
    },
    gitSha1,
  );
}

test("exports the canonical notes ref", () => {
  assert.equal(NOTES_REF, "refs/notes/reveries");
});

test("canonicalizes semantic payload and injects the Git object hash", () => {
  const record = make();
  const semantic = semanticPayload(record);

  assert.equal(
    semantic,
    '{"v":1,"driving_event":"A defect exposed two transition owners.","decision":"Use one guarded boundary because it owns transition validity.","impact":"All writers must use the guarded boundary.","recurrence_control":"A concurrency test rejects stale predecessors.","alternatives":["Keep both owners"],"sources":[{"relation":"caused-by","kind":"issue","ref":"github:org/repo#7"}],"supersedes":[]}',
  );
  assert.match(record.id, /^rv:[0-9a-f]{40}$/);
  assert.equal(canonicalRecord(record).endsWith("\n"), true);
  assert.equal(canonicalRecord(record).split("\n").length, 2);
});

test("public reverie creation refuses to guess the repository object format", () => {
  const callWithoutRepositoryHash = createReverie as unknown as (
    semantic: ReturnType<typeof input>,
    metadata: Parameters<typeof createReverie>[1],
  ) => ReverieRecord;

  assert.throws(
    () => callWithoutRepositoryHash(input(), {
      author_email: "engineer@example.com",
      session: "codex:test",
      created_at: "2026-08-25T03:00:00Z",
    }),
    /hash|function/i,
  );
});

test("canonical record uses protocol key order and no insignificant whitespace", () => {
  const record = make();
  assert.equal(
    canonicalRecord(record),
    `{"v":1,"type":"reverie","id":"${record.id}","driving_event":"A defect exposed two transition owners.","decision":"Use one guarded boundary because it owns transition validity.","impact":"All writers must use the guarded boundary.","recurrence_control":"A concurrency test rejects stale predecessors.","alternatives":["Keep both owners"],"sources":[{"relation":"caused-by","kind":"issue","ref":"github:org/repo#7"}],"supersedes":[],"author_email":"engineer@example.com","session":"codex:test","created_at":"2026-08-25T03:00:00Z"}\n`,
  );
});

test("confidential rationale uses a distinct opaque-pointer syntax", () => {
  const pointer = confidentialPointer(`vault:v1:${"A".repeat(43)}`);
  const record = make({
    sources: [{ relation: "derived-from", kind: "confidential-pointer", ref: pointer }],
  });

  assert.match(canonicalRecord(record), /"kind":"confidential-pointer","ref":"vault:v1:/);
  assert.throws(() => confidentialPointer("github:org/repo#7"), /vault:v1/);
  assert.throws(() => make({
    sources: [{ relation: "derived-from", kind: "confidential-pointer", ref: "confidential rationale" }],
  }), /vault:v1/);
});

test("session summaries reject confidential pointers before publication", () => {
  const record = make({
    sources: [{ relation: "derived-from", kind: "confidential-pointer", ref: `vault:v1:${"A".repeat(43)}` }],
  });
  assert.throws(() => validateNote([{
    v: 1,
    type: "session-summary",
    author_email: record.author_email,
    session: record.session,
    created_at: record.created_at,
    entries: [{
      driving_event: record.driving_event,
      decision: record.decision,
      impact: record.impact,
      recurrence_control: record.recurrence_control,
      alternatives: record.alternatives,
      sources: record.sources,
      reveries: [],
      retirements: [],
    }],
  }]), /Confidential pointers require an ID-bearing record/);
});

test("canonical session entries deduplicate set-like arrays", () => {
  const source = { relation: "caused-by" as const, kind: "issue" as const, ref: "github:org/repo#7" };
  const summary = {
    v: 1 as const,
    type: "session-summary" as const,
    author_email: "engineer@example.com",
    session: "codex:test",
    created_at: "2026-08-25T03:00:00Z",
    entries: [{
      driving_event: "A defect required one transition owner.",
      decision: "Use the guarded owner because it serializes transition validity.",
      impact: "All writers use the guarded owner.",
      recurrence_control: null,
      alternatives: ["Keep both owners", "Keep both owners"],
      sources: [source, source],
      reveries: [],
      retirements: [],
    }],
  };

  const canonical = JSON.parse(canonicalRecord(summary)) as { entries: Array<{ alternatives: string[]; sources: unknown[] }> };
  assert.deepEqual(canonical.entries[0]?.alternatives, ["Keep both owners"]);
  assert.equal(canonical.entries[0]?.sources.length, 1);
});

test("strict parsing accepts canonical JSONL and rejects noncanonical JSON", () => {
  const line = canonicalRecord(make());
  const parsed = parseNote(line, "strict");
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.records[0]?.type, "reverie");
  assert.throws(() => parseNote(line.replace("{", "{ "), "strict"), /canonical|whitespace/i);
});

test("tolerant parsing preserves valid records and reports malformed lines", () => {
  const line = canonicalRecord(make());
  const parsed = parseNote(`${line}{not-json}\n`, "tolerant");
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.diagnostics.length, 1);
  assert.match(parsed.diagnostics[0]?.message ?? "", /JSON/i);
});

test("strict validation rejects malformed source identities", () => {
  assert.throws(
    () => make({ sources: [{ relation: "caused-by", kind: "issue", ref: "github:not-an-issue" }] }),
    /issue source/i,
  );
  assert.throws(
    () => make({ sources: [{ relation: "requested-by", kind: "git-email", ref: "invented-address" }] }),
    /email/i,
  );
});

test("strict validation rejects a forged semantic ID", () => {
  const forged = { ...make(), id: "rv:3333333333333333333333333333333333333333" as ReverieRecord["id"] };
  assert.throws(() => validateNote([forged], { hashObject: gitSha1 }), /semantic ID|id/i);
});

test("validation collapses identical duplicate records but rejects placeholder controls", () => {
  const record = make();
  assert.equal(validateNote([record, record]).length, 2);
  const projection = projectActiveReveries([record, record]);
  assert.deepEqual(projection.duplicates, [record.id]);
  assert.throws(() => make({ recurrence_control: "N/A" }), /placeholder/i);
});

test("active projection exposes terminal reveries and detects forks", () => {
  const first = make();
  const second = make({ decision: "Use the guarded boundary because it is the sole owner.", supersedes: [first.id] });
  const fork = make({ decision: "Keep the state machine because it owns the legacy contract.", supersedes: [first.id] });
  const projection = projectActiveReveries([first, second, fork]);

  assert.equal(projection.active.some((record) => record.id === first.id), false);
  assert.equal(projection.active.some((record) => record.id === second.id), true);
  assert.equal(projection.active.some((record) => record.id === fork.id), true);
  assert.equal(projection.forks.length, 1);
  assert.equal(projection.cycles.length, 0);
});

test("active projection detects a fork through supersession descendants", () => {
  const first = make();
  const left = make({ decision: "Use the left owner because it guards writes.", supersedes: [first.id] });
  const right = make({ decision: "Use the right owner because it guards reads.", supersedes: [first.id] });
  const leftSuccessor = make({
    decision: "Refine the left owner because it now guards writes and migrations.",
    supersedes: [left.id],
  });

  const projection = projectActiveReveries([first, left, right, leftSuccessor]);

  assert.equal(projection.active.some((record) => record.id === leftSuccessor.id), true);
  assert.equal(projection.active.some((record) => record.id === right.id), true);
  assert.equal(projection.forks.length, 1);
});

test("active projection detects supersession cycles", () => {
  const first = make();
  const second = make({ decision: "Use a new sole owner.", supersedes: [first.id] });
  const cyclicFirst = { ...first, supersedes: [second.id] };
  const projection = projectActiveReveries([cyclicFirst, second]);
  assert.equal(projection.cycles.length, 1);
});

