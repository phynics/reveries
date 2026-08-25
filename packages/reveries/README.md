# `@reveries/cli`

The optional Reveries helper reads, writes, validates, searches, synchronizes, and publishes
`reveries/v1` engineering memory stored in `refs/notes/reveries`.

```bash
npm install --global @reveries/cli
reveries --help
```

The helper is replaceable. Reveries records remain canonical JSONL in ordinary Git notes and can
always be inspected or maintained with Git and standard text-processing tools.

See the repository README and V1 protocol documentation for initialization, continuity, trust,
and publishing rules.

- [Repository README](https://github.com/phynics/reveries#readme)
- [V1 protocol](https://github.com/phynics/reveries/blob/main/protocol/v1.md)
