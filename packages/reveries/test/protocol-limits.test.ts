import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  DEFAULT_LIMITS,
  LimitExceededError,
  assertNoteSize,
  canonicalRecord,
  checkNoteSize,
  createEvidenceSnapshot,
  createReverie,
  objectId,
  parseNote,
  resolveLimits,
  validateNote,
  type NoteRecord,
  type ReverieRecord,
} from "../src/protocol.ts";

test("default limits define deterministic per-note, per-record, and diagnostic budgets", () => {
  assert.equal(DEFAULT_LIMITS.maxNoteBytes, 1_048_576);
  assert.equal(DEFAULT_LIMITS.maxRecordsPerNote, 1_024);
  assert.equal(DEFAULT_LIMITS.maxRecordBytes, 65_536);
  assert.equal(DEFAULT_LIMITS.maxNarrativeChars, 8_192);
  assert.equal(DEFAULT_LIMITS.maxRefChars, 1_024);
  assert.equal(DEFAULT_LIMITS.maxAlternatives, 32);
  assert.equal(DEFAULT_LIMITS.maxSources, 64);
  assert.equal(DEFAULT_LIMITS.maxSupersedes, 64);
  assert.equal(DEFAULT_LIMITS.maxReveries, 64);
  assert.equal(DEFAULT_LIMITS.maxRetirements, 64);
  assert.equal(DEFAULT_LIMITS.maxEntries, 64);
  assert.equal(DEFAULT_LIMITS.maxGraphVisits, 131_072);
  assert.equal(DEFAULT_LIMITS.maxDiagnostics, 32);
  assert.ok(Object.isFrozen(DEFAULT_LIMITS));
});

test("resolveLimits merges partial overrides over the defaults", () => {
  const resolved = resolveLimits({ maxNoteBytes: 16 });
  assert.equal(resolved.maxNoteBytes, 16);
  assert.equal(resolved.maxRecordsPerNote, DEFAULT_LIMITS.maxRecordsPerNote);
});

test("checkNoteSize reports ok within budget and over beyond it", () => {
  assert.deepEqual(checkNoteSize(2, { maxNoteBytes: 2 }), { ok: true, byteLength: 2 });
  const over = checkNoteSize(3, { maxNoteBytes: 2 });
  assert.equal(over.ok, false);
  if (!over.ok) assert.equal(over.budget, 2);
});

test("assertNoteSize throws a LimitExceededError carrying limit, actual, and budget", () => {
  assertNoteSize(2, { maxNoteBytes: 2 });
  assert.throws(() => assertNoteSize(3, { maxNoteBytes: 2 }), (error: unknown) => {
    assert.ok(error instanceof LimitExceededError);
    assert.equal(error.limit, "maxNoteBytes");
    assert.equal(error.actual, 3);
    assert.equal(error.budget, 2);
    return true;
  });
});

test("parseNote rejects an oversized note before parsing any record body", () => {
  const oversized = `${"not json at all".repeat(80_000)}\n`;
  assert.ok(Buffer.byteLength(oversized, "utf8") > DEFAULT_LIMITS.maxNoteBytes);
  assert.throws(() => parseNote(oversized, "tolerant"), (error: unknown) => {
    assert.ok(error instanceof LimitExceededError);
    assert.equal(error.limit, "maxNoteBytes");
    return true;
  });
});

test("parseNote enforces the note gate at exactly the boundary", () => {
  assert.throws(() => parseNote("x\n", "tolerant", { limits: { maxNoteBytes: 1 } }), LimitExceededError);
  const parsed = parseNote("x\n", "tolerant", { limits: { maxNoteBytes: 2 } });
  assert.equal(parsed.records.length, 0);
  assert.equal(parsed.diagnostics.length, 1);
});

function snapshotReverie(decision: string) {
  return createReverie(
    {
      v: 1,
      driving_event: "A defect exposed two transition owners.",
      decision,
      impact: "All writers must use the guarded boundary.",
      recurrence_control: null,
      alternatives: [],
      sources: [],
      supersedes: [],
    },
    {
      author_email: "engineer@example.com",
      session: null,
      created_at: "2026-08-25T03:00:00Z",
    },
    (bytes) => objectId(createHash("sha1").update(Buffer.from(`blob ${bytes.byteLength}\0`)).update(bytes).digest("hex")),
  );
}

const SNAPSHOT_TIP = "0123456789012345678901234567890123456789";

test("createEvidenceSnapshot indexes validated reveries by semantic ID", () => {
  const record = snapshotReverie("Use one guarded boundary because it owns transition validity.");
  const snapshot = createEvidenceSnapshot({ notesTip: SNAPSHOT_TIP, records: [record] });
  assert.equal(snapshot.notesTip, SNAPSHOT_TIP);
  assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.byId.get(record.id), record);
  assert.deepEqual(snapshot.diagnostics, []);
  assert.equal(snapshot.diagnosticsTruncated, false);
  assert.equal(snapshot.limits.maxNoteBytes, DEFAULT_LIMITS.maxNoteBytes);
});

test("createEvidenceSnapshot collapses identical duplicates and rejects conflicts", () => {
  const record = snapshotReverie("Use one guarded boundary because it owns transition validity.");
  const collapsed = createEvidenceSnapshot({ notesTip: SNAPSHOT_TIP, records: [record, record] });
  assert.equal(collapsed.byId.size, 1);
  const forged = { ...record, decision: "A conflicting decision with the same semantic ID." };
  assert.throws(() => createEvidenceSnapshot({ notesTip: SNAPSHOT_TIP, records: [record, forged] }), /conflicting duplicate/);
});

test("createEvidenceSnapshot caps diagnostics and rejects a non-OID tip", () => {
  const record = snapshotReverie("Use one guarded boundary because it owns transition validity.");
  const diagnostics = Array.from({ length: 40 }, (_, index) => ({ line: index + 1, message: `bad line ${index + 1}` }));
  const snapshot = createEvidenceSnapshot({ notesTip: SNAPSHOT_TIP, records: [record], diagnostics });
  assert.equal(snapshot.diagnostics.length, DEFAULT_LIMITS.maxDiagnostics);
  assert.equal(snapshot.diagnosticsTruncated, true);
  assert.throws(() => createEvidenceSnapshot({ notesTip: "not-an-oid", records: [record] }), /object ID/i);
});

test("createEvidenceSnapshot honors partial limit overrides", () => {
  const record = snapshotReverie("Use one guarded boundary because it owns transition validity.");
  const diagnostics = [{ message: "first" }, { message: "second" }, { message: "third" }];
  const snapshot = createEvidenceSnapshot({
    notesTip: SNAPSHOT_TIP,
    records: [record],
    diagnostics,
    limits: { maxDiagnostics: 2 },
  });
  assert.equal(snapshot.diagnostics.length, 2);
  assert.equal(snapshot.diagnosticsTruncated, true);
  assert.equal(snapshot.limits.maxDiagnostics, 2);
});

function craftedReverie(idChar: string, overrides: Partial<ReverieRecord> = {}): ReverieRecord {
  return {
    v: 1,
    type: "reverie",
    id: `rv:${idChar.repeat(40)}` as ReverieRecord["id"],
    driving_event: "A defect exposed two transition owners.",
    decision: "Use one guarded boundary because it owns transition validity.",
    impact: "All writers must use the guarded boundary.",
    recurrence_control: null,
    alternatives: [],
    sources: [],
    supersedes: [],
    author_email: "engineer@example.com",
    session: null,
    created_at: "2026-08-25T03:00:00Z",
    ...overrides,
  };
}

test("parseNote rejects an oversized record line before JSON parsing", () => {
  const line = `${"x".repeat(20)}\n`;
  assert.throws(() => parseNote(line, "strict", { limits: { maxRecordBytes: 16 } }), (error: unknown) => {
    assert.ok(error instanceof LimitExceededError);
    assert.equal(error.limit, "maxRecordBytes");
    return true;
  });
  const tolerated = parseNote(line, "tolerant", { limits: { maxRecordBytes: 16 } });
  assert.equal(tolerated.records.length, 0);
  assert.equal(tolerated.diagnostics.length, 1);
  assert.match(tolerated.diagnostics[0]?.message ?? "", /maxRecordBytes/);
  const boundary = parseNote(`${"x".repeat(15)}\n`, "tolerant", { limits: { maxRecordBytes: 16 } });
  assert.equal(boundary.diagnostics.length, 1);
  assert.doesNotMatch(boundary.diagnostics[0]?.message ?? "", /maxRecordBytes/);
});

test("parseNote counts record bytes as UTF-8, not UTF-16 code units", () => {
  assert.throws(() => parseNote("é\n", "strict", { limits: { maxRecordBytes: 2 } }), (error: unknown) => {
    assert.ok(error instanceof LimitExceededError);
    assert.equal(error.limit, "maxRecordBytes");
    assert.equal(error.actual, 3);
    return true;
  });
  const boundary = parseNote("é\n", "tolerant", { limits: { maxRecordBytes: 3 } });
  assert.doesNotMatch(boundary.diagnostics[0]?.message ?? "", /maxRecordBytes/);
});

test("validateNote caps narrative fields at the boundary", () => {
  const atLimit = "x".repeat(DEFAULT_LIMITS.maxNarrativeChars);
  assert.equal(validateNote([craftedReverie("a", { driving_event: atLimit })]).length, 1);
  assert.throws(() => validateNote([craftedReverie("b", { driving_event: `${"x".repeat(DEFAULT_LIMITS.maxNarrativeChars)}y` })]), (error: unknown) => {
    assert.ok(error instanceof LimitExceededError);
    assert.equal(error.limit, "maxNarrativeChars");
    return true;
  });
  assert.throws(() => createReverie(
    {
      v: 1,
      driving_event: "A defect exposed two transition owners.",
      decision: "y".repeat(DEFAULT_LIMITS.maxNarrativeChars + 1),
      impact: "All writers must use the guarded boundary.",
      recurrence_control: null,
      alternatives: [],
      sources: [],
      supersedes: [],
    },
    { author_email: "engineer@example.com", session: null, created_at: "2026-08-25T03:00:00Z" },
    (bytes) => objectId(createHash("sha1").update(bytes).digest("hex")),
  ), LimitExceededError);
});

test("validateNote caps arrays and short reference strings", () => {
  assert.throws(() => validateNote([craftedReverie("a", { alternatives: Array.from({ length: 33 }, (_, i) => `option ${i}`) })]), (error: unknown) => {
    assert.ok(error instanceof LimitExceededError);
    assert.equal(error.limit, "maxAlternatives");
    return true;
  });
  assert.throws(() => validateNote([craftedReverie("b", {
    sources: Array.from({ length: 65 }, () => ({ relation: "caused-by" as const, kind: "issue" as const, ref: "github:org/repo#7" })),
  })]), (error: unknown) => {
    assert.ok(error instanceof LimitExceededError);
    assert.equal(error.limit, "maxSources");
    return true;
  });
  const supersedeId = craftedReverie("c").id;
  assert.throws(() => validateNote([craftedReverie("d", { supersedes: Array.from({ length: 65 }, () => supersedeId) })]), (error: unknown) => {
    assert.ok(error instanceof LimitExceededError);
    assert.equal(error.limit, "maxSupersedes");
    return true;
  });
  assert.throws(() => validateNote([craftedReverie("e", {
    sources: [{ relation: "caused-by" as const, kind: "issue" as const, ref: `github:org/repo#${"1".repeat(1020)}x` }],
  })]), (error: unknown) => {
    assert.ok(error instanceof LimitExceededError);
    assert.equal(error.limit, "maxRefChars");
    return true;
  });
  assert.throws(() => validateNote([craftedReverie("f", { session: "x".repeat(1_025) })]), (error: unknown) => {
    assert.ok(error instanceof LimitExceededError);
    assert.equal(error.limit, "maxRefChars");
    return true;
  });
  assert.throws(() => validateNote([craftedReverie("0", { author_email: `a@${"x".repeat(1_023)}` })]), LimitExceededError);
});

test("parseNote caps tolerant diagnostics and reports truncation", () => {
  const valid = canonicalRecord(craftedReverie("a"));
  const bad = Array.from({ length: 40 }, () => "{not-json}\n").join("");
  const parsed = parseNote(`${valid}${bad}`, "tolerant");
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.diagnostics.length, DEFAULT_LIMITS.maxDiagnostics);
  assert.equal(parsed.truncated, true);
  const clean = parseNote(valid, "tolerant");
  assert.equal(clean.truncated, false);
  assert.equal(parseNote("", "tolerant").truncated, false);
});

test("validateNote caps record count and supersession graph visits", () => {
  const three = [craftedReverie("a"), craftedReverie("b"), craftedReverie("c")];
  assert.throws(() => validateNote(three, { limits: { maxRecordsPerNote: 2 } }), (error: unknown) => {
    assert.ok(error instanceof LimitExceededError);
    assert.equal(error.limit, "maxRecordsPerNote");
    assert.equal(error.actual, 3);
    return true;
  });
  assert.equal(validateNote(three.slice(0, 2), { limits: { maxRecordsPerNote: 2 } }).length, 2);
  assert.throws(() => validateNote(three, { limits: { maxGraphVisits: 2 } }), (error: unknown) => {
    assert.ok(error instanceof LimitExceededError);
    assert.equal(error.limit, "maxGraphVisits");
    return true;
  });
  assert.equal(validateNote(three).length, 3);
});

test("tolerant parsing isolates malformed vectors and keeps valid records", () => {
  const valid = canonicalRecord(craftedReverie("a"));
  const vectors = "{{{\nline with\rcarriage return\nline with  nul byte\n{\"a\":\n";
  const parsed = parseNote(`${valid}${vectors}`, "tolerant");
  assert.equal(parsed.records.length, 1);
  assert.ok(parsed.diagnostics.length >= 4);
  assert.equal(parsed.truncated, false);
  const emoji = snapshotReverie("Use the guarded boundary ✅ because it owns validity across locales 🌍.");
  assert.equal(validateNote([emoji]).length, 1);
});
