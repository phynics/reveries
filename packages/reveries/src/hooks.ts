import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { GitRepository } from "./git.ts";
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
};

export type HookRepository = {
  readonly root: string;
  resolvePath(input: { path: string; revision: "HEAD" | "index" | string }): Promise<BlobId>;
  readNote(object: ObjectId): Promise<string | null>;
  hashObject(input: string): Promise<ObjectId>;
  objectExists(kind: "blob" | "commit", object: ObjectId): Promise<boolean>;
  listNotes(): Promise<readonly { readonly object: ObjectId }[]>;
};

export type HookState = {
  readonly delivered: Set<string>;
  readonly edits: Map<string, { readonly blob: BlobId; readonly ids: readonly string[] }>;
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

function emptyResult(reason: string | null = null): HookResult {
  return { context: null, user_message: null, block: false, reason };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function eventPath(event: HookEvent): string | null {
  const input = asRecord(event.input);
  if (input === null) return null;
  for (const key of ["path", "filePath", "filepath", "file", "filename", "target"]) {
    const path = stringValue(input[key]);
    if (path !== null) return path;
  }
  for (const key of ["arguments", "params", "toolInput"]) {
    const nested = asRecord(input[key]);
    if (nested === null) continue;
    const path = eventPath({ ...event, input: nested });
    if (path !== null) return path;
  }
  return null;
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
  return dependencies.repository ?? await GitRepository.open(dependencies.cwd ?? process.cwd());
}

async function hookSourceExists(repository: HookRepository, source: Source): Promise<boolean> {
  if (source.kind === "commit" || source.kind === "blob") {
    return repository.objectExists(source.kind, objectId(source.ref));
  }
  if (source.kind === "path") {
    if (source.at === undefined) return false;
    try {
      await repository.resolvePath({ path: source.ref, revision: source.at });
      return true;
    } catch {
      return false;
    }
  }
  if (source.kind !== "note") return true;
  for (const entry of await repository.listNotes()) {
    const note = await repository.readNote(entry.object);
    if (note === null) continue;
    const parsed = parseNote(note, "tolerant", { verifyIds: false });
    if (parsed.records.some((record) => record.type === "reverie" && record.id === source.ref)) return true;
  }
  return false;
}

async function activeFor(
  repository: HookRepository,
  blob: ObjectId,
): Promise<{ readonly records: ReverieRecord[]; readonly reason: string | null }> {
  const note = await repository.readNote(blob);
  if (note === null) return { records: [], reason: null };
  try {
    const parsed = parseNote(note, "strict", { verifyIds: false });
    const reveries = parsed.records.filter((record): record is ReverieRecord => record.type === "reverie");
    for (const reverie of reveries) {
      const expected = `rv:${await repository.hashObject(`${semanticPayload(reverie)}\n`)}`;
      if (expected !== reverie.id) return { records: [], reason: "malformed-note" };
      for (const source of reverie.sources) {
        if (!(await hookSourceExists(repository, source))) return { records: [], reason: "broken-source" };
      }
    }
    const projection = projectActiveReveries(reveries);
    if (projection.cycles.length > 0 || projection.forks.length > 0 || (projection.conflicts?.length ?? 0) > 0) {
      return { records: [], reason: "conflicting-note" };
    }
    return { records: projection.active, reason: null };
  } catch {
    return { records: [], reason: "malformed-note" };
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
    return emptyResult("path-unavailable");
  }
  const projection = await activeFor(repository, blob);
  if (projection.reason !== null) return emptyResult(projection.reason);
  if (projection.records.length === 0) return emptyResult();
  const key = `${event.host}\u0000${event.session ?? ""}\u0000${projectionKey(blob, projection.records)}`;
  if (state.delivered.has(key)) return emptyResult();
  state.delivered.add(key);
  return { context: renderEvidence(blob, projection.records, maxContextChars), user_message: null, block: false, reason: null };
}

async function beforeEdit(
  event: HookEvent,
  repository: HookRepository,
  state: HookState,
): Promise<HookResult> {
  const path = eventPath(event);
  if (path === null) return emptyResult();
  try {
    const blob = await repository.resolvePath({ path, revision: "HEAD" });
    const projection = await activeFor(repository, blob);
    if (projection.reason !== null) return emptyResult(projection.reason);
    if (projection.records.length > 0) {
      state.edits.set(`${event.session ?? ""}\u0000${path}`, { blob, ids: projection.records.map((record) => record.id) });
    }
  } catch {
    return emptyResult("path-unavailable");
  }
  return emptyResult();
}

async function afterEdit(
  event: HookEvent,
  repository: HookRepository,
  state: HookState,
): Promise<HookResult> {
  const path = eventPath(event);
  if (path === null) return emptyResult();
  const key = `${event.session ?? ""}\u0000${path}`;
  const prior = state.edits.get(key);
  state.edits.delete(key);
  if (prior === undefined) return emptyResult();
  const output = asRecord(event.output);
  if (output?.changed === false) return emptyResult();
  let nextBlob: ObjectId;
  try {
    nextBlob = await repository.resolvePath({ path, revision: "index" });
  } catch {
    nextBlob = prior.blob;
  }
  if (nextBlob === prior.blob) return emptyResult();
  const ids = prior.ids.map((id) => sanitize(id)).join(", ");
  return {
    context: null,
    user_message: `REVERIES continuity required for ${sanitize(path)}. Prior decisions: ${ids}. Before committing, explicitly continue, supersede, or retire every prior decision.`,
    block: false,
    reason: null,
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
