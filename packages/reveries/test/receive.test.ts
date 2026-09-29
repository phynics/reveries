import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyReceiveDiagnostic } from "../src/receive.ts";

test("missing notes publication diagnostics classify with remediation", () => {
  for (const diagnostic of [
    "Code updates must include a proposed refs/notes/reveries update",
    "Code updates must include a non-deleting refs/notes/reveries update",
  ]) {
    const finding = classifyReceiveDiagnostic(diagnostic);
    assert.equal(finding.code, "missing-notes-publication");
    assert.equal(finding.grade, "strict");
    assert.equal(finding.detail, diagnostic);
    assert.equal(finding.ref, "refs/notes/reveries");
    assert.match(finding.remediation, /refs\/notes\/reveries/);
  }
});

test("missing session summary diagnostics classify with ref and commit", () => {
  const commit = "a".repeat(40);
  const finding = classifyReceiveDiagnostic(
    `refs/pull/27/head ${commit}: Commit ${commit} requires exactly one valid session summary`,
  );
  assert.equal(finding.code, "missing-session-summary");
  assert.equal(finding.grade, "strict");
  assert.equal(finding.ref, "refs/pull/27/head");
  assert.equal(finding.commit, commit);
  assert.match(finding.remediation, /session-summary/);
});

test("missing continuity dispositions classify with ref and commit", () => {
  const commit = "b".repeat(40);
  const blob = "c".repeat(40);
  const missing = classifyReceiveDiagnostic(
    `refs/pull/27/head ${commit}: rv:${"d".repeat(40)} from ${blob}: missing-disposition`,
  );
  assert.equal(missing.code, "missing-continuity-disposition");
  assert.equal(missing.ref, "refs/pull/27/head");
  assert.equal(missing.commit, commit);
  assert.match(missing.remediation, /continue/i);

  const ambiguous = classifyReceiveDiagnostic(
    `refs/pull/27/head ${commit}: rv:${"d".repeat(40)} from ${blob}: ambiguous-disposition`,
  );
  assert.equal(ambiguous.code, "missing-continuity-disposition");

  const invalid = classifyReceiveDiagnostic(
    `refs/pull/27/head ${commit}: predecessor blob ${blob} has an invalid reverie projection`,
  );
  assert.equal(invalid.code, "missing-continuity-disposition");
});

test("doubly prefixed ref diagnostics classify with ref and commit", () => {
  const commit = "e".repeat(40);
  const finding = classifyReceiveDiagnostic(
    `refs/heads/main: refs/heads/main ${commit}: Commit ${commit} requires exactly one valid session summary`,
  );
  assert.equal(finding.code, "missing-session-summary");
  assert.equal(finding.ref, "refs/heads/main");
  assert.equal(finding.commit, commit);
});

test("unrecognized diagnostics pass through with a generic code", () => {
  const finding = classifyReceiveDiagnostic("refs/heads/main: old object does not match the current ref");
  assert.equal(finding.code, "other");
  assert.equal(finding.grade, "strict");
  assert.equal(finding.detail, "refs/heads/main: old object does not match the current ref");
  assert.ok(finding.remediation.length > 0);
});
