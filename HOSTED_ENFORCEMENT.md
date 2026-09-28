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

## Controlled merges

`.github/workflows/reveries-controlled-merge.yml` requires an operator to provide the base-tree
OID bound to the successful check. If the PR base changes, the GitHub API reports a different
tree and the bot refuses to merge until a new receive check succeeds.
