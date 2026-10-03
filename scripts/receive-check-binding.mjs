/**
 * The binding between a successful receive-check and the exact pull request
 * state it validated.
 *
 * ## Why this exists
 *
 * The controlled-merge bot must know that the passing check it accepted was run
 * against *this* pull request at *this* head and *this* base. Comparing the
 * current base tree against an operator-typed value proves nothing: the base can
 * advance, the operator types the new base tree, and a stale successful check on
 * the unchanged head still satisfies both gates.
 *
 * ## Why the evidence is an artifact, not a check run
 *
 * A same-repository pull request can add a workflow. It runs with
 * `GITHUB_TOKEN` carrying whatever permissions it declares, and with access to
 * repository secrets. So *nothing* a trusted `pull_request_target` workflow can
 * reach is out of a same-repo PR's reach — except the base branch's own code,
 * because `pull_request_target` executes the workflow file from the base branch
 * while a `pull_request` trigger executes the pull request's copy.
 *
 * That leaves the run itself as the only trustworthy channel, and it means the
 * evidence has to come from something *belonging to* that run rather than from
 * anything the attacker also controls. Two channels were considered and
 * rejected:
 *
 * - **A custom check run's `external_id` or output.** Rejected: every Actions
 *   workflow shares the `github-actions` App, so a forger can post a check run of
 *   the same name on the same head. Naming a real trusted run in `external_id`
 *   does not help, because nothing proves that trusted run produced the payload —
 *   the forger supplies the payload and merely cites a run that exists. The bot
 *   would be verifying an attribute the attacker wrote.
 * - **A ref or a secret-signed record.** Rejected: a same-repo PR can push refs
 *   with `contents: write` and can read repository secrets, so neither is
 *   source-bound.
 *
 * An **artifact** is source-bound: artifacts belong to one run, and only that
 * run can upload to it. So "the binding is in the artifact of run R" plus "run R
 * is the trusted workflow for this head" is a chain the attacker cannot forge,
 * because the attacker would have to write into a run it does not own.
 *
 * ## What the bot requires
 *
 * All of it, or it refuses: a run of the trusted workflow file, triggered by
 * `pull_request_target`, on the current head, concluded successfully; that run's
 * artifact with the fixed name; a parseable versioned binding inside it; and a
 * match against the live pull request's number, head, and base, with the base
 * tree compared against the tree the bot derives from the base SHA through the
 * API rather than against the artifact's own claim. Missing, unreadable,
 * ambiguous, stale, or untrusted-source bindings are refusals, never inferences.
 */

import { readZipEntry } from "./zip.mjs";

/** The fixed artifact name. Not configurable, so it cannot be steered. */
export const BINDING_ARTIFACT_NAME = "reveries-receive-check-binding";
/** The single file inside that artifact. */
export const BINDING_FILE_NAME = "binding.json";
/** The workflow file whose runs are the only acceptable source of a binding. */
export const TRUSTED_WORKFLOW_PATH = ".github/workflows/reveries-receive-check.yml";
/** Binding schema version. A version the bot does not know is refused. */
export const BINDING_VERSION = 1;
/** Upper bound on the complete ZIP response, enforced before buffering it. */
export const MAX_BINDING_ARCHIVE_BYTES = 8 * 1024 * 1024;
/**
 * The only workflow event whose code comes from the base branch.
 *
 * `pull_request` executes the pull request's own copy of the workflow, so a run
 * under it is attacker-influenced and cannot vouch for anything.
 */
export const TRUSTED_EVENT = "pull_request_target";

const OBJECT_ID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

/** Build the binding the trusted workflow records. */
export function buildBinding({ pullRequestNumber, headSha, baseSha, baseTree }) {
  return {
    v: BINDING_VERSION,
    pull_request: pullRequestNumber,
    head_sha: headSha,
    base_sha: baseSha,
    base_tree: baseTree,
  };
}

export function serializeBinding(binding) {
  return JSON.stringify(binding);
}

/**
 * Parse a binding, refusing anything malformed rather than coercing it.
 *
 * A binding is a security claim, so every field is validated: an unknown version,
 * a non-integer pull request number, or a non-hex SHA is a refusal, not a value to
 * be partially believed.
 */
export function parseBinding(text) {
  if (typeof text !== "string" || text.trim().length === 0) {
    return { ok: false, reason: "the binding is empty" };
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: "the binding is not JSON" };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "the binding is not an object" };
  }
  if (value.v !== BINDING_VERSION) {
    return {
      ok: false,
      reason: `the binding declares version ${String(value.v)}, and this bot only understands version ${BINDING_VERSION}`,
    };
  }
  if (!Number.isInteger(value.pull_request)) {
    return { ok: false, reason: "the binding names no integer pull request" };
  }
  for (const field of ["head_sha", "base_sha", "base_tree"]) {
    if (typeof value[field] !== "string" || !OBJECT_ID.test(value[field])) {
      return { ok: false, reason: `the binding's ${field} is not an object ID` };
    }
  }
  return { ok: true, binding: value };
}

/**
 * Whether a run is the trusted receive-check run for a given head.
 *
 * `path` and `event` are the load-bearing attributes: neither is something a pull
 * request can choose, because both come from the workflow file the base branch
 * supplied.
 */
export function isTrustedRun(run, { headSha, workflowPath = TRUSTED_WORKFLOW_PATH } = {}) {
  if (run === undefined || run === null) return false;
  if (run.path !== workflowPath) return false;
  if (run.event !== TRUSTED_EVENT) return false;
  if (headSha !== undefined && run.head_sha !== headSha) return false;
  return true;
}

/**
 * Whether an Actions run is the exact trusted source allowed to publish a binding.
 *
 * Called on the run id from the `workflow_run` event, not on an id copied out of
 * an untrusted check. The repository, path, event, conclusion, and head are all
 * checked against independently known values. `pull_request_target` is the
 * property that keeps the workflow definition on the base branch; the separate
 * `workflow_run` merge job also runs from the default branch and has no ref
 * selector of its own.
 */
export function isTrustedReceiveCheckRun(run, { repository, repositoryId, headSha }) {
  if (!isTrustedRun(run, { headSha })) return false;
  if (run.status !== "completed" || run.conclusion !== "success") return false;
  if (run.repository?.full_name !== repository) return false;
  if (String(run.repository?.id) !== String(repositoryId)) return false;
  return true;
}

/**
 * Whether a recorded binding describes exactly this pull request, head, and base.
 *
 * `baseTree` is the tree the bot derived from the base SHA through the API. It is
 * required: omitting it would let a caller "verify" a binding by skipping the one
 * field the artifact cannot be trusted to attest about itself.
 */
export function verifyBindingState(binding, { pullRequest, baseTree }) {
  if (typeof baseTree !== "string" || !OBJECT_ID.test(baseTree)) {
    throw new Error("verifyBindingState requires the base tree derived from the base SHA");
  }
  if (binding.pull_request !== pullRequest.number) {
    return {
      ok: false,
      reason: `the binding names pull request #${binding.pull_request}, and this run targets #${pullRequest.number}`,
    };
  }
  if (binding.head_sha !== pullRequest.head.sha) {
    return {
      ok: false,
      reason: `the binding names head ${binding.head_sha}, and the pull request's head is ${pullRequest.head.sha}`,
    };
  }
  if (binding.base_sha !== pullRequest.base.sha) {
    return {
      ok: false,
      reason: `the binding was validated against base ${binding.base_sha}, and the base has since moved to ${pullRequest.base.sha}`,
    };
  }
  if (binding.base_tree !== baseTree) {
    return {
      ok: false,
      reason: `the binding names base tree ${binding.base_tree}, and base ${pullRequest.base.sha} has tree ${baseTree}`,
    };
  }
  return { ok: true };
}

/** The binding inside a run's artifact archive, or a refusal. */
export function bindingFromArtifact(archive, { pullRequest, baseTree }) {
  if (!Buffer.isBuffer(archive) || archive.length > MAX_BINDING_ARCHIVE_BYTES) {
    return { ok: false, reason: `artifact archive exceeds the ${MAX_BINDING_ARCHIVE_BYTES} byte bound` };
  }
  let bytes;
  try {
    bytes = readZipEntry(archive, BINDING_FILE_NAME);
  } catch (error) {
    return { ok: false, reason: `the artifact could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (bytes === null) {
    return { ok: false, reason: `the artifact contains no ${BINDING_FILE_NAME}` };
  }
  const parsed = parseBinding(bytes.toString("utf8"));
  if (!parsed.ok) return parsed;
  const verdict = verifyBindingState(parsed.binding, { pullRequest, baseTree });
  if (!verdict.ok) return verdict;
  return { ok: true, binding: parsed.binding };
}

/**
 * Read and parse the one binding artifact belonging to `run`.
 *
 * This does not take a claim from a check run: the binding is read from the
 * artifact attached to the run itself, which is the source-bound part of the
 * protocol. State matching is a second call once the bot has fetched the live PR
 * and derived its base tree.
 */
export async function readBindingArtifact(github, githubBinary, repository, run, { repositoryId } = {}) {
  const artifacts = await github(`/repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100`);
  const named = (artifacts?.artifacts ?? []).filter(
    (artifact) => artifact.name === BINDING_ARTIFACT_NAME && artifact.expired !== true,
  );
  if (named.length === 0) {
    return { ok: false, reason: `run ${run.id} published no ${BINDING_ARTIFACT_NAME} artifact` };
  }
  if (named.length > 1) {
    return { ok: false, reason: `run ${run.id} published ${named.length} bindings, which is ambiguous` };
  }
  const artifact = named[0];
  // GitHub attaches these fields to artifact-list entries. Check every available
  // source-binding field against the exact trusted run before downloading bytes.
  // Fork PRs are valid: head_repository_id is intentionally NOT required to
  // equal the base repository, because it may name the fork.
  if (artifact.workflow_run?.id !== undefined && String(artifact.workflow_run.id) !== String(run.id)) {
    return { ok: false, reason: `artifact ${artifact.id} belongs to workflow run ${artifact.workflow_run.id}, not ${run.id}` };
  }
  if (artifact.workflow_run?.head_sha !== undefined && artifact.workflow_run.head_sha !== run.head_sha) {
    return { ok: false, reason: `artifact ${artifact.id} head ${artifact.workflow_run.head_sha} differs from source run head ${run.head_sha}` };
  }
  if (artifact.workflow_run?.repository_id !== undefined && String(artifact.workflow_run.repository_id) !== String(repositoryId ?? run.repository?.id)) {
    return { ok: false, reason: `artifact ${artifact.id} belongs to a different base repository` };
  }
  // The head repository may be a fork, so it is compared to the run's own head
  // repository rather than to the base repository.
  if (
    artifact.workflow_run?.head_repository_id !== undefined
    && run.head_repository?.id !== undefined
    && String(artifact.workflow_run.head_repository_id) !== String(run.head_repository.id)
  ) {
    return { ok: false, reason: `artifact ${artifact.id} names a head repository that differs from the source run` };
  }
  if (artifact.size_in_bytes !== undefined && (!Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes < 0 || artifact.size_in_bytes > MAX_BINDING_ARCHIVE_BYTES)) {
    return { ok: false, reason: `artifact ${artifact.id} declares ${artifact.size_in_bytes} bytes, over the ${MAX_BINDING_ARCHIVE_BYTES} byte download bound` };
  }
  const archive = await githubBinary(
    `/repos/${repository}/actions/artifacts/${artifact.id}/zip`,
    { maxBytes: MAX_BINDING_ARCHIVE_BYTES },
  );
  if (archive === null) {
    return { ok: false, reason: `run ${run.id}'s binding artifact could not be downloaded` };
  }
  const bytes = (() => {
    try {
      return readZipEntry(archive, BINDING_FILE_NAME);
    } catch (error) {
      return { zipError: error instanceof Error ? error.message : String(error) };
    }
  })();
  if (bytes !== null && typeof bytes === "object" && "zipError" in bytes) {
    return { ok: false, reason: `run ${run.id}: artifact could not be read: ${bytes.zipError}` };
  }
  if (bytes === null) {
    return { ok: false, reason: `run ${run.id}: artifact contains no ${BINDING_FILE_NAME}` };
  }
  const parsed = parseBinding(bytes.toString("utf8"));
  if (!parsed.ok) return { ok: false, reason: `run ${run.id}: ${parsed.reason}` };
  return { ok: true, binding: parsed.binding, runId: run.id };
}

/**
 * Read the pull request state out of a workflow event payload.
 *
 * The event is the trusted record of what this run is about. The head SHA is the
 * pull request author's to choose, which is fine — it names the content under
 * review, and the bot compares it to the live pull request. The base SHA and the
 * base tree are not the author's to choose, which is why a binding that records
 * them is worth something.
 *
 * Returns a refusal rather than throwing for an event that is not a pull
 * request, so a workflow running on several events records nothing rather than a
 * binding about the wrong object.
 */
export function bindingFromEvent(event, { baseTree }) {
  const pullRequest = event?.pull_request;
  if (pullRequest === undefined || pullRequest === null) {
    return { ok: false, reason: "the workflow event carries no pull request, so no binding can be published" };
  }
  const number = pullRequest.number;
  const headSha = pullRequest.head?.sha;
  const baseSha = pullRequest.base?.sha;
  if (!Number.isInteger(number)) {
    return { ok: false, reason: "the event's pull request has no number" };
  }
  for (const [label, value] of [["head", headSha], ["base", baseSha]]) {
    if (typeof value !== "string" || !OBJECT_ID.test(value)) {
      return { ok: false, reason: `the event's pull request has no usable ${label} SHA` };
    }
  }
  if (typeof baseTree !== "string" || !OBJECT_ID.test(baseTree)) {
    return { ok: false, reason: "no base tree was derived from the base SHA, so no binding can be published" };
  }
  return { ok: true, binding: buildBinding({ pullRequestNumber: number, headSha, baseSha, baseTree }) };
}
