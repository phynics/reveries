import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { access, chmod, cp, lstat, mkdir, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { GitRepository, LEDGER_REF } from "./git.ts";
import { parseNote, type ReveriesInit } from "./protocol.ts";

/**
 * The ledger envelope branch name, without its `refs/heads/` prefix.
 *
 * `LEDGER_REF` owns the full ref name; setup needs the bare branch name to build
 * fetch refspecs for both ends of the mapping. Deriving it from the owned
 * constant keeps the two from drifting apart.
 */
const LEDGER_BRANCH = LEDGER_REF.slice("refs/heads/".length);

const BEGIN = "<!-- reveries:begin -->";
const END = "<!-- reveries:end -->";
const HOOK_BEGIN = "# reveries:begin";
const HOOK_END = "# reveries:end";
const SKILL_NAMES = ["using-reveries", "reveries-git-notes-search", "reveries-git-notes-init"] as const;
const SKILL_SUBMODULE_NAME = "reveries-skills";
const SKILL_SUBMODULE_PATH = ".agents/reveries";
const execFileAsync = promisify(execFile);

const AGENTS_INTRO = `## Reveries

This repository stores engineering decisions in Git notes at
\`refs/notes/reveries\`.`;

const AGENTS_OUTRO = `Automatic note delivery is best-effort. When needed, inspect a file directly:

    git notes --ref=refs/notes/reveries show \\
      "$(git rev-parse 'HEAD:path/to/file')"

Before publishing:
- every changed annotated blob must continue, supersede, or retire its prior reveries;
- every post-initialization commit must have exactly one valid session summary;
- use \`reveries push <remote>\` for publication; generic \`git push\` is not atomic.`;

const REMINDER_SETUP = `Before interpreting or changing tracked code, use \`using-reveries\`.
For rationale and history questions, use \`reveries-git-notes-search\`.`;

const VENDORED_SETUP = `${REMINDER_SETUP}

This repository vendors the Reveries Skills under \`.agents/skills\`. If the
host did not load them, read \`.agents/skills/using-reveries/SKILL.md\` before
continuing.`;

function pullSetup(repository: string): string {
  return `${REMINDER_SETUP}

If \`using-reveries\` is unavailable, install it from
\`${repository}\` before continuing:

    npx skills add ${repository} --skill using-reveries \\
      --skill reveries-git-notes-search \\
      --skill reveries-git-notes-init --yes

Restart the agent host after installation so that it discovers the Skill.`;
}

const SYMLINK_SETUP = `${REMINDER_SETUP}

This repository exposes linked project Skills under \`.agents/skills\`. If the
host did not load them, read \`.agents/skills/using-reveries/SKILL.md\` before
continuing.`;

function submoduleSetup(repository: string): string {
  return `${REMINDER_SETUP}

This repository pins the Reveries Skills in the Git submodule
\`.agents/reveries\` from \`${repository}\`. If the submodule is absent or
uninitialized, restore its recorded commit before continuing:

    git submodule update --init --recursive -- .agents/reveries

If the host did not load the Skill, read
\`.agents/reveries/skills/using-reveries/SKILL.md\` before continuing.`;
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
    case "symlink":
      setup = SYMLINK_SETUP;
      break;
    case "submodule":
      setup = submoduleSetup(skillSetup.repository);
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
  | { readonly kind: "vendored"; readonly sourceRoot: string }
  | { readonly kind: "symlink"; readonly sourceRoot: string }
  | { readonly kind: "submodule"; readonly repository: string };

export interface HelperInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly verification?: "probe" | "self";
}

export interface InitializeOptions {
  readonly hosts: readonly SupportedHost[];
  readonly publishingRemotes: readonly string[];
  readonly directiveEmail: string | null;
  readonly skillSetup: SkillSetup;
  readonly helper?: HelperInvocation;
}

export interface HostRouting {
  readonly host: SupportedHost;
  readonly instructionFile: "AGENTS.md" | "CLAUDE.md" | "GEMINI.md";
}

export interface InitializationResult {
  readonly state: "prepared";
  readonly enforcement: "complete" | "partial";
  readonly changedFiles: readonly string[];
  readonly adoptionFiles: readonly string[];
  readonly unrelatedChanges: readonly string[];
  readonly concurrentChanges: readonly string[];
  readonly hostRouting: readonly HostRouting[];
  readonly templatePaths: {
    readonly sessionSummary: string;
    readonly initialization: string;
    readonly plan: string;
  };
  readonly hookSnippets: readonly string[];
  readonly nextCommands: readonly string[];
  /** Git-only contributor steps; empty when a working helper is configured. */
  readonly noHelperGuidance: readonly string[];
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
  const retained = `${before}${after}`;
  if (retained.trim().length === 0) await rm(path, { force: true });
  else await writeFile(path, retained, "utf8");
  return { changed: true };
}

function validateEmail(email: string | null): void {
  if (email !== null && !/^[^\s@]+@[^\s@]+$/.test(email)) {
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
      return;
    case "vendored":
    case "symlink":
      if (skillSetup.sourceRoot.trim().length === 0) {
        throw new Error("skillSetup.sourceRoot must name a repository-relative Skill directory");
      }
      return;
    case "pull":
    case "submodule":
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

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function hookInvocation(helper: HelperInvocation, hook: "pre-push" | "post-commit"): string {
  return [helper.command, ...helper.args, hook].map(shellQuote).join(" ") + ' "$@"';
}

/**
 * Git-only contributor steps for clones without a working helper. The steps
 * orchestrate the direct-Git recipes into a flow that reaches a passing
 * receive check; same-repo and fork variants live in CONTRIBUTING.md.
 */
export function noHelperContributorGuidance(): readonly string[] {
  return [
    "No working helper is configured: follow CONTRIBUTING.md for the Git-only same-repo and fork flows.",
    "Fetch approved evidence before changing code: git fetch <remote> '+refs/notes/reveries*:refs/notes/reveries*' (use a publishing remote).",
    "Inspect blob decisions with git notes --ref=refs/notes/reveries show \"$(git rev-parse 'HEAD:<path>')\"; continue, supersede, or retire every active decision using .agents/skills/using-reveries/references/direct-git.md.",
    "Attach exactly one session summary per commit, then publish notes before code; the separate pushes are not atomic. Prefer `reveries push <remote>` when the helper is available.",
  ];
}

async function resolveNoHelperGuidance(helper: HelperInvocation | undefined): Promise<readonly string[]> {
  return await helperInvocationAvailable(helper) ? [] : noHelperContributorGuidance();
}

export async function helperInvocationAvailable(helper: HelperInvocation | undefined): Promise<boolean> {
  if (helper === undefined || helper.command.length === 0 || helper.command.includes("\0")) return false;
  if (helper.args.some((argument) => argument.includes("\0") || argument.includes("\n"))) return false;
  if (helper.command.includes("/") || isAbsolute(helper.command)) {
    try {
      await access(helper.command, constants.X_OK);
      for (const argument of helper.args) {
        if (isAbsolute(argument)) await access(argument, constants.R_OK);
      }
      if (helper.verification === "self") {
        const script = helper.args[0];
        return await realpath(helper.command) === await realpath(process.execPath)
          && helper.args.length === 1
          && script !== undefined
          && /^(?:cli|main)\.(?:js|ts)$/.test(basename(script));
      }
      const result = await execFileAsync(helper.command, [...helper.args, "--version"], {
        encoding: "utf8",
        timeout: 5_000,
      });
      return /^reveries [0-9]+\.[0-9]+\.[0-9]+$/m.test(result.stdout.trim());
    } catch {
      return false;
    }
  }
  return false;
}

export async function helperInvocationFingerprint(helper: HelperInvocation | undefined): Promise<string | null> {
  if (helper === undefined || (!helper.command.includes("/") && !isAbsolute(helper.command))) return null;
  try {
    const hash = createHash("sha256");
    hash.update(await pathFingerprint(await realpath(helper.command)));
    for (const argument of helper.args) {
      hash.update("\0");
      hash.update(argument);
      if (isAbsolute(argument)) hash.update(await pathFingerprint(await realpath(argument)));
    }
    return hash.digest("hex");
  } catch {
    return null;
  }
}

async function ensureSkillSource(root: string, sourceRoot: string): Promise<string> {
  if (isAbsolute(sourceRoot)) throw new Error("Skill source must be repository-relative");
  const source = resolve(root, sourceRoot);
  const withinRoot = relative(root, source);
  if (withinRoot === "" || withinRoot.startsWith("..") || isAbsolute(withinRoot)) {
    throw new Error("Skill source must be a directory inside the repository");
  }
  for (const name of SKILL_NAMES) {
    const skillRoot = join(source, name);
    const skill = await realpath(join(skillRoot, "SKILL.md"));
    const resolvedPaths = [await realpath(skillRoot), skill, ...await Promise.all(
      (await directoryLeafPaths(skillRoot)).map((path) => realpath(path)),
    )];
    if (resolvedPaths.some((path) => {
      const relativePath = relative(root, path);
      return relativePath.startsWith("..") || isAbsolute(relativePath);
    })) {
      throw new Error(`Skill source escapes the repository: ${name}`);
    }
    await access(skill, constants.R_OK);
  }
  return source;
}

async function pathKind(path: string): Promise<"absent" | "symlink" | "directory" | "other"> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) return "symlink";
    if (stat.isDirectory()) return "directory";
    return "other";
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "absent";
    throw error;
  }
}

async function directoriesEqual(left: string, right: string): Promise<boolean> {
  const leftEntries = await readdir(left, { withFileTypes: true });
  const rightEntries = await readdir(right, { withFileTypes: true });
  const rightByName = new Map(rightEntries.map((entry) => [entry.name, entry]));
  if (leftEntries.length !== rightEntries.length) return false;
  for (const leftEntry of leftEntries) {
    const rightEntry = rightByName.get(leftEntry.name);
    if (rightEntry === undefined) return false;
    const leftPath = join(left, leftEntry.name);
    const rightPath = join(right, rightEntry.name);
    if (leftEntry.isDirectory() && rightEntry.isDirectory()) {
      if (!await directoriesEqual(leftPath, rightPath)) return false;
    } else if (leftEntry.isFile() && rightEntry.isFile()) {
      if (!(await readFile(leftPath)).equals(await readFile(rightPath))) return false;
    } else if (leftEntry.isSymbolicLink() && rightEntry.isSymbolicLink()) {
      if (await readlink(leftPath) !== await readlink(rightPath)) return false;
    } else {
      return false;
    }
  }
  return true;
}

async function installSkills(
  repository: GitRepository,
  setup: Extract<SkillSetup, { readonly kind: "vendored" | "symlink" }>,
): Promise<{ readonly changed: readonly string[]; readonly sourceRoot: string }> {
  const root = repository.root;
  const sourceRoot = await ensureSkillSource(root, setup.sourceRoot);
  const destinationRoot = join(root, ".agents", "skills");
  await mkdir(destinationRoot, { recursive: true });
  const actions: Array<{ readonly source: string; readonly destination: string; readonly target: string }> = [];
  for (const name of SKILL_NAMES) {
    const source = join(sourceRoot, name);
    const destination = join(destinationRoot, name);
    const kind = await pathKind(destination);
    if (setup.kind === "symlink") {
      const sourceFiles = await directoryLeafPaths(source);
      const tracked = await repository.run(
        ["ls-files", "--error-unmatch", "--", ...sourceFiles.map((path) => relative(root, path))],
        { allowExitCodes: [0, 1] },
      );
      if (sourceFiles.length === 0 || tracked.exitCode !== 0) {
        throw new Error(`Every linked Skill source file must be tracked: ${relative(root, source)}`);
      }
      const target = relative(dirname(destination), source);
      if (kind === "symlink" && await readlink(destination) === target) continue;
      if (kind !== "absent") throw new Error(`Refusing to replace existing Skill path: ${relative(root, destination)}`);
      actions.push({ source, destination, target });
    } else {
      if (kind === "directory" && await directoriesEqual(source, destination)) continue;
      if (kind !== "absent") {
        throw new Error(`Refusing to replace existing Skill path: ${relative(root, destination)}`);
      }
      actions.push({ source, destination, target: "" });
    }
  }
  const created: string[] = [];
  try {
    for (const action of actions) {
      if (setup.kind === "symlink") {
        await symlink(action.target, action.destination, "dir");
        created.push(action.destination);
      } else {
        await mkdir(action.destination);
        created.push(action.destination);
        await cp(action.source, action.destination, { recursive: true, force: true });
      }
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}. Partial Skill paths were preserved for explicit repair: ${created.map(
      (path) => relative(root, path),
    ).join(", ")}`);
  }
  return { changed: created.map((path) => relative(root, path)), sourceRoot: relative(root, sourceRoot) };
}

async function preflightSkills(
  repository: GitRepository,
  setup: Extract<SkillSetup, { readonly kind: "vendored" | "symlink" }>,
): Promise<void> {
  const root = repository.root;
  const sourceRoot = await ensureSkillSource(root, setup.sourceRoot);
  for (const name of SKILL_NAMES) {
    const source = join(sourceRoot, name);
    const destination = join(root, ".agents", "skills", name);
    const kind = await pathKind(destination);
    if (setup.kind === "symlink") {
      const sourceFiles = await directoryLeafPaths(source);
      const tracked = await repository.run(
        ["ls-files", "--error-unmatch", "--", ...sourceFiles.map((path) => relative(root, path))],
        { allowExitCodes: [0, 1] },
      );
      if (sourceFiles.length === 0 || tracked.exitCode !== 0) {
        throw new Error(`Every linked Skill source file must be tracked: ${relative(root, source)}`);
      }
      const target = relative(dirname(destination), source);
      if (kind !== "absent" && !(kind === "symlink" && await readlink(destination) === target)) {
        throw new Error(`Refusing to replace existing Skill path: ${relative(root, destination)}`);
      }
    } else if (kind !== "absent" && !(kind === "directory" && await directoriesEqual(source, destination))) {
      throw new Error(`Refusing to replace existing Skill path: ${relative(root, destination)}`);
    }
  }
}

interface SubmoduleEntry {
  readonly name: string;
  readonly path: string;
  readonly repository: string;
}

function canonicalRepositoryUrl(repository: string): string {
  return repository.replace(/\.git$/, "");
}

async function submoduleEntries(repository: GitRepository): Promise<readonly SubmoduleEntry[]> {
  const result = await repository.run(
    ["config", "-f", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"],
    { allowExitCodes: [0, 1, 5] },
  );
  if (result.exitCode !== 0) return [];
  const entries: SubmoduleEntry[] = [];
  for (const line of result.stdout.trimEnd().split("\n").filter(Boolean)) {
    const separator = line.indexOf(" ");
    if (separator < 0) throw new Error("The .gitmodules file contains a malformed submodule path");
    const key = line.slice(0, separator);
    const path = line.slice(separator + 1);
    const prefix = "submodule.";
    const suffix = ".path";
    if (!key.startsWith(prefix) || !key.endsWith(suffix)) {
      throw new Error("The .gitmodules file contains a malformed submodule path");
    }
    const name = key.slice(prefix.length, -suffix.length);
    const url = await repository.run(
      ["config", "-f", ".gitmodules", "--get", `submodule.${name}.url`],
      { allowExitCodes: [0, 1, 5] },
    );
    if (url.exitCode !== 0 || url.stdout.trim().length === 0) {
      throw new Error(`Submodule ${name} has no repository URL`);
    }
    entries.push({ name, path, repository: url.stdout.trim() });
  }
  return entries;
}

async function preflightSubmodule(repository: GitRepository, setup: Extract<SkillSetup, { readonly kind: "submodule" }>): Promise<void> {
  const entries = await submoduleEntries(repository);
  const byPath = entries.find((entry) => entry.path === SKILL_SUBMODULE_PATH);
  const byName = entries.find((entry) => entry.name === SKILL_SUBMODULE_NAME);
  if (byPath !== undefined && byPath.name !== SKILL_SUBMODULE_NAME) {
    throw new Error(`The ${SKILL_SUBMODULE_PATH} path belongs to submodule ${byPath.name}`);
  }
  if (byName !== undefined && byName.path !== SKILL_SUBMODULE_PATH) {
    throw new Error(`The ${SKILL_SUBMODULE_NAME} submodule is configured at ${byName.path}`);
  }
  if (byPath !== undefined) {
    if (canonicalRepositoryUrl(byPath.repository) !== canonicalRepositoryUrl(setup.repository)) {
      throw new Error(`The ${SKILL_SUBMODULE_PATH} submodule points to a different repository`);
    }
    return;
  }
  if (await pathKind(join(repository.root, SKILL_SUBMODULE_PATH)) !== "absent") {
    throw new Error(`Refusing to replace existing path: ${SKILL_SUBMODULE_PATH}`);
  }
  const tracked = await repository.run(["ls-files", "--stage", "--", SKILL_SUBMODULE_PATH], { allowExitCodes: [0, 1] });
  if (tracked.stdout.trim().length > 0) {
    throw new Error(`The ${SKILL_SUBMODULE_PATH} path is already tracked but is not configured as the Reveries submodule`);
  }
  const gitmodulesStatus = await repository.run(["status", "--porcelain=v1", "--", ".gitmodules"], { allowExitCodes: [0, 1] });
  if (gitmodulesStatus.stdout.trim().length > 0) {
    throw new Error("Refusing to edit a modified .gitmodules file while adding Reveries Skills");
  }
}

async function ensureSubmoduleSkills(repository: GitRepository): Promise<void> {
  const sourceRoot = join(repository.root, SKILL_SUBMODULE_PATH, "skills");
  for (const name of SKILL_NAMES) {
    await access(join(sourceRoot, name, "SKILL.md"), constants.R_OK);
  }
}

async function installSubmodule(
  repository: GitRepository,
  setup: Extract<SkillSetup, { readonly kind: "submodule" }>,
): Promise<{ readonly changed: readonly string[]; readonly created: boolean }> {
  const existing = (await submoduleEntries(repository)).find((entry) => entry.path === SKILL_SUBMODULE_PATH);
  if (existing !== undefined) {
    await repository.run(["submodule", "update", "--init", "--recursive", "--", SKILL_SUBMODULE_PATH]);
    await ensureSubmoduleSkills(repository);
    return { changed: [], created: false };
  }
  try {
    await repository.run(["submodule", "add", "--name", SKILL_SUBMODULE_NAME, setup.repository, SKILL_SUBMODULE_PATH]);
    await ensureSubmoduleSkills(repository);
    return { changed: [".gitmodules", SKILL_SUBMODULE_PATH], created: true };
  } catch (error: unknown) {
    await repository.run(["submodule", "deinit", "--force", "--", SKILL_SUBMODULE_PATH], { allowExitCodes: [0, 1, 128] });
    await repository.run(["rm", "--cached", "--ignore-unmatch", "--", SKILL_SUBMODULE_PATH], { allowExitCodes: [0, 1, 128] });
    const entry = (await submoduleEntries(repository)).find((item) => item.path === SKILL_SUBMODULE_PATH);
    if (entry !== undefined) {
      await repository.run(["config", "-f", ".gitmodules", "--remove-section", `submodule.${entry.name}`], { allowExitCodes: [0, 1, 5] });
      await repository.run(["add", "-A", "--", ".gitmodules"], { allowExitCodes: [0, 1] });
    }
    throw error;
  }
}

async function directoryLeafPaths(path: string): Promise<readonly string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) paths.push(...await directoryLeafPaths(child));
    else paths.push(child);
  }
  return paths.sort();
}

interface SkillOwnership {
  readonly kind: "vendored" | "symlink";
  readonly sourceRoot: string;
}

interface SubmoduleOwnership {
  readonly kind: "submodule";
  readonly path: string;
  readonly repository: string;
}

type ReveriesSkillOwnership = SkillOwnership | SubmoduleOwnership;

async function skillOwnershipPath(repository: GitRepository): Promise<string> {
  return join(repository.root, ".agents", "skills", ".reveries-owned.json");
}

async function readSkillOwnership(repository: GitRepository): Promise<ReveriesSkillOwnership | null> {
  const content = await readOptional(await skillOwnershipPath(repository));
  if (content.length === 0) return null;
  const value = JSON.parse(content) as unknown;
  if (typeof value !== "object" || value === null || !("kind" in value)) {
    throw new Error("The Reveries Skill ownership record is malformed");
  }
  const kind = value.kind;
  if (kind === "submodule") {
    if (!("path" in value) || !("repository" in value) || typeof value.path !== "string" || typeof value.repository !== "string") {
      throw new Error("The Reveries Skill ownership record is malformed");
    }
    return { kind, path: value.path, repository: value.repository };
  }
  if ((kind !== "vendored" && kind !== "symlink") || !("sourceRoot" in value) || typeof value.sourceRoot !== "string") {
    throw new Error("The Reveries Skill ownership record is malformed");
  }
  return { kind, sourceRoot: value.sourceRoot };
}

async function writeSkillOwnership(repository: GitRepository, ownership: ReveriesSkillOwnership): Promise<boolean> {
  const path = await skillOwnershipPath(repository);
  await mkdir(dirname(path), { recursive: true });
  const content = `${JSON.stringify(ownership)}\n`;
  if (await readOptional(path) === content) return false;
  await writeFile(path, content, "utf8");
  return true;
}

interface SkillRemovalResult {
  readonly removed: readonly string[];
  readonly preserved: readonly string[];
}

async function removeOwnedSkills(repository: GitRepository): Promise<SkillRemovalResult> {
  const ownership = await readSkillOwnership(repository);
  if (ownership === null) return { removed: [], preserved: [] };
  if (ownership.kind === "submodule") {
    if (ownership.path !== SKILL_SUBMODULE_PATH) {
      return { removed: [], preserved: [ownership.path] };
    }
    const entry = (await submoduleEntries(repository)).find((item) => item.path === ownership.path);
    if (entry === undefined || canonicalRepositoryUrl(entry.repository) !== canonicalRepositoryUrl(ownership.repository)) {
      return { removed: [], preserved: [ownership.path] };
    }
    const submodulePath = join(repository.root, ownership.path);
    if (await pathKind(submodulePath) === "directory") {
      const status = await repository.run(["-C", ownership.path, "status", "--porcelain=v1", "--untracked-files=all"], { allowExitCodes: [0, 1, 128] });
      if (status.exitCode !== 0 || status.stdout.trim().length > 0) {
        return { removed: [], preserved: [ownership.path] };
      }
    }
    await repository.run(["submodule", "deinit", "--force", "--", ownership.path], { allowExitCodes: [0, 1, 128] });
    await repository.run(["rm", "-f", "--", ownership.path]);
    const remaining = (await submoduleEntries(repository)).filter((item) => item.path !== ownership.path);
    if (remaining.length === 0 && await pathKind(join(repository.root, ".gitmodules")) !== "absent") {
      await rm(join(repository.root, ".gitmodules"), { force: true });
      await repository.run(["add", "-A", "--", ".gitmodules"], { allowExitCodes: [0, 1] });
    }
    const ownershipPath = await skillOwnershipPath(repository);
    await rm(ownershipPath, { force: true });
    return {
      removed: [ownership.path, ".gitmodules", relative(repository.root, ownershipPath)],
      preserved: [],
    };
  }
  const sourceRoot = resolve(repository.root, ownership.sourceRoot);
  const removable: string[] = [];
  const preserved: string[] = [];
  for (const name of SKILL_NAMES) {
    const destination = join(repository.root, ".agents", "skills", name);
    const kind = await pathKind(destination);
    if (ownership.kind === "symlink") {
      const expected = relative(dirname(destination), join(sourceRoot, name));
      if (kind === "symlink" && await readlink(destination) === expected) {
        removable.push(destination);
      } else if (kind !== "absent") preserved.push(relative(repository.root, destination));
    } else if (kind === "directory") {
      try {
        if (await directoriesEqual(join(sourceRoot, name), destination)) {
          removable.push(destination);
        } else preserved.push(relative(repository.root, destination));
      } catch {
        preserved.push(relative(repository.root, destination));
      }
    } else if (kind !== "absent") {
      preserved.push(relative(repository.root, destination));
    }
  }
  if (preserved.length > 0) return { removed: [], preserved };
  for (const path of removable) await rm(path, { recursive: true, force: true });
  const ownershipPath = await skillOwnershipPath(repository);
  await rm(ownershipPath, { force: true });
  return {
    removed: [...removable.map((path) => relative(repository.root, path)), relative(repository.root, ownershipPath)],
    preserved: [],
  };
}

function statusPaths(output: string): readonly string[] {
  const paths = new Set<string>();
  const entries = output.split("\0").filter(Boolean);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined || entry.length < 4) continue;
    paths.add(entry.slice(3));
    if (entry[0] === "R" || entry[0] === "C" || entry[1] === "R" || entry[1] === "C") {
      const previous = entries[index + 1];
      if (previous !== undefined) paths.add(previous);
      index += 1;
    }
  }
  return [...paths].sort();
}

async function worktreePaths(repository: GitRepository): Promise<readonly string[]> {
  const result = await repository.run(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  return statusPaths(result.stdout);
}

async function writeAdoptionTemplates(
  repository: GitRepository,
  options: InitializeOptions,
): Promise<InitializationResult["templatePaths"]> {
  const commonDirectory = await repository.commonDirectory();
  const planId = randomUUID();
  const directory = join(commonDirectory, "reveries", "adoption", planId);
  await mkdir(directory, { recursive: true });
  const authorResult = await repository.run(["config", "--get", "user.email"], { allowExitCodes: [0, 1] });
  const authorEmail = authorResult.stdout.trim();
  validateEmail(authorEmail);
  const createdAt = new Date().toISOString();
  const sources = options.directiveEmail === null ? [] : [{
    relation: "requested-by",
    kind: "git-email",
    ref: options.directiveEmail,
  }];
  const summary = {
    v: 1,
    type: "session-summary",
    author_email: authorEmail,
    session: null,
    created_at: createdAt,
    entries: [{
      driving_event: "The repository needs durable engineering decisions beside the Git objects they explain.",
      decision: "Adopt Reveries v1 because blob notes preserve file decisions and commit notes preserve the causal account of each published change.",
      impact: "Published descendants require one session summary, and changes to annotated blobs require an explicit continuity disposition.",
      recurrence_control: "The pre-push checker validates summary coverage, decision continuity, and notes publication.",
      alternatives: ["Keep engineering rationale only in commit messages and project documentation"],
      sources,
      reveries: [],
      retirements: [],
    }],
  };
  const initialization = {
    v: 1,
    type: "reveries-init",
    protocol: 1,
    notes_ref: "refs/notes/reveries",
    publishing_remotes: [...options.publishingRemotes],
    hosts: [...options.hosts],
    author_email: authorEmail,
    created_at: createdAt,
  };
  const sessionSummary = join(directory, "session-summary.json");
  const initializationPath = join(directory, "reveries-init.json");
  await writeFileIfAbsent(sessionSummary, `${JSON.stringify(summary, null, 2)}\n`);
  await writeFileIfAbsent(initializationPath, `${JSON.stringify(initialization, null, 2)}\n`);
  return { sessionSummary, initialization: initializationPath, plan: join(directory, "plan.json") };
}

async function writeFileIfAbsent(path: string, content: string): Promise<void> {
  try {
    await writeFile(path, content, { encoding: "utf8", flag: "wx" });
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
}

interface AdoptionPlanFile {
  readonly path: string;
  readonly fingerprint: string;
}

interface AdoptionPlan {
  readonly v: 1;
  readonly base: string | null;
  readonly templates: {
    readonly sessionSummary: string;
    readonly initialization: string;
  };
  readonly files: readonly AdoptionPlanFile[];
}

async function pathFingerprint(path: string, repository?: GitRepository): Promise<string> {
  const kind = await pathKind(path);
  if (kind === "absent") return "absent";
  if (kind === "symlink") return `symlink:${createHash("sha256").update(await readlink(path)).digest("hex")}`;
  if (kind === "other") return `file:${createHash("sha256").update(await readFile(path)).digest("hex")}`;
  if (repository !== undefined) {
    const relativePath = relative(repository.root, path);
    const staged = await repository.run(["ls-files", "--stage", "--", relativePath], { allowExitCodes: [0, 1] });
    const mode = staged.stdout.trimStart().split(/\s+/, 1)[0];
    if (mode === "160000") return `submodule:${staged.stdout.trimStart().split(/\s+/, 3)[1] ?? ""}`;
  }
  const hash = createHash("sha256");
  for (const entry of (await readdir(path)).sort()) {
    hash.update(entry);
    hash.update("\0");
    hash.update(await pathFingerprint(join(path, entry), repository));
    hash.update("\0");
  }
  return `directory:${hash.digest("hex")}`;
}

async function writeAdoptionPlan(
  repository: GitRepository,
  path: string,
  files: readonly string[],
): Promise<void> {
  const plan: AdoptionPlan = {
    v: 1,
    base: await repository.run(["rev-parse", "--verify", "HEAD"], { allowExitCodes: [0, 128] })
      .then((result) => result.exitCode === 0 ? result.stdout.trim() : null),
    templates: {
      sessionSummary: await pathFingerprint(join(dirname(path), "session-summary.json")),
      initialization: await pathFingerprint(join(dirname(path), "reveries-init.json")),
    },
    files: await Promise.all(files.map(async (file) => ({
      path: file,
      fingerprint: await pathFingerprint(join(repository.root, file), repository),
    }))),
  };
  await writeFile(path, `${JSON.stringify(plan, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

async function readAdoptionPlan(repository: GitRepository, path: string): Promise<AdoptionPlan> {
  const commonDirectory = await realpath(await repository.commonDirectory());
  const resolved = await realpath(isAbsolute(path) ? path : join(repository.root, path));
  const allowed = relative(join(commonDirectory, "reveries", "adoption"), resolved);
  if (allowed.startsWith("..") || isAbsolute(allowed)) throw new Error("Adoption plan must be under the Git common directory");
  const content = await readFile(resolved, "utf8");
  if ((await readOptional(join(dirname(resolved), "commit.json"))).length === 0) {
    const activePath = await repository.run(["config", "--get", "reveries.adoptionPlan"], { allowExitCodes: [0, 1] });
    const activeHash = await repository.run(["config", "--get", "reveries.adoptionPlanHash"], { allowExitCodes: [0, 1] });
    if (activePath.stdout.trim() !== resolved
      || activeHash.stdout.trim() !== createHash("sha256").update(content).digest("hex")) {
      throw new Error("The adoption plan is stale or was modified after initialization");
    }
  }
  const value = JSON.parse(content) as unknown;
  if (typeof value !== "object" || value === null || !("v" in value) || value.v !== 1
    || !("base" in value) || (value.base !== null && typeof value.base !== "string")
    || !("templates" in value) || typeof value.templates !== "object" || value.templates === null
    || !("sessionSummary" in value.templates) || typeof value.templates.sessionSummary !== "string"
    || !("initialization" in value.templates) || typeof value.templates.initialization !== "string"
    || !("files" in value) || !Array.isArray(value.files)) {
    throw new Error("The adoption plan is malformed");
  }
  const files: AdoptionPlanFile[] = [];
  for (const entry of value.files) {
    if (typeof entry !== "object" || entry === null || !("path" in entry) || !("fingerprint" in entry)
      || typeof entry.path !== "string" || typeof entry.fingerprint !== "string") {
      throw new Error("The adoption plan is malformed");
    }
    const resolvedFile = resolve(repository.root, entry.path);
    const relativeFile = relative(repository.root, resolvedFile);
    if (relativeFile !== entry.path || relativeFile.startsWith("..") || isAbsolute(relativeFile)) {
      throw new Error(`Invalid adoption path: ${entry.path}`);
    }
    files.push({ path: entry.path, fingerprint: entry.fingerprint });
  }
  if (files.length === 0) throw new Error("The adoption plan has no files");
  return {
    v: 1,
    base: value.base,
    templates: {
      sessionSummary: value.templates.sessionSummary,
      initialization: value.templates.initialization,
    },
    files,
  };
}

async function verifyAdoptionPlan(repository: GitRepository, planPath: string, plan: AdoptionPlan): Promise<void> {
  const directory = dirname(isAbsolute(planPath) ? planPath : join(repository.root, planPath));
  if (await pathFingerprint(join(directory, "session-summary.json")) !== plan.templates.sessionSummary
    || await pathFingerprint(join(directory, "reveries-init.json")) !== plan.templates.initialization) {
    throw new Error("Adoption templates changed after initialization");
  }
  for (const file of plan.files) {
    const actual = await pathFingerprint(join(repository.root, file.path), repository);
    if (actual !== file.fingerprint) throw new Error(`Adoption file changed after initialization: ${file.path}`);
  }
}

export interface AdoptionCommit {
  readonly commit: string;
  readonly sessionSummary: string;
  readonly initialization: string;
}

export async function commitAdoption(cwd: string, planPath: string, message: string): Promise<AdoptionCommit> {
  if (message.trim().length === 0) throw new Error("Adoption commit message must be nonempty");
  const repository = await GitRepository.open(cwd);
  return withSetupLock(repository, async () => {
    const plan = await readAdoptionPlan(repository, planPath);
    const planDirectory = dirname(isAbsolute(planPath) ? planPath : join(repository.root, planPath));
    const resultPath = join(planDirectory, "commit.json");
    await verifyAdoptionPlan(repository, planPath, plan);
    const sessionSummary = await readFile(join(planDirectory, "session-summary.json"), "utf8");
    const initialization = await readFile(join(planDirectory, "reveries-init.json"), "utf8");
    const previousResult = await readOptional(resultPath);
    if (previousResult.length > 0) {
      const result = JSON.parse(previousResult) as { commit?: unknown };
      if (typeof result.commit !== "string") throw new Error("The adoption result is malformed");
      await repository.run(["cat-file", "-e", `${result.commit}^{commit}`]);
      return { commit: result.commit, sessionSummary, initialization };
    }
    const headResult = await repository.run(["rev-parse", "--verify", "HEAD"], { allowExitCodes: [0, 128] });
    const currentHead = headResult.exitCode === 0 ? headResult.stdout.trim() : null;
    if (currentHead !== plan.base) {
      if (currentHead === null) throw new Error("Repository HEAD changed after initialization");
      const parents = (await repository.run(["rev-list", "--parents", "-n", "1", currentHead])).stdout.trim().split(" ");
      const parent = parents[1] ?? null;
      const committed = (await repository.run(["diff-tree", "--no-commit-id", "--name-only", "-r", currentHead]))
        .stdout.trim().split("\n").filter(Boolean);
      const allowed = new Set(plan.files.map((file) => file.path));
      const unexpected = committed.filter((file) => ![...allowed].some(
        (path) => file === path || file.startsWith(`${path}/`),
      ));
      if (parent !== plan.base || committed.length === 0 || unexpected.length > 0) {
        throw new Error("Repository HEAD changed after initialization");
      }
      await writeFile(resultPath, `${JSON.stringify({ v: 1, commit: currentHead })}\n`, { encoding: "utf8", flag: "wx" });
      return { commit: currentHead, sessionSummary, initialization };
    }
    await verifyAdoptionPlan(repository, planPath, plan);
    const files = plan.files.map((file) => file.path);
    await repository.run(["add", "-A", "--", ...files]);
    await verifyAdoptionPlan(repository, planPath, plan);
    await repository.run(["commit", "--only", "-m", message.trim(), "--", ...files]);
    const commit = (await repository.run(["rev-parse", "HEAD"])).stdout.trim();
    const parentFields = (await repository.run(["rev-list", "--parents", "-n", "1", commit])).stdout.trim().split(" ");
    const parent = parentFields[1] ?? null;
    if (parent !== plan.base) throw new Error("Repository HEAD changed concurrently during adoption");
    const committed = (await repository.run(["diff-tree", "--no-commit-id", "--name-only", "-r", commit]))
      .stdout.trim().split("\n").filter(Boolean);
    const allowed = new Set(files);
    const unexpected = committed.filter((file) => ![...allowed].some(
      (path) => file === path || file.startsWith(`${path}/`),
    ));
    if (unexpected.length > 0) throw new Error(`Adoption commit included unexpected paths: ${unexpected.join(", ")}`);
    await verifyAdoptionPlan(repository, planPath, plan);
    await writeFile(resultPath, `${JSON.stringify({ v: 1, commit })}\n`, { encoding: "utf8", flag: "wx" });
    return { commit, sessionSummary, initialization };
  });
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
  helper: HelperInvocation,
): Promise<{ readonly installed: boolean; readonly snippet: string | null }> {
  const commonDirectory = await repository.commonDirectory();
  const path = join(commonDirectory, "hooks", name);
  const invocation = hookInvocation(helper, name);
  const block = `${HOOK_BEGIN}\nexec ${invocation}\n${HOOK_END}`;
  const fingerprint = createHash("sha256").update(block).digest("hex");
  const fingerprintKey = `reveries.hook-${name}.fingerprint`;
  const body = `#!/bin/sh\n${block}\n`;
  const existing = await readOptional(path);
  if (existing.length === 0) {
    await writeFile(path, body, { encoding: "utf8", mode: 0o755 });
    await chmod(path, 0o755);
    await repository.run(["config", fingerprintKey, fingerprint]);
    return { installed: true, snippet: null };
  }
  if (existing === body) {
    await repository.run(["config", fingerprintKey, fingerprint]);
    return { installed: true, snippet: null };
  }
  const start = existing.indexOf(HOOK_BEGIN);
  const end = existing.indexOf(HOOK_END, start);
  if (start >= 0 && end >= start && existing.indexOf(HOOK_BEGIN, start + HOOK_BEGIN.length) < 0) {
    const existingBlock = existing.slice(start, end + HOOK_END.length);
    const recorded = await repository.run(["config", "--get", fingerprintKey], { allowExitCodes: [0, 1] });
    const existingFingerprint = createHash("sha256").update(existingBlock).digest("hex");
    const legacy = `${HOOK_BEGIN}\nexec reveries ${name} "$@"\n${HOOK_END}`;
    if (recorded.stdout.trim() !== existingFingerprint && existingBlock !== legacy) {
      return { installed: false, snippet: invocation };
    }
    const next = `${existing.slice(0, start)}${block}${existing.slice(end + HOOK_END.length)}`;
    await writeFile(path, next, "utf8");
    await chmod(path, 0o755);
    await repository.run(["config", fingerprintKey, fingerprint]);
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
  const block = existing.slice(start, end);
  const key = `reveries.hook-${name}.fingerprint`;
  const recorded = await repository.run(["config", "--get", key], { allowExitCodes: [0, 1] });
  if (recorded.stdout.trim() !== createHash("sha256").update(block).digest("hex")) return;
  const before = existing.slice(0, start);
  const after = existing.slice(end).replace(/^\n/, "");
  const retained = `${before}${after}`;
  if (retained.trim() === "#!/bin/sh") await rm(path, { force: true });
  else await writeFile(path, retained, "utf8");
  await repository.run(["config", "--unset-all", key], { allowExitCodes: [0, 1, 5] });
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

/**
 * The fetch refspecs Reveries owns for one publishing remote.
 *
 * Both the converge path and the removal path read this single list, so a
 * refspec can never be installed without a matching way to take it back out.
 *
 * The ledger refspec is a glob, not an exact name, for the same reason the notes
 * one is: an exact refspec makes an ordinary `git fetch` fail hard with
 * "couldn't find remote ref" until the remote has published a checkpoint. A glob
 * that matches nothing is not an error, so a fresh collaborator can fetch before
 * any envelope exists.
 */
function managedFetchRefspecs(remote: string): readonly string[] {
  return [
    `+refs/notes/reveries*:refs/notes/remotes/${remote}/reveries*`,
    `+refs/heads/${LEDGER_BRANCH}*:refs/remotes/${remote}/${LEDGER_BRANCH}*`,
  ];
}

/** The exact refspec an earlier managed setup may have left behind. */
function legacyManagedFetchRefspecs(remote: string): readonly string[] {
  return [`+refs/notes/reveries:refs/notes/remotes/${remote}/reveries`];
}

async function removeManagedRemoteConfig(repository: GitRepository, remote: string): Promise<void> {
  if (await managedFlag(repository, `reveries.managed-${remote}.fetch`)) {
    for (const value of [...legacyManagedFetchRefspecs(remote), ...managedFetchRefspecs(remote)]) {
      await unsetConfigValue(repository, `remote.${remote}.fetch`, value);
    }
  }
  await removeManagedPushConfig(repository, remote);
}

async function removeManagedPushConfig(repository: GitRepository, remote: string): Promise<void> {
  if (await managedFlag(repository, `reveries.managed-${remote}.pushHead`)) {
    await unsetConfigValue(repository, `remote.${remote}.push`, "HEAD");
  }
  if (await managedFlag(repository, `reveries.managed-${remote}.pushNotes`)) {
    await unsetConfigValue(repository, `remote.${remote}.push`, "refs/notes/reveries:refs/notes/reveries");
  }
  for (const key of ["pushHead", "pushNotes"]) {
    await repository.run(
      ["config", "--unset-all", `reveries.managed-${remote}.${key}`],
      { allowExitCodes: [0, 1, 5] },
    );
  }
}

/**
 * Converge only the local Git state that a clone never receives: notes merge
 * strategy, managed notes refspecs, the helper runner record, and the owned hook
 * blocks. Tracked files, notes and adoption plans are never part of this step.
 */
interface LocalIntegrationTarget {
  readonly publishingRemotes: readonly string[];
  /** `undefined` leaves an existing directive email untouched. */
  readonly directiveEmail: string | null | undefined;
  readonly helper: HelperInvocation | undefined;
  readonly mode: "initialize" | "repair";
  /** Remotes this run cannot configure, reported instead of guessed. */
  readonly unusableRemotes: readonly string[];
}

interface LocalIntegrationResult {
  readonly hookSnippets: readonly string[];
  readonly unsupportedManagers: readonly string[];
  readonly changedConfig: readonly string[];
  readonly diagnostics: readonly string[];
}

const LOCAL_CONFIG_KEY_PREFIXES = ["reveries.", "notes.reveries."];

async function localConfigSnapshot(
  repository: GitRepository,
  remotes: readonly string[],
): Promise<readonly string[]> {
  const result = await repository.run(["config", "--local", "--list"], { allowExitCodes: [0, 1] });
  const ownedKeys = new Set(remotes.flatMap((remote) => [`remote.${remote}.fetch`, `remote.${remote}.push`]));
  return result.stdout
    .trimEnd()
    .split("\n")
    .filter(Boolean)
    .filter((line) => {
      const separator = line.indexOf("=");
      if (separator < 0) return false;
      const key = line.slice(0, separator);
      return LOCAL_CONFIG_KEY_PREFIXES.some((prefix) => key.startsWith(prefix)) || ownedKeys.has(key);
    })
    .sort();
}

async function configuredHooksPath(repository: GitRepository): Promise<string | null> {
  const result = await repository.run(["config", "--get", "core.hooksPath"], { allowExitCodes: [0, 1] });
  if (result.exitCode !== 0) return null;
  const value = result.stdout.trim();
  return value.length === 0 ? null : value;
}

async function convergeLocalIntegration(
  repository: GitRepository,
  target: LocalIntegrationTarget,
): Promise<LocalIntegrationResult> {
  const diagnostics: string[] = [];
  const remotes = target.publishingRemotes.filter((remote) => !target.unusableRemotes.includes(remote));
  const before = await localConfigSnapshot(repository, target.publishingRemotes);

  if (target.mode === "initialize") {
    const previousRemotes = await configValues(repository, "reveries.publishingRemote");
    for (const remote of new Set([...previousRemotes, ...(await configuredRemoteNames(repository))])) {
      if (!target.publishingRemotes.includes(remote)) await removeManagedRemoteConfig(repository, remote);
    }
    await repository.run(["config", "--unset-all", "reveries.publishingRemote"], { allowExitCodes: [0, 1, 5] });
  }
  const configured = await configValues(repository, "reveries.publishingRemote");
  for (const remote of remotes) {
    if (configured.includes(remote)) continue;
    await repository.run(["config", "--add", "reveries.publishingRemote", remote]);
  }
  await repository.run(["config", "reveries.localOnly", remotes.length === 0 ? "true" : "false"]);

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
  if (target.directiveEmail !== undefined) {
    if (target.directiveEmail === null) {
      await repository.run(["config", "--unset-all", "reveries.directiveEmail"], { allowExitCodes: [0, 1, 5] });
    } else {
      await repository.run(["config", "reveries.directiveEmail", target.directiveEmail]);
    }
  }
  for (const remote of remotes) {
    if (await managedFlag(repository, `reveries.managed-${remote}.fetch`)) {
      for (const value of legacyManagedFetchRefspecs(remote)) {
        await unsetConfigValue(repository, `remote.${remote}.fetch`, value);
      }
    }
    await removeManagedPushConfig(repository, remote);
    let fetchAdded = false;
    for (const value of managedFetchRefspecs(remote)) {
      fetchAdded = await ensureConfigValue(repository, `remote.${remote}.fetch`, value) || fetchAdded;
    }
    await rememberManagedValue(repository, `reveries.managed-${remote}.fetch`, fetchAdded);
  }

  const hookSnippets: string[] = [];
  const available = await helperInvocationAvailable(target.helper);
  await repository.run(["config", "--unset-all", "reveries.helperCommand"], { allowExitCodes: [0, 1, 5] });
  await repository.run(["config", "--unset-all", "reveries.helperArg"], { allowExitCodes: [0, 1, 5] });
  await repository.run(["config", "--unset-all", "reveries.helperVerification"], { allowExitCodes: [0, 1, 5] });
  await repository.run(["config", "--unset-all", "reveries.helperFingerprint"], { allowExitCodes: [0, 1, 5] });
  if (available && target.helper !== undefined) {
    await repository.run(["config", "reveries.helperCommand", target.helper.command]);
    for (const argument of target.helper.args) await repository.run(["config", "--add", "reveries.helperArg", argument]);
    await repository.run(["config", "reveries.helperVerification", target.helper.verification ?? "probe"]);
    const fingerprint = await helperInvocationFingerprint(target.helper);
    if (fingerprint !== null) await repository.run(["config", "reveries.helperFingerprint", fingerprint]);
  }
  const hooks = remotes.length === 0
    ? ["post-commit"] as const
    : ["pre-push", "post-commit"] as const;
  const hooksPath = await configuredHooksPath(repository);
  if (hooksPath !== null) {
    // Hooks are redirected, so the owned block cannot be composed safely here.
    diagnostics.push(
      `core.hooksPath redirects hooks to ${hooksPath}; Reveries cannot install owned hook blocks there`,
    );
    for (const hook of hooks) {
      const helper = target.helper ?? { command: "reveries", args: [] };
      hookSnippets.push(hookInvocation(helper, hook));
    }
  } else {
    if (remotes.length === 0) await removeOwnedHook(repository, "pre-push");
    for (const hook of hooks) {
      if (!available || target.helper === undefined) {
        const helper = target.helper ?? { command: "reveries", args: [] };
        hookSnippets.push(hookInvocation(helper, hook));
      } else {
        const result = await installHook(repository, hook, target.helper);
        if (result.snippet !== null) hookSnippets.push(result.snippet);
      }
    }
  }

  const after = await localConfigSnapshot(repository, target.publishingRemotes);
  const changed = after.filter((line) => !before.includes(line))
    .map((line) => line.slice(0, Math.max(0, line.indexOf("="))));
  return {
    hookSnippets,
    unsupportedManagers: hooksPath === null ? [] : [hooksPath],
    changedConfig: [...new Set(changed)].sort(),
    diagnostics,
  };
}

async function configuredRemoteNames(repository: GitRepository): Promise<readonly string[]> {
  const result = await repository.run(["remote"]);
  return result.stdout.trimEnd().split("\n").filter((remote) => remote.length > 0);
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
      throw new Error("Another Reveries setup or removal is already running in this repository");
    }
    throw error;
  }
  try {
    return await operation();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

function routeHosts(hosts: readonly SupportedHost[]): readonly HostRouting[] {
  return hosts.map((host) => ({
    host,
    instructionFile: host === "claude" ? "CLAUDE.md" : host === "gemini" ? "GEMINI.md" : "AGENTS.md",
  }));
}

export async function initializeRepository(
  cwd: string,
  options: InitializeOptions,
): Promise<InitializationResult> {
  validateEmail(options.directiveEmail);
  validateSkillSetup(options.skillSetup);
  const repository = await GitRepository.open(cwd);
  return withSetupLock(repository, () => initializeUnlocked(repository, options));
}

async function initializeUnlocked(
  repository: GitRepository,
  options: InitializeOptions,
): Promise<InitializationResult> {
  const beforePaths = await worktreePaths(repository);
  const remotesResult = await repository.run(["remote"]);
  const existingRemotes = remotesResult.stdout.trimEnd().split("\n").filter((remote) => remote.length > 0);
  for (const remote of options.publishingRemotes) {
    validateRemote(remote);
    if (!existingRemotes.includes(remote)) {
      throw new Error(`Publishing remote does not exist: ${remote}`);
    }
    const exactFetch = `+refs/notes/reveries:refs/notes/remotes/${remote}/reveries`;
    const existingFetch = await configValues(repository, `remote.${remote}.fetch`);
    if (existingFetch.includes(exactFetch) && !await managedFlag(repository, `reveries.managed-${remote}.fetch`)) {
      throw new Error(`Publishing remote ${remote} has an unmanaged exact Reveries fetch refspec; remove or replace it explicitly`);
    }
  }
  for (const file of ["AGENTS.md", "CLAUDE.md", "GEMINI.md"]) {
    ownedBounds(await readOptional(join(repository.root, file)));
  }
  const author = await repository.run(["config", "--get", "user.email"], { allowExitCodes: [0, 1] });
  validateEmail(author.stdout.trim());
  if (options.skillSetup.kind === "vendored" || options.skillSetup.kind === "symlink") {
    await preflightSkills(repository, options.skillSetup);
  } else if (options.skillSetup.kind === "submodule") {
    await preflightSubmodule(repository, options.skillSetup);
  }
  const changedFiles: string[] = [];
  const adoptionFiles = new Set<string>(["AGENTS.md"]);
  const agentsPath = join(repository.root, "AGENTS.md");
  if ((await setOwnedBlock(agentsPath, agentsBlock(options.skillSetup))).changed) {
    changedFiles.push(relative(repository.root, agentsPath));
  }
  if (options.hosts.includes("claude")) {
    adoptionFiles.add("CLAUDE.md");
    const path = join(repository.root, "CLAUDE.md");
    if ((await setOwnedBlock(path, CLAUDE_BLOCK)).changed) {
      changedFiles.push(relative(repository.root, path));
    }
  } else {
    const path = join(repository.root, "CLAUDE.md");
    if ((await removeOwnedBlock(path)).changed) {
      const relativePath = relative(repository.root, path);
      changedFiles.push(relativePath);
      adoptionFiles.add(relativePath);
    }
  }
  if (options.hosts.includes("gemini")) {
    adoptionFiles.add("GEMINI.md");
    const path = join(repository.root, "GEMINI.md");
    if ((await setOwnedBlock(path, GEMINI_BLOCK)).changed) {
      changedFiles.push(relative(repository.root, path));
    }
  } else {
    const path = join(repository.root, "GEMINI.md");
    if ((await removeOwnedBlock(path)).changed) {
      const relativePath = relative(repository.root, path);
      changedFiles.push(relativePath);
      adoptionFiles.add(relativePath);
    }
  }

  const ownership = await readSkillOwnership(repository);
  if (options.skillSetup.kind === "vendored" || options.skillSetup.kind === "symlink") {
    if (ownership !== null && (
      ownership.kind !== options.skillSetup.kind
      || ownership.sourceRoot !== options.skillSetup.sourceRoot
    )) {
      const removal = await removeOwnedSkills(repository);
      if (removal.preserved.length > 0) {
        throw new Error(`Owned Skill paths changed and require manual review: ${removal.preserved.join(", ")}`);
      }
      for (const path of removal.removed) {
        changedFiles.push(path);
        adoptionFiles.add(path);
      }
    }
    const installed = await installSkills(repository, options.skillSetup);
    for (const path of installed.changed) changedFiles.push(path);
    const ownershipPath = relative(repository.root, await skillOwnershipPath(repository));
    if (await writeSkillOwnership(repository, { kind: options.skillSetup.kind, sourceRoot: installed.sourceRoot })) {
      changedFiles.push(ownershipPath);
    }
    adoptionFiles.add(ownershipPath);
    for (const name of SKILL_NAMES) adoptionFiles.add(`.agents/skills/${name}`);
  } else if (options.skillSetup.kind === "submodule") {
    if (ownership !== null && (
      ownership.kind !== "submodule"
      || canonicalRepositoryUrl(ownership.repository) !== canonicalRepositoryUrl(options.skillSetup.repository)
    )) {
      const removal = await removeOwnedSkills(repository);
      if (removal.preserved.length > 0) {
        throw new Error(`Owned Skill paths changed and require manual review: ${removal.preserved.join(", ")}`);
      }
      for (const path of removal.removed) {
        changedFiles.push(path);
        adoptionFiles.add(path);
      }
    }
    const installed = await installSubmodule(repository, options.skillSetup);
    for (const path of installed.changed) {
      changedFiles.push(path);
      adoptionFiles.add(path);
    }
    if (installed.created) {
      const ownershipPath = relative(repository.root, await skillOwnershipPath(repository));
      if (await writeSkillOwnership(repository, {
        kind: "submodule",
        path: SKILL_SUBMODULE_PATH,
        repository: options.skillSetup.repository,
      })) changedFiles.push(ownershipPath);
      adoptionFiles.add(ownershipPath);
      adoptionFiles.add(SKILL_SUBMODULE_PATH);
    }
  } else {
    const removal = await removeOwnedSkills(repository);
    if (removal.preserved.length > 0) {
      throw new Error(`Owned Skill paths changed and require manual review: ${removal.preserved.join(", ")}`);
    }
    for (const path of removal.removed) {
      changedFiles.push(path);
      adoptionFiles.add(path);
    }
  }

  const local = await convergeLocalIntegration(repository, {
    publishingRemotes: options.publishingRemotes,
    directiveEmail: options.directiveEmail,
    helper: options.helper,
    mode: "initialize",
    unusableRemotes: [],
  });
  const { hookSnippets } = local;

  const templatePaths = await writeAdoptionTemplates(repository, options);
  const completeFiles = [...adoptionFiles];
  await writeAdoptionPlan(repository, templatePaths.plan, completeFiles);
  const planContent = await readFile(templatePaths.plan, "utf8");
  await repository.run(["config", "reveries.adoptionPlan", templatePaths.plan]);
  await repository.run([
    "config",
    "reveries.adoptionPlanHash",
    createHash("sha256").update(planContent).digest("hex"),
  ]);
  const afterPaths = await worktreePaths(repository);
  const adoptionSet = new Set(completeFiles);
  const isAdoptionPath = (path: string): boolean => [...adoptionSet].some(
    (adoptionPath) => path === adoptionPath || path.startsWith(`${adoptionPath}/`),
  );
  const unrelatedChanges = afterPaths.filter((path) => !isAdoptionPath(path));
  const beforeSet = new Set(beforePaths);
  const concurrentChanges = unrelatedChanges.filter((path) => !beforeSet.has(path));
  const helperCommand = options.helper === undefined
    ? "reveries"
    : [options.helper.command, ...options.helper.args].map(shellQuote).join(" ");
  const nextCommands = [
    `${helperCommand} adopt --plan ${shellQuote(templatePaths.plan)} --message 'Adopt Reveries'`,
    `${helperCommand} check HEAD`,
  ];
  const remote = options.publishingRemotes[0];
  if (remote !== undefined) nextCommands.push(`${helperCommand} push ${shellQuote(remote)}`);

  return {
    state: "prepared",
    enforcement: hookSnippets.length === 0 ? "complete" : "partial",
    changedFiles,
    adoptionFiles: completeFiles,
    unrelatedChanges,
    concurrentChanges,
    hostRouting: routeHosts(options.hosts),
    templatePaths,
    hookSnippets,
    nextCommands,
    noHelperGuidance: await resolveNoHelperGuidance(options.helper),
  };
}

export interface RemovalResult {
  readonly removed: boolean;
  readonly evidencePreserved: true;
  readonly preservedSkillPaths: readonly string[];
}

export async function removeIntegration(cwd: string, options: RemovalOptions): Promise<RemovalResult> {
  const repository = await GitRepository.open(cwd);
  return withSetupLock(repository, () => removeUnlocked(repository, options));
}

async function removeUnlocked(repository: GitRepository, options: RemovalOptions): Promise<RemovalResult> {
  const skillRemoval = await removeOwnedSkills(repository);
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
  await repository.run(["config", "--unset-all", "reveries.helperCommand"], { allowExitCodes: [0, 1, 5] });
  await repository.run(["config", "--unset-all", "reveries.helperArg"], { allowExitCodes: [0, 1, 5] });
  await repository.run(["config", "--unset-all", "reveries.helperVerification"], { allowExitCodes: [0, 1, 5] });
  await repository.run(["config", "--unset-all", "reveries.helperFingerprint"], { allowExitCodes: [0, 1, 5] });
  await repository.run(["config", "--unset-all", "reveries.localOnly"], { allowExitCodes: [0, 1, 5] });
  const configuredRemotes = await configValues(repository, "reveries.publishingRemote");
  await repository.run(["config", "--unset-all", "reveries.publishingRemote"], { allowExitCodes: [0, 1, 5] });
  for (const remote of new Set([...configuredRemotes, ...options.publishingRemotes])) {
    validateRemote(remote);
    await removeManagedRemoteConfig(repository, remote);
  }
  await removeOwnedHook(repository, "pre-push");
  await removeOwnedHook(repository, "post-commit");
  return {
    removed: skillRemoval.preserved.length === 0,
    evidencePreserved: true,
    preservedSkillPaths: skillRemoval.preserved,
  };
}

export interface RepairOptions {
  readonly helper?: HelperInvocation;
}

export type RepairState = "repaired" | "partial" | "unavailable";

export interface RepairResult {
  readonly state: RepairState;
  readonly publishingRemotes: readonly string[];
  readonly changedConfig: readonly string[];
  readonly hookSnippets: readonly string[];
  readonly diagnostics: readonly string[];
  readonly unsupportedManagers: readonly string[];
  /** Git-only contributor steps; empty when a working helper is configured. */
  readonly noHelperGuidance: readonly string[];
}

/**
 * Read the single committed initialization record. A clone receives this record
 * with the notes ref, so it is the authority for repair; local configuration is
 * never used to guess it.
 */
async function committedInitialization(repository: GitRepository): Promise<ReveriesInit | null> {
  let found: ReveriesInit | null = null;
  for (const entry of await repository.listNotes()) {
    const note = await repository.readNote(entry.object);
    if (note === null) continue;
    for (const record of parseNote(note, "tolerant", { verifyIds: false }).records) {
      if (record.type !== "reveries-init") continue;
      if (found !== null) throw new Error("More than one Reveries initialization boundary exists");
      if (!(await repository.objectExists("commit", entry.object))) {
        throw new Error("The Reveries initialization record is not attached to a commit");
      }
      found = record;
    }
  }
  return found;
}

export async function repairLocalIntegration(cwd: string, options: RepairOptions = {}): Promise<RepairResult> {
  const repository = await GitRepository.open(cwd);
  return withSetupLock(repository, async () => {
    const diagnostics: string[] = [];
    let initialization: ReveriesInit | null = null;
    try {
      initialization = await committedInitialization(repository);
    } catch (error: unknown) {
      diagnostics.push(error instanceof Error ? error.message : String(error));
    }
    if (initialization === null) {
      diagnostics.push(
        "No committed Reveries initialization record is available locally; "
        + "fetch the notes ref (`git fetch origin '+refs/notes/reveries*:refs/notes/reveries*'`) "
        + "and run `reveries sync origin --pull` before repairing",
      );
      return {
        state: "unavailable",
        publishingRemotes: [],
        changedConfig: [],
        hookSnippets: [],
        diagnostics,
        unsupportedManagers: [],
        noHelperGuidance: await resolveNoHelperGuidance(options.helper),
      };
    }

    const existing = await configuredRemoteNames(repository);
    const unusableRemotes: string[] = [];
    for (const remote of initialization.publishing_remotes) {
      validateRemote(remote);
      if (!existing.includes(remote)) {
        diagnostics.push(`Publishing remote ${remote} does not exist in this clone; add it before repairing`);
        unusableRemotes.push(remote);
        continue;
      }
      const exactFetch = `+refs/notes/reveries:refs/notes/remotes/${remote}/reveries`;
      const configured = await configValues(repository, `remote.${remote}.fetch`);
      if (configured.includes(exactFetch) && !await managedFlag(repository, `reveries.managed-${remote}.fetch`)) {
        diagnostics.push(
          `Publishing remote ${remote} has an unmanaged exact Reveries fetch refspec; remove or replace it explicitly`,
        );
        unusableRemotes.push(remote);
      }
    }

    const local = await convergeLocalIntegration(repository, {
      publishingRemotes: initialization.publishing_remotes,
      directiveEmail: undefined,
      helper: options.helper,
      mode: "repair",
      unusableRemotes,
    });
    const allDiagnostics = [...diagnostics, ...local.diagnostics];
    return {
      state: allDiagnostics.length === 0 && local.hookSnippets.length === 0 ? "repaired" : "partial",
      publishingRemotes: initialization.publishing_remotes.filter(
        (remote) => !unusableRemotes.includes(remote),
      ),
      changedConfig: local.changedConfig,
      hookSnippets: local.hookSnippets,
      diagnostics: allDiagnostics,
      unsupportedManagers: local.unsupportedManagers,
      noHelperGuidance: await resolveNoHelperGuidance(options.helper),
    };
  });
}
