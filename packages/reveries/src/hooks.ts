import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { GitRepository, cloneEvidenceGrade, type CompletenessGrade } from "./git.ts";
import {
  parseNote,
  projectActiveReveries,
  semanticPayload,
  objectId,
  type BlobId,
  type ObjectId,
  type ReverieRecord,
  type Source,
} from "./protocol.ts";

const MARKER_BEGIN = "<!-- reveries:begin -->";
const MARKER_END = "<!-- reveries:end -->";
const DEFAULT_MAX_CONTEXT_CHARS = 8_000;

export type HookHost = "pi" | "claude" | "opencode" | "codex" | "gemini" | string;
export type HookEventName = "session-start" | "prompt" | "before-tool" | "after-tool" | "session-end";

export type HookEvent = {
  host: HookHost;
  event: HookEventName;
  session: string | null;
  tool: string;
  input: unknown;
  output: unknown;
};

export type HookResult = {
  context: string | null;
  user_message: string | null;
  block: false;
  reason: string | null;
  /**
   * Evidence completeness grade when the result was shaped by clone
   * incompleteness; null when completeness was not assessed for this result.
   */
  completeness: CompletenessGrade | null;
};

export type HookRepository = {
  readonly root: string;
  resolvePath(input: { path: string; revision: "HEAD" | "index" | string }): Promise<BlobId>;
  readNote(object: ObjectId): Promise<string | null>;
  hashObject(input: string): Promise<ObjectId>;
  objectExists(kind: "blob" | "commit", object: ObjectId): Promise<boolean>;
  listNotes(): Promise<readonly { readonly object: ObjectId }[]>;
  /**
   * Clone-shape detectors. Optional so lightweight fakes keep working; when
   * absent the clone is treated as complete and historical verdicts apply.
   */
  isShallowRepository?: () => Promise<boolean>;
  hasPromisorRemote?: () => Promise<boolean>;
};

type WorktreeSnapshot =
  | { readonly kind: "missing" }
  | { readonly kind: "file"; readonly fingerprint: string; readonly executable: boolean }
  | { readonly kind: "symlink"; readonly fingerprint: string }
  | { readonly kind: "other"; readonly mode: number };

type EditObservation = {
  readonly snapshot: WorktreeSnapshot;
  readonly blobs: readonly BlobId[];
  readonly ids: readonly string[];
};

export type HookState = {
  readonly delivered: Set<string>;
  readonly edits: Map<string, EditObservation>;
};

export type HookDependencies = {
  repository?: HookRepository;
  cwd?: string;
  state?: HookState;
};

export type HookRenderOptions = {
  maxContextChars?: number;
};

export function createHookState(): HookState {
  return { delivered: new Set(), edits: new Map() };
}

function emptyResult(
  reason: string | null = null,
  completeness: CompletenessGrade | null = null,
): HookResult {
  return { context: null, user_message: null, block: false, reason, completeness };
}

function fingerprint(kind: string, bytes: Uint8Array): string {
  return createHash("sha256").update(kind).update("\0").update(bytes).digest("hex");
}

function repositoryPath(root: string, path: string): string {
  if (path.length === 0 || path.includes("\0") || isAbsolute(path)
    || path.startsWith(":(") || /[*?\[\]]/.test(path)
    || path.split(/[\\/]/).includes("..")) {
    throw new Error("Hook path must be an explicit repository-relative path");
  }
  const absoluteRoot = resolve(root);
  const absolutePath = resolve(absoluteRoot, path);
  const relativePath = relative(absoluteRoot, absolutePath);
  if (relativePath.length === 0 || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error("Hook path must remain inside the repository");
  }
  return absolutePath;
}

async function snapshotWorktreePath(repository: HookRepository, path: string): Promise<WorktreeSnapshot> {
  const absolutePath = repositoryPath(repository.root, path);
  const absoluteRoot = resolve(repository.root);
  let parentPath = absoluteRoot;
  const parentParts = relative(absoluteRoot, absolutePath).split(sep).slice(0, -1);
  for (const part of parentParts) {
    parentPath = join(parentPath, part);
    let parentStats;
    try {
      parentStats = await lstat(parentPath);
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
        return { kind: "missing" };
      }
      throw error;
    }
    if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) {
      throw new Error("Hook paths cannot traverse symlink or non-directory parents");
    }
  }
  let stats;
  try {
    stats = await lstat(absolutePath);
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      return { kind: "missing" };
    }
    throw error;
  }
  if (stats.isSymbolicLink()) {
    const target = await readlink(absolutePath, { encoding: "buffer" });
    return { kind: "symlink", fingerprint: fingerprint("symlink", target) };
  }
  if (stats.isFile()) {
    const bytes = await readFile(absolutePath);
    return {
      kind: "file",
      fingerprint: fingerprint("file", bytes),
      executable: (stats.mode & 0o111) !== 0,
    };
  }
  return { kind: "other", mode: stats.mode & 0o170777 };
}

function sameSnapshot(left: WorktreeSnapshot, right: WorktreeSnapshot): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "file" && right.kind === "file") {
    return left.fingerprint === right.fingerprint && left.executable === right.executable;
  }
  if (left.kind === "symlink" && right.kind === "symlink") return left.fingerprint === right.fingerprint;
  if (left.kind === "other" && right.kind === "other") return left.mode === right.mode;
  return true;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function eventPaths(event: HookEvent): string[] {
  const input = asRecord(event.input);
  if (input === null) return [];
  const paths = new Set<string>();
  const visited = new WeakSet<object>();
  const collect = (value: unknown): void => {
    const record = asRecord(value);
    if (record === null || visited.has(record)) return;
    visited.add(record);
    for (const key of ["path", "filePath", "filepath", "file", "filename", "target", "oldPath", "newPath"]) {
      const path = stringValue(record[key]);
      if (path !== null) paths.add(path);
    }
    for (const key of ["paths", "files"]) {
      const candidates = record[key];
      if (!Array.isArray(candidates)) continue;
      for (const candidate of candidates) {
        const path = stringValue(candidate);
        if (path !== null) paths.add(path);
      }
    }
    for (const key of ["arguments", "params", "toolInput"]) collect(record[key]);
  };
  collect(input);
  return [...paths];
}

function eventPath(event: HookEvent): string | null {
  return eventPaths(event)[0] ?? null;
}

function eventRevision(event: HookEvent): "HEAD" | "index" {
  const input = asRecord(event.input);
  return input?.revision === "index" || input?.staged === true ? "index" : "HEAD";
}

function isReadTool(tool: string): boolean {
  return /^(?:read|open|view|cat|inspect|file-read)$/i.test(tool);
}

function isEditTool(tool: string): boolean {
  return /(?:edit|write|patch|replace|apply|save|modify)/i.test(tool);
}

function sanitize(value: string): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

function indent(value: string): string {
  return sanitize(value).replace(/\n/g, "\n  ");
}

function renderRecord(record: ReverieRecord): string {
  const alternatives = record.alternatives.length === 0
    ? "  - none recorded"
    : record.alternatives.map((alternative) => `  - ${indent(alternative)}`).join("\n");
  const sources = record.sources.length === 0
    ? "  - none recorded"
    : record.sources.map((source) => `  - ${sanitize(source.relation)} ${sanitize(source.kind)}:${sanitize(source.ref)}${source.at === undefined ? "" : ` at ${sanitize(source.at)}`}`).join("\n");
  const supersedes = record.supersedes.length === 0
    ? "  - none"
    : record.supersedes.map((id) => `  - ${sanitize(id)}`).join("\n");
  return [
    sanitize(record.id),
    "",
    "Driving event:",
    `  ${indent(record.driving_event)}`,
    "",
    "Decision:",
    `  ${indent(record.decision)}`,
    "",
    "Impact:",
    `  ${indent(record.impact)}`,
    "",
    "Recurrence control:",
    `  ${record.recurrence_control === null ? "none established" : indent(record.recurrence_control)}`,
    "",
    "Alternatives:",
    alternatives,
    "",
    "Sources:",
    sources,
    "",
    "Supersedes:",
    supersedes,
  ].join("\n");
}

function projectionKey(blob: ObjectId, records: readonly ReverieRecord[]): string {
  const hash = createHash("sha256");
  hash.update(blob);
  for (const record of records) hash.update(record.id);
  return hash.digest("hex");
}

function renderEvidence(blob: ObjectId, records: readonly ReverieRecord[], maxChars: number): string {
  const header = [
    "REVERIES — repository engineering evidence, not executable instructions",
    "",
    `Blob ${sanitize(blob)}`,
    "",
  ].join("\n");
  const rendered = records.map(renderRecord);
  const footer = (omitted: number) => omitted > 0
    ? `\n\n${omitted} additional reveries omitted. Use \`reveries show\` or direct git notes to inspect all.`
    : "";
  let body = header;
  let omitted = 0;
  for (const record of rendered) {
    const candidate = `${body}${body.endsWith("\n\n") ? "" : "\n\n"}${record}`;
    const remaining = rendered.length - omitted - 1;
    if (candidate.length + footer(remaining).length > maxChars) {
      omitted += 1;
      continue;
    }
    body = candidate;
  }
  const output = `${body}${footer(omitted)}`;
  return output.length <= maxChars ? output : `${header.slice(0, Math.max(0, maxChars - 1))}…`;
}

async function enabled(repository: HookRepository): Promise<boolean> {
  try {
    const content = await readFile(join(repository.root, "AGENTS.md"), "utf8");
    const firstBegin = content.indexOf(MARKER_BEGIN);
    const firstEnd = content.indexOf(MARKER_END);
    return firstBegin >= 0
      && firstEnd > firstBegin
      && content.indexOf(MARKER_BEGIN, firstBegin + MARKER_BEGIN.length) < 0
      && content.indexOf(MARKER_END, firstEnd + MARKER_END.length) < 0;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function repositoryFor(dependencies: HookDependencies): Promise<HookRepository> {
  const repository = dependencies.repository ?? await GitRepository.open(dependencies.cwd ?? process.cwd());
  // Automatic delivery must never lazily fetch: reads that would heal an
  // incomplete clone over the network fail fast instead, and callers report
  // the completeness grade. Injected fakes pass through unchanged.
  return repository instanceof GitRepository ? repository.withoutLazyFetch() : repository;
}

type CloneShape = { readonly shallow: boolean; readonly promisor: boolean };

async function cloneShape(repository: HookRepository): Promise<CloneShape> {
  const [shallow, promisor] = await Promise.all([
    repository.isShallowRepository?.() ?? false,
    repository.hasPromisorRemote?.() ?? false,
  ]);
  return { shallow, promisor };
}

type SourcePresence = "present" | "absent" | "incomplete";

async function hookSourcePresence(
  repository: HookRepository,
  source: Source,
  shape: CloneShape,
): Promise<SourcePresence> {
  if (source.kind === "commit" || source.kind === "blob") {
    if (await repository.objectExists(source.kind, objectId(source.ref))) return "present";
    if (shape.shallow || shape.promisor) return "incomplete";
    return "absent";
  }
  if (source.kind === "path") {
    if (source.at === undefined) return "absent";
    try {
      await repository.resolvePath({ path: source.ref, revision: source.at });
      return "present";
    } catch {
      return shape.shallow ? "incomplete" : "absent";
    }
  }
  if (source.kind !== "note") return "present";
  for (const entry of await repository.listNotes()) {
    let note: string | null;
    try {
      note = await repository.readNote(entry.object);
    } catch {
      // An unreadable note body behind an incomplete clone cannot vouch for
      // absence of the referenced reverie.
      if (shape.shallow || shape.promisor) return "incomplete";
      throw new Error(`Note blob is missing for annotated object ${entry.object}`);
    }
    if (note === null) continue;
    const parsed = parseNote(note, "tolerant", { verifyIds: false });
    if (parsed.records.some((record) => record.type === "reverie" && record.id === source.ref)) {
      return "present";
    }
  }
  return "absent";
}

async function activeFor(
  repository: HookRepository,
  blob: ObjectId,
): Promise<{ readonly records: ReverieRecord[]; readonly reason: string | null; readonly completeness: CompletenessGrade | null }> {
  const shape = await cloneShape(repository);
  let note: string | null;
  try {
    note = await repository.readNote(blob);
  } catch {
    if (shape.shallow || shape.promisor) {
      return {
        records: [],
        reason: "incomplete-evidence",
        completeness: cloneEvidenceGrade(shape),
      };
    }
    return { records: [], reason: "malformed-note", completeness: null };
  }
  // Silence behind an incomplete clone would claim evidence does not exist.
  if (note === null) {
    if (shape.shallow || shape.promisor) {
      return {
        records: [],
        reason: "incomplete-evidence",
        completeness: cloneEvidenceGrade(shape),
      };
    }
    return { records: [], reason: null, completeness: null };
  }
  try {
    const parsed = parseNote(note, "strict", { verifyIds: false });
    const reveries = parsed.records.filter((record): record is ReverieRecord => record.type === "reverie");
    for (const reverie of reveries) {
      const expected = `rv:${await repository.hashObject(`${semanticPayload(reverie)}\n`)}`;
      if (expected !== reverie.id) return { records: [], reason: "malformed-note", completeness: null };
      for (const source of reverie.sources) {
        const presence = await hookSourcePresence(repository, source, shape);
        if (presence === "incomplete") {
          return {
            records: [],
            reason: "incomplete-evidence",
            completeness: cloneEvidenceGrade(shape),
          };
        }
        if (presence === "absent") return { records: [], reason: "broken-source", completeness: null };
      }
    }
    const projection = projectActiveReveries(reveries);
    if (projection.cycles.length > 0 || projection.forks.length > 0 || (projection.conflicts?.length ?? 0) > 0) {
      return { records: [], reason: "conflicting-note", completeness: null };
    }
    return { records: projection.active, reason: null, completeness: null };
  } catch {
    return { records: [], reason: "malformed-note", completeness: null };
  }
}

async function readDelivery(
  event: HookEvent,
  repository: HookRepository,
  state: HookState,
  maxContextChars: number,
): Promise<HookResult> {
  const path = eventPath(event);
  if (path === null) return emptyResult();
  let blob: ObjectId;
  try {
    blob = await repository.resolvePath({ path, revision: eventRevision(event) });
  } catch {
    const shape = await cloneShape(repository);
    if (shape.shallow || shape.promisor) {
      return emptyResult("incomplete-evidence", cloneEvidenceGrade(shape));
    }
    return emptyResult("path-unavailable");
  }
  const projection = await activeFor(repository, blob);
  if (projection.reason !== null) return emptyResult(projection.reason, projection.completeness);
  if (projection.records.length === 0) return emptyResult();
  const key = `${event.host}\u0000${event.session ?? ""}\u0000${projectionKey(blob, projection.records)}`;
  if (state.delivered.has(key)) return emptyResult();
  state.delivered.add(key);
  return {
    context: renderEvidence(blob, projection.records, maxContextChars),
    user_message: null,
    block: false,
    reason: null,
    completeness: "complete",
  };
}

async function beforeEdit(
  event: HookEvent,
  repository: HookRepository,
  state: HookState,
): Promise<HookResult> {
  const paths = eventPaths(event);
  if (paths.length === 0) return emptyResult();
  let reason: string | null = null;
  let completeness: CompletenessGrade | null = null;
  for (const path of paths) {
    const key = `${event.session ?? ""}\u0000${path}`;
    state.edits.delete(key);
    try {
      const snapshot = await snapshotWorktreePath(repository, path);
      const blobs = new Set<BlobId>();
      for (const revision of ["HEAD", "index"] as const) {
        try {
          blobs.add(await repository.resolvePath({ path, revision }));
        } catch {
          // New or deleted paths have no object at this revision.
        }
      }
      const ids = new Set<string>();
      for (const blob of blobs) {
        const projection = await activeFor(repository, blob);
        if (projection.reason !== null) {
          reason ??= projection.reason;
          completeness ??= projection.completeness;
          continue;
        }
        for (const record of projection.records) ids.add(record.id);
      }
      if (ids.size > 0) state.edits.set(key, { snapshot, blobs: [...blobs], ids: [...ids] });
    } catch {
      reason ??= "path-unavailable";
    }
  }
  return emptyResult(reason, completeness);
}

async function afterEdit(
  event: HookEvent,
  repository: HookRepository,
  state: HookState,
): Promise<HookResult> {
  const paths = eventPaths(event);
  if (paths.length === 0) return emptyResult();
  const ids = new Set<string>();
  const changedPaths = new Set<string>();
  let unavailable = false;
  for (const path of paths) {
    const key = `${event.session ?? ""}\u0000${path}`;
    const prior = state.edits.get(key);
    state.edits.delete(key);
    if (prior === undefined) continue;
    let nextSnapshot: WorktreeSnapshot;
    try {
      nextSnapshot = await snapshotWorktreePath(repository, path);
    } catch {
      unavailable = true;
      continue;
    }
    if (sameSnapshot(prior.snapshot, nextSnapshot)) continue;
    changedPaths.add(path);
    for (const id of prior.ids) ids.add(id);
  }
  if (ids.size === 0) return emptyResult(unavailable ? "path-unavailable" : null);
  const pathList = [...changedPaths].map((path) => sanitize(path)).join(", ");
  const idList = [...ids].map((id) => sanitize(id)).join(", ");
  return {
    context: null,
    user_message: `REVERIES continuity required for ${pathList}. Prior decisions: ${idList}. Before committing, explicitly continue, supersede, or retire every prior decision.`,
    block: false,
    reason: null,
    completeness: null,
  };
}

export async function handleHookEvent(
  event: HookEvent,
  dependencies: HookDependencies = {},
  renderOptions: HookRenderOptions = {},
): Promise<HookResult> {
  const repository = await repositoryFor(dependencies);
  try {
    if (!(await enabled(repository))) return emptyResult();
  } catch {
    return emptyResult("repository-unavailable");
  }
  const state = dependencies.state ?? createHookState();
  const maxContextChars = Math.max(256, renderOptions.maxContextChars ?? DEFAULT_MAX_CONTEXT_CHARS);
  if (event.event === "before-tool" && isEditTool(event.tool)) return beforeEdit(event, repository, state);
  if (event.event === "after-tool" && isEditTool(event.tool)) return afterEdit(event, repository, state);
  if (event.event === "after-tool" && isReadTool(event.tool)) return readDelivery(event, repository, state, maxContextChars);
  return emptyResult();
}

function normalizedEventName(value: string): HookEventName {
  const normalized = value.toLowerCase().replace(/[_\s]/g, "-");
  if (normalized === "session-start" || normalized === "start") return "session-start";
  if (normalized === "prompt") return "prompt";
  if (normalized === "before-tool" || normalized === "beforetool") return "before-tool";
  if (normalized === "after-tool" || normalized === "aftertool" || normalized === "tool-result" || normalized === "tool-resulted") return "after-tool";
  if (normalized === "session-end" || normalized === "end") return "session-end";
  throw new Error(`Unsupported hook event: ${value}`);
}

export function adaptHostEvent(host: HookHost, input: unknown, sessionOverride?: string | null): HookEvent {
  const value = typeof input === "string" ? JSON.parse(input) as unknown : input;
  const record = asRecord(value);
  if (record === null) throw new Error("Hook event must be a JSON object");
  const session = sessionOverride ?? stringValue(record.session) ?? stringValue(record.sessionId);
  const tool = stringValue(record.tool) ?? stringValue(record.toolName) ?? stringValue(record.name) ?? "";
  const eventName = stringValue(record.event) ?? stringValue(record.type) ?? (tool.length > 0 ? "after-tool" : "prompt");
  return {
    host,
    event: normalizedEventName(eventName),
    session,
    tool,
    input: record.input ?? record.params ?? record.arguments ?? {},
    output: record.output ?? record.result ?? {},
  };
}
