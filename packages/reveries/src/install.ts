import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { GitRepository } from "./git.ts";

const BEGIN = "<!-- reveries:begin -->";
const END = "<!-- reveries:end -->";

const AGENTS_INTRO = `## Reveries

This repository stores engineering decisions in Git notes at
\`refs/notes/reveries\`.`;

const REMINDER_SETUP = `Before interpreting or changing tracked code, read the evidence attached to it.
For rationale and history questions, search the notes.`;

const AGENTS_OUTRO = `Reveries is an evidence format, not a workflow gate: nothing here blocks a
commit or a push. When you change annotated code, decide explicitly whether the
prior reverie continues, is superseded, or is retired.

Automatic note delivery is best-effort. When needed, inspect a file directly:

    git notes --ref=refs/notes/reveries show \\
      "$(git rev-parse 'HEAD:path/to/file')"

Publish evidence with an ordinary Git push of \`refs/notes/reveries\` and
\`refs/reveries/retention\`, or use \`reveries push <remote>\` for a single atomic
push of HEAD, the notes ref, and the retention ref.`;

function agentsBlock(): string {
  return `${BEGIN}
${AGENTS_INTRO}

${REMINDER_SETUP}

${AGENTS_OUTRO}
${END}`;
}

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

function ownedBounds(text: string): { readonly start: number; readonly end: number } | null {
  const start = text.indexOf(BEGIN);
  if (start < 0) return null;
  const end = text.indexOf(END, start);
  if (end < 0) return null;
  return { start, end: end + END.length };
}

async function setOwnedBlock(path: string, block: string): Promise<{ readonly changed: boolean }> {
  const current = await readOptional(path);
  const bounds = ownedBounds(current);
  const next = bounds === null
    ? `${current}${current.length > 0 && !current.endsWith("\n") ? "\n" : ""}${current.length > 0 ? "\n" : ""}${block}\n`
    : `${current.slice(0, bounds.start)}${block}${current.slice(bounds.end)}`;
  if (next === current) {
    return { changed: false };
  }
  await writeFile(path, next, "utf8");
  return { changed: true };
}

export interface InitializationResult {
  /** Always `prepared`: setup makes no commit and needs no second step. */
  readonly state: "prepared";
  /** Files setup changed, as repository-relative paths. */
  readonly changedFiles: readonly string[];
  /** Follow-up work setup deliberately did not do. */
  readonly nextCommands: readonly string[];
}

async function withSetupLock<T>(repository: GitRepository, operation: () => Promise<T>): Promise<T> {
  const commonDirectory = await repository.commonDirectory();
  const parent = join(commonDirectory, "reveries");
  const lock = join(parent, "setup.lock");
  await mkdir(parent, { recursive: true });
  try {
    await mkdir(lock);
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error("Another Reveries setup is already running in this repository");
    }
    throw error;
  }
  try {
    return await operation();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

export async function initializeRepository(
  cwd: string,
): Promise<InitializationResult> {
  const repository = await GitRepository.open(cwd);
  return withSetupLock(repository, () => initializeUnlocked(repository));
}

/**
 * Lean initialization.
 *
 * Setup prepares the one thing a reader cannot discover from the evidence: the
 * notes merge strategy that decides how two clones' notes refs combine. It
 * writes the owned instructions block so an agent host can find the format, and
 * stops there.
 *
 * It deliberately installs no hooks, configures no publishing remote, and
 * creates no trust store. Those were enforcement: they decided when a commit or
 * a push was allowed to happen. Reveries no longer makes that decision, so
 * setup must not quietly make it on an operator's behalf.
 */
async function initializeUnlocked(repository: GitRepository): Promise<InitializationResult> {
  const changedFiles: string[] = [];
  const agentsPath = join(repository.root, "AGENTS.md");
  if ((await setOwnedBlock(agentsPath, agentsBlock())).changed) {
    changedFiles.push(relative(repository.root, agentsPath));
  }
  const previousMerge = await repository.run(
    ["config", "--get", "notes.reveries.mergeStrategy"],
    { allowExitCodes: [0, 1] },
  );
  if (previousMerge.stdout.trim() !== "cat_sort_uniq") {
    await repository.run(["config", "notes.reveries.mergeStrategy", "cat_sort_uniq"]);
  }
  return {
    state: "prepared",
    changedFiles,
    // A recommendation the operator may run, never a change setup makes: the
    // remote name is the operator's choice, and configuring it here would be
    // the publication policy the lean core removed.
    nextCommands: [
      "git fetch <remote> '+refs/notes/reveries:refs/notes/remotes/<remote>/reveries' "
        + "'+refs/reveries/retention:refs/remotes/<remote>/reveries-retention'",
    ],
  };
}
