import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  isTrustedReceiveCheckRun,
  readBindingArtifact,
  TRUSTED_WORKFLOW_PATH,
  verifyBindingState,
} from "./receive-check-binding.mjs";
import { STRICT_BASE_REQUIRED } from "./required-check-contract.mjs";

/**
 * The identity a required check must have been posted by.
 *
 * These are defaults, not constants, and the difference is the whole point: the
 * `Reveries receive-check` job runs from `.github/workflows/` on a `pull_request_target`
 * trigger, so GitHub attributes the check run to the **Actions** app — slug
 * `github-actions`, numeric ID 15368. An earlier revision hard-coded a
 * `reveries` App slug and read its ID from an unset repository variable, so the
 * bot required a check that no installation could ever post and refused every
 * merge. Pinning an App that does not exist is not a control; it is a
 * permanently closed gate.
 *
 * The pin stays configurable so that adopting a repository which really does
 * install a dedicated App needs no code change — only a different value here.
 */
export const DEFAULT_REQUIRED_APP_SLUG = "github-actions";
export const DEFAULT_REQUIRED_APP_ID = "15368";

/**
 * Why a merge method is a poor default, recorded where the choice is made.
 *
 * A squash throws away every per-commit session summary the pull request carried
 * and replaces them with one synthesized for the squashed commit. A rebase
 * rewrites each commit, so the originals' summaries no longer describe anything
 * that exists, and only the tip can be matched back. `merge` is therefore the
 * default: it is the only method that leaves the pull request's own commits, and
 * their evidence, present on the base branch.
 */
export const MERGE_METHODS = ["merge", "squash", "rebase"];

/**
 * This bot is intentionally disabled until the source-bound artifact binding,
 * strict-ruleset prerequisite, protected environment, and source workflow have
 * been independently reviewed. Its trigger is `workflow_run`, which has no
 * caller-selected ref and runs this script from the default branch. The workflow
 * also grants no `pull-requests: write`, so there are two independent fail-closed
 * gates: this code refuses before making API calls, and GitHub would reject the
 * merge request even if this guard were removed.
 *
 * Do not flip this to true until the source-run artifact binding has been
 * independently reviewed, the `reveries-merge` environment has required
 * reviewers and protected-branch deployment rules configured, and the
 * base-serialisation prerequisite is configured on the repository's ruleset.
 */
export const MERGE_ENABLED = false;

export const DEFAULT_MERGE_METHOD = "merge";

/**
 * The identity to require, from explicit settings where present and the
 * documented defaults otherwise.
 *
 * An App ID must be numeric: it is compared against `app.id`, which the API
 * returns as a number, and a silently non-matching string would read as "no
 * check from the right App" rather than as a misconfiguration.
 */
export function resolveAppPin(env = {}) {
  const slug = env.REVERIES_REQUIRED_APP_SLUG || DEFAULT_REQUIRED_APP_SLUG;
  const appId = env.REVERIES_REQUIRED_APP_ID || DEFAULT_REQUIRED_APP_ID;
  if (!/^[A-Za-z0-9_-]+$/.test(slug)) {
    throw new Error(`REVERIES_REQUIRED_APP_SLUG is not a usable App slug: ${slug}`);
  }
  if (!/^\d+$/.test(appId)) {
    throw new Error("REVERIES_REQUIRED_APP_ID must be the installed App's numeric ID");
  }
  return { slug, appId };
}

/**
 * Whether a successful check run came from the required App.
 *
 * A check *name* is not an identity: any workflow can publish a check with that
 * name, so the App slug and numeric ID are what actually bind the result to a
 * trusted producer. Both are checked, and a run with no `app` at all (an older
 * check, or one posted by something that reports no app) is not a match.
 */
export function checkRunSatisfied(run, { checkName, slug, appId }) {
  return run?.name === checkName
    && run?.conclusion === "success"
    && run?.app?.slug === slug
    && String(run?.app?.id) === String(appId);
}

export function hasRequiredCheck(checkRuns, pin, checkName) {
  return (checkRuns ?? []).some((run) => checkRunSatisfied(run, { checkName, ...pin }));
}

/**
 * Every check run on a commit, across pages.
 *
 * GitHub returns 30 per page by default. The binding is a separate run from the
 * required check, so on a busy commit it can fall past the first page, and
 * stopping at page one would present "the binding is missing" as a policy
 * refusal. Bounded so a malformed or endless `Link` chain cannot spin.
 */
export const MAX_CHECK_RUN_PAGES = 10;
export const CHECK_RUNS_PER_PAGE = 100;

export async function allCheckRuns(github, repository, sha, maxPages = MAX_CHECK_RUN_PAGES) {
  const runs = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const result = await github(
      `/repos/${repository}/commits/${sha}/check-runs?per_page=${CHECK_RUNS_PER_PAGE}&page=${page}`,
    );
    const batch = result?.check_runs ?? [];
    runs.push(...batch);
    if (batch.length < CHECK_RUNS_PER_PAGE) break;
  }
  return runs;
}

/**
 * Read an HTTP response body with a hard cap before concatenating it.
 *
 * `Content-Length` is checked first when present, but is not trusted as the only
 * bound: a redirect, missing header, or chunked response can omit it. The stream
 * byte count is enforced as chunks arrive, and the reader is cancelled the first
 * time it crosses the limit, before an unbounded `arrayBuffer()` can allocate.
 */
export async function readBoundedBody(response, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("A positive response byte limit is required");
  }
  const declared = response.headers?.get?.("content-length") ?? null;
  if (declared !== null) {
    const declaredBytes = Number(declared);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0 || declaredBytes > maxBytes) {
      throw new Error(`Response declares ${declared} bytes, over the ${maxBytes} byte bound`);
    }
  }
  if (response.body === null || response.body === undefined) {
    throw new Error("Response has no body");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`Response exceeded the ${maxBytes} byte bound while streaming`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

/**
 * Whether branch protection requires the branch to be up to date with its base.
 *
 * This closes a race the binding cannot. Between the bot's last read of the pull
 * request and `PUT /pulls/{n}/merge`, the base can advance. The merge endpoint's
 * `sha` guards the *head*; nothing in the request guards the base. So a base
 * that moves in that window would be merged against evidence that described the
 * previous one, no matter how well the binding matched at the time it was read.
 *
 * `strict_required_status_checks_policy` is the host-side guard for exactly that
 * window: with it on, GitHub itself refuses the merge because the branch is
 * behind its base, so the race is resolved by the platform rather than by a
 * check this bot performed. Without it the race is unmitigated, so the bot
 * refuses rather than merging on a comparison it knows is already stale.
 *
 * The ruleset is read with the token the bot already has. On a public repository
 * it is readable without any extra permission, so this adds none. Where it cannot
 * be read at all — a private repository, or a token without access — the answer
 * is a refusal, never an assumption that the setting is on.
 */
export async function strictBaseEnforced(github, repository, defaultBranch) {
  const rulesets = await github(`/repos/${repository}/rulesets?includes_parents=true`);
  const active = (rulesets ?? []).filter(
    (ruleset) => ruleset.enforcement === "active" && targetsBranch(ruleset, defaultBranch),
  );
  if (active.length === 0) {
    return { ok: false, reason: `no active ruleset governs ${defaultBranch}` };
  }
  const guarded = active.filter((ruleset) => requiresStrictBase(ruleset, defaultBranch));
  if (guarded.length === 0) {
    return {
      ok: false,
      reason: `no active ruleset on ${defaultBranch} requires branches to be up to date with the base, `
        + "so a base that moves between this check and the merge would not be caught by the host",
    };
  }
  return { ok: true };
}

function targetsBranch(ruleset, defaultBranch) {
  const include = ruleset.conditions?.ref_name?.include ?? [];
  if (include.length === 0) return false;
  return include.includes(`refs/heads/${defaultBranch}`) || include.includes("~DEFAULT_BRANCH") || include.includes("~ALL");
}

/** A ruleset guard only counts when it actually governs the default branch. */
function requiresStrictBase(ruleset, defaultBranch) {
  if (!targetsBranch(ruleset, defaultBranch)) return false;
  return (ruleset.rules ?? []).some(
    (rule) => rule.type === "required_status_checks" && rule.parameters?.strict_required_status_checks_policy === true,
  );
}

/**
 * Whether the required check is required from the pinned App, and whether the
 * ruleset requires branches to be up to date with the base.
 */
export function checkRequiredCheckContract(github, ruleset, { pin, checkName }) {
  const check = (ruleset.rules ?? []).find((rule) => rule.type === "required_status_checks");
  if (check === undefined) {
    return { ok: false, reason: `no ruleset requires ${checkName}` };
  }
  const contexts = check.parameters?.required_status_checks ?? [];
  const fromPinnedApp = contexts.some(
    (context) => context.context === checkName && String(context.integration_id) === String(pin.appId),
  );
  if (!fromPinnedApp) {
    return {
      ok: false,
      reason: `branch protection does not require ${checkName} from the ${pin.slug} App, so a check from any other App would satisfy the gate`,
    };
  }
  if (check.parameters?.strict_required_status_checks_policy !== true) {
    return { ok: false, reason: STRICT_BASE_REQUIRED };
  }
  return { ok: true };
}

/**
 * Whether this workflow_run execution is on the protected default branch.
 *
 * Unlike `workflow_dispatch`, `workflow_run` has no caller-selected ref and
 * GitHub starts the downstream workflow from the default branch. This guard
 * verifies the platform context and catches a checkout/ref misconfiguration.
 */
export function sourceIsDefaultBranch({ ref, workflowRef, defaultBranch }) {
  if (typeof ref !== "string" || ref === "") {
    return { ok: false, reason: "the run did not report its ref" };
  }
  if (ref !== `refs/heads/${defaultBranch}`) {
    return {
      ok: false,
      reason: `this run is on ${ref}, and the bot only runs from the default branch `
        + `refs/heads/${defaultBranch}, so its code is not the reviewed code`,
    };
  }
  // `owner/repo/.github/workflows/<file>@<ref>`; confirm that the workflow
  // definition itself came from the protected default branch.
  const at = typeof workflowRef === "string" ? workflowRef.lastIndexOf("@") : -1;
  if (at < 0) {
    return { ok: false, reason: `the run did not report a usable workflow ref (${String(workflowRef)})` };
  }
  if (workflowRef.slice(at + 1) !== `refs/heads/${defaultBranch}`) {
    return {
      ok: false,
      reason: `the workflow definition came from ${workflowRef.slice(at + 1)}, and only the default branch's `
        + "copy is reviewed",
    };
  }
  return { ok: true };
}

/**
 * The tree a commit carries, from either API shape.
 *
 * `/git/commits/<sha>` reports the commit's own `tree.sha`, while a tree
 * resource reports `sha` directly. The bot uses this on the base SHA the pull
 * request reports *now*, so the tree is derived rather than supplied.
 */
export function treeOf(commit) {
  return commit?.sha ?? commit?.tree?.sha ?? null;
}

/**
 * Fetch and verify the exact receive-check run named by a workflow_run event.
 *
 * A lookup by head/workflow name could select a different successful run for
 * the same head. The event's immutable run ID is the source of record; the API
 * response is then checked for repository, path, event, conclusion, and head.
 */
export async function trustedSourceRun(github, repository, sourceRunId, repositoryId) {
  const run = await github(`/repos/${repository}/actions/runs/${sourceRunId}`);
  if (String(run?.id) !== String(sourceRunId)) {
    return { ok: false, reason: `GitHub returned run ${String(run?.id)} for requested source run ${sourceRunId}` };
  }
  if (!isTrustedReceiveCheckRun(run, {
    repository,
    repositoryId,
    headSha: run.head_sha,
  })) {
    return {
      ok: false,
      reason: `Run ${sourceRunId} is not a successful ${TRUSTED_WORKFLOW_PATH} pull_request_target run from ${repository}`,
    };
  }
  return { ok: true, run };
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN;
  const sourceRunId = process.env.REVERIES_SOURCE_RUN_ID;
  const requiredCheck = process.env.REVERIES_REQUIRED_CHECK;
  const mergeMethod = process.env.REVERIES_MERGE_METHOD ?? DEFAULT_MERGE_METHOD;

  // No PR number or base tree is supplied by a dispatcher. The workflow_run
  // event names the exact completed source run; its own artifact names the PR,
  // and the live PR/base are fetched and checked below.
  if (!repository || !token || !sourceRunId || !requiredCheck) {
    throw new Error("The controlled merge bot requires repository, token, source run, and check settings");
  }
  if (!MERGE_ENABLED) {
    throw new Error(
      "Controlled merge is disabled pending independent review of the workflow_run artifact binding, "
      + "protected reveries-merge environment, and strict base serialization.",
    );
  }
  if (!MERGE_METHODS.includes(mergeMethod)) throw new Error("Unsupported merge method");
  const pin = resolveAppPin(process.env);

  async function githubBinary(path, { maxBytes }) {
    const response = await fetch(`https://api.github.com${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`GitHub API ${response.status}: ${body}`);
    }
    return readBoundedBody(response, maxBytes);
  }

  async function github(path, options = {}) {
    const response = await fetch(`https://api.github.com${path}`, {
      ...options,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        ...(options.headers ?? {}),
      },
    });
    const body = await response.json();
    if (!response.ok) throw new Error(`GitHub API ${response.status}: ${JSON.stringify(body)}`);
    return body;
  }

  // `workflow_run` has no ref selector and GitHub starts this workflow from the
  // default branch. Verify the platform context again before reading evidence.
  const repositoryInfo = await github(`/repos/${repository}`);
  const defaultBranch = repositoryInfo.default_branch;
  const source = sourceIsDefaultBranch({
    ref: process.env.GITHUB_REF,
    workflowRef: process.env.GITHUB_WORKFLOW_REF,
    defaultBranch,
  });
  if (!source.ok) throw new Error(`${source.reason}. The merge was refused.`);

  // Host-side serialization closes the base race between the artifact check and
  // the merge. If the ruleset cannot be read or is not strict, the bot refuses.
  const rulesets = await github(`/repos/${repository}/rulesets?includes_parents=true`);
  const governed = (rulesets ?? []).filter(
    (ruleset) => ruleset.enforcement === "active" && targetsBranch(ruleset, defaultBranch),
  );
  if (governed.length === 0) {
    throw new Error(`No active ruleset governs ${defaultBranch}, so nothing enforces the required check. The merge was refused.`);
  }
  for (const ruleset of governed) {
    const contract = checkRequiredCheckContract(github, ruleset, { pin, checkName: requiredCheck });
    if (!contract.ok) throw new Error(`${contract.reason}. The merge was refused.`);
  }

  // The workflow_run event names one source run. Re-read that exact run; do not
  // search for a convenient passing run by name or head.
  const trusted = await trustedSourceRun(github, repository, sourceRunId, repositoryInfo.id);
  if (!trusted.ok) throw new Error(`${trusted.reason}. The merge was refused.`);
  const sourceRun = trusted.run;

  // The artifact belongs to exactly this run; no check-run-supplied field is
  // consulted for the binding. Read it first to get the PR number, then query the
  // live PR and derive its base tree independently.
  const recorded = await readBindingArtifact(github, githubBinary, repository, sourceRun, {
    repositoryId: repositoryInfo.id,
  });
  if (!recorded.ok) {
    throw new Error(`Trusted receive-check run ${sourceRunId}: ${recorded.reason}. The merge was refused.`);
  }
  const number = recorded.binding.pull_request;
  const pullRequest = await github(`/repos/${repository}/pulls/${number}`);
  if (pullRequest.head.sha !== sourceRun.head_sha) {
    throw new Error(
      `The source run checked head ${sourceRun.head_sha}, but pull request #${number} is now at `
      + `${pullRequest.head.sha}. The merge was refused.`,
    );
  }
  const baseCommit = await github(`/repos/${repository}/git/commits/${pullRequest.base.sha}`);
  const currentBaseTree = treeOf(baseCommit);
  const verdict = verifyBindingState(recorded.binding, { pullRequest, baseTree: currentBaseTree });
  if (!verdict.ok) throw new Error(`${verdict.reason}. The merge was refused.`);

  const checkRuns = await allCheckRuns(github, repository, pullRequest.head.sha);
  if (!hasRequiredCheck(checkRuns, pin, requiredCheck)) {
    throw new Error(`No successful ${requiredCheck} check from the required ${pin.slug} App`);
  }

  // `sha` guards the head if it moves after validation (409). The strict ruleset
  // is the separate host-side guard for a base move in the same window.
  const merged = await github(`/repos/${repository}/pulls/${number}/merge`, {
    method: "PUT",
    body: JSON.stringify({ merge_method: mergeMethod, sha: pullRequest.head.sha }),
    headers: { "content-type": "application/json" },
  });
  if (merged.merged !== true) throw new Error(`GitHub did not merge the pull request: ${merged.message ?? "unknown reason"}`);
  process.stdout.write(
    `Merged pull request #${number} by ${mergeMethod} after trusted receive-check run ${sourceRun.id}, `
    + `bound to base ${recorded.binding.base_sha} (tree ${recorded.binding.base_tree}).\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
