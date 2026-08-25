# Reveries

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
`reveries-git-notes-init`. Initialization asks which remotes publish the notes and which hosts to
configure. It does not create the adoption commit or push.

```bash
npx skills add OWNER/reveries --global \
  --agent pi --agent claude-code --agent opencode --agent codex --agent gemini-cli \
  --skill reveries-git-notes-init \
  --skill reveries-git-notes-use \
  --skill reveries-git-notes-search
```

Replace `OWNER/reveries` with the published Skills repository. The Skills and direct Git fallback
do not require the helper.

Build and run the helper from this repository:

```bash
npm install
npm run build
node packages/reveries/dist/src/main.js --help
```

Run the sandbox-safe release evaluation:

```bash
npm run evaluate:local
```

The [local evaluation guide](EVALUATION.md) explains coverage statuses and checks that require
native hosts or external access.

The helper implements `init`, `doctor`, `show`, `record`, `summarize`, `check`, `search`,
`history`, `sync`, `push`, and the hook entrypoints. Inspection and check commands accept
`--json` for stable machine output.

For day-to-day changes, use `reveries-git-notes-use`:

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

The V1 protocol, Git core, CLI, Skills, host-neutral hook contract, and conservative host adapters
are implemented. Every host remains at `CORE` until a named host version passes the native
automatic-delivery conformance suite.
