# `@reveries/cli`

The optional Reveries helper reads, writes, validates, searches, synchronizes, and preserves
`reveries/v1` engineering memory stored in `refs/notes/reveries`.

```bash
npm install --global @reveries/cli
reveries --help
```

The helper is replaceable. Reveries records remain canonical JSONL in ordinary Git notes and can
always be inspected or maintained with Git and standard text-processing tools. Nothing here
blocks a commit or a push.

- [Repository README](https://github.com/phynics/reveries#readme)
- [V1 protocol](https://github.com/phynics/reveries/blob/main/protocol/v1.md)
- [Architecture](https://github.com/phynics/reveries/blob/main/ARCHITECTURE.md)
