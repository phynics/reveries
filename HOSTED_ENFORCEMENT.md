# Hosted enforcement

`reveries receive-check` is the host-neutral receive boundary. It accepts the standard
pre-receive `old new ref` stream or a JSON proposal and reads only Git objects. A code update
must include a proposed `refs/notes/reveries` tip; the checker validates that notes snapshot,
the object IDs named as evidence, the base-tree binding, and every new post-adoption commit.
It never updates a ref, so a failing result is safe to use before a receive transaction moves.

## GHES

Install `packages/reveries/adapters/ghes-pre-receive.sh` as the repository's `pre-receive` hook
and make `reveries` available to the hook user. Git supplies proposed ref updates on standard
input. The hook exits nonzero before Git updates any ref when code or evidence is incomplete.

## GitHub.com

`.github/workflows/reveries-receive-check.yml` runs on `pull_request_target`, so GitHub uses the
workflow from the base branch. It checks out the event's base SHA and runs the workflow, scripts,
package metadata, and dependencies from that trusted checkout. It then fetches the proposed head
SHA and `refs/notes/reveries` from the PR head repository into Git refs; it does not check out or
execute PR code. The job grants only `contents: read` and `pull-requests: read`, and checkout does
not persist its token in Git configuration.

Forks cannot publish notes into the base repository directly, so
`.github/workflows/reveries-evidence-import.yml` imports a fork's notes into a read-only artifact
without executing fork code.

The workflow does not run on `merge_group`. Do not enable merge queues for this check until a
trusted GitHub App provides and owns a required check that validates the queue candidate. A
`merge_group` workflow is not protected by `pull_request_target` and can use workflow code from
the queued candidate. The base-controlled pull-request check does not validate queue candidates,
prove the final merge result, or act as a GitHub server-side pre-receive hook.

Branch protection must require the exact `Reveries receive-check` context. A required-check name
alone does not prove which workflow produced it; protect changes to `.github/` and `scripts/` with
CODEOWNERS and keep the workflow on `pull_request_target`. `.github/reveries-required-check.json`
is the checked-in App identity pin consumed by the controlled-merge workflow. The V1 bot also
requires the successful check's App slug and, when `REVERIES_APP_ID` is configured, its numeric
App ID.

## Adopting the checks

The hosted checks ship as reusable composite actions under `.github/actions/`:

- `reveries-receive-check` installs and builds the checker from the pinned action source, fetches
  the proposed head and notes refs as Git objects into the target directory, and validates them
  without executing pull-request code;
- `reveries-post-merge` builds the synthesis library from the pinned action source and publishes
  host-created summaries through the guarded notes transaction;
- `reveries-evidence-import` imports a fork's notes into a read-only artifact without executing
  fork code.

An adopting repository needs only a SHA-pinned caller workflow plus a ruleset; this repository
dogfoods the same actions through local-path callers in `.github/workflows/`. The check scripts
take `--target-dir` (fallback `REVERIES_TARGET_DIR`) so the repository under check is explicit,
while the checker binary stays anchored at the action source. The full pinning, upgrade, and
ruleset runbook lives in `docs/adopt-hosted-checks.md`.

## Controlled merges

`.github/workflows/reveries-controlled-merge.yml` runs on `workflow_run` after a successful
`Reveries receive-check`. `workflow_run` has no caller-selected ref: GitHub starts the downstream
workflow from the default branch, which removes the workflow-definition source hole present in
`workflow_dispatch`. The workflow takes no caller-supplied PR number, base tree, or ref; it reads the
source run ID from the event and the PR number/head/base binding from that run's artifact.

The privileged job names the `reveries-merge` environment. Repository settings must configure
required reviewers and a protected-branch deployment policy for that environment; naming it in YAML
does not create approval. Those settings are **not configured by this code change**.

### Source-bound receive-check evidence

The merge job re-fetches the exact receive-check run named by the `workflow_run` event and verifies
its repository, workflow path, `pull_request_target` event, conclusion, and head before it reads that
run's artifact. It then compares the artifact's PR number/head/base/tree against the live PR and the
base tree it derives independently from the base SHA. It also requires the ordinary
`Reveries receive-check` from the pinned App on the same head. Any missing, unreadable, expired,
ambiguous, malformed, stale, or untrusted-source evidence is refused.

This is an **artifact of the run**, not a check-run field. A same-repository PR can add a workflow
that requests `checks: write` and post a same-name check run under the shared `github-actions` App; a
forger-supplied `external_id` can cite a real trusted run without proving that run emitted the
payload. Artifacts belong to one run and only that run can upload to it, so they are source-bound.
The receive-check stays read-only — artifact upload uses the Actions runtime and adds no token
permission — and the merge job has `actions: read` to download the artifact.

`pull_request_target` is the trust boundary for the producer: GitHub executes the workflow
definition from the base branch. This repository's receive-check checks out the base SHA and fetches
proposal objects only; it never checks out or executes PR code. The artifact publisher reads the
trusted event payload and a base tree computed from the checked-out base commit.

### The merge bot is deliberately disabled

The script has `MERGE_ENABLED = false`, and the workflow grants no write permission. The workflow
run, source-bound artifact, ruleset verification, head-SHA guard, and protected-environment gate are
implemented for independent review, but the bot cannot merge in this state. Do not flip the flag or
grant `pull-requests: write` until all review and external prerequisites below are proven.

The merge call carries `sha: pullRequest.head.sha`, so GitHub rejects a head that moves after
validation. The default-branch ruleset must also set `strict_required_status_checks_policy=true` to
have GitHub reject a PR whose base moves between validation and merge; the live ruleset currently has
that value set to **false**.

Before enabling merges, a repository administrator must configure the `reveries-merge` environment
with required reviewers and a protected-branch deployment policy. These settings are external to
the YAML. The source-run artifact chain, ruleset setting, environment approval, and head-SHA guard
must all pass independent review first. Until then, deployment remains pending, #25/#35 remain open,
and the bot stays non-operational.

### Unproven: the artifact metadata shape for a real fork pull request

The bot checks every artifact field GitHub actually reports against the exact trusted
`workflow_run`: the `workflow_run.id`, the base `repository_id`, the `head_sha`, and the
`head_repository_id`. A field GitHub omits is not treated as a mismatch, and a field it reports
wrongly is a refusal before any bytes are downloaded. Declared `size_in_bytes` over the 8 MiB bound
is refused, and the download itself is bounded by `Content-Length` when present and by counted
stream bytes in every case, so `arrayBuffer()` can no longer allocate an unbounded body.

`head_repository_id` is compared to the **source run's** head repository, never to the base
repository, because a fork pull request is a legitimate source and its head repository is a
different repository by definition. No digest comparison is made: nothing here has a verified
definition for which digest would bind the archive to the artifact record, so inventing one would
add a check that looks strong and proves nothing.

What is **not** proven is how the Runs and run-artifacts APIs populate these fields for a real fork
pull request. Every case above is exercised against a stand-in, and the source workflow has never
run on a live fork PR here. Before enabling the bot, a fork PR must be observed end to end and the
real `head_sha` and artifact-metadata values compared against the trusted run. If a live fork run
reports a head SHA or repository identity that does not match the base-branch workflow run, the
correct fix is to correct the expectation, not to relax the comparison.

Two further external prerequisites are unresolved. The default-branch ruleset must set
`strict_required_status_checks_policy=true` (it is `false` today). And the ruleset's bypass list
must be reviewed: a bypass actor can merge without the required check, which defeats the bot's gate
regardless of what this repository's code decides. Any actor that can bypass required status checks
on the default branch is as strong as the merge permission itself.

## The host must serialise the base

A binding describes the state at the moment it was read. Between the bot's final pull-request read and
`PUT /pulls/{n}/merge` the base can advance, and the merge request's `sha` guards the **head** only. No
check the bot performs can close that window; only the host can.

`strict_required_status_checks_policy` on the default-branch ruleset is the guard: with it on, GitHub
refuses a merge whose branch is behind its base, so the race is resolved by the platform rather than by
a check the bot already finished. A merge queue serialises candidates instead and is an acceptable
alternative, but is out of scope here.

The bot reads the ruleset and refuses when the setting is absent, or when the ruleset cannot be read at
all. Reading it needs no extra permission on a public repository; where it is unreadable — a private
repository, or a token without access — the answer is a refusal, never an assumption that the setting
is on.

**This repository's live ruleset does not currently set it.** `strict_required_status_checks_policy`
is `false` on ruleset 23365189, so the bot refuses to merge here even once the binding is deployed.
Turning it on is a repository-settings change, deliberately not made by this work.

**None of this is deployed, so nothing here has been observed in production.** The receive-check
workflow change reaches `main` only through integration, and the binding is only proven once a real
pull request produces a real check run the bot accepts and a moved base that it refuses. Until then
the bot is a gate whose behaviour is tested but unexercised, and #25 is not complete. The
pre-merge receive check and the post-merge summaries remain the controls that actually hold.
Retirement of the bot remains the proposed end state.

## Disposition of the controlled-merge bot

The V1 controlled-merge bot could not succeed: it required a successful check whose App slug was
`reveries`, while the check is posted by `github-actions` (App ID 15368), and no `reveries` App is
installed. It also held `contents: read`, so it could not attach a summary even when it merged.

The App pin is now configurable and defaults to the identity the check actually runs under, so the
bot can perform the merge it was written to perform. Retirement in favour of the pre-merge receive
check plus post-merge summaries remains the proposed end state. The bot files
`.github/workflows/reveries-controlled-merge.yml`, `scripts/controlled-merge.mjs`,
`scripts/controlled-merge.test.mjs`, and `.github/reveries-required-check.json` are **still present
and still referenced**; nothing here retires them. Remove them only after both preconditions hold
in production:

1. the `pull_request_target` receive check has run and passed on real pull requests, including
   forks, with its documented permissions and no pull request code execution; and
2. the post-merge workflow is deployed on the default branch and has produced exactly one valid
   summary for a real merge, a real squash, and a real rebase, with a re-run proving it is a no-op.

**Neither precondition holds yet.** The post-merge workflow is committed but not deployed, and
merge commits on the default branch currently have no session summary at all. Retiring the bot
before it does would remove the only merge-summary control while nothing has replaced it, so the
files stay until the second precondition is observed through an authorized workflow run.

Until then the App-identity pin must not be treated as a security boundary on its own: it proves
which App posted a check, and the check's own authority comes from being required by the ruleset
and run from the trusted base revision.
