/**
 * Record the base/head binding for a successful receive-check.
 *
 * Run as a step of the trusted `pull_request_target` receive-check workflow,
 * after the check has passed. It writes the binding to a file which the next step
 * uploads as an artifact **of this run**.
 *
 * An artifact, rather than a check run or a ref, because it is the only channel
 * that is bound to the run that produced it: artifacts belong to one run and only
 * that run can upload to it. A same-repository pull request can post a look-alike
 * check run, push a ref, or read a secret, but it cannot write into this run's
 * artifact.
 *
 * ## Why this cannot be forged by a pull request
 *
 * The job runs on `pull_request_target`, so the workflow file, this script, and
 * the checker all come from the protected default branch; the checkout is the base
 * revision, and no pull request code is ever executed. Every value recorded here
 * comes from the event payload or from the base commit the job already has: the
 * pull request number, the base SHA, and the base tree are not the author's to
 * choose. The head SHA is the author's, which is correct — it names the content
 * under review, and the bot compares it against the live pull request.
 *
 * Uploading an artifact needs no token permission, so this adds none.
 *
 * A failure here is not fatal to the receive check. The check already passed and
 * its result stands; only the binding is missing, and the bot's refusal then
 * fails closed.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { BINDING_FILE_NAME, bindingFromEvent, buildBinding, serializeBinding } from "./receive-check-binding.mjs";

const execFileAsync = promisify(execFile);

/** The base commit's tree, computed here rather than supplied by anyone. */
export async function deriveBaseTree(baseSha, cwd) {
  const result = await execFileAsync("git", ["rev-parse", `${baseSha}^{tree}`], { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

/**
 * Write the binding to `directory`, for the upload step to pick up.
 *
 * Returns the path written so the caller can pass it to `upload-artifact` without
 * re-deriving where the script put it.
 */
export async function writeBindingFile(event, { baseTree, directory }) {
  const resolved = bindingFromEvent(event, { baseTree });
  if (!resolved.ok) throw new Error(resolved.reason);
  const pullRequest = event.pull_request;
  const binding = buildBinding({
    pullRequestNumber: pullRequest.number,
    headSha: pullRequest.head.sha,
    baseSha: pullRequest.base.sha,
    baseTree,
  });
  await mkdir(directory, { recursive: true });
  const path = join(directory, BINDING_FILE_NAME);
  await writeFile(path, `${serializeBinding(binding)}\n`, "utf8");
  return { path, binding };
}

export async function main({ env = process.env, cwd = process.cwd() } = {}) {
  const eventPath = env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error("GITHUB_EVENT_PATH is required to record a binding");
  const event = JSON.parse(await readFile(eventPath, "utf8"));
  // The base SHA comes from the event, and its tree is computed from the object
  // the trusted checkout already has. Neither is an input to this script.
  const baseSha = event?.pull_request?.base?.sha;
  if (typeof baseSha !== "string" || baseSha.length === 0) {
    throw new Error("The event carries no pull request base SHA, so no binding can be recorded");
  }
  const baseTree = await deriveBaseTree(baseSha, cwd);
  // The directory comes from the same job-level variable the upload step reads, so the
  // producer and the uploader cannot disagree about where the file was written.
  const directory = env.BINDING_DIR ?? join(env.RUNNER_TEMP ?? cwd, "reveries-binding");
  const { path, binding } = await writeBindingFile(event, { baseTree, directory });
  process.stdout.write(
    `Recorded a version 1 binding for #${binding.pull_request} in run ${env.GITHUB_RUN_ID}: `
    + `head ${binding.head_sha}, base ${binding.base_sha} (tree ${binding.base_tree}).\n`
    + `Wrote ${path}\n`,
  );
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  await main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
