import assert from "node:assert/strict";
import { test } from "node:test";

import { assertNoSecretMaterial, scanSecretMaterial, SECRET_SCAN_WARNING } from "../src/sensitive-evidence.ts";

test("recognizes realistic fake credentials without returning matched bytes", () => {
  const fakeGithubToken = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";
  const fakeAwsKey = "AKIAIOSFODNN7EXAMPLE";
  const fakePrivateKey = "-----BEGIN OPENSSH PRIVATE KEY-----";
  const text = `token=${fakeGithubToken}; access key ${fakeAwsKey}; ${fakePrivateKey}`;

  const findings = scanSecretMaterial(text);

  assert.deepEqual(new Set(findings.map(({ kind }) => kind)), new Set([
    "github-token",
    "aws-access-key",
    "private-key",
    "credential-assignment",
  ]));
  assert.equal(JSON.stringify(findings).includes(fakeGithubToken), false);
  assert.equal(JSON.stringify(findings).includes(fakeAwsKey), false);
});

test("writes refuse detected secrets without echoing them and state the scanner limit", () => {
  const fakeToken = "sk_test_0123456789abcdefghijklmnop";

  assert.throws(
    () => assertNoSecretMaterial(`A draft includes ${fakeToken}`, "Reverie"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Do not store secrets/);
      assert.match(error.message, /cannot prove that evidence is secret-free/);
      assert.equal(error.message.includes(fakeToken), false);
      return true;
    },
  );
  assert.match(SECRET_SCAN_WARNING, /review evidence manually/);
});
