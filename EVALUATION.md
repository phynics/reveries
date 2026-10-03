# Reveries conformance grades

Reveries reports readiness as a matrix of four independent grades. No grade is
ever inferred from a lower one: a passing LOCAL suite says nothing about team,
hosted, or automatic-delivery readiness. Each runner produces its own report
naming host and version, merge mode, repository, and evidence scale, and each
runner exits non-zero while its grade is unverified or not claimed.

## Grade matrix

| Grade | Runner | Current verdict |
| --- | --- | --- |
| LOCAL | `npm run evaluate:local` (`scripts/evaluate-local.mjs`) and `npm run conformance` (`scripts/conformance.mjs`) | verified (see V1.0.2 result below) |
| TEAM | `npm run conformance:team` (`scripts/conformance-team.mjs`) | unverified: executable checks run, but no multi-user pilot and no fuzzer exist |
| HOSTED | `npm run conformance:hosted` (`scripts/conformance-hosted.mjs`) | unverified: no named host deployment exists |
| AUTOMATIC DELIVERY | `npm run conformance:delivery` (`scripts/conformance-delivery.mjs`) | not-claimed for every host version |

## Run the evaluations

From the repository root, run:

```bash
npm ci
npm run verify
```

`npm run verify` is the strict LOCAL release gate. It runs:

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

The LOCAL report carries `grade: "LOCAL"`, the workstation host and version
(Node plus Git), the repository scope, and the evidence scale (criteria and
gate counts). Normal mode fails when an executable gate fails or recorded
evidence is stale. Strict mode also fails when any claimed criterion is
partial, uncovered, or environment-blocked.

Each grade runner accepts `--json` and writes a standalone report to stdout.
Capture acceptance-runner reports with:

```bash
npm run conformance -- --json > evidence/conformance-local.json
npm run conformance:team -- --json > evidence/conformance-team.json
npm run conformance:hosted -- --json > evidence/conformance-hosted.json
npm run conformance:delivery -- --json > evidence/conformance-delivery.json
```

Every report carries `grade`, `generated_at`, `host` (name and version),
`merge_mode`, `repository`, `evidence_scale`, per-criterion results, open
`blockers`, and a `verdict` of `verified`, `unverified`, `not-claimed`, or
`failed`. Captured reports are run artifacts: inspect them, do not check them
in as claims.

## TEAM grade

`scripts/conformance-team.mjs` executes fourteen named criteria. Plain-Git
fixtures in disposable repositories cover concurrent-writer convergence,
stale-push rejection, force-push and deleted-branch detection, shallow history
bounds, partial-clone blob deferral, and transport scale (repository size,
record count, latency, memory). Composed subprocesses cover invalid-union
fail-closed behavior, compare-and-swap retries, retention survival under
aggressive pruning, resource ceilings, and snapshot-loader scale. The shared
report helpers live in `scripts/conformance-report.mjs`.

Two criteria keep the grade unverified by design: no multi-user repository
pilot has been completed and recorded, and no note-parsing fuzzer is
committed. A stable TEAM claim requires the pilot. Protocol-level latency and
memory tables remain with the benchmark scripts themselves:

```bash
node --experimental-transform-types scripts/protocol-limits-benchmark.mjs
node --experimental-transform-types scripts/reveries-snapshot-benchmark.mjs
```

## HOSTED grade

`scripts/conformance-hosted.mjs` runs the receive fixture, the post-merge
fixture, and the workflow trust-boundary tests, then reports the merge-method
matrix (merge, squash, rebase, merge queue), fork isolation, required checks,
and transport-failure recovery as explicitly unverified cells. Each cell names
the deployment evidence that would verify it: a named host deployment with the
Reveries App installed, `REVERIES_APP_ID` configured, and the App-owned check
pinned in branch protection. Hosted behavior remains a deployment contract as
described in `COMPATIBILITY.md` and `HOSTED_ENFORCEMENT.md`.

## AUTOMATIC DELIVERY grade

`scripts/conformance-delivery.mjs` verifies that the recorded Skill-routing
evidence is fresh and records the per-host status of the DESIGN section 36.4
20-case native adapter suite. Routing evidence alone never implies delivery:
all hosts remain `not-claimed` until a named host version passes the complete
suite.

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

## V1.0.2 result

The strict LOCAL evaluation on 2026-08-25 produced:

| Status | Criteria |
| --- | ---: |
| Covered | 46 |
| Not claimed | 1 |

All eight local executable gates passed and `release_ready` was `true`. CI also reruns the complete
suite in the official Node 22.20 Debian image, whose Git 2.39 client guards the portable notes-write
path.

The single `not-claimed` criterion is native automatic delivery. All hosts remain at `CORE`.
Pi 0.84.1 was tested for Skill routing, explicit initialization, and a read-only rationale search;
that evidence does not imply its automatic read/edit adapter passed the 20-case host suite.

## Remaining compatibility boundary

V1.0.2 does not claim:

- automatic delivery against any named host version;
- native Skill routing on Claude Code, OpenCode, Codex, or Gemini CLI;
- behavior against a hosted Git service beyond ordinary Git protocol semantics;
- usefulness during a multi-user repository pilot.

Assign an automatic-delivery grade only after the complete native adapter conformance suite passes
for a named host version. The complete release criteria remain authoritative in
[the approved V1 design](DESIGN.md#36-release-acceptance-criteria).
