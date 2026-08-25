import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { GitRepository } from "./git.ts";

const BEGIN = "<!-- reveries:begin -->";
const END = "<!-- reveries:end -->";
const HOOK_BEGIN = "# reveries:begin";
const HOOK_END = "# reveries:end";

const AGENTS_INTRO = `## Reveries

This repository stores engineering decisions in Git notes at
\`refs/notes/reveries\`.`;

const AGENTS_OUTRO = `Automatic note delivery is best-effort. When needed, inspect a file directly:

    git notes --ref=refs/notes/reveries show \\
      "$(git rev-parse 'HEAD:path/to/file')"

Before publishing:
- every changed annotated blob must continue, supersede, or retire its prior reveries;
- every post-initialization commit must have exactly one valid session summary.`;

const REMINDER_SETUP = `Before interpreting or changing tracked code, use \`using-reveries\`.
For rationale and history questions, use \`reveries-git-notes-search\`.`;

const VENDORED_SETUP = `${REMINDER_SETUP}

This repository vendors \`using-reveries\` at
\`.agents/skills/using-reveries/SKILL.md\`. If the host did not load the Skill,
read that file before continuing.`;

function pullSetup(repository: string): string {
  return `${REMINDER_SETUP}

If \`using-reveries\` is unavailable, install it from
\`${repository}\` before continuing:

    npx skills add ${repository} --skill using-reveries --yes

Restart the agent host after installation so that it discovers the Skill.`;
}

function agentsBlock(skillSetup: SkillSetup): string {
  let setup: string;
  switch (skillSetup.kind) {
    case "reminder":
      setup = REMINDER_SETUP;
      break;
    case "pull":
      setup = pullSetup(skillSetup.repository);
      break;
    case "vendored":
      setup = VENDORED_SETUP;
      break;
    default: {
      const exhaustive: never = skillSetup;
      throw new Error(`Unsupported Skill setup: ${JSON.stringify(exhaustive)}`);
    }
  }
  return `${BEGIN}
${AGENTS_INTRO}

${setup}

${AGENTS_OUTRO}
${END}`;
}

const CLAUDE_BLOCK = `${BEGIN}
@AGENTS.md
${END}`;

const GEMINI_BLOCK = `${BEGIN}
@./AGENTS.md
${END}`;

export type SupportedHost = "pi" | "claude" | "opencode" | "codex" | "gemini";

export type SkillSetup =
  | { readonly kind: "reminder" }
  | { readonly kind: "pull"; readonly repository: string }
  | { readonly kind: "vendored" };

export interface InitializeOptions {
  readonly hosts: readonly SupportedHost[];
  readonly publishingRemotes: readonly string[];
  readonly directiveEmail: string;
  readonly skillSetup: SkillSetup;
}

export interface InitializationResult {
  readonly enforcement: "complete" | "partial";
  readonly changedFiles: readonly string[];
  readonly hookSnippets: readonly string[];
  readonly nextCommands: readonly string[];
}

export interface RemovalOptions {
  readonly publishingRemotes: readonly string[];
}

interface OwnedBlockResult {
  readonly changed: boolean;
}

function count(text: string, needle: string): number {
  let result = 0;
  let offset = 0;
  while (true) {
    const index = text.indexOf(needle, offset);
    if (index < 0) {
      return result;
    }
    result += 1;
    offset = index + needle.length;
  }
}

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

function ownedBounds(text: string): { readonly start: number; readonly end: number } | null {
  const begins = count(text, BEGIN);
  const ends = count(text, END);
  if (begins === 0 && ends === 0) {
    return null;
  }
  if (begins !== 1 || ends !== 1) {
    throw new Error("Malformed or duplicated Reveries owned marker");
  }
  const start = text.indexOf(BEGIN);
  const markerEnd = text.indexOf(END);
  if (markerEnd < start) {
    throw new Error("The Reveries end marker appears before its begin marker");
  }
  return { start, end: markerEnd + END.length };
}

async function setOwnedBlock(path: string, block: string): Promise<OwnedBlockResult> {
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

async function removeOwnedBlock(path: string): Promise<OwnedBlockResult> {
  const current = await readOptional(path);
  const bounds = ownedBounds(current);
  if (bounds === null) {
    return { changed: false };
  }
  const before = current.slice(0, bounds.start).replace(/\n\n$/, "\n");
  const after = current.slice(bounds.end).replace(/^\n/, "");
  await writeFile(path, `${before}${after}`, "utf8");
  return { changed: true };
}

function validateEmail(email: string): void {
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) {
    throw new Error("directiveEmail must be a Git email address supplied by the user");
  }
}

function validateRemote(remote: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(remote)) {
    throw new Error(`Invalid publishing remote name: ${remote}`);
  }
}

function validateSkillSetup(skillSetup: SkillSetup): void {
  switch (skillSetup.kind) {
    case "reminder":
    case "vendored":
      return;
    case "pull":
      if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(skillSetup.repository)) {
        throw new Error("skillSetup.repository must be an HTTPS GitHub repository URL");
      }
      return;
    default: {
      const exhaustive: never = skillSetup;
      throw new Error(`Unsupported Skill setup: ${JSON.stringify(exhaustive)}`);
    }
  }
}

async function configValues(repository: GitRepository, key: string): Promise<readonly string[]> {
  const result = await repository.run(["config", "--get-all", key], { allowExitCodes: [0, 1] });
  return result.exitCode === 0 ? result.stdout.trimEnd().split("\n") : [];
}

async function ensureConfigValue(repository: GitRepository, key: string, value: string): Promise<boolean> {
  const values = await configValues(repository, key);
  if (!values.includes(value)) {
    await repository.run(["config", "--add", key, value]);
    return true;
  }
  return false;
}

async function unsetConfigValue(repository: GitRepository, key: string, value: string): Promise<void> {
  await repository.run(["config", "--fixed-value", "--unset-all", key, value], { allowExitCodes: [0, 1, 5] });
}

async function installHook(
  repository: GitRepository,
  name: "pre-push" | "post-commit",
): Promise<{ readonly installed: boolean; readonly snippet: string | null }> {
  const commonDirectory = await repository.commonDirectory();
  const path = join(commonDirectory, "hooks", name);
  const invocation = name === "pre-push" ? "reveries pre-push \"$@\"" : "reveries post-commit \"$@\"";
  const body = `#!/bin/sh\n${HOOK_BEGIN}\nexec ${invocation}\n${HOOK_END}\n`;
  const existing = await readOptional(path);
  if (existing.length === 0) {
    await writeFile(path, body, { encoding: "utf8", mode: 0o755 });
    await chmod(path, 0o755);
    return { installed: true, snippet: null };
  }
  if (existing === body) {
    return { installed: true, snippet: null };
  }
  return { installed: false, snippet: invocation };
}

async function removeOwnedHook(repository: GitRepository, name: "pre-push" | "post-commit"): Promise<void> {
  const commonDirectory = await repository.commonDirectory();
  const path = join(commonDirectory, "hooks", name);
  const existing = await readOptional(path);
  if (!existing.includes(HOOK_BEGIN) || !existing.includes(HOOK_END)) return;
  const start = existing.indexOf(HOOK_BEGIN);
  const end = existing.indexOf(HOOK_END, start) + HOOK_END.length;
  const before = existing.slice(0, start);
  const after = existing.slice(end).replace(/^\n/, "");
  const retained = `${before}${after}`;
  if (retained.trim() === "#!/bin/sh") await rm(path, { force: true });
  else await writeFile(path, retained, "utf8");
}

async function managedFlag(repository: GitRepository, key: string): Promise<boolean> {
  const result = await repository.run(["config", "--get", key], { allowExitCodes: [0, 1] });
  return result.exitCode === 0 && result.stdout.trim() === "true";
}

async function rememberManagedValue(
  repository: GitRepository,
  marker: string,
  added: boolean,
): Promise<void> {
  const existing = await repository.run(["config", "--get", marker], { allowExitCodes: [0, 1] });
  if (added || existing.exitCode !== 0) {
    await repository.run(["config", marker, added ? "true" : "false"]);
  }
}

export async function initializeRepository(
  cwd: string,
  options: InitializeOptions,
): Promise<InitializationResult> {
  validateEmail(options.directiveEmail);
  validateSkillSetup(options.skillSetup);
  if (options.hosts.length === 0) {
    throw new Error("At least one supported host must be selected explicitly");
  }
  if (options.publishingRemotes.length === 0) {
    throw new Error("At least one publishing remote must be selected explicitly");
  }

  const repository = await GitRepository.open(cwd);
  const remotesResult = await repository.run(["remote"]);
  const existingRemotes = remotesResult.stdout.trimEnd().split("\n").filter((remote) => remote.length > 0);
  for (const remote of options.publishingRemotes) {
    validateRemote(remote);
    if (!existingRemotes.includes(remote)) {
      throw new Error(`Publishing remote does not exist: ${remote}`);
    }
  }

  const changedFiles: string[] = [];
  const agentsPath = join(repository.root, "AGENTS.md");
  if ((await setOwnedBlock(agentsPath, agentsBlock(options.skillSetup))).changed) {
    changedFiles.push(relative(repository.root, agentsPath));
  }
  if (options.hosts.includes("claude")) {
    const path = join(repository.root, "CLAUDE.md");
    if ((await setOwnedBlock(path, CLAUDE_BLOCK)).changed) {
      changedFiles.push(relative(repository.root, path));
    }
  } else {
    const path = join(repository.root, "CLAUDE.md");
    if ((await removeOwnedBlock(path)).changed) changedFiles.push(relative(repository.root, path));
  }
  if (options.hosts.includes("gemini")) {
    const path = join(repository.root, "GEMINI.md");
    if ((await setOwnedBlock(path, GEMINI_BLOCK)).changed) {
      changedFiles.push(relative(repository.root, path));
    }
  } else {
    const path = join(repository.root, "GEMINI.md");
    if ((await removeOwnedBlock(path)).changed) changedFiles.push(relative(repository.root, path));
  }

  const previousMerge = await repository.run(
    ["config", "--get", "notes.reveries.mergeStrategy"],
    { allowExitCodes: [0, 1] },
  );
  if (previousMerge.stdout.trim() !== "cat_sort_uniq") {
    await repository.run(["config", "reveries.managedMergeStrategy", "true"]);
    if (previousMerge.exitCode === 0) {
      await repository.run(["config", "reveries.previousMergeStrategy", previousMerge.stdout.trim()]);
    }
    await repository.run(["config", "notes.reveries.mergeStrategy", "cat_sort_uniq"]);
  } else if ((await repository.run(
    ["config", "--get", "reveries.managedMergeStrategy"],
    { allowExitCodes: [0, 1] },
  )).exitCode !== 0) {
    await repository.run(["config", "reveries.managedMergeStrategy", "false"]);
  }
  await repository.run(["config", "reveries.directiveEmail", options.directiveEmail]);
  for (const remote of options.publishingRemotes) {
    const fetchAdded = await ensureConfigValue(
      repository,
      `remote.${remote}.fetch`,
      `+refs/notes/reveries:refs/notes/remotes/${remote}/reveries`,
    );
    const pushHeadAdded = await ensureConfigValue(repository, `remote.${remote}.push`, "HEAD");
    const pushNotesAdded = await ensureConfigValue(
      repository,
      `remote.${remote}.push`,
      "refs/notes/reveries:refs/notes/reveries",
    );
    await rememberManagedValue(repository, `reveries.managed-${remote}.fetch`, fetchAdded);
    await rememberManagedValue(repository, `reveries.managed-${remote}.pushHead`, pushHeadAdded);
    await rememberManagedValue(repository, `reveries.managed-${remote}.pushNotes`, pushNotesAdded);
  }

  const hookSnippets: string[] = [];
  for (const hook of ["pre-push", "post-commit"] as const) {
    const result = await installHook(repository, hook);
    if (result.snippet !== null) {
      hookSnippets.push(result.snippet);
    }
  }

  return {
    enforcement: hookSnippets.length === 0 ? "complete" : "partial",
    changedFiles,
    hookSnippets,
    nextCommands: [
      `git add ${changedFiles.length > 0 ? changedFiles.join(" ") : "AGENTS.md"}`,
      "git commit",
      "reveries summarize HEAD --from session-summary.json",
      "reveries summarize HEAD --init --from reveries-init.json",
      "reveries check HEAD",
      `reveries push ${options.publishingRemotes[0]}`,
    ],
  };
}

export async function removeIntegration(cwd: string, options: RemovalOptions): Promise<void> {
  const repository = await GitRepository.open(cwd);
  await removeOwnedBlock(join(repository.root, "AGENTS.md"));
  await removeOwnedBlock(join(repository.root, "CLAUDE.md"));
  await removeOwnedBlock(join(repository.root, "GEMINI.md"));
  if (await managedFlag(repository, "reveries.managedMergeStrategy")) {
    const previous = await repository.run(
      ["config", "--get", "reveries.previousMergeStrategy"],
      { allowExitCodes: [0, 1] },
    );
    if (previous.exitCode === 0) {
      await repository.run(["config", "notes.reveries.mergeStrategy", previous.stdout.trim()]);
    } else {
      await repository.run(["config", "--unset-all", "notes.reveries.mergeStrategy"], { allowExitCodes: [0, 1, 5] });
    }
  }
  await repository.run(["config", "--unset-all", "reveries.managedMergeStrategy"], { allowExitCodes: [0, 1, 5] });
  await repository.run(["config", "--unset-all", "reveries.previousMergeStrategy"], { allowExitCodes: [0, 1, 5] });
  await repository.run(["config", "--unset-all", "reveries.directiveEmail"], { allowExitCodes: [0, 1, 5] });
  for (const remote of options.publishingRemotes) {
    validateRemote(remote);
    if (await managedFlag(repository, `reveries.managed-${remote}.fetch`)) {
      await unsetConfigValue(
        repository,
        `remote.${remote}.fetch`,
        `+refs/notes/reveries:refs/notes/remotes/${remote}/reveries`,
      );
    }
    if (await managedFlag(repository, `reveries.managed-${remote}.pushHead`)) {
      await unsetConfigValue(repository, `remote.${remote}.push`, "HEAD");
    }
    if (await managedFlag(repository, `reveries.managed-${remote}.pushNotes`)) {
      await unsetConfigValue(
        repository,
        `remote.${remote}.push`,
        "refs/notes/reveries:refs/notes/reveries",
      );
    }
    for (const key of ["fetch", "pushHead", "pushNotes"]) {
      await repository.run(
        ["config", "--unset-all", `reveries.managed-${remote}.${key}`],
        { allowExitCodes: [0, 1, 5] },
      );
    }
  }
  await removeOwnedHook(repository, "pre-push");
  await removeOwnedHook(repository, "post-commit");
}
