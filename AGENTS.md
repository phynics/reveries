<!-- reveries:begin -->
## Reveries

This repository stores engineering decisions in Git notes at
`refs/notes/reveries`.

Before interpreting or changing tracked code, read the evidence attached to it.
For rationale and history questions, search the notes.

Reveries is an evidence format, not a workflow gate: nothing here blocks a
commit or a push. When you change annotated code, decide explicitly whether the
prior reverie continues, is superseded, or is retired.

Automatic note delivery is best-effort. When needed, inspect a file directly:

    git notes --ref=refs/notes/reveries show \
      "$(git rev-parse 'HEAD:path/to/file')"

Publish evidence with an ordinary Git push of `refs/notes/reveries` and
`refs/reveries/retention`, or use `reveries push <remote>` for a single atomic
push of HEAD, the notes ref, and the retention ref.
<!-- reveries:end -->
