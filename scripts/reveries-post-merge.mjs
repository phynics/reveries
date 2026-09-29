import { appendFile, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NOTES_REF = "refs/notes/reveries";
const BOT_EMAIL = "41898282+github-actions[bot]@users.noreply.github.com";

export function gitClient(run) {
  const failure = (args, result) =>
    new Error(`git ${args.join(" ")} failed (${result.exitCode}): ${result.stderr.trim()}`);
  return {
    async ok(...args) {
      const result = await run(args, "");
      if (result.exitCode !== 0) throw failure(args, result);
      return result.stdout.trim();
    },
    attempt(...args) {
      return run(args, "");
    },
    async pipe(args, input) {
      const result = await run(args, input);
      if (result.exitCode !== 0) throw failure(args, result);
      return result.stdout.trim();
    },
  };
}

export function hasSessionSummary(note) {
  return note.split("\n").filter((line) => line.length > 0).some((line) => {
    try {
      return JSON.parse(line).type === "session-summary";
    } catch {
      return false;
    }
  });
}

async function stablePatchId(git, commit) {
  const diff = await git.ok("diff", `${commit}^!`);
  const patch = await git.pipe(["patch-id", "--stable"], diff);
  return patch.split(" ")[0] ?? "";
}

export async function planHostedSummaries({ event, git, api }) {
  const push = event?.push;
  if (push === undefined) throw new Error("The post-merge plan requires a push event");
  const repository = event.repository?.full_name ?? push.repository?.full_name;
  if (typeof repository !== "string" || !repository.includes("/")) {
    throw new Error("The push event does not name the repository");
  }
  const defaultBranch = event.repository?.default_branch ?? "main";
  const plan = { items: [], skipped: [], deferred: [], diagnostics: [] };
  if (push.ref !== `refs/heads/${defaultBranch}`) {
    plan.diagnostics.push(`The push to ${push.ref} is not the default branch`);
    return plan;
  }
  if (/^0+$/.test(push.before ?? "")) {
    plan.diagnostics.push("The push created the default branch; no merge attribution is attempted");
    return plan;
  }
  const [owner, name] = repository.split("/");
  const range = (await git.ok("rev-list", "--first-parent", "--reverse", `${push.before}..${push.after}`))
    .split("\n")
    .filter((line) => line.length > 0);
  const tip = range[range.length - 1];
  for (const commit of range) {
    const parents = (await git.ok("show", "-s", "--format=%P", commit)).split(" ").filter((line) => line.length > 0);
    const rewrite = parents.length === 1 && range.length > 1;
    if (rewrite && commit !== tip) {
      plan.deferred.push({ commit, reason: "rebase-intermediate" });
      continue;
    }
    const note = await git.attempt("notes", `--ref=${NOTES_REF}`, "show", commit);
    if (note.exitCode === 0 && hasSessionSummary(note.stdout)) {
      plan.skipped.push({ commit, reason: "already-summarized" });
      continue;
    }
    const pulls = await api(`/repos/${repository}/commits/${commit}/pulls`);
    if (!Array.isArray(pulls) || pulls.length === 0) {
      plan.skipped.push({ commit, reason: "no-pull-request" });
      plan.diagnostics.push(`Commit ${commit} has no associated pull request and stays without a session summary`);
      continue;
    }
    const number = pulls[0].number;
    const pullCommits = await api(`/repos/${repository}/pulls/${number}/commits`);
    const sourceCommits = pullCommits.map((entry) => entry.sha);
    await git.ok(
      "fetch",
      "--no-tags",
      `https://github.com/${repository}.git`,
      `+refs/pull/${number}/head:refs/reveries/pr/${number}/head`,
    );
    const pullRequest = { owner, name, number };
    if (rewrite) {
      const tipPatch = await stablePatchId(git, commit);
      const matches = [];
      for (const source of sourceCommits) {
        if (await stablePatchId(git, source) === tipPatch) matches.push(source);
      }
      if (matches.length !== 1) {
        plan.skipped.push({ commit, reason: "ambiguous-rewrite-mapping" });
        plan.diagnostics.push(`Commit ${commit} matches ${matches.length} pull request commits; no summary is written`);
        continue;
      }
      plan.items.push({ commit, pullRequest, sourceCommits: matches });
      continue;
    }
    plan.items.push({ commit, pullRequest, sourceCommits });
  }
  return plan;
}

export function composeHostedSummary(entries, attribution, pullRequest) {
  return {
    v: 1,
    type: "session-summary",
    author_email: attribution.author_email,
    session: attribution.session,
    created_at: attribution.created_at,
    entries: entries.map((entry) => ({
      ...entry,
      sources: pullRequest === undefined
        ? entry.sources
        : [
            ...entry.sources,
            {
              relation: "requested-by",
              kind: "issue",
              ref: `github:${pullRequest.owner}/${pullRequest.name}#${pullRequest.number}`,
            },
          ],
    })),
  };
}

export async function synthesize({ plan, remote, attribution, reveries }) {
  const report = {
    ok: true,
    attached: [],
    skipped: [...plan.skipped],
    deferred: plan.deferred,
    diagnostics: [...plan.diagnostics],
    published: null,
  };
  for (const item of plan.items) {
    const synthesized = await reveries.synthesizeHostedSummary({
      commit: item.commit,
      sourceCommits: item.sourceCommits,
    });
    report.diagnostics.push(...synthesized.diagnostics);
    if (synthesized.state === "already-summarized") {
      report.skipped.push({ commit: item.commit, reason: "already-summarized" });
      continue;
    }
    if (synthesized.state !== "ready") {
      report.ok = false;
      report.skipped.push({ commit: item.commit, reason: "unsummarizable" });
      continue;
    }
    const attached = await reveries.attachHostedSummary({
      commit: item.commit,
      summary: composeHostedSummary(synthesized.entries, attribution, item.pullRequest),
    });
    if (attached.state === "attached") report.attached.push(item.commit);
    else report.skipped.push({ commit: item.commit, reason: "already-summarized" });
  }
  report.published = await reveries.publishNotes({ remote, attempts: 3 });
  report.diagnostics.push(...report.published.diagnostics);
  report.ok = report.ok && report.published.ok;
  return report;
}

function spawnGit(cwd, args, input) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"] });
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

function githubClient(token) {
  return async (path) => {
    const response = await fetch(`https://api.github.com${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
    });
    const body = await response.json();
    if (!response.ok) throw new Error(`GitHub API ${response.status}: ${JSON.stringify(body)}`);
    return body;
  };
}

async function main() {
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
  const runId = process.env.GITHUB_RUN_ID;
  if (!runId) throw new Error("GITHUB_RUN_ID is required for post-merge summaries");
  const remote = process.env.REVERIES_POST_MERGE_REMOTE ?? "origin";
  const git = gitClient((args, input) => spawnGit(workspace, args, input));
  const plan = await planHostedSummaries({ event, git, api: githubClient(process.env.GITHUB_TOKEN) });
  const library = await import(pathToFileURL(join(workspace, "packages", "reveries", "dist", "src", "index.js")).href);
  const reveries = await library.Reveries.open(workspace);
  const report = await synthesize({
    plan,
    remote,
    reveries,
    attribution: {
      author_email: BOT_EMAIL,
      session: `github-actions:post-merge:${runId}`,
      created_at: new Date().toISOString(),
    },
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Reveries post-merge summaries\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`, "utf8");
  }
  process.exitCode = report.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
