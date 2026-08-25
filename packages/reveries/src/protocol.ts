export const NOTES_REF = "refs/notes/reveries" as const;

export type Brand<T, Name extends string> = T & { readonly __brand: Name };
export type ObjectId = Brand<string, "git-object-id">;
export type BlobId = ObjectId & { readonly __blobBrand: "blob-id" };
export type CommitId = ObjectId & { readonly __commitBrand: "commit-id" };
export type ReverieId = Brand<`rv:${string}`, "reverie-id">;

export type SourceRelation =
  | "caused-by"
  | "constrained-by"
  | "requested-by"
  | "derived-from"
  | "implements"
  | "corroborated-by";

export type SourceKind = "commit" | "blob" | "path" | "note" | "git-email" | "issue";

export type Source = {
  relation: SourceRelation;
  kind: SourceKind;
  ref: string;
  at?: CommitId;
};

export type ReverieSemantic = {
  v: 1;
  driving_event: string;
  decision: string;
  impact: string;
  recurrence_control: string | null;
  alternatives: string[];
  sources: Source[];
  supersedes: ReverieId[];
};

export type ReverieMetadata = {
  author_email: string;
  session: string | null;
  created_at: string;
};

export type ReverieRecord = ReverieSemantic & ReverieMetadata & {
  type: "reverie";
  id: ReverieId;
};

export type ReverieInput = ReverieSemantic;

export type Retirement = {
  reverie: ReverieId;
  from_blob: BlobId;
  reason: string;
};

export type SummaryEntry = {
  driving_event: string;
  decision: string;
  impact: string;
  recurrence_control: string | null;
  alternatives: string[];
  sources: Source[];
  reveries: ReverieId[];
  retirements: Retirement[];
};

export type SessionSummary = {
  v: 1;
  type: "session-summary";
  author_email: string;
  session: string | null;
  created_at: string;
  entries: SummaryEntry[];
  correction_reason?: string;
};

export type ReveriesInit = {
  v: 1;
  type: "reveries-init";
  protocol: 1;
  notes_ref: typeof NOTES_REF;
  publishing_remotes: string[];
  hosts: string[];
  author_email: string;
  created_at: string;
};

export type NoteRecord = ReverieRecord | SessionSummary | ReveriesInit;

export type Diagnostic = {
  line?: number;
  message: string;
};

export type ParsedNote = {
  records: NoteRecord[];
  diagnostics: Diagnostic[];
};

export type HashObject = (bytes: Uint8Array) => ObjectId;

const HEX_OBJECT_ID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const REVERIE_ID = /^rv:[0-9a-f]{40}$|^rv:[0-9a-f]{64}$/;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const RELATIONS = new Set<SourceRelation>([
  "caused-by", "constrained-by", "requested-by", "derived-from", "implements", "corroborated-by",
]);
const KINDS = new Set<SourceKind>(["commit", "blob", "path", "note", "git-email", "issue"]);
const HOSTS = new Set(["pi", "claude", "opencode", "codex", "gemini"]);
const EMAIL = /^[^\s@]+@[^\s@]+$/;
const ISSUE = /^(?:github:[^\s#]+\/[^\s#]+#\d+|gitlab:[^\s#]+\/[^\s#]+#\d+|linear:[A-Z][A-Z0-9]*-\d+|jira:[A-Z][A-Z0-9]*-\d+|generic:[^\s:]+:[^\s:]+)$/;

export function objectId(value: string): ObjectId {
  if (!HEX_OBJECT_ID.test(value)) throw new Error(`Invalid Git object ID: ${value}`);
  return value as ObjectId;
}

export function blobId(value: string): BlobId {
  return objectId(value) as BlobId;
}

export function commitId(value: string): CommitId {
  return objectId(value) as CommitId;
}

export function reverieId(value: string): ReverieId {
  if (!REVERIE_ID.test(value)) throw new Error(`Invalid reverie ID: ${value}`);
  return value as ReverieId;
}

function trimText(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} must be a nonempty string`);
  return trimmed;
}

function recurrenceText(value: string, field: string): string {
  const trimmed = trimText(value, field);
  if (/^(?:n\/a|none|tests pass)\.?$/i.test(trimmed)) throw new Error(`${field} cannot be a placeholder`);
  return trimmed;
}

function validateEmail(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !EMAIL.test(value)) throw new Error(`${field} must be a Git email address`);
}

function normalizeSource(source: Source): Source {
  const result: Source = {
    relation: source.relation,
    kind: source.kind,
    ref: trimText(source.ref, "source.ref"),
  };
  if (source.at !== undefined) result.at = source.at;
  return result;
}

function sourceSort(a: Source, b: Source): number {
  const left = [a.relation, a.kind, a.ref, a.at ?? ""].join("\u0000");
  const right = [b.relation, b.kind, b.ref, b.at ?? ""].join("\u0000");
  return Buffer.from(left).compare(Buffer.from(right));
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => trimText(value, "array item")))].sort(compareUtf8);
}

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}

function sortedUniqueSources(sources: readonly Source[]): Source[] {
  const unique = new Map<string, Source>();
  for (const source of sources) {
    const normalized = normalizeSource(source);
    unique.set(JSON.stringify(normalized), normalized);
  }
  return [...unique.values()].sort(sourceSort);
}

function normalizeSemantic(input: ReverieSemantic): ReverieSemantic {
  if (input.v !== 1) throw new Error("v must be exactly 1");
  const recurrence = input.recurrence_control === null
    ? null
    : recurrenceText(input.recurrence_control, "recurrence_control");
  return {
    v: 1,
    driving_event: trimText(input.driving_event, "driving_event"),
    decision: trimText(input.decision, "decision"),
    impact: trimText(input.impact, "impact"),
    recurrence_control: recurrence,
    alternatives: sortedUnique(input.alternatives),
    sources: sortedUniqueSources(input.sources),
    supersedes: [...new Set(input.supersedes)].sort(compareUtf8),
  };
}

export function semanticPayload(record: ReverieSemantic): string {
  return JSON.stringify(normalizeSemantic(record));
}

export function createReverie(
  input: ReverieInput,
  metadata: ReverieMetadata,
  hashObject: HashObject,
): ReverieRecord {
  const semantic = normalizeSemantic(input);
  validateTimestamp(metadata.created_at, "created_at");
  const id = `rv:${hashObject(Buffer.from(`${JSON.stringify(semantic)}\n`, "utf8"))}` as ReverieId;
  const record: ReverieRecord = {
    ...semantic,
    type: "reverie",
    id,
    author_email: trimText(metadata.author_email, "author_email"),
    session: metadata.session === null ? null : trimText(metadata.session, "session"),
    created_at: metadata.created_at,
  };
  validateRecord(record, hashObject);
  return record;
}

function canonicalRetirement(retirement: Retirement): Retirement {
  return {
    reverie: retirement.reverie,
    from_blob: retirement.from_blob,
    reason: trimText(retirement.reason, "retirement.reason"),
  };
}

function canonicalRecordValue(record: NoteRecord): Record<string, unknown> {
  if (record.type === "reverie") {
    const semantic = normalizeSemantic(record);
    return {
      v: 1,
      type: "reverie",
      id: record.id,
      driving_event: semantic.driving_event,
      decision: semantic.decision,
      impact: semantic.impact,
      recurrence_control: semantic.recurrence_control,
      alternatives: semantic.alternatives,
      sources: semantic.sources,
      supersedes: semantic.supersedes,
      author_email: trimText(record.author_email, "author_email"),
      session: record.session === null ? null : trimText(record.session, "session"),
      created_at: record.created_at,
    };
  }
  if (record.type === "session-summary") {
    return {
      v: 1,
      type: "session-summary",
      author_email: trimText(record.author_email, "author_email"),
      session: record.session === null ? null : trimText(record.session, "session"),
      created_at: record.created_at,
      entries: record.entries.map((entry) => ({
        driving_event: trimText(entry.driving_event, "entry.driving_event"),
        decision: trimText(entry.decision, "entry.decision"),
        impact: trimText(entry.impact, "entry.impact"),
        recurrence_control: entry.recurrence_control === null ? null : recurrenceText(entry.recurrence_control, "entry.recurrence_control"),
        alternatives: sortedUnique(entry.alternatives),
        sources: sortedUniqueSources(entry.sources),
        reveries: [...new Set(entry.reveries)].sort(compareUtf8),
        retirements: [...entry.retirements].map(canonicalRetirement).sort((a, b) => compareUtf8(`${a.reverie}\u0000${a.from_blob}`, `${b.reverie}\u0000${b.from_blob}`)),
      })),
      ...(record.correction_reason === undefined ? {} : { correction_reason: trimText(record.correction_reason, "correction_reason") }),
    };
  }
  return {
    v: 1,
    type: "reveries-init",
    protocol: 1,
    notes_ref: NOTES_REF,
    publishing_remotes: sortedUnique(record.publishing_remotes),
    hosts: sortedUnique(record.hosts),
    author_email: trimText(record.author_email, "author_email"),
    created_at: record.created_at,
  };
}

export function canonicalRecord(record: NoteRecord): string {
  return `${JSON.stringify(canonicalRecordValue(record))}\n`;
}

function asRecord(value: unknown): NoteRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("record must be a JSON object");
  const record = value as Record<string, unknown>;
  if (record.type === "reverie") return record as unknown as ReverieRecord;
  if (record.type === "session-summary") return record as unknown as SessionSummary;
  if (record.type === "reveries-init") return record as unknown as ReveriesInit;
  throw new Error(`unknown record type: ${String(record.type)}`);
}

function validateTimestamp(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !RFC3339_UTC.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${field} must be a canonical UTC RFC 3339 timestamp`);
  }
}

function validateSource(source: unknown): asserts source is Source {
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("source must be an object");
  const value = source as Record<string, unknown>;
  if (typeof value.relation !== "string" || !RELATIONS.has(value.relation as SourceRelation)) throw new Error("invalid source relation");
  if (typeof value.kind !== "string" || !KINDS.has(value.kind as SourceKind)) throw new Error("invalid source kind");
  if (typeof value.ref !== "string" || !value.ref.trim()) throw new Error("source.ref must be nonempty");
  if (value.kind === "path") {
    if (value.at === undefined) throw new Error("path source requires an at commit");
    commitId(String(value.at));
  } else if (value.at !== undefined) throw new Error("source.at is valid only for a path source");
  if (value.kind === "commit" || value.kind === "blob") objectId(value.ref);
  else if (value.kind === "note") reverieId(value.ref);
  else if (value.kind === "git-email") validateEmail(value.ref, "source.ref");
  else if (value.kind === "issue" && !ISSUE.test(value.ref)) throw new Error("invalid issue source reference");
}

function validateRecord(record: NoteRecord, hashObject?: HashObject): void {
  if (record.v !== 1) throw new Error("v must be exactly 1");
  if (record.type === "reverie") {
    if (!REVERIE_ID.test(record.id)) throw new Error("invalid reverie ID");
    if (!Array.isArray(record.alternatives) || !Array.isArray(record.sources) || !Array.isArray(record.supersedes)) throw new Error("reverie arrays are required");
    for (const source of record.sources) validateSource(source);
    for (const id of record.supersedes) reverieId(id);
    trimText(record.driving_event, "driving_event");
    trimText(record.decision, "decision");
    trimText(record.impact, "impact");
    if (record.recurrence_control !== null) recurrenceText(record.recurrence_control, "recurrence_control");
    validateEmail(record.author_email, "author_email");
    if (record.session !== null) trimText(record.session, "session");
    validateTimestamp(record.created_at, "created_at");
    if (hashObject) {
      const expected = `rv:${hashObject(Buffer.from(`${semanticPayload(record)}\n`, "utf8"))}`;
      if (expected !== record.id) throw new Error(`semantic ID mismatch: expected ${expected}, got ${record.id}`);
    }
    return;
  }
  if (record.type === "session-summary") {
    validateEmail(record.author_email, "author_email");
    if (record.session !== null) trimText(record.session, "session");
    validateTimestamp(record.created_at, "created_at");
    if (!Array.isArray(record.entries) || record.entries.length === 0) throw new Error("entries must be nonempty");
    for (const entry of record.entries) {
      trimText(entry.driving_event, "entry.driving_event");
      trimText(entry.decision, "entry.decision");
      trimText(entry.impact, "entry.impact");
      if (entry.recurrence_control !== null) recurrenceText(entry.recurrence_control, "entry.recurrence_control");
      if (!Array.isArray(entry.alternatives) || !Array.isArray(entry.sources) || !Array.isArray(entry.reveries) || !Array.isArray(entry.retirements)) throw new Error("summary entry arrays are required");
      for (const source of entry.sources) validateSource(source);
      for (const id of entry.reveries) reverieId(id);
      for (const retirement of entry.retirements) {
        reverieId(retirement.reverie);
        blobId(retirement.from_blob);
        trimText(retirement.reason, "retirement.reason");
      }
    }
    if (record.correction_reason !== undefined) trimText(record.correction_reason, "correction_reason");
    return;
  }
  if (record.protocol !== 1 || record.notes_ref !== NOTES_REF) throw new Error("invalid Reveries initialization record");
  if (!Array.isArray(record.publishing_remotes) || !Array.isArray(record.hosts)) throw new Error("initialization arrays are required");
  for (const remote of record.publishing_remotes) trimText(remote, "publishing remote");
  for (const host of record.hosts) {
    if (typeof host !== "string" || !HOSTS.has(host)) throw new Error(`unsupported initialization host: ${String(host)}`);
  }
  validateEmail(record.author_email, "author_email");
  validateTimestamp(record.created_at, "created_at");
}

export type ValidateOptions = {
  hashObject?: HashObject;
  requireCanonical?: boolean;
  verifyIds?: boolean;
};

export function validateNote(
  input: ParsedNote | readonly NoteRecord[],
  options: ValidateOptions = {},
): NoteRecord[] {
  const isRecordList = Array.isArray(input);
  const parsed = isRecordList ? undefined : input as ParsedNote;
  const records = isRecordList ? [...input as readonly NoteRecord[]] : [...parsed!.records];
  if (parsed !== undefined && parsed.diagnostics.length > 0) throw new Error("note contains malformed records");
  const verifyIds = options.verifyIds ?? options.hashObject !== undefined;
  if (verifyIds && options.hashObject === undefined) {
    throw new Error("Semantic ID verification requires the repository hashObject function");
  }
  for (const record of records) validateRecord(record, verifyIds ? options.hashObject : undefined);
  const summaries = records.filter((record): record is SessionSummary => record.type === "session-summary");
  const inits = records.filter((record): record is ReveriesInit => record.type === "reveries-init");
  if (summaries.length > 1) throw new Error("note contains more than one session summary");
  if (inits.length > 1) throw new Error("note contains more than one initialization record");
  if (inits.length > 0 && (summaries.length !== 1 || records.length !== 2)) throw new Error("initialization note must contain exactly one summary and one init record");
  if (summaries.length === 0 && inits.length === 0 && records.some((record) => record.type !== "reverie")) throw new Error("blob note contains a non-reverie record");
  const byId = new Map<ReverieId, string>();
  for (const record of records) {
    if (record.type !== "reverie") continue;
    const semantic = semanticPayload(record);
    const previous = byId.get(record.id);
    if (previous !== undefined && previous !== semantic) throw new Error(`conflicting duplicate reverie ID: ${record.id}`);
    byId.set(record.id, semantic);
  }
  return records;
}

export function parseNote(
  text: string,
  mode: "strict" | "tolerant",
  options: ValidateOptions = {},
): ParsedNote {
  const records: NoteRecord[] = [];
  const diagnostics: Diagnostic[] = [];
  if (text.length === 0) return { records, diagnostics };
  if (!text.endsWith("\n")) {
    const diagnostic = { message: "note must end with one LF" };
    if (mode === "strict") throw new Error(diagnostic.message);
    diagnostics.push(diagnostic);
  }
  const lines = text.split("\n");
  const limit = text.endsWith("\n") ? lines.length - 1 : lines.length;
  for (let index = 0; index < limit; index += 1) {
    const line = lines[index] ?? "";
    try {
      if (!line || line.includes("\r")) throw new Error("invalid JSONL line");
      const parsed = asRecord(JSON.parse(line));
      validateRecord(parsed, options.hashObject);
      if (mode === "strict" && canonicalRecord(parsed) !== `${line}\n`) throw new Error("record is not canonical JSON");
      records.push(parsed);
    } catch (error) {
      const diagnostic = { line: index + 1, message: error instanceof Error ? error.message : String(error) };
      if (mode === "strict") throw new Error(`line ${diagnostic.line}: ${diagnostic.message}`);
      diagnostics.push(diagnostic);
    }
  }
  if (mode === "strict") validateNote(records, { ...options, verifyIds: options.hashObject !== undefined });
  return { records, diagnostics };
}

export type ActiveProjection = import("./projection.ts").ActiveProjection;
export { projectActiveReveries } from "./projection.ts";
export type { ContinuityInput, ContinuityReport, ContinuityDisposition, ContinuityObligation } from "./continuity.ts";
export { analyzeContinuity } from "./continuity.ts";
