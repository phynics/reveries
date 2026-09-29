import assert from "node:assert/strict";
import { test } from "node:test";
import { HOSTED_CRITERIA, HOSTED_GRADE_BLOCKERS, hostedReport } from "./conformance-hosted.mjs";

const REQUIRED_IDS = [
  "receive-fixture-validates-proposals",
  "post-merge-summarizes-host-commits",
  "github-trust-boundary-pinned",
  "merge-method-merge",
  "merge-method-squash",
  "merge-method-rebase",
  "merge-method-queue",
  "fork-behavior-isolated",
  "required-checks-live",
  "transport-failure-recovery",
];

test("the HOSTED table names the executable fixtures and every merge-mode matrix cell", () => {
  const ids = HOSTED_CRITERIA.map((item) => item.id);
  for (const required of REQUIRED_IDS) {
    assert.ok(ids.includes(required), `HOSTED criteria miss ${required}`);
  }
});

test("HOSTED stays unverified without a named host deployment", () => {
  assert.ok(HOSTED_GRADE_BLOCKERS.some((blocker) => blocker.match(/deployment/i)));
  const report = hostedReport(
    Object.fromEntries(HOSTED_CRITERIA.map((item) => [item.id, { status: "passed", detail: "ok" }])),
  );
  assert.equal(report.grade, "HOSTED");
  assert.equal(report.verdict, "unverified");
});

test("the HOSTED report names host version and merge modes without claiming them", () => {
  const report = hostedReport(
    Object.fromEntries(HOSTED_CRITERIA.map((item) => [item.id, { status: "passed" }])),
  );
  assert.ok(report.host.name.length > 0);
  assert.ok(report.host.version.match(/unverified/i));
  assert.ok(report.merge_mode.match(/merge.*squash.*rebase.*queue/s));
});
