# Contributing without the helper

This guide takes a contributor who does not have the `reveries` helper from a
fresh clone to a passing `Reveries receive-check`, using only Git and the
checked-in scripts. The helper remains the preferred path because it validates
records and publishes atomically; everything here is the lower-grade Git-only
fallback.

The canonical Git-only recipes live in
`.agents/skills/using-reveries/references/direct-git.md` and the manual setup
reference in `skills/reveries-git-notes-init/references/manual-setup.md`. This
file orchestrates those recipes into pass-the-check flows instead of
duplicating them. Hosted enforcement (workflows, fork evidence import, trust
boundary) is described in `HOSTED_ENFORCEMENT.md`.

## What the receive check enforces

Every proposed code update must arrive with its evidence:

| Stable finding code | Meaning | Fix |
|---|---|---|
| `missing-session-summary` | A proposed commit has no valid session summary note. | Attach one session summary per commit (recipe below). |
| `missing-continuity-disposition` | A changed annotated blob was neither continued, superseded, nor retired. | Continue, supersede, or retire every active decision (recipe below). |
| `missing-notes-publication` | Code was proposed without a `refs/notes/reveries` update. | Push the notes ref before the code ref (notes-first push below). |
| `summary-from-pr-description` (lower-grade) | A missing summary was covered by pull-request description text. | Attach a real session summary before merge; see below. |
| `other` | Anything else; the raw diagnostic is preserved in the finding. | Read the finding detail and rerun with `--json`. |

Run the checker with `--json` to see the typed findings; each finding carries
a `remediation` block with copy-paste commands. The protected CI check never
checks out or executes pull-request code.

## Same-repo flow

```bash
# 1. Fetch the approved evidence into your clone.
git fetch origin '+refs/notes/reveries*:refs/notes/reveries*'
git notes --ref=refs/notes/reveries list

# 2. Before editing, inspect the active decisions on the blob you will touch.
git notes --ref=refs/notes/reveries show "$(git rev-parse 'HEAD:path/to/file')"

# 3. Edit, stage, then give the successor blob its disposition:
#    continue the decision when its causal statement still holds,
#    supersede it when the statement changed, or record the retirement
#    in the commit session summary. Follow the "Continue a reverie" /
#    "Supersede a reverie" recipes in direct-git.md.

# 4. Commit, then attach exactly one session summary to that commit.
commit="$(git rev-parse HEAD)"
printf '{"v":1,"type":"session-summary","author_email":"%s","session":null,"created_at":"2026-08-25T03:00:00Z","entries":[{"driving_event":"...","decision":"...","impact":"...","recurrence_control":null,"alternatives":[],"sources":[],"reveries":[],"retirements":[]}]}\n' \
  "$(git config user.email)" > /tmp/session-summary.jsonl
git notes --ref=refs/notes/reveries add -F /tmp/session-summary.jsonl "$commit"

# 5. Publish notes before code. These pushes are separate and NOT atomic;
#    if the code push fails, leave the published notes in place and
#    reconcile before retrying. Never force either ref.
branch="$(git branch --show-current)"
git push origin refs/notes/reveries:refs/notes/reveries
git push --no-verify origin "$branch:refs/heads/$branch"
```

`--no-verify` skips the entire `pre-push` hook, including checks unrelated to
Reveries. Inspect the hook first and run any other required checks separately,
or do not use this fallback.

## Fork flow

Forks cannot publish notes into the base repository, so evidence travels
through the fork's own notes ref and is imported as Git objects:

```bash
# 1. In your fork, do steps 2-4 of the same-repo flow, then publish the
#    fork's notes ref (notes first, same non-atomic warning as above).
git push origin refs/notes/reveries:refs/notes/reveries
git push --no-verify origin "$branch:refs/heads/$branch"

# 2. Open the pull request from the fork branch. CI imports the fork's
#    notes without executing fork code
#    (.github/workflows/reveries-evidence-import.yml) and the receive
#    check validates the proposed head plus the imported evidence.

# 3. To reproduce the check locally, import the fork evidence into a
#    manifest and run the receive script against it:
node scripts/import-fork-evidence.mjs
node scripts/github-receive-check.mjs --fork-evidence-manifest reveries-fork-evidence.json
```

If the manifest reports `absent`, the fork published no notes ref: push it
from the fork and update the pull request. A manifest that names a different
pull request is rejected; evidence never crosses pull-request boundaries.

## Checking a proposal locally

Build once, then pipe a proposal to the checker. The proposal names Git
objects only; nothing is executed.

```bash
npm run build
cat > /tmp/proposal.json <<'JSON'
{
  "updates": [
    {"ref": "refs/heads/<branch>", "old": "<base-sha>", "new": "<head-sha>"},
    {"ref": "refs/notes/reveries", "old": "<base-notes-tip>", "new": "<proposed-notes-tip>"}
  ],
  "base_tree": "<base-tree-sha>",
  "evidence": [
    {"object": "<head-sha>", "base_tree": "<base-tree-sha>"},
    {"object": "<proposed-notes-tip>"}
  ]
}
JSON
node packages/reveries/dist/src/main.js receive-check --json < /tmp/proposal.json
```

## Pull-request description fallback (lower-grade, off by default)

A missing session summary can optionally be covered by the pull request
description text by passing `--allow-pr-description-summary` to
`scripts/github-receive-check.mjs`. This fallback is **off by default** and
the resulting coverage is marked `summary-from-pr-description` with grade
`lower` in the typed findings: it is explicitly weaker than a session summary
note and must never be treated as equivalent. Attach a real session summary
to the commit before merge; description text alone is not durable evidence.

Description text is read as text only. Enabling the fallback does not check
out or execute pull-request code, and the protected check keeps its
read-only permissions and base-revision checkout either way.
