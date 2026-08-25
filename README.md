# Reveries

[![CI](https://github.com/phynics/reveries/actions/workflows/ci.yml/badge.svg)](https://github.com/phynics/reveries/actions/workflows/ci.yml)

Reveries preserves the causal engineering record that source control usually loses. It stores
immutable decisions as Git notes attached to exact blobs and attaches one causal session summary
to each published post-adoption commit.

The protocol is `reveries/v1`; its only authoritative storage ref is
`refs/notes/reveries`. The helper is optional: all evidence remains ordinary JSONL in Git notes.

## What it guarantees

- A file reverie applies to a blob, so unchanged renames and copies retain it, and an edit cannot
  silently inherit it.
- An annotated blob change must explicitly continue, supersede, or retire every active decision.
- Each published commit after the adoption boundary has one session summary.
- A note is repository evidence, not executable authority and not proof that an assertion is true.

Reveries deliberately does not manage work, permissions, architecture graphs, issue systems, or
server-side enforcement.

## Quick start

Install the Skills, then explicitly initialize a repository with
`reveries-git-notes-init`. Initialization asks how agents obtain the Skills, which hosts to
configure, which remotes publish the notes, and which email identifies material directives.
Local-only setup, no host adapters, and no directive email are valid choices. The initializer
does not create the adoption commit or push.

```bash
npx skills add https://github.com/phynics/reveries --global \
  --agent pi --agent claude-code --agent opencode --agent codex --agent gemini-cli \
  --skill reveries-git-notes-init \
  --skill using-reveries \
  --skill reveries-git-notes-search
```

The initializer asks how future agents should obtain the Reveries Skills: rely on an existing
installation, pull them from an approved repository, commit pinned copies, or expose tracked
project Skills through relative symlinks. The Skills and direct Git fallback do not require the
helper.

Build and run the helper from this repository:

```bash
npm install
npm run build
node packages/reveries/dist/src/main.js --help
```

Run the strict release evaluation:

```bash
npm run verify
```

The [local evaluation guide](EVALUATION.md) explains the executable matrix, recorded Pi evidence,
and the boundary of the automatic-delivery claim.

The helper implements `init`, `adopt`, `doctor`, `show`, `record`, `summarize`, `check`, `search`,
`history`, `sync`, `push`, and the hook entrypoints. Inspection and check commands accept
`--json` for stable machine output.

For day-to-day changes, use `using-reveries`:

```text
inspect blob evidence → edit → stage → reconcile continuity → commit
→ summarize the commit → strict check → synchronize → publish branch + notes
```

For rationale questions, use `reveries-git-notes-search`. It is read-only and starts from the
current revision unless historical evidence is requested.

## Direct Git fallback

```bash
blob="$(git rev-parse 'HEAD:src/state.rs')"
git notes --ref=refs/notes/reveries show "$blob"

git notes --ref=refs/notes/reveries list
git log -p refs/notes/reveries
```

Use `git notes --ref=refs/notes/reveries` explicitly; Reveries never changes `core.notesRef`.
The Skills include safe writing, synchronization, and recovery commands.

## Protocol documentation

- [Approved V1 design](DESIGN.md)
- [V1 protocol](protocol/v1.md)
- [Reverie schema](protocol/schemas/reverie.schema.json)
- [Session-summary schema](protocol/schemas/session-summary.schema.json)
- [Initialization-record schema](protocol/schemas/reveries-init.schema.json)

## Compatibility

| Host | Grade | Automatic delivery |
| --- | --- | --- |
| Pi | CORE | Not yet verified |
| Claude Code | CORE | Not yet verified |
| OpenCode | CORE | Not yet verified |
| Codex | CORE | Not yet verified |
| Gemini CLI | CORE | Not yet verified |

`CORE` means project instructions, Skills, direct Git inspection, and manual maintenance work.
It does not claim an automatic read/edit adapter has passed a host-version conformance suite.

## Status

Reveries V1.0.2 implements the protocol, Git core, CLI, Skills, host-neutral hook contract, and
conservative host adapters. The release gate covers 46 claimed acceptance criteria; automatic
delivery remains explicitly unclaimed. Every host stays at `CORE` until a named host version
passes the native automatic-delivery conformance suite.
