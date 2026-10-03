import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SIGNATURE_DOMAIN_RECORD,
  canonicalRecord,
  classifySignature,
  createSignature,
  type SignatureRecord,
  type SignatureRole,
  type SigningPolicy,
  type TrustStore,
} from "../src/protocol.ts";
import { hashBlobContent } from "../src/git.ts";

const sha1 = (bytes: Uint8Array) => hashBlobContent(bytes, "sha1");
const SUBJECT = "b".repeat(40);
const CONTENT_ID = "c".repeat(40);
const KEY = "SHA256:aaaabbbb";
const OTHER_KEY = "SHA256:ccccdddd";

const metadata = { author_email: "runner@example.test", session: null, created_at: "2026-09-29T21:11:20Z" };

function signature(overrides: Partial<Parameters<typeof createSignature>[0]> = {}): SignatureRecord {
  return createSignature({
    domain: SIGNATURE_DOMAIN_RECORD,
    role: "author" as SignatureRole,
    target: `rv:${"a".repeat(40)}`,
    subject: SUBJECT,
    signer: "alice@example.test",
    key_id: KEY,
    algorithm: "ed25519",
    signature: "c2ln",
    content_id: CONTENT_ID,
    ...overrides,
  }, metadata, sha1);
}

function trustStore(overrides: Partial<TrustStore> = {}): TrustStore {
  return {
    keys: [{ key_id: KEY, signer: "alice@example.test", revoked: false }],
    ...overrides,
  };
}

const policy: SigningPolicy = { requiredRoles: ["author", "reviewer"] };

/** Trust state is a strict refinement, so every case below is total. */
function stateOf(
  record: SignatureRecord,
  store: TrustStore,
  verified: boolean,
  signingPolicy: SigningPolicy = policy,
): string {
  return classifySignature(record, { verdict: { verified }, trust: store, policy: signingPolicy }).state;
}

test("a key the trust store has never seen is unknown, not invalid", () => {
  assert.equal(stateOf(signature({ key_id: "SHA256:never-seen" }), trustStore(), true), "unknown");
});

test("an unknown key stays unknown even when the bytes do not verify", () => {
  // Trust is resolved before cryptography: an unverifiable key we know nothing
  // about is not a claim of forgery, it is an unresolvable one.
  assert.equal(stateOf(signature({ key_id: "SHA256:never-seen" }), trustStore(), false), "unknown");
});

test("a revoked key is revoked whether or not the bytes verify", () => {
  const store = trustStore({ keys: [{ key_id: KEY, signer: "alice@example.test", revoked: true }] });
  assert.equal(stateOf(signature(), store, true), "revoked");
  assert.equal(stateOf(signature(), store, false), "revoked");
});

test("a known key with failing bytes is invalid", () => {
  assert.equal(stateOf(signature(), trustStore(), false), "invalid");
});

test("a verifying key the trust store does not bind to this signer is merely valid", () => {
  const store = trustStore({ keys: [{ key_id: KEY, signer: "mallory@example.test", revoked: false }] });
  assert.equal(stateOf(signature(), store, true), "valid");
});

test("a verifying key bound to the signer is trusted but not yet policy-satisfying", () => {
  // The role here is `author` and the policy requires both author and reviewer,
  // so the single signature is trusted while the policy is still unsatisfied.
  assert.equal(stateOf(signature({ role: "author" }), trustStore(), true, { requiredRoles: ["reviewer"] }), "trusted");
});

test("a trusted signature whose role the policy requires is policy-satisfying", () => {
  assert.equal(stateOf(signature({ role: "reviewer" }), trustStore(), true, { requiredRoles: ["reviewer"] }), "policy-satisfying");
});

test("an empty required-roles policy cannot be satisfied by any signature", () => {
  // A repository that configures no roles must not report its signatures as
  // policy-satisfying; trusted is the honest ceiling.
  assert.equal(stateOf(signature(), trustStore(), true, { requiredRoles: [] }), "trusted");
});

test("invalid and revoked signatures stay visible in the report", () => {
  const revoked = signature();
  const report = classifySignature(revoked, {
    verdict: { verified: true },
    trust: trustStore({ keys: [{ key_id: KEY, signer: "alice@example.test", revoked: true }] }),
    policy,
  });
  assert.equal(report.state, "revoked");
  assert.equal(report.id, revoked.id);
  assert.equal(report.signer, "alice@example.test");
  assert.equal(report.key_id, KEY);
  assert.equal(report.role, "author");
  assert.equal(report.target, revoked.target);
});

test("a trust entry bound to the same key twice is contradictory and rejected", () => {
  const store: TrustStore = {
    keys: [
      { key_id: KEY, signer: "alice@example.test", revoked: false },
      { key_id: KEY, signer: "mallory@example.test", revoked: false },
    ],
  };
  assert.throws(() => stateOf(signature(), store, true), /trust|key/i);
});

test("a trust store entry with an empty signer or key is rejected", () => {
  assert.throws(
    () => stateOf(signature(), { keys: [{ key_id: KEY, signer: "", revoked: false }] }, true),
    /signer/,
  );
  assert.throws(
    () => stateOf(signature(), { keys: [{ key_id: "", signer: "alice@example.test", revoked: false }] }, true),
    /key_id/,
  );
});

test("the report records the verifier diagnostic without discarding the signature", () => {
  const record = signature();
  const report = classifySignature(record, {
    verdict: { verified: false, diagnostic: "malformed signature length" },
    trust: trustStore(),
    policy,
  });
  assert.equal(report.state, "invalid");
  assert.deepEqual(report.diagnostics, ["malformed signature length"]);
  assert.equal(report.id, record.id);
});

test("classification is pure and repeatable", () => {
  const record = signature();
  const store = trustStore();
  const first = classifySignature(record, { verdict: { verified: true }, trust: store, policy });
  const second = classifySignature(record, { verdict: { verified: true }, trust: store, policy });
  assert.deepEqual(first, second);
  // The input record is not mutated by classification: its canonical bytes are
  // identical before and after, so no trust verdict is written back into it.
  assert.equal(canonicalRecord(record), canonicalRecord(signature()));
});

test("a publisher role is independently satisfiable", () => {
  assert.equal(
    stateOf(signature({ role: "publisher" }), trustStore(), true, { requiredRoles: ["publisher"] }),
    "policy-satisfying",
  );
  assert.equal(
    stateOf(signature({ role: "publisher" }), trustStore(), true, { requiredRoles: ["author"] }),
    "trusted",
  );
});
