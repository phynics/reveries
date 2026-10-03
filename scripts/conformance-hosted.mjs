// RVR-020 HOSTED conformance grade runner.
//
// HOSTED names the host and version, pull request type, fork behavior, merge
// method, merge queue, required checks, permissions, transport failures, and
// recovery. The locally executable evidence (receive fixture, post-merge
// fixture, workflow trust-boundary tests) runs here as subprocesses. Every
// merge-method matrix cell stays "unverified" until a named host deployment
// with the Reveries App installed provides evidence — a local pass must never
// imply hosted readiness.
//
// Run: node scripts/conformance-hosted.mjs [--json]
// Capture: node scripts/conformance-hosted.mjs --json > evidence/conformance-hosted.json

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HOSTED,
  criterion,
  gitVersion,
  hasFlag,
  nodeVersion,
  reportEnvelope,
  runStep,
} from "./conformance-report.mjs";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const HOSTED_CRITERIA = [
  { id: "receive-fixture-validates-proposals", name: "The receive fixture validates proposed ref updates", kind: "suite", evidence: "scripts/receive-fixture.mjs" },
  { id: "post-merge-summarizes-host-commits", name: "Host-created merge, squash, and rebase commits receive summaries", kind: "suite", evidence: "scripts/post-merge-fixture.mjs" },
  { id: "github-trust-boundary-pinned", name: "The GitHub check runs base-controlled code with read-only permissions", kind: "suite", evidence: "scripts/github-receive-check.test.mjs + scripts/reveries-post-merge.test.mjs" },
  { id: "merge-method-merge", name: "Merge-commit pull requests carry evidence on a live host", kind: "manual", evidence: "requires a named host deployment with the Reveries App installed" },
  { id: "merge-method-squash", name: "Squash-merge pull requests carry evidence on a live host", kind: "manual", evidence: "requires a named host deployment with the Reveries App installed" },
  { id: "merge-method-rebase", name: "Rebase-merge pull requests carry evidence on a live host", kind: "manual", evidence: "requires a named host deployment with the Reveries App installed" },
  { id: "merge-method-queue", name: "Merge-queue commits carry evidence on a live host", kind: "manual", evidence: "requires a named host deployment with the Reveries App installed" },
  { id: "fork-behavior-isolated", name: "Fork pull request code is never executed by the checks", kind: "manual", evidence: "requires a live fork pull request against the deployment" },
  { id: "required-checks-live", name: "Branch protection requires the App-owned check", kind: "manual", evidence: "requires a live repository with REVERIES_APP_ID configured" },
  { id: "transport-failure-recovery", name: "Transport failures and recovery are recorded against the deployment", kind: "manual", evidence: "requires a named host deployment" },
];

export const HOSTED_GRADE_BLOCKERS = [
  "no named host deployment exists: merge-method, fork, required-check, and recovery cells are unverified",
];

const MERGE_MODES = "merge | squash | rebase | merge-queue (each unverified without a live deployment)";

export function hostedReport(results, context = {}) {
  const criteria = HOSTED_CRITERIA.map((item) => {
    const result = results[item.id] ?? { status: "failed", detail: "criterion was not executed" };
    return criterion({ id: item.id, name: item.name, status: result.status, evidence: item.evidence, detail: result.detail ?? null });
  });
  return reportEnvelope({
    grade: HOSTED,
    host: context.host ?? { name: "github", version: "unverified — no deployment" },
    mergeMode: MERGE_MODES,
    repository: context.repository ?? "not-applicable (no live repository under check)",
    evidenceScale: context.evidenceScale ?? {},
    criteria,
    blockers: [...HOSTED_GRADE_BLOCKERS],
  });
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  const asJson = hasFlag(process.argv.slice(2), "--json");
  const results = {};
  const durations = {};
  const run = async (id, command, args, label) => {
    const result = await runStep(command, args, { cwd: workspace, timeout: 600000 });
    durations[id] = result.ms;
    results[id] = result.ok
      ? { status: "passed", detail: `${label} exited 0 in ${result.ms} ms` }
      : { status: "failed", detail: `${label} failed (${result.code}): ${result.stderr.slice(-2000)}` };
  };

  await run("receive-fixture-validates-proposals", process.execPath, ["scripts/receive-fixture.mjs"], "receive fixture");
  await run("post-merge-summarizes-host-commits", process.execPath, ["scripts/post-merge-fixture.mjs"], "post-merge fixture");
  await run(
    "github-trust-boundary-pinned",
    process.execPath,
    ["--test", "scripts/github-receive-check.test.mjs", "scripts/reveries-post-merge.test.mjs"],
    "workflow trust-boundary tests",
  );
  for (const item of HOSTED_CRITERIA.filter((entry) => entry.kind === "manual")) {
    results[item.id] = { status: "unverified", detail: item.evidence };
  }

  const hostVersion = await gitVersion(workspace);
  const report = hostedReport(results, {
    host: { name: "github", version: "unverified — no deployment" },
    repository: "not-applicable (no live repository under check)",
    evidenceScale: { suite_ms: durations, runner: nodeVersion(), git: hostVersion },
  });

  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write("Reveries HOSTED conformance\n\n");
    for (const item of report.criteria) {
      process.stdout.write(`${item.status.toUpperCase().padEnd(10)} ${item.id}: ${item.detail ?? item.name}\n`);
    }
    process.stdout.write(`\nVerdict: ${report.verdict}\n`);
    for (const blocker of report.blockers) process.stdout.write(`Blocker: ${blocker}\n`);
  }
  if (report.verdict !== "verified") process.exitCode = 1;
}
