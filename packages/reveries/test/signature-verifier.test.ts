import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SIGNATURE_DOMAIN_RECORD,
  canonicalRecord,
  createSignature,
  signingPayload,
  type SignatureRole,
} from "../src/protocol.ts";
import {
  createLocalEd25519Signer,
  createLocalEd25519Verifier,
  ed25519KeyId,
  generateEd25519KeyPair,
  readTrustStore,
  type SignatureSigner,
  type SignatureVerifier,
} from "../src/git.ts";

const metadata = { author_email: "runner@example.test", session: null, created_at: "2026-09-29T21:11:20Z" };

function baseInput(signer: string, keyId: string, signature: string) {
  return {
    domain: SIGNATURE_DOMAIN_RECORD,
    role: "author" as SignatureRole,
    target: `rv:${"a".repeat(40)}`,
    subject: "b".repeat(40),
    signer,
    key_id: keyId,
    algorithm: "ed25519",
    signature,
    content_id: "c".repeat(40),
  };
}

test("a generated ed25519 key pair produces a stable SHA256 fingerprint", () => {
  const pair = generateEd25519KeyPair();
  assert.match(pair.keyId, /^SHA256:[0-9a-f]{64}$/);
  assert.equal(pair.keyId, ed25519KeyId(pair.publicKey));
  // Deterministic: the same public key always yields the same key ID, which is
  // what lets a trust store refer to a key without embedding the key itself.
  assert.equal(ed25519KeyId(pair.publicKey), ed25519KeyId(pair.publicKey));
});

test("different keys produce different key IDs", () => {
  assert.notEqual(generateEd25519KeyPair().keyId, generateEd25519KeyPair().keyId);
});

test("the default verifier accepts a signature the default signer produced", () => {
  const pair = generateEd25519KeyPair();
  const signer: SignatureSigner = createLocalEd25519Signer({
    signer: "alice@example.test",
    keyId: pair.keyId,
    privateKey: pair.privateKey,
  });
  const verifier: SignatureVerifier = createLocalEd25519Verifier({ [pair.keyId]: pair.publicKey });

  const payload = Buffer.from('{"v":1,"domain":"reveries/v1/record"}', "utf8");
  const signature = signer.sign(payload);

  assert.equal(verifier.verify({ payload, signature, keyId: pair.keyId }), true);
  assert.equal(signer.algorithm, "ed25519");
  assert.equal(verifier.algorithm, "ed25519");
});

test("a signature over different bytes does not verify", () => {
  const pair = generateEd25519KeyPair();
  const signer = createLocalEd25519Signer({
    signer: "alice@example.test",
    keyId: pair.keyId,
    privateKey: pair.privateKey,
  });
  const verifier = createLocalEd25519Verifier({ [pair.keyId]: pair.publicKey });

  const signature = signer.sign(Buffer.from("original payload", "utf8"));
  const other = verifier.verify({
    payload: Buffer.from("tampered payload", "utf8"),
    signature,
    keyId: pair.keyId,
  });
  assert.equal(other, false);
});

test("a signature from a different key does not verify against this key ID", () => {
  const alice = generateEd25519KeyPair();
  const mallory = generateEd25519KeyPair();
  const mallorySigner = createLocalEd25519Signer({
    signer: "mallory@example.test",
    keyId: mallory.keyId,
    privateKey: mallory.privateKey,
  });
  const verifier = createLocalEd25519Verifier({ [alice.keyId]: alice.publicKey });

  const payload = Buffer.from("payload", "utf8");
  const signature = mallorySigner.sign(payload);
  assert.equal(verifier.verify({ payload, signature, keyId: alice.keyId }), false);
});

test("a key the verifier does not know does not verify", () => {
  const alice = generateEd25519KeyPair();
  const signer = createLocalEd25519Signer({
    signer: "alice@example.test",
    keyId: alice.keyId,
    privateKey: alice.privateKey,
  });
  const verifier = createLocalEd25519Verifier({});
  const payload = Buffer.from("payload", "utf8");
  assert.equal(verifier.verify({ payload, signature: signer.sign(payload), keyId: alice.keyId }), false);
});

test("malformed signature or key material never throws, it only fails to verify", () => {
  const pair = generateEd25519KeyPair();
  const verifier = createLocalEd25519Verifier({ [pair.keyId]: pair.publicKey });
  const payload = Buffer.from("payload", "utf8");
  assert.equal(verifier.verify({ payload, signature: new Uint8Array(0), keyId: pair.keyId }), false);
  assert.equal(verifier.verify({ payload, signature: Buffer.from("nonsense"), keyId: pair.keyId }), false);
  assert.equal(verifier.verify({ payload, signature: Buffer.from("AAAA"), keyId: pair.keyId }), false);
});

test("a full sign-then-verify round trip over a signature record works", () => {
  const pair = generateEd25519KeyPair();
  const signer = createLocalEd25519Signer({
    signer: "alice@example.test",
    keyId: pair.keyId,
    privateKey: pair.privateKey,
  });
  const verifier = createLocalEd25519Verifier({ [pair.keyId]: pair.publicKey });

  const draft = baseInput("alice@example.test", pair.keyId, "");
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      domain: SIGNATURE_DOMAIN_RECORD,
      role: draft.role,
      target: draft.target,
      subject: draft.subject,
      signer: draft.signer,
      algorithm: "ed25519",
      content_id: draft.content_id,
    }),
    "utf8",
  );
  const record = createSignature(
    { ...draft, signature: Buffer.from(signer.sign(payload)).toString("base64") },
    metadata,
    () => "d".repeat(40) as never,
  );
  const verified = verifier.verify({
    payload: Buffer.from(signingPayload(record), "utf8"),
    signature: Buffer.from(record.signature, "base64"),
    keyId: record.key_id,
  });
  assert.equal(verified, true);
  assert.ok(canonicalRecord(record).endsWith("\n"));
});

test("a trust store is read as public key material plus revocation", async () => {
  const pair = generateEd25519KeyPair();
  const store = await readTrustStore({
    keys: [{ key_id: pair.keyId, signer: "alice@example.test", revoked: false, public_key: pair.publicKey }],
  });
  assert.equal(store.keys.length, 1);
  const [entry] = store.keys;
  assert.equal(entry?.signer, "alice@example.test");
  assert.equal(entry?.revoked, false);
  assert.equal(entry?.public_key, pair.publicKey);
});

test("a trust store entry without public key material is rejected", async () => {
  await assert.rejects(
    () => readTrustStore({ keys: [{ key_id: "SHA256:aa", signer: "alice@example.test", revoked: false }] }),
    /public_key/,
  );
});

test("an empty trust store is valid and authorizes nothing", async () => {
  const store = await readTrustStore({ keys: [] });
  assert.deepEqual(store.keys, []);
});
