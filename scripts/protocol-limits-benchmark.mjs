// RVR-010 protocol resource-limits benchmark.
//
// Measures parse/validate/snapshot latency and peak RSS for synthetic notes at
// several record counts, plus adversarial inputs (oversized note, oversized
// line, diagnostic flood, deep supersession chain). Asserts every ceiling in
// DEFAULT_LIMITS holds; exits non-zero on violation.
//
// Run with:
//   node --experimental-transform-types scripts/protocol-limits-benchmark.mjs
//
// Imports the TypeScript source directly so results always reflect the working
// tree (no dist build required). Node builtins only.

import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import {
  DEFAULT_LIMITS,
  LimitExceededError,
  canonicalRecord,
  createEvidenceSnapshot,
  createReverie,
  objectId,
  parseNote,
  validateNote,
} from "../packages/reveries/src/protocol.ts";

const TIP = "0123456789012345678901234567890123456789";
process.exitCode = 0;

function gitSha1(bytes) {
  return objectId(createHash("sha1").update(Buffer.from(`blob ${bytes.byteLength}\0`)).update(bytes).digest("hex"));
}

function makeRecord(index, overrides = {}) {
  return createReverie(
    {
      v: 1,
      driving_event: `Benchmark defect ${index} exposed two transition owners.`,
      decision: `Use one guarded boundary ${index} because it owns transition validity.`,
      impact: "All writers must use the guarded boundary.",
      recurrence_control: null,
      alternatives: [],
      sources: [],
      supersedes: [],
      ...overrides,
    },
    {
      author_email: "engineer@example.com",
      session: null,
      created_at: "2026-08-25T03:00:00Z",
    },
    gitSha1,
  );
}

function noteOf(records) {
  return records.map((record) => canonicalRecord(record)).join("");
}

const results = [];
function measure(name, fn) {
  const rssBefore = process.memoryUsage().rss;
  const start = performance.now();
  const extra = fn();
  const ms = performance.now() - start;
  const rssAfter = process.memoryUsage().rss;
  results.push({ name, ms: Math.round(ms * 100) / 100, rssDeltaBytes: rssAfter - rssBefore, ...extra });
}

function assertLimit(condition, message) {
  if (!condition) {
    console.error(`LIMIT VIOLATION: ${message}`);
    process.exitCode = 1;
  }
}

// Valid notes at several corpus sizes.
for (const count of [1, 10, 100, 1024]) {
  const records = Array.from({ length: count }, (_, i) => makeRecord(i));
  const text = noteOf(records);
  measure(`valid-note-${count}-records`, () => {
    const parsed = parseNote(text, "strict");
    const validated = validateNote(parsed.records);
    const snapshot = createEvidenceSnapshot({ notesTip: TIP, records: validated });
    assertLimit(snapshot.byId.size === count, `byId size ${snapshot.byId.size} !== ${count}`);
    return { noteBytes: Buffer.byteLength(text, "utf8"), records: count };
  });
}

// Oversized note must be rejected before per-record parsing.
measure("oversized-note-rejected", () => {
  const text = `${"x".repeat(DEFAULT_LIMITS.maxNoteBytes + 1)}\n`;
  const start = performance.now();
  let rejected = false;
  try {
    parseNote(text, "tolerant");
  } catch (error) {
    rejected = error instanceof LimitExceededError && error.limit === "maxNoteBytes";
  }
  assertLimit(rejected, "oversized note was not rejected as maxNoteBytes");
  return { rejectMs: Math.round((performance.now() - start) * 100) / 100 };
});

// Oversized single line must be rejected before JSON parsing.
measure("oversized-line-rejected", () => {
  const text = `${"x".repeat(DEFAULT_LIMITS.maxRecordBytes + 1)}\n`;
  const parsed = parseNote(text, "tolerant");
  assertLimit(parsed.records.length === 0, "oversized line produced a record");
  assertLimit(parsed.diagnostics.length === 1, "oversized line did not produce exactly one diagnostic");
  return {};
});

// Diagnostic flood must be capped.
measure("diagnostic-flood-capped", () => {
  const text = Array.from({ length: 2000 }, () => "{not-json}\n").join("");
  const parsed = parseNote(text, "tolerant");
  assertLimit(parsed.diagnostics.length === DEFAULT_LIMITS.maxDiagnostics,
    `diagnostics ${parsed.diagnostics.length} !== cap ${DEFAULT_LIMITS.maxDiagnostics}`);
  assertLimit(parsed.truncated === true, "diagnostic flood did not set truncated");
  return { badLines: 2000, diagnostics: parsed.diagnostics.length };
});

// Deep supersession chain traversal stays bounded.
measure("supersession-chain-500", () => {
  let previous = null;
  const records = Array.from({ length: 500 }, (_, i) => {
    const record = makeRecord(i, previous === null ? {} : { supersedes: [previous] });
    previous = record.id;
    return record;
  });
  const validated = validateNote(noteOf(records) === "" ? [] : parseNote(noteOf(records), "strict").records);
  assertLimit(validated.length === 500, `chain validated ${validated.length} !== 500`);
  return { records: 500 };
});

// Narrative at exactly the ceiling remains valid.
measure("narrative-at-ceiling", () => {
  const record = makeRecord(0, { decision: "x".repeat(DEFAULT_LIMITS.maxNarrativeChars) });
  assertLimit(validateNote([record]).length === 1, "ceiling narrative failed validation");
  return { narrativeChars: DEFAULT_LIMITS.maxNarrativeChars };
});

for (const result of results) {
  console.log(`${result.name}: ${result.ms}ms rss+${result.rssDeltaBytes}B ${JSON.stringify({ ...result, name: undefined, ms: undefined, rssDeltaBytes: undefined })}`);
}
console.log(JSON.stringify({ limits: DEFAULT_LIMITS, results }, null, 2));
if (process.exitCode !== 0) console.error("benchmark FAILED: a ceiling did not hold");
else console.log("benchmark OK: all ceilings hold");
