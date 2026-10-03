// RVR-020 conformance grade report envelope.
//
// Every conformance grade (LOCAL, TEAM, HOSTED, AUTOMATIC DELIVERY) produces
// its own report through reportEnvelope(). A verdict is computed only from
// that grade's own criteria and blockers: a passing lower grade never implies
// a higher one. Vocabulary:
//   verified    - every executable criterion passed and no blockers remain.
//   unverified  - executable evidence is recorded but a grade-level blocker
//                 (e.g. no multi-user pilot, no host deployment) stays open.
//   not-claimed - the grade is explicitly not asserted (automatic delivery
//                 until a named host/version passes the adapter suite).
//   failed      - at least one executable criterion of this grade failed.

import { execFile } from "node:child_process";

export const LOCAL = "LOCAL";
export const TEAM = "TEAM";
export const HOSTED = "HOSTED";
export const AUTOMATIC_DELIVERY = "AUTOMATIC_DELIVERY";

export const GRADES = [LOCAL, TEAM, HOSTED, AUTOMATIC_DELIVERY];

export function criterion({ id, name, status, evidence = null, detail = null }) {
  if (!id || !name) throw new Error("criterion requires id and name");
  if (!["passed", "failed", "unverified", "not-claimed"].includes(status)) {
    throw new Error(`criterion ${id} has unknown status ${status}`);
  }
  return { id, name, status, evidence, detail };
}

export function reportEnvelope({
  grade,
  host,
  mergeMode,
  repository,
  evidenceScale,
  criteria,
  blockers = [],
}) {
  if (!GRADES.includes(grade)) throw new Error(`unknown grade ${grade}`);
  if (!host?.name || !host?.version) throw new Error("report requires host name and version");
  const failed = criteria.filter((item) => item.status === "failed");
  let verdict;
  if (failed.length > 0) verdict = "failed";
  else if (blockers.length > 0) verdict = grade === AUTOMATIC_DELIVERY ? "not-claimed" : "unverified";
  else verdict = "verified";
  return {
    grade,
    generated_at: new Date().toISOString(),
    host: { name: host.name, version: host.version },
    merge_mode: mergeMode,
    repository,
    evidence_scale: evidenceScale,
    criteria,
    blockers,
    verdict,
  };
}

export function hasFlag(argv, flag) {
  return argv.includes(flag);
}

export function nodeVersion() {
  return process.version;
}

export function gitVersion(cwd) {
  return new Promise((resolvePromise) => {
    execFile("git", ["--version"], { cwd }, (error, stdout) => {
      if (error) resolvePromise("unknown");
      else resolvePromise(stdout.trim());
    });
  });
}

export function runStep(command, args, options = {}) {
  const started = performance.now();
  return new Promise((resolvePromise) => {
    execFile(command, args, { cwd: options.cwd, env: process.env, timeout: options.timeout }, (error, stdout, stderr) => {
      const ms = Math.round(performance.now() - started);
      if (error) {
        resolvePromise({
          ok: false,
          code: typeof error.code === "number" ? error.code : 1,
          ms,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? error.message ?? ""),
        });
      } else {
        resolvePromise({ ok: true, code: 0, ms, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      }
    });
  });
}
