import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  checkRequiredCheckContract,
  checkRunSatisfied,
  MERGE_ENABLED,
  sourceIsDefaultBranch,
  DEFAULT_MERGE_METHOD,
  DEFAULT_REQUIRED_APP_ID,
  DEFAULT_REQUIRED_APP_SLUG,
  hasRequiredCheck,
  MERGE_METHODS,
  resolveAppPin,
  readBoundedBody,
  treeOf,
} from "./controlled-merge.mjs";
import {
  BINDING_ARTIFACT_NAME,
  TRUSTED_EVENT,
  TRUSTED_WORKFLOW_PATH,
} from "./receive-check-binding.mjs";
import { STRICT_BASE_REQUIRED } from "./required-check-contract.mjs";

const workflow = await readFile(new URL("../.github/workflows/reveries-controlled-merge.yml", import.meta.url), "utf8");

const CHECK = "Reveries receive-check";
const run = (over = {}) => ({
  name: CHECK,
  conclusion: "success",
  app: { slug: DEFAULT_REQUIRED_APP_SLUG, id: Number(DEFAULT_REQUIRED_APP_ID) },
  ...over,
});

// --- The App pin -------------------------------------------------------------
//
// The check is posted by a workflow in this repository on a `pull_request_target`
// trigger, so GitHub attributes the run to the Actions app. An earlier revision
// pinned the slug `reveries` and read its ID from an unset repository variable:
// no installation can post a check under that slug, so the bot required an
// impossible check and refused every merge. A gate that can never open is not a
// control.

test("the default pin names the App the check actually runs under", () => {
  assert.equal(DEFAULT_REQUIRED_APP_SLUG, "github-actions");
  assert.equal(DEFAULT_REQUIRED_APP_ID, "15368");
  // The documented identity of the GitHub Actions app.
  assert.deepEqual(resolveAppPin({}), { slug: "github-actions", appId: "15368" });
});

test("the pin is configurable so a real dedicated App needs no code change", () => {
  assert.deepEqual(
    resolveAppPin({ REVERIES_REQUIRED_APP_SLUG: "reveries", REVERIES_REQUIRED_APP_ID: "4242" }),
    { slug: "reveries", appId: "4242" },
  );
  // An empty setting falls back to the default rather than pinning "".
  assert.deepEqual(resolveAppPin({ REVERIES_REQUIRED_APP_SLUG: "", REVERIES_REQUIRED_APP_ID: "" }),
    { slug: "github-actions", appId: "15368" });
});

test("a non-numeric App ID is refused rather than silently never matching", () => {
  // `app.id` comes back as a number. A non-numeric pin would compare unequal to
  // every real check and read as "the wrong App posted it", hiding a
  // misconfiguration as a policy failure.
  assert.throws(
    () => resolveAppPin({ REVERIES_REQUIRED_APP_ID: "unset" }),
    /numeric ID/,
  );
  assert.throws(() => resolveAppPin({ REVERIES_REQUIRED_APP_SLUG: "bad slug" }), /App slug/);
});

// --- The check must come from the required App -------------------------------

test("a successful check from the required App satisfies the gate", () => {
  const pin = { slug: DEFAULT_REQUIRED_APP_SLUG, appId: DEFAULT_REQUIRED_APP_ID };
  assert.equal(checkRunSatisfied(run(), { checkName: CHECK, ...pin }), true);
  assert.equal(hasRequiredCheck([run()], pin, CHECK), true);
});

test("a check name alone is never enough", () => {
  const pin = { slug: DEFAULT_REQUIRED_APP_SLUG, appId: DEFAULT_REQUIRED_APP_ID };
  // Any workflow can publish a check with the right name. The App identity is
  // what binds the result to a trusted producer.
  assert.equal(checkRunSatisfied(run({ app: { slug: "some-other-app", id: 1 } }), { checkName: CHECK, ...pin }), false);
  assert.equal(checkRunSatisfied(run({ app: { slug: DEFAULT_REQUIRED_APP_SLUG, id: 999 } }), { checkName: CHECK, ...pin }), false);
  // A run that reports no App at all cannot be attributed to one.
  assert.equal(checkRunSatisfied(run({ app: undefined }), { checkName: CHECK, ...pin }), false);
  assert.equal(checkRunSatisfied(run({ app: null }), { checkName: CHECK, ...pin }), false);
});

test("only a successful run counts, under the exact check name", () => {
  const pin = { slug: DEFAULT_REQUIRED_APP_SLUG, appId: DEFAULT_REQUIRED_APP_ID };
  for (const conclusion of ["failure", "cancelled", "skipped", "timed_out", "queued", "in_progress", null]) {
    assert.equal(
      checkRunSatisfied(run({ conclusion }), { checkName: CHECK, ...pin }),
      false,
      `conclusion ${conclusion} must not satisfy the gate`,
    );
  }
  assert.equal(checkRunSatisfied(run({ name: "evaluate" }), { checkName: CHECK, ...pin }), false);
  assert.equal(checkRunSatisfied(run({ name: "reveries receive-check " }), { checkName: CHECK, ...pin }), false);
  assert.equal(hasRequiredCheck([], pin, CHECK), false);
  assert.equal(hasRequiredCheck(undefined, pin, CHECK), false);
});

// --- The base tree the operator bound ---------------------------------------

test("the base tree is derived from the commit, never taken from input", () => {
  // The commit resource reports the tree under `tree.sha`; a tree resource
  // reports `sha` directly. The bot derives it from the base SHA the pull
  // request reports now, which is why the operator's `base_tree` is gone.
  assert.equal(treeOf({ sha: "abc", tree: { sha: "abc" } }), "abc");
  assert.equal(treeOf({ tree: { sha: "abc" } }), "abc");
  assert.equal(treeOf({ sha: "abc" }), "abc");
  assert.equal(treeOf({}), null);
  assert.equal(treeOf(undefined), null);
});

test("the bot no longer accepts an operator-supplied base tree", async () => {
  // Comparing the current base tree against a value the operator typed proved
  // nothing: typing the current tree satisfied it while a stale successful
  // check remained. The input is removed from the workflow and unread here.
  assert.doesNotMatch(workflow, /^ {6}base_tree:/m, "no base_tree dispatch input may exist");
  assert.doesNotMatch(workflow, /REVERIES_BASE_TREE/);
  assert.doesNotMatch(workflow, /inputs\.base_tree/);
  const source = await readFile(new URL("./controlled-merge.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /env\.REVERIES_BASE_TREE/);
});

test("the bot takes its binding from a run artifact, never a check run", async () => {
  // A same-repository pull request can post a look-alike check run under the same
  // App identity, so no binding may be read from one. The source is an artifact of
  // a run of the trusted workflow, which only that run can write to.
  const source = await readFile(new URL("./controlled-merge.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /external_id/, "a binding must not be read from a check run's external_id");
  assert.doesNotMatch(source, /output\.text/);
  assert.match(source, /readBindingArtifact/);
  assert.match(source, /actions\/runs\/\$\{sourceRunId\}/);
  assert.match(source, /REVERIES_SOURCE_RUN_ID/);
  // The artifact is fetched by the binding module, which is where the URL lives.
  const bindingModule = await readFile(new URL("./receive-check-binding.mjs", import.meta.url), "utf8");
  assert.match(bindingModule, /actions\/artifacts\/\$\{artifact\.id\}\/zip/);
  // Prose may name external_id to explain why it was rejected; code may not use it.
  const code = bindingModule
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join("\n");
  assert.doesNotMatch(code, /external_id/, "no binding may be read from a check run");
  // The bot is granted only the read it needs, and never writes notes.
  const granted = workflow.match(/^permissions:\n((?:  .+\n)+)/m)?.[1] ?? "";
  assert.ok(granted.includes("actions: read"));
  assert.ok(!granted.includes("contents: write"));
  assert.ok(!granted.includes("checks: write"));
});

test("the receive-check workflow needs no extra permission to record a binding", async () => {
  // Artifact upload uses the Actions runtime, not the token, so recording the
  // binding adds nothing to the read-only pair the receive check has always held.
  const receive = await readFile(new URL("../.github/workflows/reveries-receive-check.yml", import.meta.url), "utf8");
  const jobPermissions = receive.match(/^    permissions:\n((?:      .+\n)+)/m)?.[1] ?? "";
  assert.deepEqual(
    jobPermissions.trim().split("\n").map((line) => line.trim()),
    ["contents: read", "pull-requests: read"],
  );
  assert.match(receive, /actions\/upload-artifact@v4/);
  assert.match(receive, new RegExp(`name: ${BINDING_ARTIFACT_NAME}`));
  assert.match(receive, /- name: Record the base and head binding\n {8}if: success\(\)/);
  assert.match(receive, /- name: Publish the binding as an artifact of this run\n {8}if: success\(\)/);
  assert.match(receive, new RegExp(`ref: \\$\\{\\{ github\\.event\\.pull_request\\.base\\.sha \\}\\}`));
  assert.doesNotMatch(receive, /github\.event\.pull_request\.head\.sha/);
  assert.equal(TRUSTED_EVENT, "pull_request_target");
  assert.equal(TRUSTED_WORKFLOW_PATH, ".github/workflows/reveries-receive-check.yml");
});

test("merge is the default, and squash and rebase are documented as lossy", async () => {
  assert.equal(DEFAULT_MERGE_METHOD, "merge");
  assert.deepEqual(MERGE_METHODS, ["merge", "squash", "rebase"]);
  assert.match(workflow, /REVERIES_MERGE_METHOD: merge/);
  assert.doesNotMatch(workflow, /default: squash/);
  assert.equal(workflow.includes("workflow_dispatch:"), false);
  // The fail-closed workflow currently pins merge; the script's supported
  // alternatives remain documented for a future reviewed enablement.
  const source = await readFile(new URL("./controlled-merge.mjs", import.meta.url), "utf8");
  assert.match(source, /throws away every per-commit/);
});

// --- Workflow configuration --------------------------------------------------

test("the workflow's default pin matches the script's default", () => {
  assert.match(workflow, /github-actions/);
  assert.match(workflow, /15368/);
  // The old hard-coded pin and the unset variable it read are gone.
  assert.doesNotMatch(workflow, /REVERIES_REQUIRED_APP_SLUG: reveries$/m);
  assert.doesNotMatch(workflow, /vars\.REVERIES_APP_ID/);
});

test("the App pin is repository-controlled, not supplied by the workflow_run event", () => {
  // The override lives in repository configuration that only an administrator
  // can set, not in the event or an input supplied by the caller.
  assert.match(workflow, /vars\.REVERIES_REQUIRED_APP_SLUG/);
  assert.match(workflow, /vars\.REVERIES_REQUIRED_APP_ID/);
  assert.doesNotMatch(workflow, /inputs\./);

  // The defaults are still the identity the check actually runs under, and are
  // applied when the variable is unset.
  assert.match(workflow, /vars\.REVERIES_REQUIRED_APP_SLUG \|\| 'github-actions'/);
  assert.match(workflow, /vars\.REVERIES_REQUIRED_APP_ID \|\| '15368'/);
});

test("the script still validates the pin it is given", () => {
  // The pin moving to repository configuration does not weaken the check on it:
  // a non-numeric ID or an unusable slug is refused, so a misconfigured
  // variable fails loudly rather than silently never matching.
  assert.throws(() => resolveAppPin({ REVERIES_REQUIRED_APP_ID: "unset" }), /numeric ID/);
  assert.throws(() => resolveAppPin({ REVERIES_REQUIRED_APP_SLUG: "bad slug" }), /App slug/);
  // And the bot is handed the value verbatim, so the script is the single place
  // the pin is interpreted.
  assert.match(workflow, /REVERIES_REQUIRED_APP_SLUG: \$\{\{/);
  assert.match(workflow, /REVERIES_REQUIRED_APP_ID: \$\{\{/);
});

test("the bot holds no write access at all", () => {
  // Session summaries are the post-merge workflow's job; it owns
  // `refs/notes/reveries` under a compare-and-swap lease. And the merge permission
  // itself is gone while the trigger can still be dispatched from any ref.
  const permissions = workflow.match(/^permissions:\n((?:  .+\n)+)/m)?.[1];
  assert.ok(permissions, "workflow permissions are explicit");
  const granted = permissions.trim().split("\n").map((line) => line.trim());
  assert.deepEqual(granted, ["actions: read", "checks: read", "contents: read", "pull-requests: read"]);
  assert.ok(!granted.some((scope) => scope.endsWith(": write")), "the bot must hold no write scope");
});

// --- The checked-in required-check contract must agree with the code ---------
//
// `.github/reveries-required-check.json` is the record of what branch
// protection has to require. It previously named a `reveries` App that no
// installation provides, while the ruleset and the actual check runs both use
// the GitHub Actions App — so the contract disagreed with every other artifact
// in the repository. Three artifacts that name the same control have to agree,
// or one of them is decoration.

const contract = JSON.parse(
  await readFile(new URL("../.github/reveries-required-check.json", import.meta.url), "utf8"),
);
const compatibility = await readFile(new URL("../COMPATIBILITY.md", import.meta.url), "utf8");

test("the checked-in contract names the App the check actually runs under", () => {
  assert.equal(contract.app_slug, DEFAULT_REQUIRED_APP_SLUG);
  assert.equal(contract.app_id, DEFAULT_REQUIRED_APP_ID);
  // The old App never existed as an installation, so a pin naming it could only
  // ever be unsatisfiable.
  assert.notEqual(contract.app_slug, "reveries");
  assert.equal(contract.app_id_env, "REVERIES_REQUIRED_APP_ID");
  assert.equal(contract.check_name, "Reveries receive-check");
});

test("the contract's override names match the workflow's repository variables", () => {
  // An override the workflow does not read is not an override; it is a second
  // place to change the trust boundary and forget one of them.
  assert.equal(contract.app_slug_env, "REVERIES_REQUIRED_APP_SLUG");
  assert.equal(contract.app_id_env, "REVERIES_REQUIRED_APP_ID");
  assert.match(workflow, new RegExp(`vars\\.${contract.app_slug_env}`));
  assert.match(workflow, new RegExp(`vars\\.${contract.app_id_env}`));
});

test("the contract records the binding the bot now requires", () => {
  // A passing check alone is not sufficient, a look-alike check of the same name
  // is not sufficient either, and a contract that does not say so implies it is.
  assert.equal(contract.binding_artifact_name, BINDING_ARTIFACT_NAME);
  assert.match(contract.binding_note, /base SHA/);
  assert.match(contract.binding_note, /artifact/);
  assert.match(contract.binding_note, /belong to one run/i);
  assert.match(contract.binding_note, /shared by every workflow/);
  assert.match(contract.binding_note, /pull_request_target/);
  assert.match(contract.binding_note, /Missing, unreadable, ambiguous, stale, or untrusted-source bindings are refused/);
});

test("the contract states that overriding the App requires matching ruleset config", () => {
  // A bot trusting App A while branch protection requires App B checks nothing.
  assert.match(contract.override_note, /branch protection must be changed/i);
  assert.match(contract.override_note, /one control/);
});

test("COMPATIBILITY.md no longer claims an App that is not installed", () => {
  // It previously told adopters to "install the App" and configure
  // REVERIES_APP_ID for an App that does not exist.
  assert.doesNotMatch(compatibility, /REVERIES_APP_ID/);
  assert.doesNotMatch(compatibility, /the required `reveries` App is not installed/);
  assert.doesNotMatch(compatibility, /install the App/i);
  assert.match(compatibility, /github-actions/);
});

// --- The host-side base guard ------------------------------------------------
//
// A binding can only describe the state at the moment it was read. Between the
// bot's last pull-request read and `PUT /pulls/{n}/merge` the base can advance,
// and the merge request's `sha` guards the head only. No check the bot performs
// can close that window, so the host has to: `strict_required_status_checks_policy`
// makes GitHub refuse a merge whose branch is behind its base.
//
// This repository's live ruleset does NOT have it set, which is why #25 stays
// open. The shape below is taken from the real ruleset rather than invented.

const PINNED = { slug: DEFAULT_REQUIRED_APP_SLUG, appId: DEFAULT_REQUIRED_APP_ID };
const context = (integrationId) => ({ context: "Reveries receive-check", integration_id: integrationId });

const ruleset = (over = {}) => ({
  name: "main: Reveries receive-check",
  enforcement: "active",
  conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
  rules: [
    { type: "non_fast_forward" },
    { type: "deletion" },
    {
      type: "required_status_checks",
      parameters: {
        do_not_enforce_on_create: false,
        required_status_checks: [context(Number(DEFAULT_REQUIRED_APP_ID))],
        strict_required_status_checks_policy: true,
      },
    },
  ],
  ...over,
});

test("a strict ruleset requiring the pinned App satisfies the contract", () => {
  const result = checkRequiredCheckContract(() => {}, ruleset(), { pin: PINNED, checkName: "Reveries receive-check" });
  assert.equal(result.ok, true, result.reason);
});

test("the live ruleset shape, without strict, is refused", () => {
  // The repository's actual ruleset as queried: strict is false. A bot that
  // merged on this configuration would be relying on a comparison already stale
  // by the time the merge landed.
  const live = ruleset();
  live.rules[2].parameters.strict_required_status_checks_policy = false;
  const result = checkRequiredCheckContract(() => {}, live, { pin: PINNED, checkName: "Reveries receive-check" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /strict_required_status_checks_policy/);
  assert.match(result.reason, /up to date with the base/);
});

test("a ruleset that does not require the pinned App is refused", () => {
  // Otherwise a check from any App would satisfy the gate the bot trusts.
  const wrong = ruleset();
  wrong.rules[2].parameters.required_status_checks = [context(999)];
  const result = checkRequiredCheckContract(() => {}, wrong, { pin: PINNED, checkName: "Reveries receive-check" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /does not require Reveries receive-check from the github-actions App/);
});

test("a ruleset with no required status checks at all is refused", () => {
  const bare = ruleset({ rules: [{ type: "non_fast_forward" }] });
  const result = checkRequiredCheckContract(() => {}, bare, { pin: PINNED, checkName: "Reveries receive-check" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /no ruleset requires/);
});

test("the strict-base requirement has one wording everywhere", () => {
  // The contract file, the documentation, and the bot's refusal must not drift.
  assert.equal(checkRequiredCheckContract(() => {}, ruleset({ rules: [{ type: "non_fast_forward" }] }), {
    pin: PINNED, checkName: "nope",
  }).reason, "no ruleset requires nope");
  const live = ruleset();
  live.rules[2].parameters.strict_required_status_checks_policy = false;
  const refusal = checkRequiredCheckContract(() => {}, live, { pin: PINNED, checkName: "Reveries receive-check" }).reason;
  assert.equal(refusal, STRICT_BASE_REQUIRED, "the bot must use the shared wording verbatim");
  assert.match(contract.strict_base_note, /strict_required_status_checks_policy/);
  assert.match(contract.strict_base_note, /guards the\s+head only/);
  assert.equal(contract.strict_required_status_checks, true);
});


// --- The dispatch source ----------------------------------------------------
//
// `workflow_dispatch` lets a caller pick a ref, and GitHub runs the workflow
// *definition* from that ref. A guard inside the YAML therefore cannot be a
// control against a caller who edits that YAML — the guard is in the file being
// edited. What these checks do is close the narrower cases and make the
// requirement explicit; the residual risk is documented rather than papered over.

const DEFAULT_BRANCH = "main";
const WF = `phynics/reveries/.github/workflows/reveries-controlled-merge.yml`;

test("a workflow_run on the default branch is accepted", () => {
  assert.equal(
    sourceIsDefaultBranch({ ref: "refs/heads/main", workflowRef: `${WF}@refs/heads/main`, defaultBranch: DEFAULT_BRANCH }).ok,
    true,
  );
});

test("a workflow_run from any other ref is refused", () => {
  // workflow_run should always be on the default branch; this catches a
  // misconfigured or unexpected platform context before it reaches the API.
  for (const ref of ["refs/heads/attacker", "refs/heads/feature/x", "refs/tags/v1", "refs/heads/main2"]) {
    const result = sourceIsDefaultBranch({ ref, workflowRef: `${WF}@${ref}`, defaultBranch: DEFAULT_BRANCH });
    assert.equal(result.ok, false, `${ref} must be refused`);
    assert.match(result.reason, /only runs from the default branch/);
  }
});

test("a workflow definition taken from another ref is refused", () => {
  const result = sourceIsDefaultBranch({
    ref: "refs/heads/main",
    workflowRef: `${WF}@refs/heads/attacker`,
    defaultBranch: DEFAULT_BRANCH,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /only the default branch's/);
});

test("an unreported workflow or definition ref is refused, not assumed", () => {
  for (const input of [
    { ref: undefined, workflowRef: `${WF}@refs/heads/main` },
    { ref: "", workflowRef: `${WF}@refs/heads/main` },
    { ref: "refs/heads/main", workflowRef: undefined },
    { ref: "refs/heads/main", workflowRef: WF },
  ]) {
    assert.equal(
      sourceIsDefaultBranch({ ...input, defaultBranch: DEFAULT_BRANCH }).ok,
      false,
      `${JSON.stringify(input)} must be refused`,
    );
  }
});

test("the merge bot is triggered by workflow_run and checks out the default branch", async () => {
  assert.match(workflow, /workflow_run:\n/);
  assert.match(workflow, /workflows: \["Reveries receive-check"\]/);
  assert.match(workflow, /types: \[completed\]/);
  assert.match(workflow, /if: github\.event\.workflow_run\.conclusion == 'success'/);
  assert.doesNotMatch(workflow, /workflow_dispatch/);
  assert.match(workflow, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.doesNotMatch(workflow, /ref: \$\{\{ github\.ref \}\}/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /environment: reveries-merge/);
  assert.match(workflow, /REVERIES_SOURCE_RUN_ID: \$\{\{ github\.event\.workflow_run\.id \}\}/);
  assert.doesNotMatch(workflow, /REVERIES_PULL_REQUEST/);
  const permissions = workflow.match(/^permissions:\n((?:  .+\n)+)/m)?.[1] ?? "";
  assert.ok(!permissions.includes("pull-requests: write"));
  assert.equal(MERGE_ENABLED, false);
  // And the run-time guard exists independently of that checkout setting.
  const source = await readFile(new URL("./controlled-merge.mjs", import.meta.url), "utf8");
  assert.match(source, /sourceIsDefaultBranch/);
  assert.match(source, /GITHUB_WORKFLOW_REF/);
  assert.match(source, /GITHUB_REF/);
  assert.match(source, /actions\/runs\/\$\{sourceRunId\}/, "the bot re-fetches the exact event-named source run");
  assert.doesNotMatch(source, /discoverTrustedBinding/, "the bot does not search for a convenient matching run");
});

test("the contract records workflow_run, hard-disabled status, and external prerequisites", () => {
  assert.equal(contract.merge_trigger, "workflow_run");
  assert.equal(contract.merge_environment, "reveries-merge");
  assert.equal(contract.merge_enabled, false);
  assert.ok(contract.merge_enablement_prerequisites.some((p) => /strict_required_status_checks_policy=true/.test(p)));
  assert.ok(contract.merge_enablement_prerequisites.some((p) => /required reviewers/.test(p)));
  assert.ok(contract.merge_enablement_prerequisites.some((p) => /Independently review/.test(p)));
});

// --- The head guard on the merge request -------------------------------------

test("the merge request carries the head SHA it validated", async () => {
  // Without `sha`, a head that moves after the checks but before the merge would
  // be merged unchecked. Sending it makes GitHub refuse that case.
  const source = await readFile(new URL("./controlled-merge.mjs", import.meta.url), "utf8");
  assert.match(source, /JSON\.stringify\(\{ merge_method: mergeMethod, sha: pullRequest\.head\.sha \}\)/);
});

test("a merge refused for a moved head is reported rather than retried", async () => {
  // The bot does not retry on a 409. A retry would be a fresh merge attempt
  // against a head it has not re-validated, which is the thing being prevented.
  const source = await readFile(new URL("./controlled-merge.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /status === 409[\s\S]{0,200}retry/i);
  assert.match(source, /GitHub did not merge the pull request/);
});

// --- The binding directory the two steps must agree on ----------------------

test("the binding producer and the upload step read one job-level directory", async () => {
  const receive = await readFile(new URL("../.github/workflows/reveries-receive-check.yml", import.meta.url), "utf8");
  // A step-scoped `env:` does not reach later steps, so the variable has to be at
  // job level for the upload step to resolve it at all.
  const jobEnv = receive.match(/^    env:\n((?:      .+\n)+)/m)?.[1] ?? "";
  assert.match(jobEnv, /BINDING_DIR: \$\{\{ runner\.temp \}\}\/reveries-binding/);
  assert.doesNotMatch(receive, /^        env:\n          BINDING_DIR/m, "BINDING_DIR must not be step-scoped");
  assert.match(receive, /path: \$\{\{ env\.BINDING_DIR \}\}\/binding\.json/);

  // The producer writes to the same variable, so the two cannot drift.
  const publisher = await readFile(new URL("./publish-receive-check-binding.mjs", import.meta.url), "utf8");
  assert.match(publisher, /env\.BINDING_DIR \?\? join\(env\.RUNNER_TEMP/);
});


// --- The bot is not merge-capable while its trigger is not trusted -----------

test("the merge bot is hard-disabled until review and external prerequisites are complete", async () => {
  assert.equal(MERGE_ENABLED, false);
  const source = await readFile(new URL("./controlled-merge.mjs", import.meta.url), "utf8");
  assert.match(source, /if \(!MERGE_ENABLED\)/);
  assert.match(source, /independent review of the workflow_run artifact binding/);
  assert.match(source, /strict base serialization/);
  // No workflow token can merge in the reviewed state, independently of the
  // hard code guard.
  const permissions = workflow.match(/^permissions:\n((?:  .+\n)+)/m)?.[1] ?? "";
  assert.ok(!permissions.includes("pull-requests: write"));
});

test("the workflow_run source is the default branch, and the environment is external config", async () => {
  // `workflow_run` has no ref selector. The environment gate still requires
  // repository settings (required reviewers and protected-branch deployment
  // policy); YAML cannot create that protection by naming the environment.
  assert.match(workflow, /workflow_run:/);
  assert.match(workflow, /environment: reveries-merge/);
  const source = await readFile(new URL("./controlled-merge.mjs", import.meta.url), "utf8");
  assert.match(source, /sourceIsDefaultBranch/);
  const doc = await readFile(new URL("../HOSTED_ENFORCEMENT.md", import.meta.url), "utf8");
  assert.match(doc, /workflow_run.*default branch/s);
  assert.match(doc, /required reviewers/);
  assert.match(doc, /strict_required_status_checks_policy/);
});

test("a response body is bounded before it is buffered", async () => {
  const bodyOf = (chunks) => new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
  );

  // A body inside the bound is returned whole.
  const small = bodyOf([new Uint8Array([1, 2, 3]), new Uint8Array([4])]);
  assert.deepEqual([...await readBoundedBody(small, 16)], [1, 2, 3, 4]);

  // An oversized Content-Length is refused from the header alone, with no read.
  const declared = new Response(new Uint8Array([1, 2, 3]), { headers: { "content-length": "999" } });
  await assert.rejects(() => readBoundedBody(declared, 16), /over the 16 byte bound/);

  // A missing or lying header does not help: the streamed bytes are counted, and
  // the reader is cancelled the moment the total crosses the bound.
  let cancelled = false;
  const lying = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(8));
        controller.enqueue(new Uint8Array(8));
        controller.enqueue(new Uint8Array(8));
      },
      cancel() { cancelled = true; },
    }),
  );
  await assert.rejects(() => readBoundedBody(lying, 12), /exceeded the 12 byte bound/);
  assert.equal(cancelled, true);

  // No limit is not a licence to read everything.
  await assert.rejects(() => readBoundedBody(bodyOf([new Uint8Array(1)]), 0), /positive response byte limit/);
  await assert.rejects(() => readBoundedBody({ headers: new Headers() }, 8), /no body/);
});
