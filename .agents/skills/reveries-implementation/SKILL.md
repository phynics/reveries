---
name: reveries-implementation
description: Implement or review a bounded Reveries V1 component in this repository. Use for delegated protocol, Git, CLI, hook-adapter, documentation, or test work that must preserve the approved `reveries/v1` invariants and remain inside an assigned path scope.
---

# Implement Reveries V1

Stay inside the paths assigned by the parent agent. Do not edit another agent's files.

## Preserve the boundaries

- Keep protocol and continuity functions pure.
- Parse untrusted JSON, CLI arguments, Git output, and host events at their boundaries.
- Run Git with an argv array. Do not build shell command strings.
- Use `refs/notes/reveries` explicitly. Do not change `core.notesRef`.
- Treat file reveries as universally applicable to an exact blob. Do not add path applicability.
- Keep host adapters free of Reveries domain logic.
- Mark adapters `CORE`, `PARTIAL`, or `UNVERIFIED` until conformance evidence supports `VERIFIED`.
- Preserve unknown instruction prose and unknown hooks. Never overwrite them.
- Preserve `refs/notes/reveries` during uninstall.

## Work test-first

1. Add or identify the narrow failing test for the assigned behavior.
2. Run that test and record the expected failure.
3. Add the smallest implementation that passes it.
4. Run the focused test, then the package typecheck.
5. Report the changed paths and exact verification commands.

Use real temporary Git repositories for Git behavior. Do not mock Git when the local executable can prove the result.

## Keep V1 small

Do not add path identity, server-side enforcement, network provenance lookup, an authoritative database, transcript inference, or automatic decision writing. Do not claim that evidence is authority.
