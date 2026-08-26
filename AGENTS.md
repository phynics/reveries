<!-- reveries:begin -->
## Reveries

This repository stores engineering decisions in Git notes at
`refs/notes/reveries`.

Before interpreting or changing tracked code, use `using-reveries`.
For rationale and history questions, use `reveries-git-notes-search`.

This repository vendors `using-reveries` at
`.agents/skills/using-reveries/SKILL.md`. If the host did not load the Skill,
read that file before continuing.

Automatic note delivery is best-effort. When needed, inspect a file directly:

    git notes --ref=refs/notes/reveries show \
      "$(git rev-parse 'HEAD:path/to/file')"

Before publishing:
- every changed annotated blob must continue, supersede, or retire its prior reveries;
- every post-initialization commit must have exactly one valid session summary;
- use `reveries push <remote>` for publication; generic `git push` is not atomic.
<!-- reveries:end -->
