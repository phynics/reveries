// RVR-020 TEAM conformance grade runner.
//
// TEAM covers multiple writers and clones, failure recovery, retention,
// incomplete clones, resource limits, and published scale results. Each
// criterion is executable: plain-Git fixtures run in disposable repositories
// and src-level behavior is composed from the existing integration tests and
// benchmark scripts (invoked as subprocesses, never reimplemented here).
//
// A stable TEAM claim additionally requires a completed multi-user pilot, so
// this runner reports verdict "unverified" and exits non-zero until pilot
// evidence exists — even when every executable check passes. No TEAM result
// is ever inferred from the LOCAL grade.
//
// Run: node scripts/conformance-team.mjs [--json]
// Capture: node scripts/conformance-team.mjs --json > evidence/conformance-team.json

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TEAM,
  criterion,
  gitVersion,
  hasFlag,
  nodeVersion,
  reportEnvelope,
  runStep,
} from "./conformance-report.mjs";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const TEAM_CRITERIA = [
  { id: "multi-clone-writers-converge", name: "Two clones merge independent notes without loss", kind: "fixture", evidence: "concurrent writers fixture below (plain Git notes merge)" },
  { id: "stale-notes-push-rejected", name: "A stale notes push fails safely and leaves the remote untouched", kind: "fixture", evidence: "stale push fixture below (non-fast-forward rejection)" },
  { id: "invalid-union-fails-closed", name: "An invalid concurrent notes union fails closed", kind: "suite", evidence: "packages/reveries/test/hosted-summary.integration.ts (invalid concurrent union)" },
  { id: "cas-retry-converges", name: "A concurrent writer is incorporated before the compare-and-swap push", kind: "suite", evidence: "packages/reveries/test/hosted-summary.integration.ts (concurrent writer)" },
  { id: "force-push-and-deleted-branch-detected", name: "Force-push and deleted-branch cases are detected on fetch", kind: "fixture", evidence: "forced-update fixture below (fetch --prune)" },
  { id: "gc-retention-survives", name: "Retained annotated objects survive aggressive pruning", kind: "suite", evidence: "packages/reveries/test/operations.integration.ts + git.integration.ts (retention)" },
  { id: "shallow-clone-reports-bounded-history", name: "A shallow clone reports bounded history", kind: "fixture", evidence: "shallow fixture below (--depth 1)" },
  { id: "partial-clone-defers-blobs", name: "A partial clone defers blobs through a promisor remote", kind: "fixture", evidence: "partial fixture below (--filter=blob:none over file://)" },
  { id: "concurrent-worktree-writers-retry", name: "A writer outside the shared lock forces a compare-and-swap retry", kind: "suite", evidence: "packages/reveries/test/git.integration.ts (worktree lock and CAS retry)" },
  { id: "fuzz-corpus-exercised", name: "A fuzz corpus exercises note parsing", kind: "manual", evidence: "no fuzzer is committed; see gaps" },
  { id: "resource-limits-hold", name: "Protocol resource ceilings hold under adversarial inputs", kind: "suite", evidence: "scripts/protocol-limits-benchmark.mjs + protocol-limits.test.ts" },
  { id: "snapshot-scale-published", name: "Snapshot loader scale results publish latency and memory", kind: "suite", evidence: "scripts/reveries-snapshot-benchmark.mjs + snapshot.integration.ts" },
  { id: "transport-scale-published", name: "Transport scale results publish repository size, record count, and latency", kind: "fixture", evidence: "scale fixture below (300 commits, 50 notes)" },
  { id: "multi-user-pilot-completed", name: "A multi-user repository pilot is completed and recorded", kind: "manual", evidence: "no pilot has been recorded; see gaps" },
];

export const TEAM_GRADE_BLOCKERS = [
  "no multi-user pilot has been completed and recorded: a stable TEAM claim requires one",
  "fuzz-corpus-exercised is unverified: no note-parsing fuzzer is committed",
];

const GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Reveries Team Fixture",
  GIT_AUTHOR_EMAIL: "team-fixture@example.com",
  GIT_COMMITTER_NAME: "Reveries Team Fixture",
  GIT_COMMITTER_EMAIL: "team-fixture@example.com",
};

async function git(cwd, ...args) {
  const result = await runStep("git", ["-c", "user.name=Reveries Team Fixture", "-c", "user.email=team-fixture@example.com", ...args], { cwd });
  if (!result.ok) throw new Error(`git ${args.join(" ")} failed (${result.code})\n${result.stderr}`);
  return result.stdout.trim();
}

async function writeCommit(dir, name, content, message) {
  await writeFile(join(dir, name), content, "utf8");
  await git(dir, "add", name);
  await git(dir, "commit", "-q", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

export function teamReport(results, context = {}) {
  const criteria = TEAM_CRITERIA.map((item) => {
    const result = results[item.id] ?? { status: "failed", detail: "criterion was not executed" };
    return criterion({ id: item.id, name: item.name, status: result.status, evidence: item.evidence, detail: result.detail ?? null });
  });
  return reportEnvelope({
    grade: TEAM,
    host: context.host ?? { name: "local-git-fixture", version: "unknown" },
    mergeMode: "not-applicable (transport grade; hosted merge modes belong to HOSTED)",
    repository: context.repository ?? "disposable bare origin with file:// and local clones",
    evidenceScale: context.evidenceScale ?? {},
    criteria,
    blockers: [...TEAM_GRADE_BLOCKERS],
  });
}

async function fixtureConcurrentWriters(root) {
  const origin = join(root, "writers.git");
  await runStep("git", ["init", "-q", "-b", "main", "--bare", origin], { cwd: root });
  const seed = join(root, "seed");
  await runStep("git", ["clone", "-q", origin, seed], { cwd: root });
  const first = await writeCommit(seed, "state.txt", "one\n", "first");
  const second = await writeCommit(seed, "state.txt", "two\n", "second");
  await git(seed, "push", "-q", "origin", "main");
  const cloneA = join(root, "writer-a");
  const cloneB = join(root, "writer-b");
  await runStep("git", ["clone", "-q", origin, cloneA], { cwd: root });
  await runStep("git", ["clone", "-q", origin, cloneB], { cwd: root });

  await git(cloneA, "notes", "--ref=reveries", "add", "-m", '{"v":1,"from":"A"}', first);
  await git(cloneA, "push", "-q", "origin", "refs/notes/reveries");
  const notesTipAfterA = await git(seed, "ls-remote", origin, "refs/notes/reveries").then((out) => out.split(/\s/)[0]);

  await git(cloneB, "notes", "--ref=reveries", "add", "-m", '{"v":1,"from":"B"}', second);
  const stalePush = await runStep("git", ["push", "origin", "refs/notes/reveries"], { cwd: cloneB });
  const notesTipAfterStale = await git(seed, "ls-remote", origin, "refs/notes/reveries").then((out) => out.split(/\s/)[0]);
  const staleRejected = !stalePush.ok && notesTipAfterStale === notesTipAfterA;

  await git(cloneB, "fetch", "-q", "origin", "refs/notes/reveries");
  await git(cloneB, "notes", "--ref=reveries", "merge", "FETCH_HEAD");
  const listed = await git(cloneB, "notes", "--ref=reveries", "list");
  const unionComplete = listed.split("\n").filter(Boolean).length === 2;
  await git(cloneB, "push", "-q", "origin", "refs/notes/reveries");

  return {
    "multi-clone-writers-converge": unionComplete
      ? { status: "passed", detail: "two independent notes merged without loss and pushed" }
      : { status: "failed", detail: `expected 2 merged notes, got: ${listed}` },
    "stale-notes-push-rejected": staleRejected
      ? { status: "passed", detail: "non-fast-forward notes push rejected; remote tip unchanged" }
      : { status: "failed", detail: `stale push ok=${stalePush.ok}, remote moved=${notesTipAfterStale !== notesTipAfterA}` },
  };
}

async function fixtureForcedUpdate(root) {
  const origin = join(root, "forced.git");
  await runStep("git", ["init", "-q", "-b", "main", "--bare", origin], { cwd: root });
  const seed = join(root, "forced-seed");
  await runStep("git", ["clone", "-q", origin, seed], { cwd: root });
  await writeCommit(seed, "main.txt", "base\n", "base");
  await git(seed, "push", "-q", "origin", "main");
  await git(seed, "checkout", "-q", "-b", "feature");
  await writeCommit(seed, "feature.txt", "v1\n", "feature v1");
  await git(seed, "push", "-q", "origin", "feature");
  await git(seed, "checkout", "-q", "-b", "obsolete");
  await writeCommit(seed, "obsolete.txt", "gone\n", "obsolete");
  await git(seed, "push", "-q", "origin", "obsolete");
  const observer = join(root, "forced-observer");
  await runStep("git", ["clone", "-q", origin, observer], { cwd: root });
  await git(observer, "fetch", "-q", "origin", "feature", "obsolete");
  const beforeForce = await git(observer, "rev-parse", "origin/feature");

  await git(seed, "checkout", "-q", "feature");
  await git(seed, "commit", "-q", "--amend", "-m", "feature v1 rewritten");
  await git(seed, "push", "-q", "--force", "origin", "feature");
  await git(seed, "push", "-q", "origin", "--delete", "obsolete");
  const afterForce = await git(seed, "rev-parse", "feature");
  await git(observer, "fetch", "-q", "--prune", "origin");
  const observed = await git(observer, "rev-parse", "origin/feature");
  const branches = await git(observer, "branch", "-r");
  const detected = observed === afterForce && observed !== beforeForce && !branches.includes("origin/obsolete");
  return {
    "force-push-and-deleted-branch-detected": detected
      ? { status: "passed", detail: "forced tip change and pruned deletion both observed" }
      : { status: "failed", detail: `observed=${observed} expected=${afterForce} branches=${branches}` },
  };
}

async function fixtureShallow(root) {
  const origin = join(root, "shallow.git");
  await runStep("git", ["init", "-q", "-b", "main", "--bare", origin], { cwd: root });
  const seed = join(root, "shallow-seed");
  await runStep("git", ["clone", "-q", origin, seed], { cwd: root });
  for (let index = 0; index < 5; index += 1) {
    await writeCommit(seed, "f.txt", `rev ${index}\n`, `rev ${index}`);
  }
  await git(seed, "push", "-q", "origin", "main");
  const shallow = join(root, "shallow-clone");
  await runStep("git", ["clone", "-q", "--depth", "1", `file://${origin}`, shallow], { cwd: root });
  const count = await git(shallow, "rev-list", "--count", "HEAD");
  const isShallow = await git(shallow, "rev-parse", "--is-shallow-repository");
  const bounded = count === "1" && isShallow === "true";
  return {
    "shallow-clone-reports-bounded-history": bounded
      ? { status: "passed", detail: "depth-1 clone sees 1 of 5 commits and reports shallow" }
      : { status: "failed", detail: `count=${count} shallow=${isShallow}` },
  };
}

async function fixturePartial(root) {
  const origin = join(root, "partial.git");
  await runStep("git", ["init", "-q", "-b", "main", "--bare", origin], { cwd: root });
  await runStep("git", ["--git-dir", origin, "config", "uploadpack.allowFilter", "true"], { cwd: root });
  const seed = join(root, "partial-seed");
  await runStep("git", ["clone", "-q", origin, seed], { cwd: root });
  await writeCommit(seed, "blob.txt", "checked-out\n", "blob commit");
  await git(seed, "checkout", "-q", "-b", "side");
  await writeCommit(seed, "deferred.bin", `${"deferred-bytes\n".repeat(200)}`, "deferred blob commit");
  const blob = await git(seed, "rev-parse", "side:deferred.bin");
  await git(seed, "push", "-q", "origin", "main", "side");
  const partial = join(root, "partial-clone");
  const cloned = await runStep("git", ["clone", "-q", "--filter=blob:none", `file://${origin}`, partial], { cwd: root });
  if (!cloned.ok) {
    return { "partial-clone-defers-blobs": { status: "failed", detail: `partial clone failed: ${cloned.stderr}` } };
  }
  const promisor = await git(partial, "config", "--get", "remote.origin.promisor");
  const filter = await git(partial, "config", "--get", "remote.origin.partialclonefilter");
  const before = await runStep("git", ["cat-file", "--batch-check", "--batch-all-objects"], { cwd: partial });
  const absentBefore = !before.stdout.split("\n").some((line) => line.startsWith(blob));
  const onDemand = await runStep("git", ["cat-file", "-e", blob], { cwd: partial });
  const after = await runStep("git", ["cat-file", "--batch-check", "--batch-all-objects"], { cwd: partial });
  const presentAfter = after.stdout.split("\n").some((line) => line.startsWith(blob));
  const deferred = promisor === "true" && filter === "blob:none" && absentBefore && onDemand.ok && presentAfter;
  return {
    "partial-clone-defers-blobs": deferred
      ? { status: "passed", detail: "promisor remote omits blobs until first access, then serves them on demand" }
      : { status: "failed", detail: `promisor=${promisor} filter=${filter} absentBefore=${absentBefore} onDemand=${onDemand.ok} presentAfter=${presentAfter}` },
  };
}

async function fixtureScale(root) {
  const started = performance.now();
  const rssBefore = process.memoryUsage().rss;
  const origin = join(root, "scale.git");
  await runStep("git", ["init", "-q", "-b", "main", "--bare", origin], { cwd: root });
  const seed = join(root, "scale-seed");
  await runStep("git", ["clone", "-q", origin, seed], { cwd: root });
  const commits = 300;
  for (let index = 0; index < commits; index += 1) {
    await writeCommit(seed, `file-${index % 10}.txt`, `scale revision ${index}\n`, `scale ${index}`);
    if (index % 6 === 0) {
      const target = await git(seed, "rev-parse", "HEAD");
      await git(seed, "notes", "--ref=reveries", "add", "-m", `{"v":1,"scale":${index}}`, target);
    }
  }
  await git(seed, "push", "-q", "origin", "main");
  await git(seed, "push", "-q", "origin", "refs/notes/reveries");
  const cloneStarted = performance.now();
  const cloneDir = join(root, "scale-clone");
  await runStep("git", ["clone", "-q", origin, cloneDir], { cwd: root });
  const cloneMs = Math.round(performance.now() - cloneStarted);
  const fetchStarted = performance.now();
  await git(cloneDir, "fetch", "-q", "origin", "refs/notes/*:refs/notes/*");
  const fetchMs = Math.round(performance.now() - fetchStarted);
  const recordCount = Number(await git(cloneDir, "rev-list", "--count", "HEAD"));
  const noteCount = (await git(cloneDir, "notes", "--ref=reveries", "list")).split("\n").filter(Boolean).length;
  const du = await runStep("du", ["-sb", origin], { cwd: root });
  const repoBytes = Number(du.stdout.split(/\s/)[0]);
  const scale = {
    commits: recordCount,
    notes: noteCount,
    repo_bytes: repoBytes,
    clone_ms: cloneMs,
    notes_fetch_ms: fetchMs,
    runner_rss_delta_bytes: process.memoryUsage().rss - rssBefore,
    runner_total_ms: Math.round(performance.now() - started),
  };
  const ok = recordCount === commits && noteCount === 50 && Number.isFinite(repoBytes);
  return {
    result: {
      "transport-scale-published": ok
        ? { status: "passed", detail: `${commits} commits and 50 notes round-tripped through a fresh clone` }
        : { status: "failed", detail: `commits=${recordCount} notes=${noteCount} bytes=${repoBytes}` },
    },
    scale,
  };
}

async function runSuite(command, args, label, timeoutMs = 600000) {
  const result = await runStep(command, args, { cwd: workspace, timeout: timeoutMs });
  return {
    status: result.ok ? "passed" : "failed",
    detail: result.ok ? `${label} exited 0 in ${result.ms} ms` : `${label} failed (${result.code}): ${result.stderr.slice(-2000)}`,
  };
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  const asJson = hasFlag(process.argv.slice(2), "--json");
  const root = await mkdtemp(join(tmpdir(), "reveries-team-"));
  process.env = { ...process.env, ...GIT_ENV };
  const results = {};
  let scale = {};
  try {
    Object.assign(results, await fixtureConcurrentWriters(root));
    Object.assign(results, await fixtureForcedUpdate(root));
    Object.assign(results, await fixtureShallow(root));
    Object.assign(results, await fixturePartial(root));
    const scaleFixture = await fixtureScale(root);
    Object.assign(results, scaleFixture.result);
    scale = scaleFixture.scale;

    const nodeTest = [process.execPath, "--experimental-transform-types", "--test"];
    results["invalid-union-fails-closed"] = await runSuite(
      nodeTest[0],
      [...nodeTest.slice(1), "--test-name-pattern=invalid concurrent union", "packages/reveries/test/hosted-summary.integration.ts"],
      "hosted-summary invalid-union",
    );
    results["cas-retry-converges"] = await runSuite(
      nodeTest[0],
      [...nodeTest.slice(1), "--test-name-pattern=concurrent writer", "packages/reveries/test/hosted-summary.integration.ts"],
      "hosted-summary concurrent-writer",
    );
    results["gc-retention-survives"] = await runSuite(
      nodeTest[0],
      [...nodeTest.slice(1), "--test-name-pattern=retention|aggressive pruning", "packages/reveries/test/operations.integration.ts", "packages/reveries/test/git.integration.ts"],
      "retention and pruning",
    );
    results["concurrent-worktree-writers-retry"] = await runSuite(
      nodeTest[0],
      [...nodeTest.slice(1), "--test-name-pattern=compare-and-swap retry|common-directory lock|two clones merge", "packages/reveries/test/git.integration.ts"],
      "worktree lock and CAS retry",
    );
    const limitsBench = await runSuite(process.execPath, ["--experimental-transform-types", "scripts/protocol-limits-benchmark.mjs"], "protocol limits benchmark");
    const limitsUnit = await runSuite(nodeTest[0], [...nodeTest.slice(1), "packages/reveries/test/protocol-limits.test.ts"], "protocol limits unit");
    results["resource-limits-hold"] = limitsBench.status === "passed" && limitsUnit.status === "passed"
      ? { status: "passed", detail: `benchmark and unit suites green (${limitsBench.detail}; ${limitsUnit.detail})` }
      : { status: "failed", detail: `benchmark: ${limitsBench.detail}; unit: ${limitsUnit.detail}` };
    const snapshotBench = await runSuite(process.execPath, ["--experimental-transform-types", "scripts/reveries-snapshot-benchmark.mjs"], "snapshot benchmark");
    const snapshotTests = await runSuite(nodeTest[0], [...nodeTest.slice(1), "packages/reveries/test/snapshot.integration.ts"], "snapshot integration");
    results["snapshot-scale-published"] = snapshotBench.status === "passed" && snapshotTests.status === "passed"
      ? { status: "passed", detail: `benchmark and integration green (${snapshotBench.detail}; ${snapshotTests.detail}); run the benchmark directly for the full latency/memory table` }
      : { status: "failed", detail: `benchmark: ${snapshotBench.detail}; integration: ${snapshotTests.detail}` };

    results["fuzz-corpus-exercised"] = { status: "unverified", detail: "no note-parsing fuzzer is committed" };
    results["multi-user-pilot-completed"] = { status: "unverified", detail: "no multi-user pilot has been recorded" };
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const hostVersion = await gitVersion(workspace);
  const report = teamReport(results, {
    host: { name: "local-git-fixture", version: `${nodeVersion()}, ${hostVersion}` },
    repository: "disposable bare origins with local and file:// clones (removed after the run)",
    evidenceScale: { transport: scale, unit: "commits, notes, bytes, milliseconds" },
  });

  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write("Reveries TEAM conformance\n\n");
    for (const item of report.criteria) {
      process.stdout.write(`${item.status.toUpperCase().padEnd(10)} ${item.id}: ${item.detail ?? item.name}\n`);
    }
    process.stdout.write(`\nVerdict: ${report.verdict}\n`);
    for (const blocker of report.blockers) process.stdout.write(`Blocker: ${blocker}\n`);
  }
  if (report.verdict !== "verified") process.exitCode = 1;
}
