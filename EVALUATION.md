# Evaluate Reveries locally

The local evaluator runs every check that this repository can prove without network access,
global installation, or a native agent host. It uses disposable Git repositories and local bare
remotes. It does not push to a real remote.

## Run the evaluation

From the repository root, run:

```bash
npm ci
npm run evaluate:local
```

The evaluator runs these gates:

1. TypeScript checking.
2. The complete unit and integration suite.
3. The compiled CLI conformance workflow.
4. An npm package dry run.
5. Git whitespace validation.

Use JSON output for automation:

```bash
npm run evaluate:local -- --json
```

Use strict mode when a release job must fail until every criterion is covered:

```bash
npm run evaluate:local -- --strict
```

Normal mode exits with failure only when an executable gate fails or recorded evidence is stale.
Strict mode also fails when the acceptance matrix contains a partial, uncovered, or
environment-blocked criterion.

## Read the result

The evaluator assigns one status to each locally audited criterion:

- `covered`: a named test or local static check exists, and all executable gates passed.
- `partial`: nearby behavior is tested, but the exact acceptance scenario is not.
- `uncovered`: no dedicated executable check exists.
- `environment-blocked`: the check requires network access, a global install, or a native host.
- `not-claimed`: Reveries makes no compatibility claim that requires the check.

The first local run on 2026-08-25 produced this result:

| Status | Criteria |
| --- | ---: |
| Covered | 24 |
| Partial | 7 |
| Uncovered | 8 |
| Environment-blocked | 7 |
| Not claimed | 1 |

All five executable gates passed. The evaluator reported `release_ready: false` because local
coverage does not yet satisfy the full acceptance matrix.

## Environment boundary

This evaluator does not claim to verify:

- Skill activation inside Pi, Claude Code, OpenCode, Codex, or Gemini CLI;
- automatic delivery against a named host version;
- global installation, update, or removal through `npx skills`;
- behavior against a hosted Git service;
- usefulness during a multi-user repository pilot.

All hosts therefore remain at the `CORE` compatibility grade. Run native host conformance and a
real repository pilot before assigning an automatic-delivery grade.

The complete release criteria remain authoritative in [the approved V1 design](DESIGN.md#36-release-acceptance-criteria).
