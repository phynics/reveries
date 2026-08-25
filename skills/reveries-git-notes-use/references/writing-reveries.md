# Writing causal records

## Decide whether a reverie is warranted

Create a blob reverie only for a durable engineering decision that is true for every current
occurrence of the exact blob. Do not manufacture one for a routine implementation step, release
note, or path-specific convention. Put a path-specific reason in the session summary, an ADR, or
other guidance instead.

A commit always needs a causal session summary after adoption. It does not need a new reverie.

## Write the four causal fields

- **Driving event:** the concrete defect, constraint, directive, measurement, prior design, or risk
  that required or materially favored action.
- **Decision:** what was selected and why it addresses that event.
- **Impact:** consequences beyond the edit: interfaces, migration, constraints, accepted costs,
  affected callers, or risks.
- **Recurrence control:** a specific prevention/detection control, or `null` if none exists.

Bad: “The state machine was removed.”

Good: “Remove the parallel state machine because it independently owns transition validity while
the guarded state boundary must be the sole authority; retaining both permits incompatible
concurrent histories.”

List only meaningful rejected alternatives. Add sources as attributable causal claims, not proof.
For a material user directive, cite the configured address with
`{"relation":"requested-by","kind":"git-email","ref":"user@example.com"}` and restate
the engineering consequence in prose. Do not turn ordinary conversation into a source.

## Immutable identity

A reverie ID covers only its causal semantic payload. Do not edit causal content under the same ID.
A correction or changed rationale creates a new reverie and names the old ID in `supersedes`.
Continue copies the original canonical record exactly, preserving its ID and attestations.

Read [the protocol](../../../protocol/v1.md) for defined key order, canonical bytes, identity, and
source validation.
