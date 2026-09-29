import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, input = "", cwd = workspace) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.on("close", (code) => resolvePromise({
      code: code ?? 128,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
    child.stdin.end(input);
  });
}

export function gitIn(cwd) {
  return async (...args) => {
    const result = await run("git", args, "", cwd);
    if (result.code !== 0) throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
    return result.stdout.trim();
  };
}

export function resolveTargetDir(options = {}) {
  // The checker binary stays anchored at this script's source tree (the
  // action source). Only Git object reads move into the target directory,
  // so building from a pinned action revision never executes target code.
  if (typeof options.targetDir === "string" && options.targetDir.length > 0) {
    return resolve(options.targetDir);
  }
  const fromEnv = process.env.REVERIES_TARGET_DIR;
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    return resolve(fromEnv);
  }
  return workspace;
}

export function parseScriptArgs(argv) {
  const options = { allowPrDescriptionSummary: false, forkEvidenceManifestPath: null, targetDir: null };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--allow-pr-description-summary") {
      options.allowPrDescriptionSummary = true;
    } else if (token === "--target-dir") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--target-dir requires a value");
      }
      options.targetDir = value;
      index += 1;
    } else if (token === "--fork-evidence-manifest") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--fork-evidence-manifest requires a value");
      }
      options.forkEvidenceManifestPath = value;
      index += 1;
    } else {
      throw new Error(`unknown option ${token}`);
    }
  }
  return options;
}

export async function readForkEvidenceManifest(path) {
  const manifest = JSON.parse(await readFile(path, "utf8"));
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`The fork evidence manifest at ${path} must be a JSON object`);
  }
  return manifest;
}

export async function createReceiveProposal(event, git, options = {}) {
  const allowPrDescriptionSummary = options.allowPrDescriptionSummary === true;
  const forkEvidence = options.forkEvidence ?? null;
  const notesTip = await git("rev-parse", "refs/notes/reveries");
  let baseSha;
  let headSha;
  let ref;
  if (event.pull_request !== undefined) {
    baseSha = event.pull_request.base.sha;
    headSha = event.pull_request.head.sha;
    ref = `refs/pull/${event.pull_request.number}/head`;
  } else if (event.merge_group !== undefined) {
    baseSha = event.merge_group.base_sha;
    headSha = event.merge_group.head_sha;
    ref = event.merge_group.base_ref;
  } else {
    throw new Error("Reveries receive check only supports pull_request and merge_group events");
  }

  const baseTree = await git("rev-parse", `${baseSha}^{tree}`);
  const transitionBaseSha = event.pull_request === undefined
    ? baseSha
    : await git("merge-base", baseSha, headSha);
  let notesOld = notesTip;
  let notesNew = notesTip;
  const evidence = [
    { object: headSha, base_tree: baseTree },
    { object: notesTip },
  ];
  if (forkEvidence !== null) {
    // Fork evidence arrives as Git objects plus a JSON manifest; the fork's
    // code is never checked out or executed. The manifest only selects which
    // notes tip the proposal carries.
    if (forkEvidence.state !== "imported") {
      throw new Error("The fork evidence manifest reports no imported evidence; the fork must publish refs/notes/reveries");
    }
    const pullNumber = event.pull_request?.number;
    if (forkEvidence.pull_request !== pullNumber) {
      throw new Error("The fork evidence manifest targets a different pull request");
    }
    if (typeof forkEvidence.notes_tip !== "string" || forkEvidence.notes_tip.length === 0) {
      throw new Error("The fork evidence manifest has no notes tip");
    }
    notesNew = forkEvidence.notes_tip;
    evidence.push({ object: notesNew });
  }
  const proposal = {
    updates: [
      { ref, old: transitionBaseSha, new: headSha },
      { ref: "refs/notes/reveries", old: notesOld, new: notesNew },
    ],
    base_tree: baseTree,
    evidence,
    allow_pr_description_summary: allowPrDescriptionSummary,
  };
  if (allowPrDescriptionSummary) {
    // Description text only: never checked out, never executed. The checker
    // marks any coverage from this text as explicitly lower-grade.
    const body = event.pull_request?.body;
    if (typeof body === "string" && body.trim().length > 0) {
      proposal.pr_description = body;
    }
  }
  return proposal;
}

export function formatFinding(finding) {
  const identity = [finding.ref, finding.commit].filter((part) => typeof part === "string" && part.length > 0).join(" ");
  const header = `[${finding.code}]${finding.grade === "lower" ? " (lower-grade)" : ""}${identity.length === 0 ? "" : ` ${identity}`}`;
  return [`${header}: ${finding.detail}`, "Remedy:", ...finding.remediation.split("\n").map((line) => `  ${line}`)].join("\n");
}

export function formatReport(output) {
  const findings = Array.isArray(output?.result?.findings) ? output.result.findings : [];
  if (findings.length === 0) return "";
  const blocks = findings.map(formatFinding);
  if (output?.ok === true) {
    return ["WARNING: the receive check passed with lower-grade coverage.", ...blocks].join("\n\n");
  }
  return [`The receive check failed with ${findings.length} finding(s).`, ...blocks].join("\n\n");
}

async function main() {
  const options = parseScriptArgs(process.argv.slice(2));
  const targetGit = gitIn(resolveTargetDir(options));
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
  const forkEvidence = options.forkEvidenceManifestPath === null
    ? null
    : await readForkEvidenceManifest(options.forkEvidenceManifestPath);
  const proposal = await createReceiveProposal(event, targetGit, {
    allowPrDescriptionSummary: options.allowPrDescriptionSummary,
    forkEvidence,
  });
  const cli = join(workspace, "packages", "reveries", "dist", "src", "main.js");
  const result = await run(process.execPath, [cli, "receive-check", "--json"], `${JSON.stringify(proposal)}\n`);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  try {
    const report = formatReport(JSON.parse(result.stdout));
    if (report.length > 0) process.stderr.write(`${report}\n`);
  } catch {
    // Keep the checker's raw output authoritative when it is not JSON.
  }
  process.exitCode = result.code;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
