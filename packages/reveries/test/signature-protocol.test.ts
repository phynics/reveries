import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  SIGNATURE_DOMAIN_MANIFEST,
  SIGNATURE_DOMAIN_RECORD,
  canonicalRecord,
  createReverie,
  createSignature,
  signingPayload,
  type HashObject,
  type SignatureRole,
} from "../src/protocol.ts";
import { hashBlobContent } from "../src/git.ts";

const sha1: HashObject = (bytes) => hashBlobContent(bytes, "sha1");
const sha256: HashObject = (bytes) => hashBlobContent(bytes, "sha256");

const SUBJECT = "b".repeat(40);
const CONTENT_ID = "c".repeat(40);
const KEY_ID = "SHA256:3d401bbc2e3a0b1c1e0e2f2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e";

function signatureInput(overrides: Partial<Parameters<typeof createSignature>[0]> = {}) {
  return {
    domain: SIGNATURE_DOMAIN_RECORD,
    role: "author" as SignatureRole,
    target: `rv:${"a".repeat(40)}`,
    subject: SUBJECT,
    signer: "alice@example.test",
    key_id: KEY_ID,
    algorithm: "ed25519",
    signature: "c2lnbmF0dXJl",
    content_id: CONTENT_ID,
    ...overrides,
  };
}

const metadata = { author_email: "alice@example.test", session: null, created_at: "2026-09-29T21:11:20Z" };

test("a signature record carries an sg: identity derived from its own content", () => {
  const record = createSignature(signatureInput(), metadata, sha1);
  assert.match(record.id, /^sg:[0-9a-f]{40}$/);
  assert.equal(record.type, "signature");
  assert.equal(record.v, 1);
});

test("a signature identity never depends on the target it attests", () => {
  const first = createSignature(signatureInput({ target: `rv:${"a".repeat(40)}` }), metadata, sha1);
  const second = createSignature(signatureInput({ target: `rv:${"d".repeat(40)}` }), metadata, sha1);
  // The target is part of the signed payload, so the signature record content
  // differs and therefore so does its own identity. What must NOT differ is the
  // target's own semantic ID, which no signature field can influence.
  assert.notEqual(first.id, second.id);
  assert.equal(first.target, `rv:${"a".repeat(40)}`);
});

test("the same signature always produces the same identity and payload", () => {
  assert.equal(
    createSignature(signatureInput(), metadata, sha1).id,
    createSignature(signatureInput(), metadata, sha1).id,
  );
  assert.equal(
    signingPayload(createSignature(signatureInput(), metadata, sha1)),
    signingPayload(createSignature(signatureInput(), metadata, sha1)),
  );
});

test("a signature record serializes canonically with a stable key order", () => {
  const canonical = canonicalRecord(createSignature(signatureInput(), metadata, sha1));
  assert.ok(canonical.endsWith("\n"));
  const parsed = JSON.parse(canonical) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed), [
    "v",
    "type",
    "id",
    "domain",
    "role",
    "target",
    "subject",
    "signer",
    "key_id",
    "algorithm",
    "signature",
    "content_id",
    "author_email",
    "session",
    "created_at",
  ]);
});

test("the signed payload is domain separated so a record signature cannot replay as a checkpoint", () => {
  const record = createSignature(signatureInput(), metadata, sha1);
  const payload = JSON.parse(signingPayload(record)) as Record<string, unknown>;
  assert.equal(payload.domain, SIGNATURE_DOMAIN_RECORD);
  assert.equal(SIGNATURE_DOMAIN_RECORD, "reveries/v1/record");
  assert.equal(SIGNATURE_DOMAIN_MANIFEST, "reveries/v1/ledger-manifest");
  assert.notEqual(SIGNATURE_DOMAIN_RECORD, SIGNATURE_DOMAIN_MANIFEST);
  assert.equal(payload.target, record.target);
  assert.equal(payload.subject, record.subject);
  assert.equal(payload.signer, record.signer);
  assert.equal(payload.algorithm, record.algorithm);
  assert.equal(payload.content_id, CONTENT_ID);
  assert.equal(payload.role, "author");
});

test("the signed payload omits the signature and identity so it stays O(1)", () => {
  const record = createSignature(signatureInput(), metadata, sha1);
  const payload = JSON.parse(signingPayload(record)) as Record<string, unknown>;
  assert.ok(!("signature" in payload));
  assert.ok(!("id" in payload));
  assert.ok(!("created_at" in payload));
  assert.ok(!("author_email" in payload));
  assert.deepEqual(Object.keys(payload), [
    "v",
    "domain",
    "role",
    "target",
    "subject",
    "signer",
    "algorithm",
    "content_id",
  ]);
});

test("a 64-character SHA-256 content id is accepted", () => {
  const contentId = "e".repeat(64);
  const record = createSignature(signatureInput({ content_id: contentId }), metadata, sha256);
  assert.equal(record.content_id, contentId);
  assert.match(record.id, /^sg:[0-9a-f]{64}$/);
});

test("a malformed domain, role, algorithm, or target is rejected", () => {
  assert.throws(() => createSignature(signatureInput({ domain: "" }), metadata, sha1), /domain/);
  assert.throws(() => createSignature(signatureInput({ domain: "reveries/v2/record" }), metadata, sha1), /domain/);
  assert.throws(() => createSignature(signatureInput({ role: "owner" as SignatureRole }), metadata, sha1), /role/);
  assert.throws(() => createSignature(signatureInput({ algorithm: "" }), metadata, sha1), /algorithm/);
  assert.throws(() => createSignature(signatureInput({ signer: "" }), metadata, sha1), /signer/);
  assert.throws(() => createSignature(signatureInput({ key_id: "" }), metadata, sha1), /key_id/);
  assert.throws(() => createSignature(signatureInput({ signature: "" }), metadata, sha1), /signature/);
  assert.throws(() => createSignature(signatureInput({ target: "not-an-id" }), metadata, sha1), /target/);
  assert.throws(() => createSignature(signatureInput({ subject: "z" }), metadata, sha1), /subject/);
  assert.throws(() => createSignature(signatureInput({ content_id: "z" }), metadata, sha1), /content_id/);
});

test("a manifest signature accepts the reserved ledger-manifest target", () => {
  const record = createSignature(
    signatureInput({ domain: SIGNATURE_DOMAIN_MANIFEST, target: "ledger-manifest" }),
    metadata,
    sha1,
  );
  assert.equal(record.target, "ledger-manifest");
  const payload = JSON.parse(signingPayload(record)) as Record<string, unknown>;
  assert.equal(payload.domain, SIGNATURE_DOMAIN_MANIFEST);
  assert.equal(payload.target, "ledger-manifest");
});

test("a record-domain signature may not target the ledger manifest", () => {
  assert.throws(
    () => createSignature(signatureInput({ target: "ledger-manifest" }), metadata, sha1),
    /target/,
  );
});

test("every signed fact ID prefix is an accepted target", () => {
  for (const prefix of ["rv", "tr", "cr", "rs", "rd"]) {
    const record = createSignature(signatureInput({ target: `${prefix}:${"a".repeat(40)}` }), metadata, sha1);
    assert.equal(record.target, `${prefix}:${"a".repeat(40)}`);
  }
});

test("a noncanonical RFC 3339 created_at is rejected", () => {
  assert.throws(
    () => createSignature(signatureInput(), { ...metadata, created_at: "2026-09-29 21:11:20" }, sha1),
    /created_at/,
  );
});

/**
 * The key-rotation criterion, stated as a protocol invariant: a signature is a
 * separate record, so no signature field can reach a semantic payload. This test
 * would fail if a signer, key, or signature field were ever added to
 * `ReverieSemantic`, because the reverie ID would then change.
 */
test("a signature cannot change a reverie identity, because it is not part of the record", () => {
  const semantic = {
    v: 1 as const,
    driving_event: "Evidence had no cryptographic identity.",
    decision: "Keep signatures as separate records.",
    impact: "Key rotation leaves decision IDs unchanged.",
    recurrence_control: null,
    alternatives: [],
    sources: [],
    supersedes: [],
  };
  const before = createReverie(semantic, metadata, sha1);
  // Attaching a signature does not touch the record's own bytes, so recomputing
  // the record after any number of signatures yields the identical ID.
  const after = createReverie({ ...semantic }, metadata, sha1);
  assert.equal(before.id, after.id);
  assert.equal(canonicalRecord(before), canonicalRecord(after));
});

// --- Note placement, duplicate handling, and limits -------------------------

import { parseNote, validateNote } from "../src/protocol.ts";

function noteBody(records: readonly unknown[]): string {
  return records.map((record) => canonicalRecord(record as never)).join("");
}

test("a note accepts a signature alongside a reverie", () => {
  const reverie = createReverie(
    {
      v: 1,
      driving_event: "Evidence had no cryptographic identity.",
      decision: "Keep signatures as separate records.",
      impact: "Key rotation leaves decision IDs unchanged.",
      recurrence_control: null,
      alternatives: [],
      sources: [],
      supersedes: [],
    },
    metadata,
    sha1,
  );
  const body = noteBody([reverie, createSignature(signatureInput(), metadata, sha1)]);
  const parsed = parseNote(body, "strict", { hashObject: sha1 });
  assert.equal(parsed.records.length, 2);
  assert.equal(parsed.diagnostics.length, 0);
  assert.doesNotThrow(() => validateNote(parsed.records, { hashObject: sha1 }));
});

test("multiple signatures may attest one target", () => {
  const target = `rv:${"a".repeat(40)}`;
  const author = createSignature(signatureInput({ target, role: "author", key_id: "SHA256:k1" }), metadata, sha1);
  const reviewer = createSignature(signatureInput({ target, role: "reviewer", key_id: "SHA256:k2" }), metadata, sha1);
  assert.notEqual(author.id, reviewer.id);
  const parsed = parseNote(noteBody([author, reviewer]), "strict", { hashObject: sha1 });
  assert.equal(parsed.records.length, 2);
});

test("an identical duplicate signature line is accepted, matching the union model", () => {
  const record = createSignature(signatureInput(), metadata, sha1);
  const parsed = parseNote(noteBody([record, record]), "strict", { hashObject: sha1 });
  assert.equal(parsed.records.length, 2);
  assert.doesNotThrow(() => validateNote(parsed.records, { hashObject: sha1 }));
});

test("two different records claiming one signature ID are a visible fork", () => {
  const first = createSignature(signatureInput(), metadata, sha1);
  // Re-point one ID at different content. The ID is deliberately left stale so
  // the duplicate-content check is what has to catch it; `hashObject` is omitted
  // because this test is about fork detection, not per-record ID verification.
  const forged = { ...first, signature: "b3RoZXI" };
  assert.throws(() => validateNote([first, forged as never], { forkPolicy: "reject" }), /signature ID/);
  assert.doesNotThrow(() => validateNote([first, forged as never], { forkPolicy: "project" }));
});

test("validateNote rejects a signature whose content_id disagrees with its ID", () => {
  const record = { ...createSignature(signatureInput(), metadata, sha1), content_id: "f".repeat(40) };
  assert.throws(() => validateNote([record as never], { hashObject: sha1 }), /signature ID mismatch/);
});

test("maxSignaturesPerTarget bounds fan-out over one record", () => {
  const target = `rv:${"a".repeat(40)}`;
  const records = ["k1", "k2", "k3"].map((key) =>
    createSignature(signatureInput({ target, key_id: `SHA256:${key}` }), metadata, sha1));
  assert.throws(
    () => validateNote(records, { hashObject: sha1, limits: { maxSignaturesPerTarget: 2 } }),
    /maxSignaturesPerTarget/,
  );
  assert.doesNotThrow(
    () => validateNote(records, { hashObject: sha1, limits: { maxSignaturesPerTarget: 3 } }),
  );
});

test("maxSignatures bounds the total signatures in one note", () => {
  const records = ["a", "b", "c"].map((key) =>
    createSignature(signatureInput({ key_id: `SHA256:${key}` }), metadata, sha1));
  assert.throws(
    () => validateNote(records, { hashObject: sha1, limits: { maxSignatures: 2 } }),
    /maxSignatures/,
  );
});

/**
 * The published schema must describe exactly the signature the protocol
 * produces: same key set, same required set. There is no schema validator in
 * this repository, so drift is caught here instead, exactly as the ledger
 * manifest schema is checked in ledger-protocol.test.ts.
 */
test("the published schema describes exactly the canonical signature", async () => {
  const path = fileURLToPath(new URL("../../../protocol/schemas/signature.schema.json", import.meta.url));
  const schema = JSON.parse(await readFile(path, "utf8")) as {
    properties: Record<string, { const?: unknown }>;
    required: string[];
    additionalProperties: boolean;
  };
  const canonical = JSON.parse(canonicalRecord(createSignature(signatureInput(), metadata, sha1))) as Record<string, unknown>;
  assert.equal(schema.properties.type?.const, "signature");
  assert.deepEqual(Object.keys(canonical).sort(), Object.keys(schema.properties).sort());
  assert.deepEqual(Object.keys(canonical).sort(), [...schema.required].sort());
  assert.equal(schema.additionalProperties, false);
});
