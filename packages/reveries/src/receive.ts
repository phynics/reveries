import { GitRepository, NOTES_REF } from "./git.ts";
import { Reveries, type CheckResult } from "./operations.ts";
import { commitId, objectId, type CommitId, type ObjectId } from "./protocol.ts";

export type ReceiveRefUpdate = {
  readonly ref: string;
  readonly oldObject: ObjectId | null;
  readonly newObject: ObjectId | null;
};

export type ReceiveEvidence = {
  readonly object: ObjectId;
  readonly baseTree?: ObjectId;
};

export type ReceiveCheckInput = {
  readonly updates: readonly ReceiveRefUpdate[];
  readonly evidence?: readonly ReceiveEvidence[];
  readonly baseTree?: ObjectId;
  /**
   * Pull-request description text used only by the explicitly opt-in
   * lower-grade summary fallback. No code is read or executed; the text
   * alone never equals a real session summary.
   */
  readonly prDescription?: string;
  /**
   * Allow the PR-description fallback to cover missing session summaries.
   * Off unless explicitly set to true; when enabled without a non-empty
   * `prDescription` the check behaves exactly as when it is disabled.
   */
  readonly allowPrDescriptionSummary?: boolean;
};

export type ReceiveFindingCode =
  | "missing-session-summary"
  | "missing-continuity-disposition"
  | "missing-notes-publication"
  | "summary-from-pr-description"
  | "other";

export type ReceiveFinding = {
  readonly code: ReceiveFindingCode;
  /** `lower` marks explicitly downgraded coverage; everything else is `strict`. */
  readonly grade: "strict" | "lower";
  readonly ref?: string;
  readonly commit?: string;
  /** The original diagnostic this finding was classified from. */
  readonly detail: string;
  /** Copy-paste commands that resolve the finding. */
  readonly remediation: string;
};

export type ReceiveCheckResult = {
  readonly ok: boolean;
  readonly diagnostics: readonly string[];
  readonly findings: readonly ReceiveFinding[];
  readonly checkedRefs: readonly string[];
  readonly notesTip: ObjectId | null;
  readonly baseTree: ObjectId | null;
};

const MISSING_NOTES_UPDATE = `Code updates must include a proposed ${NOTES_REF} update`;
const MISSING_NOTES_NON_DELETING = `Code updates must include a non-deleting ${NOTES_REF} update`;

const SUMMARY_REMEDIATION = `Attach exactly one valid session summary to the proposed commit, then push the notes ref first:

    commit="<proposed-commit-sha>"
    printf '%s\\n' '<session-summary-jsonl>' > /tmp/session-summary.jsonl
    git notes --ref=refs/notes/reveries add -F /tmp/session-summary.jsonl "$commit"
    git push origin refs/notes/reveries:refs/notes/reveries

See the "Retire a reverie and summarize the commit" recipe in
.agents/skills/using-reveries/references/direct-git.md and CONTRIBUTING.md.
A commit summary added this way must exist before the receive check runs.`;

const CONTINUITY_REMEDIATION = `Give every active decision on the changed blob an explicit disposition, then push the notes ref first:

    predecessor="$(git rev-parse 'HEAD:<path>')"
    successor="$(git rev-parse ':<path>')"
    git notes --ref=refs/notes/reveries show "$predecessor" > /tmp/predecessor.jsonl
    cp /tmp/predecessor.jsonl /tmp/successor-reveries.jsonl
    git notes --ref=refs/notes/reveries add -F /tmp/successor-reveries.jsonl "$successor"
    git push origin refs/notes/reveries:refs/notes/reveries

Continue the decision when its causal statement still holds, supersede it when
the statement changed, or retire it in the commit session summary. See the
"Continue a reverie" recipe in .agents/skills/using-reveries/references/direct-git.md
and CONTRIBUTING.md.`;

const NOTES_PUBLICATION_REMEDIATION = `Publish the notes ref alongside the code so the proposal carries its evidence:

    git push origin refs/notes/reveries:refs/notes/reveries
    git push --no-verify origin "<branch>:refs/heads/<branch>"

Push notes before code; the separate pushes are not atomic, so if the code push
fails, leave the published notes in place and reconcile before retrying. Prefer
\`reveries push <remote>\` when the helper is available. See CONTRIBUTING.md.`;

const GENERIC_REMEDIATION = `Rerun the check with \`--json\` to see the stable finding codes, then follow
CONTRIBUTING.md for the matching no-helper flow. When the helper is available,
run the strict local check before pushing again.`;

const PR_DESCRIPTION_REMEDIATION = `Lower-grade coverage: the missing session summary was covered by the pull
request description text, not by a session summary note. Attach a real session
summary to the commit (see the missing-session-summary remediation) before
merge so the published history carries durable evidence. PR-description
coverage is explicitly weaker and must never be treated as equivalent.`;

/**
 * Split an optional `<ref> <commit>: ` prefix from a receive diagnostic.
 * Diagnostics surfaced through `checkProposedRef` carry the ref twice
 * (`<ref>: <ref> <commit>: <message>`); evidence diagnostics carry only an
 * object ID and are left untouched.
 */
function splitRefPrefix(diagnostic: string): { readonly ref?: string; readonly commit?: string; readonly rest: string } {
  const doubled = /^\S+: (refs\/\S+) ([0-9a-f]{40}(?:[0-9a-f]{24})?): ([\s\S]*)$/.exec(diagnostic);
  if (doubled?.[1] !== undefined && doubled?.[2] !== undefined && doubled?.[3] !== undefined) {
    return { ref: doubled[1], commit: doubled[2], rest: doubled[3] };
  }
  const single = /^(refs\/\S+) ([0-9a-f]{40}(?:[0-9a-f]{24})?): ([\s\S]*)$/.exec(diagnostic);
  if (single?.[1] !== undefined && single?.[2] !== undefined && single?.[3] !== undefined) {
    return { ref: single[1], commit: single[2], rest: single[3] };
  }
  return { rest: diagnostic };
}

function isMissingSessionSummaryDiagnostic(diagnostic: string): boolean {
  return diagnostic.includes("requires exactly one valid session summary");
}

/**
 * Classify one receive diagnostic into a stable finding. The wording of
 * diagnostics owned by operations.ts is matched, never rewritten; anything
 * unrecognized passes through with the generic `other` code and its raw
 * detail preserved.
 */
export function classifyReceiveDiagnostic(diagnostic: string): ReceiveFinding {
  const { ref, commit, rest } = splitRefPrefix(diagnostic);
  if (diagnostic === MISSING_NOTES_UPDATE || diagnostic === MISSING_NOTES_NON_DELETING) {
    return {
      code: "missing-notes-publication",
      grade: "strict",
      ref: NOTES_REF,
      detail: diagnostic,
      remediation: NOTES_PUBLICATION_REMEDIATION,
    };
  }
  if (isMissingSessionSummaryDiagnostic(diagnostic)) {
    return {
      code: "missing-session-summary",
      grade: "strict",
      ...(ref === undefined ? {} : { ref }),
      ...(commit === undefined ? {} : { commit }),
      detail: diagnostic,
      remediation: SUMMARY_REMEDIATION,
    };
  }
  if (/(?:rv:[0-9a-f]+ from [0-9a-f]+: (?:missing-disposition|ambiguous-disposition)|predecessor blob [0-9a-f]+ has an invalid reverie projection)/.test(rest)) {
    return {
      code: "missing-continuity-disposition",
      grade: "strict",
      ...(ref === undefined ? {} : { ref }),
      ...(commit === undefined ? {} : { commit }),
      detail: diagnostic,
      remediation: CONTINUITY_REMEDIATION,
    };
  }
  return {
    code: "other",
    grade: "strict",
    ...(ref === undefined ? {} : { ref }),
    ...(commit === undefined ? {} : { commit }),
    detail: diagnostic,
    remediation: GENERIC_REMEDIATION,
  };
}

function result(
  diagnostics: readonly string[],
  checkedRefs: readonly string[] = [],
  notesTip: ObjectId | null = null,
  baseTree: ObjectId | null = null,
  findings: readonly ReceiveFinding[] | null = null,
): ReceiveCheckResult {
  return {
    ok: diagnostics.length === 0,
    diagnostics,
    findings: findings ?? diagnostics.map(classifyReceiveDiagnostic),
    checkedRefs,
    notesTip,
    baseTree,
  };
}

function isCodeRef(ref: string): boolean {
  return ref.startsWith("refs/heads/") || ref.startsWith("refs/pull/");
}

function isValidRef(ref: string): boolean {
  return ref.startsWith("refs/")
    && ref.length > "refs/".length
    && !ref.includes("\0")
    && !ref.includes("..")
    && !ref.endsWith("/")
    && !ref.includes("@{");
}

function objectOrNull(value: ObjectId | null, label: string, diagnostics: string[]): ObjectId | null {
  if (value === null) return null;
  try {
    return objectId(value);
  } catch (error: unknown) {
    diagnostics.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function appendCheck(
  diagnostics: string[],
  check: Promise<CheckResult>,
  prefix: string,
): Promise<void> {
  const result = await check;
  diagnostics.push(...result.diagnostics.map((diagnostic) => `${prefix}: ${diagnostic}`));
}

/**
 * Validate a receive proposal using only Git objects and the proposed notes tip.
 * This function never updates a ref and is safe to call from pre-receive hooks.
 */
export async function checkReceive(cwd: string, input: ReceiveCheckInput): Promise<ReceiveCheckResult> {
  const diagnostics: string[] = [];
  const checkedRefs: string[] = [];
  let notesTip: ObjectId | null = null;
  let baseTree: ObjectId | null = null;

  try {
    const repository = await GitRepository.openBare(cwd);
    if (input.updates.length === 0) diagnostics.push("The receive proposal contains no ref updates");

    const updates: ReceiveRefUpdate[] = [];
    const seenRefs = new Set<string>();
    for (const candidate of input.updates) {
      if (!isValidRef(candidate.ref)) {
        diagnostics.push(`Invalid proposed ref: ${candidate.ref}`);
        continue;
      }
      if (seenRefs.has(candidate.ref)) {
        diagnostics.push(`The receive proposal updates ${candidate.ref} more than once`);
        continue;
      }
      seenRefs.add(candidate.ref);
      const oldObject = objectOrNull(candidate.oldObject, `${candidate.ref} old object`, diagnostics);
      const newObject = objectOrNull(candidate.newObject, `${candidate.ref} new object`, diagnostics);
      updates.push({ ...candidate, oldObject, newObject });

      if (oldObject !== null && await repository.objectType(oldObject) === null) {
        diagnostics.push(`${candidate.ref}: old object ${oldObject} is unavailable`);
      }
      if (newObject !== null && await repository.objectType(newObject) === null) {
        diagnostics.push(`${candidate.ref}: new object ${newObject} is unavailable`);
      }
      if (candidate.ref === NOTES_REF) {
        if (newObject !== null && await repository.objectType(newObject) !== "commit") {
          diagnostics.push(`${candidate.ref}: proposed notes object must be a commit`);
        }
        notesTip = newObject;
      } else if (isCodeRef(candidate.ref) && newObject !== null) {
        if (await repository.objectType(newObject) !== "commit") {
          diagnostics.push(`${candidate.ref}: proposed code object must be a commit`);
        }
      }

      if (candidate.ref.startsWith("refs/heads/") || candidate.ref === NOTES_REF) {
        const current = await repository.run(
          ["rev-parse", "--verify", `${candidate.ref}^{commit}`],
          { allowExitCodes: [0, 1, 128] },
        );
        const currentObject = current.exitCode === 0 ? objectId(current.stdout.trim()) : null;
        if (oldObject === null && currentObject !== null) {
          diagnostics.push(`${candidate.ref}: creation proposal does not match the existing ref`);
        } else if (oldObject !== null && currentObject !== oldObject) {
          diagnostics.push(`${candidate.ref}: old object does not match the current ref`);
        }
      }
    }

    const codeUpdates = updates.filter((update) => isCodeRef(update.ref) && update.newObject !== null);
    const notesUpdate = updates.find((update) => update.ref === NOTES_REF);
    if (codeUpdates.length > 0 && notesUpdate === undefined) {
      diagnostics.push(MISSING_NOTES_UPDATE);
    }
    if (codeUpdates.length > 0 && notesTip === null) {
      diagnostics.push(MISSING_NOTES_NON_DELETING);
    }

    const evidence = input.evidence ?? [];
    for (const item of evidence) {
      const object = objectOrNull(item.object, "evidence object", diagnostics);
      if (object === null) continue;
      const type = await repository.objectType(object);
      if (type === null) diagnostics.push(`Evidence object ${object} is unavailable`);
      if (item.baseTree !== undefined) {
        const tree = objectOrNull(item.baseTree, `evidence ${object} base tree`, diagnostics);
        if (tree !== null && await repository.objectType(tree) !== "tree") {
          diagnostics.push(`Evidence ${object} base tree ${tree} is not a tree`);
        }
      }
    }

    if (input.baseTree !== undefined) {
      baseTree = objectOrNull(input.baseTree, "base tree", diagnostics);
      if (baseTree !== null && await repository.objectType(baseTree) !== "tree") {
        diagnostics.push(`Base tree ${baseTree} is not a tree`);
      }
    }

    for (const update of codeUpdates) {
      if (update.oldObject !== null && await repository.objectType(update.oldObject) !== "commit") {
        diagnostics.push(`${update.ref}: old object must be a commit`);
        continue;
      }
      if (update.newObject === null) continue;
      const currentBaseTree = update.oldObject === null
        ? null
        : await repository.treeForCommit(update.oldObject);
      if (baseTree === null && currentBaseTree !== null) baseTree = currentBaseTree;
      const evidenceBaseTree = baseTree ?? currentBaseTree;
      for (const item of evidence) {
        if (item.baseTree !== undefined && evidenceBaseTree !== null && item.baseTree !== evidenceBaseTree) {
          diagnostics.push(`${update.ref}: evidence base tree changed; rerun the receive check`);
        }
      }
    }

    if (notesTip !== null) {
      const reveries = await Reveries.openBareForReceive(cwd, notesTip);
      const evidenceCheck = await reveries.checkProposedEvidence();
      diagnostics.push(...evidenceCheck.diagnostics.map((diagnostic) => `evidence: ${diagnostic}`));
      for (const update of codeUpdates) {
        if (update.newObject === null) continue;
        checkedRefs.push(update.ref);
        await appendCheck(
          diagnostics,
          reveries.checkProposedRef(
            commitId(update.newObject),
            update.oldObject,
            update.ref,
          ),
          update.ref,
        );
      }
    }

    const lowerGradeFindings: ReceiveFinding[] = [];
    let effectiveDiagnostics = diagnostics;
    if (input.allowPrDescriptionSummary === true && (input.prDescription ?? "").trim().length > 0) {
      const remaining: string[] = [];
      for (const diagnostic of diagnostics) {
        if (!isMissingSessionSummaryDiagnostic(diagnostic)) {
          remaining.push(diagnostic);
          continue;
        }
        const { ref, commit } = splitRefPrefix(diagnostic);
        lowerGradeFindings.push({
          code: "summary-from-pr-description",
          grade: "lower",
          ...(ref === undefined ? {} : { ref }),
          ...(commit === undefined ? {} : { commit }),
          detail: `${diagnostic} (covered by pull-request description text: lower-grade, not a session summary)`,
          remediation: PR_DESCRIPTION_REMEDIATION,
        });
      }
      effectiveDiagnostics = remaining;
    }

    return result(
      effectiveDiagnostics,
      checkedRefs,
      notesTip,
      baseTree,
      [...lowerGradeFindings, ...effectiveDiagnostics.map(classifyReceiveDiagnostic)],
    );
  } catch (error: unknown) {
    diagnostics.push(error instanceof Error ? error.message : String(error));
    return result(diagnostics, checkedRefs, notesTip, baseTree);
  }
}

export const receiveCheck = checkReceive;
