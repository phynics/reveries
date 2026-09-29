# Adopting the hosted Reveries checks

This runbook installs the reusable hosted checks in another repository. The
adopter surface is one pinned caller workflow plus a branch-protection
ruleset. The checker is installed and built from the pinned Reveries revision
and never executes pull-request code.

## Prerequisites

- The adopting repository uses Reveries V1 (`refs/notes/reveries`) and has
  completed adoption on its default branch.
- Fork contributors publish `refs/notes/reveries` from the fork so the
  evidence-import workflow can read it as Git objects.

## 1. Add the pinned caller workflow

Create `.github/workflows/reveries-receive-check.yml` in the adopting
repository. Pin the action to a full commit SHA, never a branch tag:

```yaml
name: Reveries receive-check

on:
  pull_request_target:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: read

jobs:
  receive-check:
    name: Reveries receive-check
    runs-on: ubuntu-latest
    steps:
      - name: Check out the trusted base revision
        uses: actions/checkout@v7
        with:
          ref: ${{ github.event.pull_request.base.sha }}
          fetch-depth: 0
          persist-credentials: false

      - name: Run the pinned receive check
        uses: phynics/reveries/.github/actions/reveries-receive-check@<SHA>
```

Replace `<SHA>` with the reviewed upstream commit. The caller must keep
`pull_request_target` (so the workflow, action, and dependencies all come
from the base revision), check out only the base SHA, and keep read-only
permissions with `persist-credentials: false`. The action fetches the
proposed head and notes refs as Git objects and validates them with
`scripts/github-receive-check.mjs --target-dir <checkout>`.

Fork pull requests additionally need the evidence-import caller:

```yaml
      - name: Import fork evidence without executing fork code
        uses: phynics/reveries/.github/actions/reveries-evidence-import@<SHA>
        with:
          artifact-name: reveries-fork-evidence-${{ github.event.pull_request.number }}
```

Pass its manifest to the receive check via the `fork-evidence-manifest`
input.

Host-created commits need the post-merge caller on pushes to the default
branch. It requires `contents: write` (rulesets do not cover
`refs/notes/reveries`), a checkout of the pushed revision with
`fetch-depth: 0` and `persist-credentials: false`, and a per-branch
concurrency group with `cancel-in-progress: false`:

```yaml
      - name: Synthesize and publish host-created summaries
        uses: phynics/reveries/.github/actions/reveries-post-merge@<SHA>
```

## 2. Set up the ruleset

1. Require the exact `Reveries receive-check` status check on the default
   branch. A required-check name alone does not prove which workflow
   produced it: keep the caller workflow on `pull_request_target` and
   protect `.github/` with CODEOWNERS so only reviewed changes can alter
   the pinned SHA.
2. Do not enable merge queues. A `merge_group` workflow is not protected by
   `pull_request_target` and can run workflow code from the queued
   candidate; the base-controlled pull-request check does not validate queue
   candidates.
3. When the Reveries App is installed, set `REVERIES_APP_ID` and require the
   App-owned check rather than the `github-actions` bot check (see
   `HOSTED_ENFORCEMENT.md` for the V1 App-identity limitation).

## 3. Upgrade

1. Review the upstream diff and pick the new SHA.
2. Bump the `@<SHA>` pin in each caller workflow.
3. Open a pull request; the old pinned check validates the bump like any
   other change.
4. Merge only after the receive check passes on the upgrade pull request.

## Trust boundary recap

- The action installs (`npm ci`) and builds (`npm run build`) from the
  pinned action source. Target-directory code is read as Git objects and is
  never checked out or executed.
- The check scripts accept `--target-dir` (fallback
  `REVERIES_TARGET_DIR`) to select the repository under check; the checker
  binary path stays anchored at the action source.
- The post-merge action holds `contents: write`. That risk is bounded by the
  pre-merge receive check, required review, and CODEOWNERS on `.github/`,
  exactly as documented in `HOSTED_ENFORCEMENT.md`.
