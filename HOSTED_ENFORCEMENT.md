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

`.github/workflows/reveries-controlled-merge.yml` requires an operator to provide the base-tree
OID bound to the successful check. If the PR base changes, the GitHub API reports a different
tree and the bot refuses to merge until a new receive check succeeds.

## Post-merge summaries

Merging a pull request creates commits whose IDs did not exist when the pull request evidence was
written. `.github/workflows/reveries-post-merge.yml` runs on `push` to the default branch and gives
each such commit one valid session summary.

`scripts/reveries-post-merge.mjs` plans the work from committed evidence only. For every new
first-parent commit without a valid summary it asks the API for the associated pull request, fetches
`refs/pull/N/head` into a local ref, and hands the commit plus the pull request's commits to
`Reveries.synthesizeHostedSummary`. The library copies each pull request summary entry, adds a
`derived-from` commit source, and keeps the retirements whose `from_blob` changed relative to the
new commit's first parent. The script then composes the record — the Actions bot noreply address,
`github-actions:post-merge:<run_id>`, and a `github:owner/repo#N` `requested-by` source — and hands it
to `Reveries.attachHostedSummary`, which verifies the commit strictly before it writes anything and
then publishes through the same guarded notes transaction as every other operation. Notes reach the
remote with `Reveries.publishNotes`, which reconciles the remote tip and pushes `refs/notes/reveries`
alone under a compare-and-swap lease.

Trust and permissions:

- the job holds `contents: write` because the ruleset does not cover `refs/notes/reveries`;
- it checks out the pushed default-branch revision only, and never checks out or executes a pull
  request ref. Pull request commits are fetched as Git objects for reading summaries and computing
  patch IDs;
- `fetch-depth: 0`, `persist-credentials: false`, and the token is passed only through the
  environment;
- a concurrency group per branch serialises runs, and the compare-and-swap lease is the real guard
  against a concurrent writer.

Known limitations:

- a rebase merge summarizes only the new tip commit. The intermediate rewritten commits are reported
  as deferred and remain without a summary, so `reveries check` still fails for them. RVR-004
  removes the need for this bridge;
- a merge commit is verified against every parent, but retirements are copied only for predecessors
  changed relative to the first parent. When unrelated base-branch commits changed an annotated blob
  after the merge base, the strict check still fails for that predecessor, nothing is written, and
  the commit is reported instead of receiving a summary that would misattribute the decision;
- a direct push with no associated pull request is reported and left unsummarised rather than
  attributed by guesswork;
- an ambiguous rebased commit, identified by a stable patch ID that matches zero or several pull
  request commits, is reported and left unsummarised;
- the job builds and executes the default-branch revision, so a merged pull request that changes
  `package.json`, `package-lock.json`, `scripts/`, or `packages/` runs with `contents: write`. That
  risk is bounded by the pre-merge receive check, required review, and CODEOWNERS on `.github/`,
  `scripts/`, `packages/`, and the manifests. **This repository has no CODEOWNERS file yet**, so the
  workflow must not be treated as a security boundary until one exists;
- merge queues remain disabled, exactly as for the pre-merge check.

## Proposed retirement of the controlled-merge bot

The V1 controlled-merge bot cannot succeed today: it requires a successful check whose App slug is
`reveries`, while the check is posted by `github-actions` (App ID 15368), and no `reveries` App is
installed. It also holds `contents: read`, so it could not attach a summary even when it merged.

Retiring it in favour of the pre-merge receive check plus post-merge summaries is the proposed
disposition. The bot files `.github/workflows/reveries-controlled-merge.yml`,
`scripts/controlled-merge.mjs`, and `.github/reveries-required-check.json` are **still present and
still referenced**; nothing here retires them. Remove them only after both preconditions hold in
production:

1. the `pull_request_target` receive check has run and passed on real pull requests, including forks,
   with its documented permissions and no pull request code execution; and
2. the post-merge workflow has produced exactly one valid summary for a real merge, a real squash,
   and a real rebase, with a re-run proving it is a no-op.

Until then the bot is documented as inoperative rather than removed, and its App-identity pin must
not be treated as a working control.
