import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AUTOMATIC_DELIVERY,
  HOSTED,
  LOCAL,
  TEAM,
  criterion,
  hasFlag,
  reportEnvelope,
  runStep,
} from "./conformance-report.mjs";

test("the report envelope names grade, host and version, merge mode, repository, and evidence scale", () => {
  const report = reportEnvelope({
    grade: TEAM,
    host: { name: "local-git-fixture", version: "git 2.39.5" },
    mergeMode: "not-applicable",
    repository: "disposable bare origin + 2 clones",
    evidenceScale: { records: 2, unit: "notes lines" },
    criteria: [criterion({ id: "example", name: "Example", status: "passed" })],
    blockers: [],
  });
  assert.equal(report.grade, TEAM);
  assert.equal(report.host.name, "local-git-fixture");
  assert.equal(report.host.version, "git 2.39.5");
  assert.equal(report.merge_mode, "not-applicable");
  assert.match(report.repository, /disposable/);
  assert.equal(report.evidence_scale.records, 2);
  assert.equal(report.verdict, "verified");
  assert.ok(typeof report.generated_at === "string");
});

test("a grade with open blockers is unverified, never inferred from another grade", () => {
  const local = reportEnvelope({
    grade: LOCAL,
    host: { name: "node", version: "v24" },
    mergeMode: "not-applicable",
    repository: "local worktree",
    evidenceScale: {},
    criteria: [criterion({ id: "local-ok", name: "Local ok", status: "passed" })],
    blockers: [],
  });
  assert.equal(local.verdict, "verified");

  const team = reportEnvelope({
    grade: TEAM,
    host: { name: "local-git-fixture", version: "git 2.39.5" },
    mergeMode: "not-applicable",
    repository: "disposable bare origin + 2 clones",
    evidenceScale: {},
    criteria: [criterion({ id: "team-ok", name: "Team ok", status: "passed" })],
    blockers: ["no multi-user pilot"],
  });
  assert.equal(team.verdict, "unverified");
});

test("a failed criterion fails its own grade report", () => {
  const report = reportEnvelope({
    grade: HOSTED,
    host: { name: "github", version: "unverified — no deployment" },
    mergeMode: "merge",
    repository: "not-applicable",
    evidenceScale: {},
    criteria: [criterion({ id: "broken", name: "Broken", status: "failed", detail: "boom" })],
    blockers: [],
  });
  assert.equal(report.verdict, "failed");
});

test("automatic delivery without a passed adapter suite is not-claimed", () => {
  const report = reportEnvelope({
    grade: AUTOMATIC_DELIVERY,
    host: { name: "pi", version: "0.84.1" },
    mergeMode: "not-applicable",
    repository: "not-applicable",
    evidenceScale: { cases: 6 },
    criteria: [criterion({ id: "routing", name: "Routing", status: "passed" })],
    blockers: ["20-case native adapter suite has not passed for pi 0.84.1"],
  });
  assert.equal(report.verdict, "not-claimed");
});

test("hasFlag detects exact CLI flags", () => {
  assert.equal(hasFlag(["--json"], "--json"), true);
  assert.equal(hasFlag([], "--json"), false);
  assert.equal(hasFlag(["--jsonish"], "--json"), false);
});

test("runStep captures exit code, duration, and output", async () => {
  const ok = await runStep(process.execPath, ["-e", "process.stdout.write('hi')"], {});
  assert.equal(ok.ok, true);
  assert.equal(ok.code, 0);
  assert.equal(ok.stdout, "hi");
  assert.ok(ok.ms >= 0);

  const failing = await runStep(process.execPath, ["-e", "process.exit(3)"], {});
  assert.equal(failing.ok, false);
  assert.equal(failing.code, 3);
});
