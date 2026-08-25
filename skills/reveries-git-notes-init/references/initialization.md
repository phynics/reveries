# Initialization workflow

## Inspect and ask

Run this workflow only after the user explicitly requests setup, repair, upgrade, or removal.

1. Confirm a Git worktree and identify its root and common Git directory.
2. Inspect root `AGENTS.md`, existing Reveries records, configuration, hooks, and remotes.
3. Classify the state as absent, healthy, damaged, or older protocol.
4. Ask three separate questions:
   - Which supported host adapters should this repository configure?
   - Which remote or remotes publish Reveries?
   - Which Git email should identify material user directives?
5. Detect the optional helper and adapter support, then show a dry-run plan.

Never choose `origin` merely because it exists. Do not invent a directive address. A configured
directive address is local preference, not a network identity claim.

## Owned instruction block

Insert or update only this block in the root `AGENTS.md`; preserve all surrounding prose.

```markdown
<!-- reveries:begin -->
## Reveries

This repository stores engineering decisions in Git notes at
`refs/notes/reveries`.

Before interpreting or changing tracked code, use `reveries-git-notes-use`.
For rationale/history questions, use `reveries-git-notes-search`.

Automatic note delivery is best-effort. When needed, inspect a file directly:

    git notes --ref=refs/notes/reveries show \
      "$(git rev-parse 'HEAD:path/to/file')"

Before publishing:
- every changed annotated blob must continue, supersede, or retire its prior reveries;
- every post-initialization commit must have exactly one valid session summary.
<!-- reveries:end -->
```

Refuse duplicate or malformed owned markers. Only create host-specific instruction files for
selected hosts. Claude Code receives an owned adapter block through its supported mechanism;
Gemini may import the root file with an owned `@./AGENTS.md` block. Do not claim delivery is
verified before host-version conformance evidence exists.

## Adoption boundary

Prepare tracked instruction changes and configuration. Do not commit or push without explicit
authority. After the user creates the adoption commit, attach both a causal session summary and a
`reveries-init` record to that commit, run a strict check, then make the first atomic push.

The initializer must be idempotent. Re-running it changes only owned blocks/configuration and
reports state rather than duplicating integration.
