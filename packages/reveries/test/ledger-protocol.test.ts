import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  canonicalLedgerManifest,
  createLedgerManifest,
  ledgerManifestPayload,
  parseLedgerManifest,
  readLedgerManifest,
  validateLedgerManifest,
} from "../src/protocol.ts";

const NOTES = "a".repeat(40);
const NOTES_COMMIT = "b".repeat(40);
const PREVIOUS = "c".repeat(40);
const RETENTION = "d".repeat(40);

type ManifestInput = Parameters<typeof createLedgerManifest>[0];

function manifest(overrides: Partial<ManifestInput> = {}) {
  return createLedgerManifest({
    notes_commit: NOTES_COMMIT,
    notes_tree: NOTES,
    previous_ledger: PREVIOUS,
    retention_commit: null,
    authority: "origin",
    annotated_subjects: 3,
    records: 5,
    note_bytes: 900,
    ...overrides,
  });
}

test("a ledger manifest serializes canonically with a stable key order", () => {
  const canonical = canonicalLedgerManifest(manifest());
  assert.ok(canonical.endsWith("\n"));
  assert.deepEqual(JSON.parse(canonical), {
    v: 1,
    type: "ledger-manifest",
    protocol: 1,
    ledger_ref: "refs/heads/reveries-ledger",
    notes_ref: "refs/notes/reveries",
    notes_commit: NOTES_COMMIT,
    notes_tree: NOTES,
    previous_ledger: PREVIOUS,
    retention_commit: null,
    authority: "origin",
    annotated_subjects: 3,
    records: 5,
    note_bytes: 900,
  });
  assert.equal(
    canonical,
    '{"v":1,"type":"ledger-manifest","protocol":1,"ledger_ref":"refs/heads/reveries-ledger",'
    + `"notes_ref":"refs/notes/reveries","notes_commit":"${NOTES_COMMIT}","notes_tree":"${NOTES}",`
    + `"previous_ledger":"${PREVIOUS}","retention_commit":null,"authority":"origin",`
    + '"annotated_subjects":3,"records":5,"note_bytes":900}\n',
  );
});

test("an identical manifest always produces identical bytes", () => {
  assert.equal(canonicalLedgerManifest(manifest()), canonicalLedgerManifest(manifest()));
});

test("a manifest round-trips through strict parsing", () => {
  const record = manifest();
  const parsed = parseLedgerManifest(canonicalLedgerManifest(record), "strict");
  assert.deepEqual(parsed.diagnostics, []);
  assert.deepEqual(parsed.manifest, record);
  assert.equal(ledgerManifestPayload(record), ledgerManifestPayload(parsed.manifest!));
  assert.deepEqual(readLedgerManifest(canonicalLedgerManifest(record)), record);
});

test("a genesis manifest with no notes and no previous ledger validates", () => {
  const genesis = createLedgerManifest({
    notes_commit: null,
    notes_tree: null,
    previous_ledger: null,
    retention_commit: null,
    authority: null,
    annotated_subjects: 0,
    records: 0,
    note_bytes: 0,
  });
  assert.doesNotThrow(() => validateLedgerManifest(genesis));
  assert.equal(genesis.authority, null);
});

test("a notes commit without a notes tree is rejected", () => {
  assert.throws(
    () => validateLedgerManifest(manifest({ notes_commit: NOTES_COMMIT, notes_tree: null })),
    /notes_tree/,
  );
});

test("a notes tree without a notes commit is rejected", () => {
  assert.throws(
    () => validateLedgerManifest(manifest({ notes_commit: null, notes_tree: NOTES })),
    /notes_commit/,
  );
});

test("a manifest with a non-object ID is rejected", () => {
  assert.throws(() => validateLedgerManifest(manifest({ notes_tree: "not-an-oid" })), /notes_tree/);
  assert.throws(() => validateLedgerManifest(manifest({ previous_ledger: "z".repeat(40) })), /previous_ledger/);
});

test("a 64-character SHA-256 object ID is accepted", () => {
  const sha256 = "e".repeat(64);
  assert.doesNotThrow(() => validateLedgerManifest(manifest({ notes_tree: sha256 })));
});

test("negative or fractional counts are rejected", () => {
  assert.throws(() => validateLedgerManifest(manifest({ annotated_subjects: -1 })), /annotated_subjects/);
  assert.throws(() => validateLedgerManifest(manifest({ note_bytes: 1.5 })), /note_bytes/);
});

test("a reserved authority name must be a trimmed single token", () => {
  assert.doesNotThrow(() => validateLedgerManifest(manifest({ authority: "upstream" })));
  assert.throws(() => validateLedgerManifest(manifest({ authority: "" })), /authority/);
  assert.throws(() => validateLedgerManifest(manifest({ authority: "  " })), /authority/);
  assert.throws(() => validateLedgerManifest(manifest({ authority: "two words" })), /authority/);
  assert.throws(() => validateLedgerManifest(manifest({ authority: "origin\nremote" })), /authority/);
  assert.throws(
    () => validateLedgerManifest(manifest({ authority: "x".repeat(200) }), { maxRefChars: 64 }),
    /maxRefChars/,
  );
});

test("strict parsing rejects an unknown manifest field", () => {
  const canonical = canonicalLedgerManifest(manifest());
  const tampered = canonical.replace('"note_bytes":900', '"note_bytes":900,"extra":1');
  assert.throws(() => parseLedgerManifest(tampered, "strict"), /extra/);
  const tolerant = parseLedgerManifest(tampered, "tolerant");
  assert.equal(tolerant.diagnostics.length, 1);
  assert.equal(tolerant.manifest, null);
});

test("strict parsing rejects a noncanonical manifest body", () => {
  const canonical = canonicalLedgerManifest(manifest());
  const reordered = JSON.stringify({
    type: "ledger-manifest",
    v: 1,
    protocol: 1,
    ledger_ref: "refs/heads/reveries-ledger",
    notes_ref: "refs/notes/reveries",
    notes_commit: NOTES_COMMIT,
    notes_tree: NOTES,
    previous_ledger: PREVIOUS,
    retention_commit: null,
    authority: "origin",
    annotated_subjects: 3,
    records: 5,
    note_bytes: 900,
  });
  assert.notEqual(reordered, canonical);
  assert.throws(() => parseLedgerManifest(`${reordered}\n`, "strict"), /canonical/);
  assert.equal(parseLedgerManifest(`${reordered}\n`, "tolerant").manifest, null);
});

test("strict parsing rejects a manifest without one trailing newline", () => {
  const canonical = canonicalLedgerManifest(manifest());
  assert.throws(() => parseLedgerManifest(canonical.trimEnd(), "strict"), /LF/);
});

test("strict parsing rejects a manifest that is not a ledger manifest", () => {
  assert.throws(
    () => parseLedgerManifest(`${JSON.stringify({ v: 1, type: "reverie" })}\n`, "strict"),
    /ledger-manifest/,
  );
});

test("an oversized manifest exceeds maxRecordBytes", () => {
  const oversized = canonicalLedgerManifest(manifest({ authority: "x".repeat(64) }));
  assert.throws(
    () => parseLedgerManifest(oversized, "strict", { limits: { maxRecordBytes: 32 } }),
    /maxRecordBytes/,
  );
});

/**
 * The published schema must describe exactly the manifest the protocol
 * produces: same key set, same required set. There is no schema validator in
 * this repository, so drift is caught here instead.
 */
test("the published schema describes exactly the canonical manifest", async () => {
  const path = fileURLToPath(new URL("../../../protocol/schemas/ledger-manifest.schema.json", import.meta.url));
  const schema = JSON.parse(await readFile(path, "utf8")) as {
    properties: Record<string, { const?: unknown }>;
    required: string[];
    additionalProperties: boolean;
  };
  const canonical = JSON.parse(canonicalLedgerManifest(manifest())) as Record<string, unknown>;
  assert.equal(schema.properties.type?.const, "ledger-manifest");
  assert.deepEqual(Object.keys(canonical).sort(), Object.keys(schema.properties).sort());
  assert.deepEqual(Object.keys(canonical).sort(), [...schema.required].sort());
  assert.equal(schema.additionalProperties, false);
});
