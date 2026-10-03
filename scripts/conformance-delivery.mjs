// RVR-020 AUTOMATIC DELIVERY conformance grade runner.
//
// AUTOMATIC DELIVERY names the agent host and version tested by native
// delivery fixtures. Recorded Skill-routing evidence (evidence/pi-skills.json)
// is checked for freshness, but routing evidence must never imply that the
// DESIGN section 36.4 20-case native adapter suite passed: every host stays
// "not-claimed" until its named version passes that suite.
//
// Run: node scripts/conformance-delivery.mjs [--json]
// Capture: node scripts/conformance-delivery.mjs --json > evidence/conformance-delivery.json

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUTOMATIC_DELIVERY,
  criterion,
  hasFlag,
  nodeVersion,
  reportEnvelope,
  runStep,
} from "./conformance-report.mjs";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const HOSTS = ["pi", "claude-code", "opencode", "codex", "gemini-cli"];

export const DELIVERY_CRITERIA = [
  { id: "skill-routing-evidence-fresh", name: "Recorded Skill-routing evidence matches the checked-in Skills", kind: "suite", evidence: "scripts/native-skill-evidence.mjs (verify mode) over evidence/pi-skills.json" },
  ...HOSTS.map((host) => ({
    id: `adapter-suite-20-case-${host}`,
    name: `The 20-case native adapter suite passes for ${host}`,
    kind: "manual",
    evidence: "DESIGN section 36.4; no executable suite run has been recorded for any host version",
  })),
];

export const DELIVERY_GRADE_BLOCKERS = [
  "the 20-case native adapter suite has not passed for any named host version",
];

export function deliveryReport(results, context = {}) {
  const criteria = DELIVERY_CRITERIA.map((item) => {
    const result = results[item.id] ?? { status: "not-claimed", detail: "criterion was not executed" };
    return criterion({ id: item.id, name: item.name, status: result.status, evidence: item.evidence, detail: result.detail ?? null });
  });
  return reportEnvelope({
    grade: AUTOMATIC_DELIVERY,
    host: context.host ?? { name: "pi", version: "0.84.1" },
    mergeMode: "not-applicable (delivery grade names agent hosts, not merge modes)",
    repository: context.repository ?? "not-applicable (native host behavior, not a repository fixture)",
    evidenceScale: context.evidenceScale ?? {},
    criteria,
    blockers: [...DELIVERY_GRADE_BLOCKERS],
  });
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  const asJson = hasFlag(process.argv.slice(2), "--json");
  const results = {};
  let recorded = null;
  try {
    recorded = JSON.parse(await readFile(join(workspace, "evidence", "pi-skills.json"), "utf8"));
  } catch {
    recorded = null;
  }
  const verifier = await runStep(process.execPath, ["scripts/native-skill-evidence.mjs"], { cwd: workspace, timeout: 300000 });
  results["skill-routing-evidence-fresh"] = verifier.ok
    ? {
      status: "passed",
      detail: `native Skill evidence verifier exited 0 in ${verifier.ms} ms; routing evidence alone does not imply delivery`,
    }
    : { status: "failed", detail: `evidence verifier failed (${verifier.code}): ${verifier.stderr.slice(-2000)}` };
  for (const host of HOSTS) {
    results[`adapter-suite-20-case-${host}`] = { status: "not-claimed", detail: "no executable suite run has been recorded for this host" };
  }

  const caseCount = recorded && typeof recorded.cases === "object" ? Object.keys(recorded.cases).length : 0;
  const report = deliveryReport(results, {
    host: {
      name: recorded?.host?.name ?? "pi",
      version: recorded?.host?.version ?? "0.84.1",
    },
    evidenceScale: {
      recorded_cases: caseCount,
      recorded_model: recorded?.model ?? null,
      runner: nodeVersion(),
    },
  });

  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write("Reveries AUTOMATIC DELIVERY conformance\n\n");
    for (const item of report.criteria) {
      process.stdout.write(`${item.status.toUpperCase().padEnd(10)} ${item.id}: ${item.detail ?? item.name}\n`);
    }
    process.stdout.write(`\nVerdict: ${report.verdict}\n`);
    for (const blocker of report.blockers) process.stdout.write(`Blocker: ${blocker}\n`);
  }
  if (report.verdict !== "verified") process.exitCode = 1;
}
