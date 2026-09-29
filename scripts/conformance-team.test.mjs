import assert from "node:assert/strict";
import { test } from "node:test";
import { TEAM_CRITERIA, TEAM_GRADE_BLOCKERS, teamReport } from "./conformance-team.mjs";

const REQUIRED_IDS = [
  "multi-clone-writers-converge",
  "stale-notes-push-rejected",
  "invalid-union-fails-closed",
  "cas-retry-converges",
  "force-push-and-deleted-branch-detected",
  "gc-retention-survives",
  "shallow-clone-reports-bounded-history",
  "partial-clone-defers-blobs",
  "concurrent-worktree-writers-retry",
  "fuzz-corpus-exercised",
  "resource-limits-hold",
  "snapshot-scale-published",
  "transport-scale-published",
  "multi-user-pilot-completed",
];

test("the TEAM table covers every RVR-020 multi-user, failure, and scale item", () => {
  const ids = TEAM_CRITERIA.map((item) => item.id);
  for (const required of REQUIRED_IDS) {
    assert.ok(ids.includes(required), `TEAM criteria miss ${required}`);
  }
});

test("TEAM stays unverified while the multi-user pilot blocker is open", () => {
  assert.ok(TEAM_GRADE_BLOCKERS.some((blocker) => blocker.match(/pilot/i)));
  const report = teamReport(
    Object.fromEntries(TEAM_CRITERIA.map((item) => [item.id, { status: "passed", detail: "fixture green" }])),
  );
  assert.equal(report.grade, "TEAM");
  assert.equal(report.verdict, "unverified");
  assert.ok(report.blockers.some((blocker) => blocker.match(/pilot/i)));
});

test("a failed TEAM check fails the grade report", () => {
  const results = Object.fromEntries(TEAM_CRITERIA.map((item) => [item.id, { status: "passed" }]));
  results["stale-notes-push-rejected"] = { status: "failed", detail: "remote moved" };
  const report = teamReport(results);
  assert.equal(report.verdict, "failed");
});

test("the TEAM report names host and version, merge mode, repository, and evidence scale", () => {
  const report = teamReport(
    Object.fromEntries(TEAM_CRITERIA.map((item) => [item.id, { status: "passed" }])),
  );
  assert.ok(report.host.name.length > 0);
  assert.ok(report.host.version.length > 0);
  assert.ok(report.merge_mode.length > 0);
  assert.ok(report.repository.length > 0);
  assert.ok(report.evidence_scale !== null && typeof report.evidence_scale === "object");
});
