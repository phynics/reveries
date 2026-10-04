# Lineage and retirement

## The problem lineage solves

A decision is attached to the exact content of a blob or tree. Any edit produces a new
object, so the successor carries no decision by itself. Reveries never lets new content
silently inherit old evidence: the reader sees that the successor has no evidence, and a
`link` is how a person asserts that the decision continues in a new form.

Lineage is never inferred. `reveries link suggest` prints candidate edges from content
similarity, but a suggestion is not evidence until it is recorded.

## Choose a kind

| Kind | Shape | Use when |
| --- | --- | --- |
| `preserve` | 1 to 1 | The same intent moved to a new subject. |
| `split` | 1 to N | One subject became several. |
| `merge` | N to 1 | Several subjects became one. |
| `derive` | N to M | The general case, including 2 to 3. |
| `retire` | 1 to 0 | The occurrence ended with no successor. |

The immutable record is written to the note of every `to` endpoint, or to every `from`
endpoint when `to` is empty. Because endpoints are object IDs, the edge survives a rebase.

## What a link does not do

An edge says only which subjects are related and why. It carries no decision and discharges
no obligation on its own. Each decision on a predecessor still needs its own continuation on
every successor, a supersession, or a retirement. This is deliberate: it keeps an edge from
becoming a back door around per-decision reasoning.

## Retirement

A `retire` link records that a decision no longer applies. The original record stays on its
original subject, so history is preserved. There is no session summary and no adoption
ceremony: retirement is one more lineage edge.

## What stays unresolved

After a rebase or an edit, a successor with no evidence and no lineage edge is unresolved
continuity. That is a visible gap, not an error. `reveries doctor` reports the notes as
healthy because the evidence it does have is sound; it never blocks a commit, a rebase, a
merge, or a push. Resolve the gap when the decision matters, or leave it explicit.
