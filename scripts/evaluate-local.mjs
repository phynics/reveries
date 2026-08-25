import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const json = process.argv.includes("--json");
const strict = process.argv.includes("--strict");
const cache = await mkdtemp(join(tmpdir(), "reveries-evaluation-npm-"));

const evidence = (file, test) => ({ file, test });

const criteria = [
  { category: "protocol-git", criterion: "Create reverie and read exact blob", status: "covered", evidence: [evidence("packages/reveries/test/operations.integration.ts", "records, shows, and continues a decision onto a staged successor blob")] },
  { category: "protocol-git", criterion: "Unchanged rename retains reverie", status: "partial", reason: "Blob identity makes this true, but no dedicated rename test exercises it." },
  { category: "protocol-git", criterion: "Identical copy resolves same reverie", status: "partial", reason: "The duplicate-blob deletion test uses identical content, but does not assert note lookup through both paths." },
  { category: "protocol-git", criterion: "Edited blob does not silently inherit decisions", status: "covered", evidence: [evidence("packages/reveries/test/operations.integration.ts", "records, shows, and continues a decision onto a staged successor blob")] },
  { category: "protocol-git", criterion: "Continue validates", status: "covered", evidence: [evidence("packages/reveries/test/operations.integration.ts", "records, shows, and continues a decision onto a staged successor blob")] },
  { category: "protocol-git", criterion: "Supersede validates", status: "covered", evidence: [evidence("packages/reveries/test/operations.integration.ts", "merge continuity is checked independently from every parent")] },
  { category: "protocol-git", criterion: "Retire validates", status: "covered", evidence: [evidence("packages/reveries/test/protocol.test.ts", "continuity accepts a causal retirement")] },
  { category: "protocol-git", criterion: "Missing disposition fails", status: "covered", evidence: [evidence("packages/reveries/test/protocol.test.ts", "continuity requires continue, supersede, or retire for every changed annotated blob")] },
  { category: "protocol-git", criterion: "Merge checks both parents", status: "covered", evidence: [evidence("packages/reveries/test/operations.integration.ts", "merge continuity is checked independently from every parent")] },
  { category: "protocol-git", criterion: "Forked supersession is detected", status: "covered", evidence: [evidence("packages/reveries/test/protocol.test.ts", "active projection exposes terminal reveries and detects forks")] },
  { category: "protocol-git", criterion: "Supersession cycle is detected", status: "covered", evidence: [evidence("packages/reveries/test/protocol.test.ts", "active projection detects supersession cycles")] },
  { category: "protocol-git", criterion: "Malformed JSON is inspectable but fails strict operations", status: "covered", evidence: [evidence("packages/reveries/test/protocol.test.ts", "tolerant parsing preserves valid records and reports malformed lines"), evidence("packages/reveries/test/hooks.test.ts", "malformed notes are suppressed rather than injected")] },
  { category: "protocol-git", criterion: "Noncanonical JSON fails strict operations", status: "covered", evidence: [evidence("packages/reveries/test/protocol.test.ts", "strict parsing accepts canonical JSONL and rejects noncanonical JSON")] },
  { category: "protocol-git", criterion: "Same ID with conflicting semantic content fails", status: "uncovered", reason: "Forged IDs are tested, but two records sharing an ID with different semantic payloads are not." },
  { category: "protocol-git", criterion: "Two clones merge independent records without loss", status: "covered", evidence: [evidence("packages/reveries/test/git.integration.ts", "two clones merge independent canonical note lines without loss")] },
  { category: "protocol-git", criterion: "Two summaries on one commit conflict", status: "covered", evidence: [evidence("packages/reveries/test/operations.integration.ts", "summary replacement keeps the initialization record and rejects concurrent duplicates")] },
  { category: "protocol-git", criterion: "Amend requires fresh summary", status: "uncovered", reason: "No rewrite fixture exercises amend." },
  { category: "protocol-git", criterion: "Rebase requires fresh summaries", status: "uncovered", reason: "No rewrite fixture exercises rebase." },
  { category: "protocol-git", criterion: "Squash requires fresh summary", status: "uncovered", reason: "No rewrite fixture exercises squash." },
  { category: "protocol-git", criterion: "Cherry-pick requires fresh summary", status: "uncovered", reason: "No rewrite fixture exercises cherry-pick." },
  { category: "protocol-git", criterion: "Pre-initialization history is grandfathered", status: "uncovered", reason: "Summary coverage tests start at the adoption commit but do not assert an older commit directly." },
  { category: "protocol-git", criterion: "New published branches contain initialization boundary", status: "partial", reason: "Pre-push tests cover an outgoing descendant, not a branch that omits adoption." },
  { category: "protocol-git", criterion: "SHA-1 repositories generate correct IDs", status: "covered", evidence: [evidence("packages/reveries/test/git.integration.ts", "hashes semantic payloads with the repository object format")] },
  { category: "protocol-git", criterion: "SHA-256 repositories generate correct IDs", status: "covered", evidence: [evidence("packages/reveries/test/operations.integration.ts", "repository-backed semantic IDs use SHA-256 when the repository does")] },
  { category: "protocol-git", criterion: "Linked worktrees share notes state and lock", status: "covered", evidence: [evidence("packages/reveries/test/git.integration.ts", "linked worktrees use the same common-directory lock")] },
  { category: "protocol-git", criterion: "Non-fast-forward notes push fails safely", status: "uncovered", reason: "Clone merge is covered, but rejection of a stale direct notes push is not." },
  { category: "protocol-git", criterion: "Arbitrary unstaged object write is refused", status: "covered", evidence: [evidence("packages/reveries/test/operations.integration.ts", "continuity refuses an arbitrary unstaged object")] },

  { category: "initialization", criterion: "Repeated initialization is idempotent", status: "covered", evidence: [evidence("packages/reveries/test/install.integration.ts", "initialization is explicit and idempotent")] },
  { category: "initialization", criterion: "Existing AGENTS prose is preserved", status: "covered", evidence: [evidence("packages/reveries/test/install.integration.ts", "initialization is explicit and idempotent")] },
  { category: "initialization", criterion: "Duplicate or malformed markers are refused", status: "covered", evidence: [evidence("packages/reveries/test/install.integration.ts", "malformed or duplicated owned markers are refused")] },
  { category: "initialization", criterion: "Unknown hooks are not overwritten", status: "covered", evidence: [evidence("packages/reveries/test/install.integration.ts", "unknown hooks are preserved and reported as partial enforcement")] },
  { category: "initialization", criterion: "Removal preserves notes ref", status: "covered", evidence: [evidence("packages/reveries/test/install.integration.ts", "removal keeps the notes ref and unknown prose")] },
  { category: "initialization", criterion: "User is queried for publishing remotes", status: "environment-blocked", reason: "The Skill owns the conversation. Native agent invocation is outside this local CLI evaluator." },
  { category: "initialization", criterion: "Multiple remotes are supported", status: "uncovered", reason: "The implementation loops over remotes, but no integration test selects two remotes." },
  { category: "initialization", criterion: "Directive email is not invented", status: "partial", reason: "The API requires and validates an email, but no test rejects omission through the Skill workflow." },
  { category: "initialization", criterion: "Host files are created only when selected", status: "partial", reason: "Selected Claude and Gemini files are tested, but unselected-host absence is not asserted." },

  { category: "skills", criterion: "Skill names and frontmatter are structurally valid", status: "local-static" },
  { category: "skills", criterion: "Skill descriptions trigger intended workflows", status: "environment-blocked", reason: "Trigger behavior requires a real agent host." },
  { category: "skills", criterion: "Init does not activate implicitly", status: "environment-blocked", reason: "Activation requires a real agent host." },
  { category: "skills", criterion: "Use activates for annotated edits and commits", status: "environment-blocked", reason: "Activation requires a real agent host." },
  { category: "skills", criterion: "Search activates for rationale questions", status: "environment-blocked", reason: "Activation requires a real agent host." },
  { category: "skills", criterion: "Search never mutates", status: "partial", reason: "The Skill text is read-only, but no host-level mutation audit exists." },
  { category: "skills", criterion: "Main Skill files stay within disclosure limits", status: "local-static" },
  { category: "skills", criterion: "Direct Git reference works without helper", status: "partial", reason: "Commands are documented and core Git behavior is tested, but the cookbook is not executed as a standalone scenario." },

  { category: "host-adapters", criterion: "Native automatic-delivery conformance", status: "not-claimed", reason: "All hosts are graded CORE. No host/version claims verified delivery." },
  { category: "installer", criterion: "Global npx Skills install for five hosts", status: "environment-blocked", reason: "Requires network access and writes outside the project." },
  { category: "installer", criterion: "Skills update and removal paths", status: "environment-blocked", reason: "Requires an installed external Skills CLI and global host directories." },
];

async function run(command, args) {
  const started = performance.now();
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd: workspace,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => resolvePromise({
      ok: false,
      command: [command, ...args],
      duration_ms: Math.round(performance.now() - started),
      stdout: "",
      stderr: error.message,
    }));
    child.on("close", (code) => resolvePromise({
      ok: code === 0,
      command: [command, ...args],
      duration_ms: Math.round(performance.now() - started),
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
}

async function validateSkills() {
  const names = [
    "reveries-git-notes-init",
    "using-reveries",
    "reveries-git-notes-search",
  ];
  const failures = [];
  for (const name of names) {
    const path = join(workspace, "skills", name, "SKILL.md");
    const content = await readFile(path, "utf8");
    const frontmatter = content.match(/^---\n([\s\S]*?)\n---\n/);
    if (frontmatter === null || !frontmatter[1].includes(`name: ${name}`)) {
      failures.push(`${name}: invalid or mismatched frontmatter name`);
    }
    if (!frontmatter?.[1].includes("description:")) failures.push(`${name}: missing description`);
    if (content.split("\n").length > 120) failures.push(`${name}: main Skill exceeds 120 lines`);
  }
  await readFile(join(workspace, "skills", "using-reveries", "references", "direct-git.md"), "utf8");
  return failures;
}

async function validateEvidence() {
  const cacheByFile = new Map();
  const failures = [];
  for (const criterion of criteria.filter((item) => item.status === "covered")) {
    for (const item of criterion.evidence) {
      let content = cacheByFile.get(item.file);
      if (content === undefined) {
        content = await readFile(join(workspace, item.file), "utf8");
        cacheByFile.set(item.file, content);
      }
      if (!content.includes(`test("${item.test}"`)) {
        failures.push(`${criterion.criterion}: missing evidence test '${item.test}'`);
      }
    }
  }
  return failures;
}

try {
  const gates = [];
  gates.push(await run("npm", ["run", "typecheck"]));
  gates.push(await run("npm", ["run", "test:full"]));
  gates.push(await run("npm", ["run", "conformance"]));
  gates.push(await run("npm", [
    "pack",
    "--dry-run",
    "--workspace", "@reveries/cli",
    "--cache", cache,
  ]));
  gates.push(await run("git", ["diff", "--check", "HEAD"]));

  const skillFailures = await validateSkills();
  const evidenceFailures = await validateEvidence();
  const localStaticOk = skillFailures.length === 0;
  for (const criterion of criteria.filter((item) => item.status === "local-static")) {
    criterion.status = localStaticOk ? "covered" : "failed";
    criterion.reason = localStaticOk ? "Validated by the local evaluator." : skillFailures.join("; ");
  }

  const counts = Object.fromEntries(
    [...new Set(criteria.map((item) => item.status))]
      .map((status) => [status, criteria.filter((item) => item.status === status).length]),
  );
  const gatesOk = gates.every((gate) => gate.ok);
  const releaseReady = gatesOk
    && evidenceFailures.length === 0
    && criteria.every((item) => item.status === "covered" || item.status === "not-claimed");
  const result = {
    generated_at: new Date().toISOString(),
    environment: {
      network_used: false,
      external_writes: false,
      native_host_testing: false,
    },
    gates: gates.map(({ ok, command, duration_ms, stderr }) => ({
      ok,
      command,
      duration_ms,
      diagnostic: ok ? null : stderr.trim(),
    })),
    acceptance: {
      counts,
      evidence_failures: evidenceFailures,
      skill_failures: skillFailures,
      criteria,
    },
    release_ready: releaseReady,
  };

  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write("Reveries local evaluation\n\n");
    for (const gate of result.gates) {
      process.stdout.write(`${gate.ok ? "PASS" : "FAIL"} ${gate.command.join(" ")} (${gate.duration_ms} ms)\n`);
      if (!gate.ok && gate.diagnostic !== null) process.stdout.write(`  ${gate.diagnostic.replaceAll("\n", "\n  ")}\n`);
    }
    process.stdout.write("\nAcceptance coverage\n");
    for (const [status, count] of Object.entries(counts).sort()) {
      process.stdout.write(`${status}: ${count}\n`);
    }
    const gaps = criteria.filter((item) => item.status !== "covered" && item.status !== "not-claimed");
    if (gaps.length > 0) {
      process.stdout.write("\nGaps and environment limits\n");
      for (const item of gaps) process.stdout.write(`${item.status.toUpperCase()} ${item.criterion}: ${item.reason}\n`);
    }
    process.stdout.write(`\nRelease ready: ${releaseReady ? "yes" : "no"}\n`);
  }

  if (!gatesOk || evidenceFailures.length > 0 || skillFailures.length > 0 || (strict && !releaseReady)) {
    process.exitCode = 1;
  }
} finally {
  await rm(cache, { recursive: true, force: true });
}
