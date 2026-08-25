# Evaluate Reveries locally

The release evaluator executes the V1 acceptance matrix without network access or writes outside
disposable directories. It uses temporary Git repositories and bare remotes, a temporary home for
the Skills installer, and content-bound evidence captured from Pi 0.84.1. It does not push to a
hosted remote.

## Run the evaluation

From the repository root, run:

```bash
npm ci
npm run verify
```

`npm run verify` is the strict release gate. It runs:

1. TypeScript checking.
2. The complete unit and integration suite.
3. The compiled CLI conformance workflow.
4. The direct-Git cookbook without the helper.
5. Verification of content-bound Pi Skill evidence.
6. Global install, update, and removal for all five hosts in a disposable home.
7. An npm package dry run.
8. Git whitespace validation.

Use JSON output for automation:

```bash
npm run evaluate:local -- --strict --json
```

Normal mode fails when an executable gate fails or recorded evidence is stale. Strict mode also
fails when any claimed criterion is partial, uncovered, or environment-blocked.

## Evidence architecture

The acceptance matrix is the public release contract. Each covered criterion points directly to
a named executable scenario or verifier in the repository. Reveries does not generate a second
evidence manifest because that would create another artifact that could drift from the matrix.

Native model behavior is the exception because CI has no model credentials. The capture command
records the host version, provider, model, exact prompts and outputs, repository snapshots, and a
SHA-256 digest of every file in each tested Skill:

```bash
node scripts/native-skill-evidence.mjs --capture
```

The checked-in evidence is valid only while those Skill digests match. The normal verifier rejects
stale evidence. Recapture requires Pi and model access; verification does not.

## V1.0.0 result

The strict evaluation on 2026-08-25 produced:

| Status | Criteria |
| --- | ---: |
| Covered | 46 |
| Not claimed | 1 |

All eight executable gates passed and `release_ready` was `true`.

The single `not-claimed` criterion is native automatic delivery. All hosts remain at `CORE`.
Pi 0.84.1 was tested for Skill routing, explicit initialization, and a read-only rationale search;
that evidence does not imply its automatic read/edit adapter passed the 20-case host suite.

## Remaining compatibility boundary

V1.0.0 does not claim:

- automatic delivery against any named host version;
- native Skill routing on Claude Code, OpenCode, Codex, or Gemini CLI;
- behavior against a hosted Git service beyond ordinary Git protocol semantics;
- usefulness during a multi-user repository pilot.

Assign an automatic-delivery grade only after the complete native adapter conformance suite passes
for a named host version. The complete release criteria remain authoritative in
[the approved V1 design](DESIGN.md#36-release-acceptance-criteria).
