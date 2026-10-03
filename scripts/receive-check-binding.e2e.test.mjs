import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import { deriveBaseTree, main as recordMain, writeBindingFile } from "./publish-receive-check-binding.mjs";
import {
  BINDING_ARTIFACT_NAME,
  BINDING_FILE_NAME,
  MAX_BINDING_ARCHIVE_BYTES,
  TRUSTED_EVENT,
  TRUSTED_WORKFLOW_PATH,
  bindingFromArtifact,
  bindingFromEvent,
  buildBinding,
  isTrustedRun,
  parseBinding,
  readBindingArtifact,
  serializeBinding,
  verifyBindingState,
} from "./receive-check-binding.mjs";
import { trustedSourceRun } from "./controlled-merge.mjs";
import { readZipEntry } from "./zip.mjs";

const execFileAsync = promisify(execFile);

const HEAD = "a".repeat(40);
const RUN_ID = "34877238850";
const REPO = "phynics/reveries";
const REPO_ID = "1346500768";
const BASE_B = "b".repeat(40);
const TREE_B = "1".repeat(40);
const BASE_C = "c".repeat(40);
const TREE_C = "2".repeat(40);
const NUMBER = 26;
const PULL_REQUEST = { number: NUMBER, head: { sha: HEAD }, base: { sha: BASE_B } };

const EVENT = (over = {}) => ({
  pull_request: { number: NUMBER, head: { sha: HEAD }, base: { sha: BASE_B } },
  ...over,
});

/** Build a real ZIP, the way Actions serves an artifact. */
async function artifactZip(dir, { name = BINDING_FILE_NAME, body, extraEntries = [] } = {}) {
  const path = join(dir, "artifact.zip");
  const args = ["-q"];
  if (extraEntries.length > 0) {
    args.push(...extraEntries.flatMap(([n, c]) => ["--", n, "-c", c]));
  }
  // `zip` may be absent; python3 is present in CI and always available here.
  await execFileAsync("python3", ["-c", `
import json, sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as z:
    for n, c in json.loads(sys.argv[2]):
        z.writestr(n, c)
`, path, JSON.stringify([[name, body], ...extraEntries])]);
  return readFile(path);
}

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), "reveries-binding-"));
  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 10 }),
  };
}

/** A trusted run, as the runs API reports it. */
const trustedRun = (over = {}) => ({
  id: Number(RUN_ID),
  path: TRUSTED_WORKFLOW_PATH,
  event: TRUSTED_EVENT,
  status: "completed",
  conclusion: "success",
  head_sha: HEAD,
  repository: { full_name: REPO, id: Number(REPO_ID) },
  ...over,
});

/** Artifact metadata as the runs-artifacts API reports it for a same-repo run. */
const artifactMetadata = (over = {}) => ({
  id: 1,
  name: BINDING_ARTIFACT_NAME,
  expired: false,
  size_in_bytes: 512,
  workflow_run: {
    id: Number(RUN_ID),
    repository_id: Number(REPO_ID),
    head_repository_id: Number(REPO_ID),
    head_sha: HEAD,
  },
  ...over,
});

/** A GitHub stand-in that serves the exact run, artifacts, and archive. */
function fakeGitHub({ run = trustedRun(), binary = null, artifactList = null } = {}) {
  const calls = [];
  const github = async (path) => {
    calls.push(path);
    if (path === `/repos/${REPO}/actions/runs/${RUN_ID}`) return run;
    if (/\/artifacts\?/.test(path)) {
      const fallback = binary === null ? [] : [artifactMetadata()];
      return { artifacts: artifactList ?? fallback };
    }
    throw new Error(`unexpected path ${path}`);
  };
  const githubBinary = async (path, options) => {
    calls.push(path);
    if (options !== undefined) calls.push(options);
    if (path.includes("/actions/artifacts/")) return binary;
    throw new Error("unexpected binary path");
  };
  return { github, githubBinary, calls };
}

/** Follow the same exact-run source check and artifact read as the bot. */
async function trustedBinding(gh, { pullRequest = PULL_REQUEST, baseTree = TREE_B } = {}) {
  const source = await trustedSourceRun(gh.github, REPO, RUN_ID, REPO_ID);
  if (!source.ok) return source;
  const artifact = await readBindingArtifact(gh.github, gh.githubBinary, REPO, source.run);
  if (!artifact.ok) return artifact;
  const state = verifyBindingState(artifact.binding, { pullRequest, baseTree });
  if (!state.ok) return state;
  return { ok: true, binding: artifact.binding, runId: source.run.id };
}

// --- Recording the binding ---------------------------------------------------

test("the recorded binding names the PR, head, base, and computed base tree", async () => {
  const { dir, cleanup } = await scratch();
  try {
    const { binding } = writeBindingFileResult(EVENT(), TREE_B);
    assert.equal(binding.v, 1);
    assert.equal(binding.pull_request, NUMBER);
    assert.equal(binding.head_sha, HEAD);
    assert.equal(binding.base_sha, BASE_B);
    assert.equal(binding.base_tree, TREE_B);

    // And it is written where the upload step will find it.
    const { path } = await writeBindingFile(EVENT(), { baseTree: TREE_B, directory: dir });
    assert.equal(path, join(dir, BINDING_FILE_NAME));
    const written = JSON.parse(await readFile(path, "utf8"));
    assert.equal(written.head_sha, HEAD);
  } finally {
    await cleanup();
  }
});

function writeBindingFileResult(event, baseTree) {
  const resolved = bindingFromEvent(event, { baseTree });
  assert.equal(resolved.ok, true, resolved.reason);
  return resolved;
}

test("the base tree is computed by Git from the base SHA, not supplied", async () => {
  const { dir, cleanup } = await scratch();
  try {
    await execFileAsync("git", ["init", "-q", "-b", "main", dir]);
    await execFileAsync("git", ["-C", dir, "config", "user.name", "T"]);
    await execFileAsync("git", ["-C", dir, "config", "user.email", "t@example.com"]);
    await writeFile(join(dir, "state.txt"), "base\n", "utf8");
    await execFileAsync("git", ["-C", dir, "add", "state.txt"]);
    await execFileAsync("git", ["-C", dir, "commit", "-qm", "base"]);
    const head = (await execFileAsync("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();
    const tree = await deriveBaseTree(head, dir);
    assert.match(tree, /^[0-9a-f]{40}$|^[0-9a-f]{64}$/);

    const eventPath = join(dir, "event.json");
    await writeFile(eventPath, JSON.stringify(EVENT({ pull_request: { number: NUMBER, head: { sha: HEAD }, base: { sha: head } } })), "utf8");
    await recordMain({ cwd: dir, env: { GITHUB_EVENT_PATH: eventPath, RUNNER_TEMP: dir, GITHUB_RUN_ID: "1", GITHUB_SHA: head } });
    const written = JSON.parse(await readFile(join(dir, "reveries-binding", BINDING_FILE_NAME), "utf8"));
    assert.equal(written.base_tree, tree, "the tree must be the one Git reports for the base commit");
    assert.equal(written.head_sha, HEAD, "the head comes from the event, not GITHUB_SHA");
  } finally {
    await cleanup();
  }
});

// --- Only a trusted run is a source -----------------------------------------

test("only the trusted workflow path and event count as a source", () => {
  assert.equal(isTrustedRun(trustedRun(), { headSha: HEAD }), true);
  // A look-alike workflow in the same repository.
  assert.equal(isTrustedRun(trustedRun({ path: ".github/workflows/attacker.yml" }), { headSha: HEAD }), false);
  // A `pull_request` run executes the pull request's own copy of the workflow.
  assert.equal(isTrustedRun(trustedRun({ event: "pull_request" }), { headSha: HEAD }), false);
  assert.equal(isTrustedRun(trustedRun({ head_sha: "9".repeat(40) }), { headSha: HEAD }), false);
  assert.equal(isTrustedRun(undefined, { headSha: HEAD }), false);
});

test("the workflow_run source is fetched by its exact event run ID", async () => {
  const gh = fakeGitHub({ run: trustedRun() });
  const source = await trustedSourceRun(gh.github, REPO, RUN_ID, REPO_ID);
  assert.equal(source.ok, true, source.reason);
  assert.ok(gh.calls.includes(`/repos/${REPO}/actions/runs/${RUN_ID}`));
  assert.ok(!gh.calls.some((path) => path.includes("/actions/workflows/")), "no search-by-head run selection");
});

test("a different path, event, repository, head, or conclusion is not the source run", async () => {
  for (const run of [
    trustedRun({ path: ".github/workflows/attacker.yml" }),
    trustedRun({ event: "pull_request" }),
    trustedRun({ repository: { full_name: "other/repo", id: Number(REPO_ID) } }),
    trustedRun({ repository: { full_name: REPO, id: 99 } }),
    trustedRun({ head_sha: "9".repeat(40) }),
    trustedRun({ conclusion: "failure" }),
    trustedRun({ status: "in_progress" }),
  ]) {
    const gh = fakeGitHub({ run });
    assert.equal((await trustedBinding(gh)).ok, false);
  }
});

// --- Reading the artifact ----------------------------------------------------

test("a binding inside a real ZIP archive is read", async () => {
  const { dir, cleanup } = await scratch();
  try {
    const binding = buildBinding({ pullRequestNumber: NUMBER, headSha: HEAD, baseSha: BASE_B, baseTree: TREE_B });
    const zip = await artifactZip(dir, { body: serializeBinding(binding), extraEntries: [["noise.txt", "x"]] });
    const found = bindingFromArtifact(zip, { pullRequest: PULL_REQUEST, baseTree: TREE_B });
    assert.equal(found.ok, true, found.reason);
    assert.equal(found.binding.base_sha, BASE_B);
    // The reader is also usable directly.
    assert.match(String(readZipEntry(zip, BINDING_FILE_NAME)), /base_sha/);
  } finally {
    await cleanup();
  }
});

test("an archive without the binding file is a refusal", async () => {
  const { dir, cleanup } = await scratch();
  try {
    const zip = await artifactZip(dir, { name: "other.json", body: "{}" });
    const found = bindingFromArtifact(zip, { pullRequest: PULL_REQUEST, baseTree: TREE_B });
    assert.equal(found.ok, false);
    assert.match(found.reason, /no binding\.json/);
    assert.equal(bindingFromArtifact(Buffer.from("not a zip"), { pullRequest: PULL_REQUEST, baseTree: TREE_B }).ok, false);
  } finally {
    await cleanup();
  }
});

test("the exact trusted workflow_run artifact is accepted, and a moved base refuses it", async () => {
  const { dir, cleanup } = await scratch();
  try {
    const zip = await artifactZip(dir, {
      body: serializeBinding(buildBinding({ pullRequestNumber: NUMBER, headSha: HEAD, baseSha: BASE_B, baseTree: TREE_B })),
    });
    const gh = fakeGitHub({ run: trustedRun(), binary: zip });
    const ok = await trustedBinding(gh);
    assert.equal(ok.ok, true, ok.reason);
    assert.equal(ok.binding.base_sha, BASE_B);

    // The identical artifact, against a base that has since moved.
    const stale = await trustedBinding(gh, { pullRequest: { number: NUMBER, head: { sha: HEAD }, base: { sha: BASE_C } }, baseTree: TREE_C });
    assert.equal(stale.ok, false);
    assert.match(stale.reason, /base has since moved/);
  } finally {
    await cleanup();
  }
});

test("a missing, expired, ambiguous, or unfetchable artifact is a refusal", async () => {
  const none = fakeGitHub({ run: trustedRun() });
  assert.match((await trustedBinding(none)).reason, /published no reveries-receive-check-binding/);

  const expired = fakeGitHub({ run: trustedRun(), artifactList: [{ id: 1, name: BINDING_ARTIFACT_NAME, expired: true }] });
  assert.equal((await trustedBinding(expired)).ok, false);

  const ambiguous = fakeGitHub({ run: trustedRun(), artifactList: [
    { id: 1, name: BINDING_ARTIFACT_NAME, expired: false },
    { id: 2, name: BINDING_ARTIFACT_NAME, expired: false },
  ] });
  assert.match((await trustedBinding(ambiguous)).reason, /ambiguous/);

  // A fetch failure is a refusal, not an assumption that there is no binding.
  const unfetchable = fakeGitHub({ run: trustedRun(), binary: null });
  assert.equal((await trustedBinding(unfetchable)).ok, false);

  // No trusted run at all.
  const noRuns = fakeGitHub({ run: null });
  assert.equal((await trustedBinding(noRuns)).ok, false);
});

test("artifact metadata that does not name the trusted run is refused before download", async () => {
  const cases = [
    [artifactMetadata({ workflow_run: { id: 999, repository_id: Number(REPO_ID), head_sha: HEAD } }), /belongs to workflow run 999/],
    [artifactMetadata({ workflow_run: { id: Number(RUN_ID), repository_id: 4242, head_sha: HEAD } }), /different base repository/],
    [artifactMetadata({ workflow_run: { id: Number(RUN_ID), repository_id: Number(REPO_ID), head_sha: "b".repeat(40) } }), /differs from source run head/],
    [artifactMetadata({ size_in_bytes: 64 * 1024 * 1024 }), /over the .* byte download bound/],
    [artifactMetadata({ size_in_bytes: -1 }), /over the .* byte download bound/],
  ];
  for (const [artifact, pattern] of cases) {
    const gh = fakeGitHub({ run: trustedRun(), artifactList: [artifact], binary: Buffer.from("unused") });
    const result = await trustedBinding(gh);
    assert.equal(result.ok, false);
    assert.match(result.reason, pattern);
    // The refusal happens from metadata alone: no archive is fetched.
    assert.ok(!gh.calls.some((call) => typeof call === "string" && call.includes("/zip")));
  }
});

test("a fork pull request is not refused for a head repository that differs from the base", async () => {
  const FORK_ID = 555;
  const run = trustedRun({ head_repository: { id: FORK_ID, full_name: "someone/reveries" } });
  const gh = fakeGitHub({
    run,
    artifactList: [artifactMetadata({
      workflow_run: {
        id: Number(RUN_ID),
        repository_id: Number(REPO_ID),
        head_repository_id: FORK_ID,
        head_sha: HEAD,
      },
    })],
  });
  // It reaches the download step, which is the point: a fork is a valid source.
  const result = await readBindingArtifact(gh.github, gh.githubBinary, REPO, run, { repositoryId: Number(REPO_ID) });
  assert.match(result.reason, /could not be downloaded/);

  // A metadata head repository that matches neither the run's head nor nothing
  // is still refused when the run reports one.
  const mismatched = fakeGitHub({
    run,
    artifactList: [artifactMetadata({
      workflow_run: { id: Number(RUN_ID), repository_id: Number(REPO_ID), head_repository_id: 777, head_sha: HEAD },
    })],
  });
  const refusal = await readBindingArtifact(mismatched.github, mismatched.githubBinary, REPO, run, {
    repositoryId: Number(REPO_ID),
  });
  assert.match(refusal.reason, /head repository that differs/);
});

test("the artifact download is bounded and metadata that is absent is not assumed", async () => {
  const run = trustedRun();
  // Only the fields GitHub actually reported are checked; a list without a
  // workflow_run block is not treated as a mismatch.
  const sparse = fakeGitHub({ run, artifactList: [{ id: 9, name: BINDING_ARTIFACT_NAME, expired: false }], binary: null });
  const result = await readBindingArtifact(sparse.github, sparse.githubBinary, REPO, run, { repositoryId: Number(REPO_ID) });
  assert.match(result.reason, /could not be downloaded/);
  const limits = sparse.calls.filter((call) => typeof call === "object");
  assert.equal(limits.length, 1);
  assert.equal(limits[0].maxBytes, MAX_BINDING_ARCHIVE_BYTES);
});

// --- The adversarial case ---------------------------------------------------

test("a forged check run citing a real trusted run cannot substitute for its artifact", async () => {
  // The attack: a same-repository pull request adds a workflow with checks:write,
  // posts a check run of the binding's name on the head, and points it at a REAL
  // successful trusted run. Any binding carried by that check run is written by
  // the forger. The merge workflow_run ignores that check-run field entirely and
  // reads only the artifact attached to the exact source run id from its event.
  //
  // Here the forger's artifact-free setup is modelled directly: there is a real
  // trusted run, and the bot must obtain the binding from *that run's* artifact.
  // Because the forger cannot write into a run it does not own, the only binding
  // available is the trusted run's own.
  const { dir, cleanup } = await scratch();
  try {
    // The trusted run's genuine artifact: base B.
    const genuine = await artifactZip(dir, {
      body: serializeBinding(buildBinding({ pullRequestNumber: NUMBER, headSha: HEAD, baseSha: BASE_B, baseTree: TREE_B })),
    });
    // The forger's claim would be base C, with a current base of C. The bot must
    // not be satisfied by that claim; it reads the trusted run's artifact, which
    // says B, and refuses against a live base of C.
    const gh = fakeGitHub({ run: trustedRun(), binary: genuine });
    const verdict = await trustedBinding(gh, {
      pullRequest: { number: NUMBER, head: { sha: HEAD }, base: { sha: BASE_C } },
      baseTree: TREE_C,
    });
    assert.equal(verdict.ok, false, "a forger's claim must not stand in for the trusted run's artifact");
    assert.match(verdict.reason, /base has since moved/);

    // And with the forger having produced no artifact at all on any run it owns,
    // there is nothing for the bot to accept.
    const forgerOnly = fakeGitHub({ run: trustedRun({ path: ".github/workflows/attacker.yml", event: "pull_request" }) });
    const none = await trustedBinding(forgerOnly);
    assert.equal(none.ok, false);
    assert.match(none.reason, /not a successful .*pull_request_target run/);
  } finally {
    await cleanup();
  }
});

test("the artifact reader needs no check-run content", async () => {
  // The source-run ID and its artifact are sufficient to read the binding. No
  // check-run external_id or output is requested or consulted here.
  const { dir, cleanup } = await scratch();
  try {
    const genuine = await artifactZip(dir, {
      body: serializeBinding(buildBinding({ pullRequestNumber: NUMBER, headSha: HEAD, baseSha: BASE_B, baseTree: TREE_B })),
    });
    const gh = fakeGitHub({ run: trustedRun(), binary: genuine });
    // This fake source run includes no check-run fields or external_id. The
    // source-bound artifact is the binding.
    gh.github = async (path) => {
      if (path === `/repos/${REPO}/actions/runs/${RUN_ID}`) return trustedRun();
      if (/\/artifacts\?/.test(path)) return { artifacts: [{ id: 1, name: BINDING_ARTIFACT_NAME, expired: false }] };
      throw new Error(`the binding reader must not consult check-run data: ${path}`);
    };
    const result = await trustedBinding(gh);
    assert.equal(result.ok, true, result.reason);
  } finally {
    await cleanup();
  }
});

// --- Format and state validation --------------------------------------------

test("a malformed or hostile binding is refused", () => {
  for (const value of [
    undefined, "", "not json", "[]", "null",
    JSON.stringify({ v: 2, pull_request: 1, head_sha: HEAD, base_sha: BASE_B, base_tree: TREE_B }),
    JSON.stringify({ v: 1, pull_request: "1", head_sha: HEAD, base_sha: BASE_B, base_tree: TREE_B }),
    JSON.stringify({ v: 1, pull_request: 1, head_sha: "zz", base_sha: BASE_B, base_tree: TREE_B }),
    JSON.stringify({ v: 1, pull_request: 1, head_sha: HEAD, base_sha: BASE_B }),
  ]) {
    assert.equal(parseBinding(value).ok, false, `${String(value).slice(0, 40)} must be refused`);
  }
});

test("the derived base tree is required", () => {
  for (const bad of [undefined, null, "", "nope"]) {
    assert.throws(
      () => verifyBindingState(buildBinding({ pullRequestNumber: NUMBER, headSha: HEAD, baseSha: BASE_B, baseTree: TREE_B }), { pullRequest: PULL_REQUEST, baseTree: bad }),
      /requires the base tree/,
    );
  }
});

test("a binding for a different pull request, head, or tree is refused", () => {
  const binding = buildBinding({ pullRequestNumber: NUMBER, headSha: HEAD, baseSha: BASE_B, baseTree: TREE_B });
  const wrong = (over) => verifyBindingState({ ...binding, ...over }, { pullRequest: PULL_REQUEST, baseTree: TREE_B });
  assert.match(wrong({ pull_request: 99 }).reason, /pull request #99/);
  assert.match(wrong({ head_sha: "9".repeat(40) }).reason, /head/);
  assert.match(wrong({ base_tree: TREE_C }).reason, /has tree/);
  assert.equal(verifyBindingState(binding, { pullRequest: PULL_REQUEST, baseTree: TREE_B }).ok, true);
});

test("an event without a pull request records nothing", () => {
  assert.equal(bindingFromEvent({ merge_group: {} }, { baseTree: TREE_B }).ok, false);
  assert.equal(bindingFromEvent(EVENT(), { baseTree: undefined }).ok, false);
  assert.equal(bindingFromEvent({ pull_request: { number: NUMBER, head: {}, base: { sha: BASE_B } } }, { baseTree: TREE_B }).ok, false);
});
