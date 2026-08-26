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
};

export type ReceiveCheckResult = {
  readonly ok: boolean;
  readonly diagnostics: readonly string[];
  readonly checkedRefs: readonly string[];
  readonly notesTip: ObjectId | null;
  readonly baseTree: ObjectId | null;
};

function result(
  diagnostics: readonly string[],
  checkedRefs: readonly string[] = [],
  notesTip: ObjectId | null = null,
  baseTree: ObjectId | null = null,
): ReceiveCheckResult {
  return {
    ok: diagnostics.length === 0,
    diagnostics,
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
      diagnostics.push(`Code updates must include a proposed ${NOTES_REF} update`);
    }
    if (codeUpdates.length > 0 && notesTip === null) {
      diagnostics.push(`Code updates must include a non-deleting ${NOTES_REF} update`);
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
      if (baseTree !== null && currentBaseTree !== null && baseTree !== currentBaseTree) {
        diagnostics.push(`${update.ref}: base tree changed; prior evidence is invalid`);
      }
      if (baseTree === null && currentBaseTree !== null) baseTree = currentBaseTree;
      for (const item of evidence) {
        if (item.baseTree !== undefined && currentBaseTree !== null && item.baseTree !== currentBaseTree) {
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

    return result(diagnostics, checkedRefs, notesTip, baseTree);
  } catch (error: unknown) {
    diagnostics.push(error instanceof Error ? error.message : String(error));
    return result(diagnostics, checkedRefs, notesTip, baseTree);
  }
}

export const receiveCheck = checkReceive;
