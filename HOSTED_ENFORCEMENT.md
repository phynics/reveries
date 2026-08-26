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

`.github/workflows/reveries-receive-check.yml` handles both `pull_request` and `merge_group`.
It fetches the notes ref, binds the proposal to the current base tree, and invokes the same
checker. Forks cannot publish notes into the base repository directly, so
`.github/workflows/reveries-evidence-import.yml` imports a fork's notes into a read-only
artifact without executing fork code.

Branch protection should require the exact `Reveries receive-check` context from the installed
Reveries App. `.github/reveries-required-check.json` is the checked-in pin consumed by the
controlled merge workflow. The V1 bot also requires the successful check's App slug and, when
`REVERIES_APP_ID` is configured, its numeric App ID.

## Controlled merges

`.github/workflows/reveries-controlled-merge.yml` requires an operator to provide the base-tree
OID bound to the successful check. If the PR base changes, the GitHub API reports a different
tree and the bot refuses to merge until a new receive check succeeds.
