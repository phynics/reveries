# Initialization workflow

## Inspect and ask

Run this workflow only after the user explicitly requests setup, repair, upgrade, or removal.

1. Confirm a Git worktree and identify its root and common Git directory.
2. Inspect root `AGENTS.md`, existing Reveries records, configuration, hooks, and remotes.
3. Classify the state as absent, healthy, damaged, or older protocol.
4. Ask four separate questions:
   - How should new agents obtain `using-reveries`?
   - Which supported host adapters should this repository configure?
   - Which remote or remotes publish Reveries?
   - Which Git email should identify material user directives?
5. Detect the optional helper and adapter support, then show a dry-run plan.

Never choose `origin` merely because it exists. Do not invent a directive address. A configured
directive address is local preference, not a network identity claim.

The user may select no host adapters, no publishing remotes, or no directive email. Pass those
answers as `--no-hosts`, `--no-publish`, or `--no-directive-email`. Omission is not an answer.

## Choose how agents obtain the Skill

Offer exactly these choices. Do not choose one for the user.

1. **Reminder only.** Add an `AGENTS.md` instruction to use `using-reveries`. This choice
   assumes that each agent host already has the Skill.
2. **Pull when missing.** Add the reminder, the user-approved Skill repository URL, and a
   project-install command to `AGENTS.md`. Require an HTTPS GitHub repository URL. Do not run
   the command during agent startup when the Skill is already available.
3. **Vendored Skills.** Add the reminder and commit pinned copies of all three Reveries Skills
   under `.agents/skills`. Pass the repository-relative source root with `--skill-source`.
4. **Linked project Skills.** Add the reminder and create project-local relative symlinks under
   `.agents/skills` to all three Skills in a tracked source root. Use this for a repository that
   develops or already tracks the Skills. Pass that root with `--skill-source`.
5. **Git submodule.** Add the full approved repository as the pinned submodule
   `.agents/reveries`. The submodule delivers all three Skills under
   `.agents/reveries/skills`; pass the repository URL with `--skill-repository`.
   Generated instructions initialize the recorded commit only when the checkout is missing.

For the vendored choice, verify that each destination matches its source Skill. Add every
vendored path to the initializer's tracked-file plan. Updates arrive as reviewed repository
changes. Agent startup never updates a vendored copy.

The helper owns neither an existing nonmatching directory nor a nonmatching symlink. Refuse to
replace one. Record linked or vendored ownership in the tracked `.agents/skills` setup metadata
so a later clone can remove only paths created by Reveries. Preserve that metadata when a path
has drifted and needs manual review. A repeated vendored or linked setup must converge without
changing files. For linked Skills, require every file in each source Skill subtree to be tracked.

Adding a submodule stages `.gitmodules` and the gitlink as part of the prepared adoption change.
Do not advance it automatically with `--remote`; update it later through a reviewed gitlink
change. An existing matching submodule is reused without being claimed for removal.

## Owned instruction block

Insert or update only this block in the root `AGENTS.md`; preserve all surrounding prose.

```markdown
<!-- reveries:begin -->
## Reveries

This repository stores engineering decisions in Git notes at
`refs/notes/reveries`.

Before interpreting or changing tracked code, use `using-reveries`.
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
selected hosts. Pi, OpenCode, and Codex read the owned block from `AGENTS.md`; they do not need a
second instruction file. Claude Code receives `CLAUDE.md`, and Gemini receives `GEMINI.md`.
Do not claim delivery is verified before host-version conformance evidence exists.

## Adoption boundary

Prepare tracked instruction changes and configuration. Do not commit or push without explicit
authority. After the user creates the adoption commit, attach both a causal session summary and a
`reveries-init` record to that commit, run a strict check, then make the first atomic push.

The initializer writes a fingerprinted adoption plan and valid summary and initialization
templates under `<git-common-dir>/reveries/adoption/<plan-id>/`. Run the returned
`reveries adopt --plan ... --message ...` command after review. It refuses changed prepared
files, commits only the complete `adoptionFiles` set, and attaches both records to that exact
commit. This excludes unrelated staged work and prevents a later commit from receiving the
adoption records accidentally. Each preparation has an immutable plan; a newer preparation
makes an older unconsumed plan stale.

The post-commit hook stays quiet until the adoption boundary exists. Before adoption,
`doctor` reports `prepared` as a successful state. The initializer must be idempotent.
Re-running it changes only owned blocks and configuration and does not duplicate integration.
