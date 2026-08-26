# Reveries roadmap

This roadmap records the next architectural direction after V1. Reveries V1 attaches
decisions to exact blobs and attaches a causal summary to each post-adoption commit. The
next version separates engineering causality from commit publication.

## The problem

A commit identity describes a Git object. It includes its tree, parents, author, committer,
timestamps, and message. Amending only metadata creates a new commit even when the engineering
transition is unchanged. Hosted squash merges and merge queues create final commit IDs after
review, so contributors cannot attach evidence to those IDs in advance.

Reveries needs three separate evidence layers:

1. **Object evidence** explains why an exact blob or tree has its form.
2. **Transition evidence** explains why parent tree or trees became a result tree.
3. **Publication attestation** connects a published commit to reviewed transition evidence.

This keeps the causal record stable when publication changes commit metadata. A rebase onto a
different base still requires new transition evidence because its parent tree changes.

## Target architecture

The target V2 model has these parts:

- Git blobs and trees remain the exact subjects of object evidence.
- Git notes remain the native, content-addressed evidence store.
- Immutable facts make replica union deterministic and make conflicts visible.
- Tree-transition summaries become the causal unit for repository-state changes.
- A protected `reveries-ledger` branch carries notes history, manifests, review projections, and
  optional retention checkpoints through normal clone and branch-governance flows.
- A retention vault keeps annotated subjects reachable through Git history.
- Host adapters enforce evidence where hosted systems create merge commits.
- Conformance grades report tested scope without claiming that local tests prove hosted behavior.

V1 remains the current implementation until a ticket introduces an explicit protocol version or
compatibility change. This roadmap does not change the approved V1 design by itself.

## Implementation order

### Stage 1: Make V1 fail safely

Strengthen synchronization, publication, retention, validation cost, worktree detection,
completeness reporting, concurrency, and team-scale testing.

Tickets: [RVR-001](docs/tickets.md#rvr-001-validate-fetched-note-unions-before-promotion),
[RVR-002](https://github.com/phynics/reveries/issues/2),
[RVR-006](https://github.com/phynics/reveries/issues/6),
[RVR-008](https://github.com/phynics/reveries/issues/8),
[RVR-010](https://github.com/phynics/reveries/issues/10),
[RVR-011](https://github.com/phynics/reveries/issues/11),
[RVR-012](https://github.com/phynics/reveries/issues/12),
[RVR-015](https://github.com/phynics/reveries/issues/15),
[RVR-016](https://github.com/phynics/reveries/issues/16), and
[RVR-020](https://github.com/phynics/reveries/issues/20).

### Stage 2: Build the V2 Evidence Graph

Introduce transition summaries, immutable facts, tree decisions, and explicit occurrence and
lineage evidence.

Tickets: [RVR-004](https://github.com/phynics/reveries/issues/4),
[RVR-007](https://github.com/phynics/reveries/issues/7),
[RVR-013](https://github.com/phynics/reveries/issues/13), and
[RVR-014](https://github.com/phynics/reveries/issues/14).

The key invariant is:

> Every protected repository-state transition has one exact causal explanation. Every final
> published commit has an attestation that links it to that transition.

### Stage 3: Add the ledger control plane

Add the protected ledger envelope, receive-side checks, signatures, remote authority roles, and
review surfaces.

Tickets: [RVR-003](https://github.com/phynics/reveries/issues/3),
[RVR-005](https://github.com/phynics/reveries/issues/5),
[RVR-009](https://github.com/phynics/reveries/issues/9),
[RVR-017](https://github.com/phynics/reveries/issues/17), and
[RVR-019](https://github.com/phynics/reveries/issues/19).

### Stage 4: Define governance boundaries

Set the policy for secrets, redaction, confidential evidence, hosted compatibility, and recovery
from rewritten or unavailable evidence.

Ticket: [RVR-018](https://github.com/phynics/reveries/issues/18).

## Ticket register

| ID | Priority | Ticket | Feasibility |
| --- | --- | --- | --- |
| RVR-001 | P0 | [Validate fetched-note unions before promotion](docs/tickets.md#rvr-001-validate-fetched-note-unions-before-promotion) | Core / V1 |
| RVR-002 | P0 | [Eliminate unsafe non-atomic publication paths](https://github.com/phynics/reveries/issues/2) | Core / V1 + Boundary |
| RVR-003 | P0 | [Add receive-side and hosted-merge enforcement](https://github.com/phynics/reveries/issues/3) | Core + Adapter + Boundary |
| RVR-004 | P0 | [Introduce tree-transition summaries](https://github.com/phynics/reveries/issues/4) | Core / V2 |
| RVR-005 | P0 | [Introduce a protected ledger envelope branch](https://github.com/phynics/reveries/issues/5) | Core / V2 + Adapter |
| RVR-006 | P0 | [Add atomic local commit-and-summary creation](https://github.com/phynics/reveries/issues/6) | Core / V1 |
| RVR-007 | P1 | [Generalize all evidence into a monotonic immutable fact graph](https://github.com/phynics/reveries/issues/7) | Core / V2 |
| RVR-008 | P0 | [Preserve annotated objects against garbage collection](https://github.com/phynics/reveries/issues/8) | Core / V1 |
| RVR-009 | P1 | [Add cryptographic attestations and signed checkpoints](https://github.com/phynics/reveries/issues/9) | Core / V2 + Boundary |
| RVR-010 | P0 | [Add protocol resource limits and bounded validation](https://github.com/phynics/reveries/issues/10) | Core / V1 hardening |
| RVR-011 | P0 | [Detect unstaged worktree edits correctly](https://github.com/phynics/reveries/issues/11) | Core / V1 |
| RVR-012 | P1 | [Replace repeated scans with a snapshot loader and disposable index](https://github.com/phynics/reveries/issues/12) | Core / V1 |
| RVR-013 | P1 | [Support exact tree-level engineering decisions](https://github.com/phynics/reveries/issues/13) | Core / V2 |
| RVR-014 | P1 | [Add occurrence-specific and N-to-M lineage evidence](https://github.com/phynics/reveries/issues/14) | Core / V2 |
| RVR-015 | P1 | [Model shallow and partial-clone completeness explicitly](https://github.com/phynics/reveries/issues/15) | Core / V1 |
| RVR-016 | P0 | [Remove the crash-prone lock as a correctness dependency](https://github.com/phynics/reveries/issues/16) | Core / V1 |
| RVR-017 | P1 | [Define primary authority, mirrors, and optional federation](https://github.com/phynics/reveries/issues/17) | Core / V1 and V2 |
| RVR-018 | P1 | [Define redaction, secrets, and confidential-evidence policy](https://github.com/phynics/reveries/issues/18) | Partial / Boundary |
| RVR-019 | P1 | [Add evidence-diff review surfaces for PRs and IDEs](https://github.com/phynics/reveries/issues/19) | Core + Adapter |
| RVR-020 | P0 | [Add multi-user, failure, and scale conformance grades](https://github.com/phynics/reveries/issues/20) | Core + Adapter |

## Conformance policy

The project reports separate grades:

- **LOCAL** covers the current protocol, CLI, direct-Git, installer, and single-repository
  behavior.
- **TEAM** covers multiple writers and clones, failure recovery, retention, incomplete clones,
  resource limits, fuzzing, and published scale results.
- **HOSTED** names the host, version, merge methods, required checks, and recovery behavior.
- **AUTOMATIC DELIVERY** names the agent host and version tested by native delivery fixtures.

A higher grade is never inferred from a lower grade. Each grade needs executable criteria and
evidence for the exact environment it names.

## Policy boundary

Reveries evidence must be readable by everyone authorized to read the repository. It must never
contain secrets. Soft redaction can suppress normal display, but it cannot erase bytes from clones,
bundles, mirrors, or caches. Hard redaction must state that distributed deletion is not guaranteed.
