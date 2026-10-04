# Writing causal records

## Decide whether a reverie is warranted

Create a blob or tree reverie only for a durable engineering decision that is true for every
occurrence of the exact content. Do not manufacture one for a routine implementation step, a
release note, or a path-specific convention. Put a path-specific reason in an ADR or other
guidance instead.

A commit does not need a session summary. Reveries no longer attaches one, and nothing
requires it before a commit or a push.

## Write the four causal fields

- **Driving event:** the concrete defect, constraint, directive, measurement, prior design, or
  risk that required or materially favored action.
- **Decision:** what was selected and why it addresses that event.
- **Impact:** consequences beyond the edit: interfaces, migration, constraints, accepted
  costs, affected callers, or risks.
- **Recurrence control:** a specific prevention or detection control, or none.

Bad: "The state machine was removed."

Good: "Remove the parallel state machine because it independently owns transition validity
while the guarded state boundary must be the sole authority; retaining both permits
incompatible concurrent histories."

List only meaningful rejected alternatives. Add sources as attributable causal claims, not
proof. For a material user directive, cite the configured address with
`{"relation":"requested-by","kind":"git-email","ref":"user@example.com"}` and restate the
engineering consequence in prose. Do not turn ordinary conversation into a source.

## Immutable identity

A reverie ID covers only its causal semantic payload. Do not edit causal content under the
same ID. A changed rationale creates a new reverie and names the old ID in `supersedes`.
Continue copies the original canonical record exactly, preserving its ID.

For the canonical key order, identity derivation, and the direct Git write sequence, use the
[canonical record recipe](direct-git.md#add-a-canonical-record). A JSON line that looks valid
does not prove that the record is a valid reverie; `reveries doctor` validates the notes.
