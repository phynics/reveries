export const NOTES_REF = "refs/notes/reveries" as const;

export type Brand<T, Name extends string> = T & { readonly __brand: Name };
export type ObjectId = Brand<string, "git-object-id">;
export type BlobId = ObjectId & { readonly __blobBrand: "blob-id" };
export type CommitId = ObjectId & { readonly __commitBrand: "commit-id" };
export type ReverieId = Brand<`rv:${string}`, "reverie-id">;
export type TransitionId = Brand<`tr:${string}`, "transition-id">;
export type CorrectionId = Brand<`cr:${string}`, "correction-id">;
export type ResolutionId = Brand<`rs:${string}`, "resolution-id">;
export type RedactionId = Brand<`rd:${string}`, "redaction-id">;

/**
 * Heads a correction or resolution edge may name: reveries and the new
 * immutable fact kinds. Transition facts keep their RVR-004 identity and
 * fail-closed duplicate handling; they are never superseded, only redacted.
 */
export type FactHeadId = ReverieId | CorrectionId | ResolutionId;
/** Every fact a soft redaction may suppress from normal display. */
export type FactTargetId = FactHeadId | TransitionId;

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

/**
 * Causal content of a tree transition. The full set participates in the
 * transition identity, normalized exactly like reverie semantic content.
 * RVR-007 builds its fact graph on this shape: keep it small and stable.
 */
export type TransitionCausal = {
  driving_event: string;
  decision: string;
  impact: string;
  recurrence_control: string | null;
  alternatives: string[];
  sources: Source[];
  reveries: ReverieId[];
  retirements: Retirement[];
};

export type TransitionMetadata = {
  author_email: string;
  session: string | null;
  created_at: string;
};

/**
 * A causal explanation for why ordered parent trees became a result tree.
 * Stored as a note on the result tree object (RVR-005 may index it by id).
 * `parents` is ordered merge-parent order (`[]` for a root commit) and that
 * order participates in the identity.
 */
export type TransitionSummary = TransitionCausal & TransitionMetadata & {
  v: 1;
  type: "transition-summary";
  id: TransitionId;
  parents: ObjectId[];
  result: ObjectId;
};

export type TransitionInput = TransitionCausal & {
  parents: readonly ObjectId[];
  result: ObjectId;
};

/**
 * Minimal publication claim: who published `commit` and which reviewed
 * transition it used. The annotated commit is its identity (like a session
 * summary); it carries no independent `tr:`-style ID. RVR-005/RVR-009 may
 * extend it; the transition identity itself never depends on it.
 */
export type PublicationAttestation = TransitionMetadata & {
  v: 1;
  type: "publication-attestation";
  commit: CommitId;
  transition: TransitionId;
  publisher: string;
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

export type CorrectionSemantic = {
  v: 1;
  driving_event: string;
  decision: string;
  impact: string;
  recurrence_control: string | null;
  alternatives: string[];
  sources: Source[];
  /** Heads this correction claims to replace; nonempty so a bare new claim stays a reverie. */
  supersedes: FactHeadId[];
};

/**
 * An append-only correction to earlier facts. Unlike a session-summary
 * replacement it never rewrites a canonical line: concurrent corrections
 * naming the same heads form a visible fork until a resolution names them all.
 */
export type CorrectionRecord = CorrectionSemantic & ReverieMetadata & {
  type: "correction";
  id: CorrectionId;
};

export type CorrectionInput = CorrectionSemantic;

export type ResolutionSemantic = {
  v: 1;
  driving_event: string;
  decision: string;
  impact: string;
  recurrence_control: string | null;
  alternatives: string[];
  sources: Source[];
  /**
   * Every conflicting head this resolution converges. A resolution that
   * names only some terminals leaves the fork visible; naming every head
   * produces one active result.
   */
  resolves: FactHeadId[];
};

/**
 * Explicit convergence for a visible fork. The fork collapses only when
 * `resolves` covers every terminal head; partial coverage stays forked.
 */
export type ResolutionRecord = ResolutionSemantic & ReverieMetadata & {
  type: "resolution";
  id: ResolutionId;
};

export type ResolutionInput = ResolutionSemantic;

export type RedactionSemantic = {
  v: 1;
  /** The fact to suppress from normal display and search. */
  target: FactTargetId;
  reason: string;
};

/**
 * Soft redaction: normal display and search skip the target, while the
 * underlying immutable record stays in the snapshot bytes and history.
 * This never claims distributed erasure; hard redaction belongs to RVR-018.
 */
export type RedactionRecord = RedactionSemantic & ReverieMetadata & {
  type: "redaction";
  id: RedactionId;
};

export type RedactionInput = RedactionSemantic;

export type NoteRecord =
  | ReverieRecord
  | SessionSummary
  | ReveriesInit
  | TransitionSummary
  | PublicationAttestation
  | CorrectionRecord
  | ResolutionRecord
  | RedactionRecord;

export type Diagnostic = {
  line?: number;
  message: string;
};

export type ParsedNote = {
  records: NoteRecord[];
  diagnostics: Diagnostic[];
  truncated: boolean;
};

export type ResourceLimits = {
  maxNoteBytes: number;
  maxRecordsPerNote: number;
  maxRecordBytes: number;
  maxNarrativeChars: number;
  maxRefChars: number;
  maxAlternatives: number;
  maxSources: number;
  maxSupersedes: number;
  maxReveries: number;
  maxRetirements: number;
  maxEntries: number;
  maxParents: number;
  maxGraphVisits: number;
  maxDiagnostics: number;
  maxCorrections: number;
  maxResolutions: number;
  maxRedactions: number;
  maxResolves: number;
};

export const DEFAULT_LIMITS: Readonly<ResourceLimits> = Object.freeze({
  maxNoteBytes: 1_048_576,
  maxRecordsPerNote: 1_024,
  maxRecordBytes: 65_536,
  maxNarrativeChars: 8_192,
  maxRefChars: 1_024,
  maxAlternatives: 32,
  maxSources: 64,
  maxSupersedes: 64,
  maxReveries: 64,
  maxRetirements: 64,
  maxEntries: 64,
  maxParents: 64,
  maxGraphVisits: 131_072,
  maxDiagnostics: 32,
  maxCorrections: 64,
  maxResolutions: 64,
  maxRedactions: 64,
  maxResolves: 64,
});

export class LimitExceededError extends Error {
  readonly limit: keyof ResourceLimits;
  readonly actual: number;
  readonly budget: number;

  constructor(limit: keyof ResourceLimits, actual: number, budget: number, detail = "value") {
    super(`${detail} exceeds ${limit}: ${actual} > ${budget}`);
    this.name = "LimitExceededError";
    this.limit = limit;
    this.actual = actual;
    this.budget = budget;
  }
}

export function resolveLimits(overrides: Partial<ResourceLimits> = {}): Readonly<ResourceLimits> {
  return Object.freeze({ ...DEFAULT_LIMITS, ...overrides });
}

function utf8Length(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export type NoteSizeCheck =
  | { ok: true; byteLength: number }
  | { ok: false; byteLength: number; budget: number };

export function checkNoteSize(byteLength: number, limits: Partial<ResourceLimits> = {}): NoteSizeCheck {
  const budget = resolveLimits(limits).maxNoteBytes;
  if (byteLength <= budget) return { ok: true, byteLength };
  return { ok: false, byteLength, budget };
}

export function assertNoteSize(byteLength: number, limits: Partial<ResourceLimits> = {}): void {
  const resolved = resolveLimits(limits);
  if (byteLength > resolved.maxNoteBytes) {
    throw new LimitExceededError("maxNoteBytes", byteLength, resolved.maxNoteBytes, "note body");
  }
}

export type EvidenceSnapshot = {
  readonly notesTip: string;
  readonly records: readonly NoteRecord[];
  readonly byId: ReadonlyMap<ReverieId, NoteRecord>;
  readonly diagnostics: readonly Diagnostic[];
  readonly diagnosticsTruncated: boolean;
  readonly limits: Readonly<ResourceLimits>;
};

export type EvidenceSnapshotInput = {
  notesTip: string;
  records: readonly NoteRecord[];
  diagnostics?: readonly Diagnostic[];
  diagnosticsTruncated?: boolean;
  limits?: Partial<ResourceLimits>;
  hashObject?: HashObject;
};

export function createEvidenceSnapshot(input: EvidenceSnapshotInput): EvidenceSnapshot {
  const limits = resolveLimits(input.limits);
  objectId(input.notesTip);
  const records = validateNote(input.records, {
    ...(input.hashObject === undefined ? {} : { hashObject: input.hashObject }),
    limits,
  });
  const byId = new Map<ReverieId, NoteRecord>();
  for (const record of records) {
    if (record.type !== "reverie") continue;
    if (!byId.has(record.id)) byId.set(record.id, record);
  }
  const diagnostics = (input.diagnostics ?? []).slice(0, limits.maxDiagnostics);
  const diagnosticsTruncated = (input.diagnosticsTruncated ?? false)
    || (input.diagnostics ?? []).length > limits.maxDiagnostics;
  return {
    notesTip: input.notesTip,
    records,
    byId,
    diagnostics,
    diagnosticsTruncated,
    limits,
  };
}

export type HashObject = (bytes: Uint8Array) => ObjectId;

const HEX_OBJECT_ID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const REVERIE_ID = /^rv:[0-9a-f]{40}$|^rv:[0-9a-f]{64}$/;
const TRANSITION_ID = /^tr:[0-9a-f]{40}$|^tr:[0-9a-f]{64}$/;
const CORRECTION_ID = /^cr:[0-9a-f]{40}$|^cr:[0-9a-f]{64}$/;
const RESOLUTION_ID = /^rs:[0-9a-f]{40}$|^rs:[0-9a-f]{64}$/;
const REDACTION_ID = /^rd:[0-9a-f]{40}$|^rd:[0-9a-f]{64}$/;
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

export function transitionId(value: string): TransitionId {
  if (!TRANSITION_ID.test(value)) throw new Error(`Invalid transition ID: ${value}`);
  return value as TransitionId;
}

export function correctionId(value: string): CorrectionId {
  if (!CORRECTION_ID.test(value)) throw new Error(`Invalid correction ID: ${value}`);
  return value as CorrectionId;
}

export function resolutionId(value: string): ResolutionId {
  if (!RESOLUTION_ID.test(value)) throw new Error(`Invalid resolution ID: ${value}`);
  return value as ResolutionId;
}

export function redactionId(value: string): RedactionId {
  if (!REDACTION_ID.test(value)) throw new Error(`Invalid redaction ID: ${value}`);
  return value as RedactionId;
}

export function factHeadId(value: string): FactHeadId {
  if (REVERIE_ID.test(value)) return value as ReverieId;
  if (CORRECTION_ID.test(value)) return value as CorrectionId;
  if (RESOLUTION_ID.test(value)) return value as ResolutionId;
  throw new Error(`Invalid fact head ID: ${value}`);
}

export function factTargetId(value: string): FactTargetId {
  if (TRANSITION_ID.test(value)) return value as TransitionId;
  return factHeadId(value);
}

/**
 * The content-hash identity of a fact record, or null for records without
 * one (session summaries, initialization records, publication attestations).
 * Redaction filtering and snapshot indexes key on this.
 */
export function recordFactId(record: NoteRecord): string | null {
  if (record.type === "reverie"
    || record.type === "transition-summary"
    || record.type === "correction"
    || record.type === "resolution"
    || record.type === "redaction") {
    return record.id;
  }
  return null;
}

function trimText(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} must be a nonempty string`);
  return trimmed;
}

function checkChars(value: string, budget: number, limit: keyof ResourceLimits, field: string): void {
  const actual = [...value].length;
  if (actual > budget) throw new LimitExceededError(limit, actual, budget, field);
}

function checkArrayLength(values: readonly unknown[], budget: number, limit: keyof ResourceLimits, field: string): void {
  if (values.length > budget) throw new LimitExceededError(limit, values.length, budget, field);
}

function trimNarrative(value: string, field: string, limits: Readonly<ResourceLimits>): string {
  const trimmed = trimText(value, field);
  checkChars(trimmed, limits.maxNarrativeChars, "maxNarrativeChars", field);
  return trimmed;
}

function trimRef(value: string, field: string, limits: Readonly<ResourceLimits>): string {
  const trimmed = trimText(value, field);
  checkChars(trimmed, limits.maxRefChars, "maxRefChars", field);
  return trimmed;
}

function recurrenceText(value: string, field: string, limits: Readonly<ResourceLimits> = DEFAULT_LIMITS): string {
  const trimmed = trimNarrative(value, field, limits);
  if (/^(?:n\/a|none|tests pass)\.?$/i.test(trimmed)) throw new Error(`${field} cannot be a placeholder`);
  return trimmed;
}

function validateEmail(value: unknown, field: string, limits: Readonly<ResourceLimits> = DEFAULT_LIMITS): asserts value is string {
  if (typeof value !== "string" || !EMAIL.test(value)) throw new Error(`${field} must be a Git email address`);
  checkChars(value, limits.maxRefChars, "maxRefChars", field);
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
  limits: Partial<ResourceLimits> = {},
): ReverieRecord {
  const resolved = resolveLimits(limits);
  const semantic = normalizeSemantic(input);
  validateTimestamp(metadata.created_at, "created_at");
  const id = `rv:${hashObject(Buffer.from(`${JSON.stringify(semantic)}\n`, "utf8"))}` as ReverieId;
  const record: ReverieRecord = {
    ...semantic,
    type: "reverie",
    id,
    author_email: trimRef(metadata.author_email, "author_email", resolved),
    session: metadata.session === null ? null : trimRef(metadata.session, "session", resolved),
    created_at: metadata.created_at,
  };
  validateRecord(record, hashObject, resolved);
  return record;
}

function normalizeTransitionCausal(input: TransitionCausal): TransitionCausal {
  const recurrence = input.recurrence_control === null
    ? null
    : recurrenceText(input.recurrence_control, "recurrence_control");
  return {
    driving_event: trimText(input.driving_event, "driving_event"),
    decision: trimText(input.decision, "decision"),
    impact: trimText(input.impact, "impact"),
    recurrence_control: recurrence,
    alternatives: sortedUnique(input.alternatives),
    sources: sortedUniqueSources(input.sources),
    reveries: [...new Set(input.reveries)].sort(compareUtf8),
    retirements: canonicalRetirements(input.retirements),
  };
}

function canonicalRetirements(retirements: readonly Retirement[]): Retirement[] {
  return [...retirements].map(canonicalRetirement)
    .sort((a, b) => compareUtf8(`${a.reverie}\u0000${a.from_blob}`, `${b.reverie}\u0000${b.from_blob}`));
}

/**
 * Exact bytes hashed for the transition identity: version, ordered parent
 * trees, result tree, and normalized causal fields. Parent order is
 * preserved (never sorted); set-like causal arrays are deduplicated and
 * sorted. Author metadata is excluded, so the identity survives amends and
 * publication rewrites. RVR-007 depends on this exact shape.
 */
export function transitionPayload(
  record: TransitionCausal & { parents: readonly ObjectId[]; result: ObjectId },
): string {
  const causal = normalizeTransitionCausal(record);
  return JSON.stringify({
    v: 1,
    parents: [...record.parents],
    result: record.result,
    ...causal,
  });
}

export function createTransition(
  input: TransitionInput,
  metadata: TransitionMetadata,
  hashObject: HashObject,
  limits: Partial<ResourceLimits> = {},
): TransitionSummary {
  const resolved = resolveLimits(limits);
  const payload = transitionPayload(input);
  validateTimestamp(metadata.created_at, "created_at");
  const id = `tr:${hashObject(Buffer.from(`${payload}\n`, "utf8"))}` as TransitionId;
  const causal = normalizeTransitionCausal(input);
  const record: TransitionSummary = {
    ...causal,
    v: 1,
    type: "transition-summary",
    id,
    parents: [...input.parents],
    result: input.result,
    author_email: trimRef(metadata.author_email, "author_email", resolved),
    session: metadata.session === null ? null : trimRef(metadata.session, "session", resolved),
    created_at: metadata.created_at,
  };
  validateRecord(record, hashObject, resolved);
  return record;
}

export function createAttestation(
  input: { commit: CommitId; transition: TransitionId; publisher: string },
  metadata: TransitionMetadata,
  limits: Partial<ResourceLimits> = {},
): PublicationAttestation {
  const resolved = resolveLimits(limits);
  validateTimestamp(metadata.created_at, "created_at");
  const record: PublicationAttestation = {
    v: 1,
    type: "publication-attestation",
    author_email: trimRef(metadata.author_email, "author_email", resolved),
    session: metadata.session === null ? null : trimRef(metadata.session, "session", resolved),
    created_at: metadata.created_at,
    commit: commitId(input.commit),
    transition: transitionId(input.transition),
    publisher: trimRef(input.publisher, "publisher", resolved),
  };
  validateRecord(record, undefined, resolved);
  return record;
}

function sortedUniqueFactHeads(values: readonly FactHeadId[]): FactHeadId[] {
  return [...new Set(values.map((value) => factHeadId(value)))].sort(compareUtf8);
}

function normalizeCorrectionSemantic(input: CorrectionSemantic): CorrectionSemantic {
  if (input.v !== 1) throw new Error("v must be exactly 1");
  if (!Array.isArray(input.supersedes) || input.supersedes.length === 0) {
    throw new Error("correction supersedes must be nonempty");
  }
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
    supersedes: sortedUniqueFactHeads(input.supersedes),
  };
}

function normalizeResolutionSemantic(input: ResolutionSemantic): ResolutionSemantic {
  if (input.v !== 1) throw new Error("v must be exactly 1");
  if (!Array.isArray(input.resolves) || input.resolves.length === 0) {
    throw new Error("resolution resolves must be nonempty");
  }
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
    resolves: sortedUniqueFactHeads(input.resolves),
  };
}

function normalizeRedactionSemantic(input: RedactionSemantic): RedactionSemantic {
  if (input.v !== 1) throw new Error("v must be exactly 1");
  return {
    v: 1,
    target: factTargetId(input.target),
    reason: trimText(input.reason, "redaction.reason"),
  };
}

/** Exact bytes hashed for a correction identity: version plus normalized semantic content. */
export function correctionPayload(record: CorrectionSemantic): string {
  return JSON.stringify(normalizeCorrectionSemantic(record));
}

/** Exact bytes hashed for a resolution identity: version plus normalized content and head list. */
export function resolutionPayload(record: ResolutionSemantic): string {
  return JSON.stringify(normalizeResolutionSemantic(record));
}

/** Exact bytes hashed for a redaction identity: version, target, and reason. */
export function redactionPayload(record: RedactionSemantic): string {
  return JSON.stringify(normalizeRedactionSemantic(record));
}

export function createCorrection(
  input: CorrectionInput,
  metadata: ReverieMetadata,
  hashObject: HashObject,
  limits: Partial<ResourceLimits> = {},
): CorrectionRecord {
  const resolved = resolveLimits(limits);
  const semantic = normalizeCorrectionSemantic(input);
  validateTimestamp(metadata.created_at, "created_at");
  const id = `cr:${hashObject(Buffer.from(`${JSON.stringify(semantic)}\n`, "utf8"))}` as CorrectionId;
  const record: CorrectionRecord = {
    ...semantic,
    type: "correction",
    id,
    author_email: trimRef(metadata.author_email, "author_email", resolved),
    session: metadata.session === null ? null : trimRef(metadata.session, "session", resolved),
    created_at: metadata.created_at,
  };
  validateRecord(record, hashObject, resolved);
  return record;
}

export function createResolution(
  input: ResolutionInput,
  metadata: ReverieMetadata,
  hashObject: HashObject,
  limits: Partial<ResourceLimits> = {},
): ResolutionRecord {
  const resolved = resolveLimits(limits);
  const semantic = normalizeResolutionSemantic(input);
  validateTimestamp(metadata.created_at, "created_at");
  const id = `rs:${hashObject(Buffer.from(`${JSON.stringify(semantic)}\n`, "utf8"))}` as ResolutionId;
  const record: ResolutionRecord = {
    ...semantic,
    type: "resolution",
    id,
    author_email: trimRef(metadata.author_email, "author_email", resolved),
    session: metadata.session === null ? null : trimRef(metadata.session, "session", resolved),
    created_at: metadata.created_at,
  };
  validateRecord(record, hashObject, resolved);
  return record;
}

export function createRedaction(
  input: RedactionInput,
  metadata: ReverieMetadata,
  hashObject: HashObject,
  limits: Partial<ResourceLimits> = {},
): RedactionRecord {
  const resolved = resolveLimits(limits);
  const semantic = normalizeRedactionSemantic(input);
  validateTimestamp(metadata.created_at, "created_at");
  const id = `rd:${hashObject(Buffer.from(`${JSON.stringify(semantic)}\n`, "utf8"))}` as RedactionId;
  const record: RedactionRecord = {
    ...semantic,
    type: "redaction",
    id,
    author_email: trimRef(metadata.author_email, "author_email", resolved),
    session: metadata.session === null ? null : trimRef(metadata.session, "session", resolved),
    created_at: metadata.created_at,
  };
  validateRecord(record, hashObject, resolved);
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
  if (record.type === "transition-summary") {
    const causal = normalizeTransitionCausal(record);
    return {
      v: 1,
      type: "transition-summary",
      id: record.id,
      parents: [...record.parents],
      result: record.result,
      driving_event: causal.driving_event,
      decision: causal.decision,
      impact: causal.impact,
      recurrence_control: causal.recurrence_control,
      alternatives: causal.alternatives,
      sources: causal.sources,
      reveries: causal.reveries,
      retirements: causal.retirements,
      author_email: trimText(record.author_email, "author_email"),
      session: record.session === null ? null : trimText(record.session, "session"),
      created_at: record.created_at,
    };
  }
  if (record.type === "publication-attestation") {
    return {
      v: 1,
      type: "publication-attestation",
      author_email: trimText(record.author_email, "author_email"),
      session: record.session === null ? null : trimText(record.session, "session"),
      created_at: record.created_at,
      commit: record.commit,
      transition: record.transition,
      publisher: trimText(record.publisher, "publisher"),
    };
  }
  if (record.type === "correction") {
    const semantic = normalizeCorrectionSemantic(record);
    return {
      v: 1,
      type: "correction",
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
  if (record.type === "resolution") {
    const semantic = normalizeResolutionSemantic(record);
    return {
      v: 1,
      type: "resolution",
      id: record.id,
      driving_event: semantic.driving_event,
      decision: semantic.decision,
      impact: semantic.impact,
      recurrence_control: semantic.recurrence_control,
      alternatives: semantic.alternatives,
      sources: semantic.sources,
      resolves: semantic.resolves,
      author_email: trimText(record.author_email, "author_email"),
      session: record.session === null ? null : trimText(record.session, "session"),
      created_at: record.created_at,
    };
  }
  if (record.type === "redaction") {
    const semantic = normalizeRedactionSemantic(record);
    return {
      v: 1,
      type: "redaction",
      id: record.id,
      target: semantic.target,
      reason: semantic.reason,
      author_email: trimText(record.author_email, "author_email"),
      session: record.session === null ? null : trimText(record.session, "session"),
      created_at: record.created_at,
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
  if (record.type === "transition-summary") return record as unknown as TransitionSummary;
  if (record.type === "publication-attestation") return record as unknown as PublicationAttestation;
  if (record.type === "correction") return record as unknown as CorrectionRecord;
  if (record.type === "resolution") return record as unknown as ResolutionRecord;
  if (record.type === "redaction") return record as unknown as RedactionRecord;
  throw new Error(`unknown record type: ${String(record.type)}`);
}

function validateTimestamp(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !RFC3339_UTC.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${field} must be a canonical UTC RFC 3339 timestamp`);
  }
}

function validateSource(source: unknown, limits: Readonly<ResourceLimits> = DEFAULT_LIMITS): asserts source is Source {
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("source must be an object");
  const value = source as Record<string, unknown>;
  if (typeof value.relation !== "string" || !RELATIONS.has(value.relation as SourceRelation)) throw new Error("invalid source relation");
  if (typeof value.kind !== "string" || !KINDS.has(value.kind as SourceKind)) throw new Error("invalid source kind");
  if (typeof value.ref !== "string" || !value.ref.trim()) throw new Error("source.ref must be nonempty");
  checkChars(value.ref.trim(), limits.maxRefChars, "maxRefChars", "source.ref");
  if (value.kind === "path") {
    if (value.at === undefined) throw new Error("path source requires an at commit");
    commitId(String(value.at));
  } else if (value.at !== undefined) throw new Error("source.at is valid only for a path source");
  if (value.kind === "commit" || value.kind === "blob") objectId(value.ref);
  else if (value.kind === "note") reverieId(value.ref);
  else if (value.kind === "git-email") validateEmail(value.ref, "source.ref", limits);
  else if (value.kind === "issue" && !ISSUE.test(value.ref)) throw new Error("invalid issue source reference");
}

function validateTransitionSummary(
  record: TransitionSummary,
  hashObject?: HashObject,
  limits: Readonly<ResourceLimits> = DEFAULT_LIMITS,
): void {
  if (!TRANSITION_ID.test(record.id)) throw new Error("invalid transition ID");
  if (!Array.isArray(record.parents)) throw new Error("transition parents are required");
  checkArrayLength(record.parents, limits.maxParents, "maxParents", "parents");
  for (const parent of record.parents) objectId(parent);
  objectId(record.result);
  if (!Array.isArray(record.alternatives) || !Array.isArray(record.sources)
    || !Array.isArray(record.reveries) || !Array.isArray(record.retirements)) {
    throw new Error("transition arrays are required");
  }
  checkArrayLength(record.alternatives, limits.maxAlternatives, "maxAlternatives", "alternatives");
  checkArrayLength(record.sources, limits.maxSources, "maxSources", "sources");
  checkArrayLength(record.reveries, limits.maxReveries, "maxReveries", "reveries");
  checkArrayLength(record.retirements, limits.maxRetirements, "maxRetirements", "retirements");
  for (const alternative of record.alternatives) trimNarrative(alternative, "alternatives item", limits);
  for (const source of record.sources) validateSource(source, limits);
  for (const id of record.reveries) reverieId(id);
  for (const retirement of record.retirements) {
    reverieId(retirement.reverie);
    blobId(retirement.from_blob);
    trimNarrative(retirement.reason, "retirement.reason", limits);
  }
  trimNarrative(record.driving_event, "driving_event", limits);
  trimNarrative(record.decision, "decision", limits);
  trimNarrative(record.impact, "impact", limits);
  if (record.recurrence_control !== null) recurrenceText(record.recurrence_control, "recurrence_control", limits);
  validateEmail(record.author_email, "author_email", limits);
  if (record.session !== null) trimRef(record.session, "session", limits);
  validateTimestamp(record.created_at, "created_at");
  if (hashObject) {
    const expected = `tr:${hashObject(Buffer.from(`${transitionPayload(record)}\n`, "utf8"))}`;
    if (expected !== record.id) throw new Error(`transition ID mismatch: expected ${expected}, got ${record.id}`);
  }
}

function validateAttestation(
  record: PublicationAttestation,
  limits: Readonly<ResourceLimits> = DEFAULT_LIMITS,
): void {
  commitId(record.commit);
  transitionId(record.transition);
  trimRef(record.publisher, "publisher", limits);
  validateEmail(record.author_email, "author_email", limits);
  if (record.session !== null) trimRef(record.session, "session", limits);
  validateTimestamp(record.created_at, "created_at");
}

function validateFactNarrative(
  record: CorrectionSemantic | ResolutionSemantic,
  limits: Readonly<ResourceLimits>,
): void {
  if (!Array.isArray(record.alternatives) || !Array.isArray(record.sources)) {
    throw new Error("fact arrays are required");
  }
  checkArrayLength(record.alternatives, limits.maxAlternatives, "maxAlternatives", "alternatives");
  checkArrayLength(record.sources, limits.maxSources, "maxSources", "sources");
  for (const alternative of record.alternatives) trimNarrative(alternative, "alternatives item", limits);
  for (const source of record.sources) validateSource(source, limits);
  trimNarrative(record.driving_event, "driving_event", limits);
  trimNarrative(record.decision, "decision", limits);
  trimNarrative(record.impact, "impact", limits);
  if (record.recurrence_control !== null) recurrenceText(record.recurrence_control, "recurrence_control", limits);
}

function validateCorrection(
  record: CorrectionRecord,
  hashObject?: HashObject,
  limits: Readonly<ResourceLimits> = DEFAULT_LIMITS,
): void {
  if (!CORRECTION_ID.test(record.id)) throw new Error("invalid correction ID");
  if (!Array.isArray(record.supersedes) || record.supersedes.length === 0) {
    throw new Error("correction supersedes must be nonempty");
  }
  checkArrayLength(record.supersedes, limits.maxSupersedes, "maxSupersedes", "supersedes");
  for (const id of record.supersedes) factHeadId(id);
  validateFactNarrative(record, limits);
  validateEmail(record.author_email, "author_email", limits);
  if (record.session !== null) trimRef(record.session, "session", limits);
  validateTimestamp(record.created_at, "created_at");
  if (hashObject) {
    const expected = `cr:${hashObject(Buffer.from(`${correctionPayload(record)}\n`, "utf8"))}`;
    if (expected !== record.id) throw new Error(`correction ID mismatch: expected ${expected}, got ${record.id}`);
  }
}

function validateResolution(
  record: ResolutionRecord,
  hashObject?: HashObject,
  limits: Readonly<ResourceLimits> = DEFAULT_LIMITS,
): void {
  if (!RESOLUTION_ID.test(record.id)) throw new Error("invalid resolution ID");
  if (!Array.isArray(record.resolves) || record.resolves.length === 0) {
    throw new Error("resolution resolves must be nonempty");
  }
  checkArrayLength(record.resolves, limits.maxResolves, "maxResolves", "resolves");
  for (const id of record.resolves) factHeadId(id);
  validateFactNarrative(record, limits);
  validateEmail(record.author_email, "author_email", limits);
  if (record.session !== null) trimRef(record.session, "session", limits);
  validateTimestamp(record.created_at, "created_at");
  if (hashObject) {
    const expected = `rs:${hashObject(Buffer.from(`${resolutionPayload(record)}\n`, "utf8"))}`;
    if (expected !== record.id) throw new Error(`resolution ID mismatch: expected ${expected}, got ${record.id}`);
  }
}

function validateRedaction(
  record: RedactionRecord,
  hashObject?: HashObject,
  limits: Readonly<ResourceLimits> = DEFAULT_LIMITS,
): void {
  if (!REDACTION_ID.test(record.id)) throw new Error("invalid redaction ID");
  factTargetId(record.target);
  trimNarrative(record.reason, "redaction.reason", limits);
  validateEmail(record.author_email, "author_email", limits);
  if (record.session !== null) trimRef(record.session, "session", limits);
  validateTimestamp(record.created_at, "created_at");
  if (hashObject) {
    const expected = `rd:${hashObject(Buffer.from(`${redactionPayload(record)}\n`, "utf8"))}`;
    if (expected !== record.id) throw new Error(`redaction ID mismatch: expected ${expected}, got ${record.id}`);
  }
}

function validateRecord(record: NoteRecord, hashObject?: HashObject, limits: Readonly<ResourceLimits> = DEFAULT_LIMITS): void {
  if (record.v !== 1) throw new Error("v must be exactly 1");
  if (record.type === "reverie") {
    if (!REVERIE_ID.test(record.id)) throw new Error("invalid reverie ID");
    if (!Array.isArray(record.alternatives) || !Array.isArray(record.sources) || !Array.isArray(record.supersedes)) throw new Error("reverie arrays are required");
    checkArrayLength(record.alternatives, limits.maxAlternatives, "maxAlternatives", "alternatives");
    checkArrayLength(record.sources, limits.maxSources, "maxSources", "sources");
    checkArrayLength(record.supersedes, limits.maxSupersedes, "maxSupersedes", "supersedes");
    for (const alternative of record.alternatives) trimNarrative(alternative, "alternatives item", limits);
    for (const source of record.sources) validateSource(source, limits);
    for (const id of record.supersedes) reverieId(id);
    trimNarrative(record.driving_event, "driving_event", limits);
    trimNarrative(record.decision, "decision", limits);
    trimNarrative(record.impact, "impact", limits);
    if (record.recurrence_control !== null) recurrenceText(record.recurrence_control, "recurrence_control", limits);
    validateEmail(record.author_email, "author_email", limits);
    if (record.session !== null) trimRef(record.session, "session", limits);
    validateTimestamp(record.created_at, "created_at");
    if (hashObject) {
      const expected = `rv:${hashObject(Buffer.from(`${semanticPayload(record)}\n`, "utf8"))}`;
      if (expected !== record.id) throw new Error(`semantic ID mismatch: expected ${expected}, got ${record.id}`);
    }
    return;
  }
  if (record.type === "session-summary") {
    validateEmail(record.author_email, "author_email", limits);
    if (record.session !== null) trimRef(record.session, "session", limits);
    validateTimestamp(record.created_at, "created_at");
    if (!Array.isArray(record.entries) || record.entries.length === 0) throw new Error("entries must be nonempty");
    checkArrayLength(record.entries, limits.maxEntries, "maxEntries", "entries");
    for (const entry of record.entries) {
      trimNarrative(entry.driving_event, "entry.driving_event", limits);
      trimNarrative(entry.decision, "entry.decision", limits);
      trimNarrative(entry.impact, "entry.impact", limits);
      if (entry.recurrence_control !== null) recurrenceText(entry.recurrence_control, "entry.recurrence_control", limits);
      if (!Array.isArray(entry.alternatives) || !Array.isArray(entry.sources) || !Array.isArray(entry.reveries) || !Array.isArray(entry.retirements)) throw new Error("summary entry arrays are required");
      checkArrayLength(entry.alternatives, limits.maxAlternatives, "maxAlternatives", "entry.alternatives");
      checkArrayLength(entry.sources, limits.maxSources, "maxSources", "entry.sources");
      checkArrayLength(entry.reveries, limits.maxReveries, "maxReveries", "entry.reveries");
      checkArrayLength(entry.retirements, limits.maxRetirements, "maxRetirements", "entry.retirements");
      for (const alternative of entry.alternatives) trimNarrative(alternative, "entry.alternatives item", limits);
      for (const source of entry.sources) validateSource(source, limits);
      for (const id of entry.reveries) reverieId(id);
      for (const retirement of entry.retirements) {
        reverieId(retirement.reverie);
        blobId(retirement.from_blob);
        trimNarrative(retirement.reason, "retirement.reason", limits);
      }
    }
    if (record.correction_reason !== undefined) trimNarrative(record.correction_reason, "correction_reason", limits);
    return;
  }
  if (record.type === "transition-summary") {
    validateTransitionSummary(record, hashObject, limits);
    return;
  }
  if (record.type === "publication-attestation") {
    validateAttestation(record, limits);
    return;
  }
  if (record.type === "correction") {
    validateCorrection(record, hashObject, limits);
    return;
  }
  if (record.type === "resolution") {
    validateResolution(record, hashObject, limits);
    return;
  }
  if (record.type === "redaction") {
    validateRedaction(record, hashObject, limits);
    return;
  }
  if (record.protocol !== 1 || record.notes_ref !== NOTES_REF) throw new Error("invalid Reveries initialization record");
  if (!Array.isArray(record.publishing_remotes) || !Array.isArray(record.hosts)) throw new Error("initialization arrays are required");
  for (const remote of record.publishing_remotes) trimRef(remote, "publishing remote", limits);
  for (const host of record.hosts) {
    if (typeof host !== "string" || !HOSTS.has(host)) throw new Error(`unsupported initialization host: ${String(host)}`);
    checkChars(host, limits.maxRefChars, "maxRefChars", "initialization host");
  }
  validateEmail(record.author_email, "author_email", limits);
  validateTimestamp(record.created_at, "created_at");
}

export type ForkPolicy = "reject" | "project";

export type ValidateOptions = {
  hashObject?: HashObject;
  requireCanonical?: boolean;
  verifyIds?: boolean;
  limits?: Partial<ResourceLimits>;
  /**
   * How to treat unions that are structurally valid but forked: conflicting
   * duplicate fact IDs or concurrent session summaries. `reject` (default)
   * fails closed so sync and mutation paths keep quarantine behavior;
   * `project` keeps every record so the projection can surface the fork.
   * Malformed bytes and limit violations always throw.
   */
  forkPolicy?: ForkPolicy;
};

/**
 * Monotonic evidence union: set-union over canonical lines. Associative,
 * commutative, and idempotent by construction, so replica merge order never
 * changes the fact set. Earlier canonical lines are preserved verbatim;
 * no record is rewritten or discarded.
 */
export function unionFacts(...inputs: readonly (readonly NoteRecord[])[]): NoteRecord[] {
  const lines = new Map<string, NoteRecord>();
  for (const records of inputs) {
    for (const record of records) {
      const line = canonicalRecord(record);
      if (!lines.has(line)) lines.set(line, record);
    }
  }
  return [...lines.entries()]
    .sort((left, right) => Buffer.from(left[0]).compare(Buffer.from(right[0])))
    .map(([, record]) => record);
}

export function validateNote(
  input: ParsedNote | readonly NoteRecord[],
  options: ValidateOptions = {},
): NoteRecord[] {
  const isRecordList = Array.isArray(input);
  const parsed = isRecordList ? undefined : input as ParsedNote;
  const records = isRecordList ? [...input as readonly NoteRecord[]] : [...parsed!.records];
  if (parsed !== undefined && parsed.diagnostics.length > 0) throw new Error("note contains malformed records");
  const limits = resolveLimits(options.limits);
  checkArrayLength(records, limits.maxRecordsPerNote, "maxRecordsPerNote", "note records");
  const forkPolicy = options.forkPolicy ?? "reject";
  const verifyIds = options.verifyIds ?? options.hashObject !== undefined;
  if (verifyIds && options.hashObject === undefined) {
    throw new Error("Semantic ID verification requires the repository hashObject function");
  }
  for (const record of records) validateRecord(record, verifyIds ? options.hashObject : undefined, limits);
  const summaries = records.filter((record): record is SessionSummary => record.type === "session-summary");
  const inits = records.filter((record): record is ReveriesInit => record.type === "reveries-init");
  if (summaries.length > 1 && forkPolicy === "reject") throw new Error("note contains more than one session summary");
  if (inits.length > 1) throw new Error("note contains more than one initialization record");
  if (inits.length > 0 && (summaries.length !== 1 || records.length !== 2)) throw new Error("initialization note must contain exactly one summary and one init record");
  checkArrayLength(
    records.filter((record) => record.type === "correction"),
    limits.maxCorrections,
    "maxCorrections",
    "corrections",
  );
  checkArrayLength(
    records.filter((record) => record.type === "resolution"),
    limits.maxResolutions,
    "maxResolutions",
    "resolutions",
  );
  checkArrayLength(
    records.filter((record) => record.type === "redaction"),
    limits.maxRedactions,
    "maxRedactions",
    "redactions",
  );
  // Tree notes carry transition summaries and commit notes may carry
  // publication attestations; object-type placement beyond this is enforced
  // by the snapshot validator, which knows each annotated object's type.
  // Corrections, resolutions, and redactions are global facts that may ride
  // on blob, tree, or commit notes within the snapshot placement rules.
  if (summaries.length === 0 && inits.length === 0
    && records.some((record) => record.type !== "reverie"
      && record.type !== "transition-summary"
      && record.type !== "publication-attestation"
      && record.type !== "correction"
      && record.type !== "resolution"
      && record.type !== "redaction")) {
    throw new Error("blob note contains a non-reverie record");
  }
  const byId = new Map<ReverieId, string>();
  const transitionsById = new Map<TransitionId, string>();
  const correctionsById = new Map<CorrectionId, string>();
  const resolutionsById = new Map<ResolutionId, string>();
  const redactionsById = new Map<RedactionId, string>();
  const checkDuplicate = (previous: string | undefined, payload: string, message: string): void => {
    if (previous !== undefined && previous !== payload && forkPolicy === "reject") throw new Error(message);
  };
  let graphVisits = 0;
  const chargeGraph = (visits: number, scope: string): void => {
    graphVisits += visits;
    if (graphVisits > limits.maxGraphVisits) {
      throw new LimitExceededError("maxGraphVisits", graphVisits, limits.maxGraphVisits, scope);
    }
  };
  for (const record of records) {
    if (record.type === "transition-summary") {
      chargeGraph(1, "transition graph");
      const payload = transitionPayload(record);
      const previous = transitionsById.get(record.id);
      checkDuplicate(previous, payload, `conflicting duplicate transition ID: ${record.id}`);
      transitionsById.set(record.id, payload);
      continue;
    }
    if (record.type === "correction") {
      chargeGraph(1 + record.supersedes.length, "correction graph");
      const payload = correctionPayload(record);
      const previous = correctionsById.get(record.id);
      checkDuplicate(previous, payload, `conflicting duplicate correction ID: ${record.id}`);
      correctionsById.set(record.id, payload);
      continue;
    }
    if (record.type === "resolution") {
      chargeGraph(1 + record.resolves.length, "resolution graph");
      checkArrayLength(record.resolves, limits.maxResolves, "maxResolves", "resolves");
      const payload = resolutionPayload(record);
      const previous = resolutionsById.get(record.id);
      checkDuplicate(previous, payload, `conflicting duplicate resolution ID: ${record.id}`);
      resolutionsById.set(record.id, payload);
      continue;
    }
    if (record.type === "redaction") {
      chargeGraph(1, "redaction graph");
      const payload = redactionPayload(record);
      const previous = redactionsById.get(record.id);
      checkDuplicate(previous, payload, `conflicting duplicate redaction ID: ${record.id}`);
      redactionsById.set(record.id, payload);
      continue;
    }
    if (record.type !== "reverie") continue;
    chargeGraph(1 + record.supersedes.length, "supersession graph");
    const semantic = semanticPayload(record);
    const previous = byId.get(record.id);
    checkDuplicate(previous, semantic, `conflicting duplicate reverie ID: ${record.id}`);
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
  const limits = resolveLimits(options.limits);
  assertNoteSize(utf8Length(text), limits);
  let truncated = false;
  const pushDiagnostic = (diagnostic: Diagnostic): void => {
    if (diagnostics.length < limits.maxDiagnostics) diagnostics.push(diagnostic);
    else truncated = true;
  };
  if (text.length === 0) return { records, diagnostics, truncated };
  if (!text.endsWith("\n")) {
    const diagnostic = { message: "note must end with one LF" };
    if (mode === "strict") throw new Error(diagnostic.message);
    pushDiagnostic(diagnostic);
  }
  const lines = text.split("\n");
  const limit = text.endsWith("\n") ? lines.length - 1 : lines.length;
  for (let index = 0; index < limit; index += 1) {
    const line = lines[index] ?? "";
    const lineBytes = utf8Length(line) + 1;
    if (lineBytes > limits.maxRecordBytes) {
      const field = `record on line ${index + 1}`;
      if (mode === "strict") throw new LimitExceededError("maxRecordBytes", lineBytes, limits.maxRecordBytes, field);
      pushDiagnostic({ line: index + 1, message: `${field} exceeds maxRecordBytes: ${lineBytes} > ${limits.maxRecordBytes}` });
      continue;
    }
    if (records.length >= limits.maxRecordsPerNote) {
      const field = "note records";
      if (mode === "strict") throw new LimitExceededError("maxRecordsPerNote", records.length + 1, limits.maxRecordsPerNote, field);
      pushDiagnostic({ message: `${field} exceed maxRecordsPerNote: more than ${limits.maxRecordsPerNote} records` });
      truncated = true;
      break;
    }
    try {
      if (!line || line.includes("\r")) throw new Error("invalid JSONL line");
      const parsed = asRecord(JSON.parse(line));
      validateRecord(parsed, options.hashObject, limits);
      if (mode === "strict" && canonicalRecord(parsed) !== `${line}\n`) throw new Error("record is not canonical JSON");
      records.push(parsed);
    } catch (error) {
      const diagnostic = { line: index + 1, message: error instanceof Error ? error.message : String(error) };
      if (mode === "strict") throw new Error(`line ${diagnostic.line}: ${diagnostic.message}`);
      pushDiagnostic(diagnostic);
    }
  }
  if (mode === "strict") validateNote(records, { ...options, verifyIds: options.hashObject !== undefined });
  return { records, diagnostics, truncated };
}

export type ActiveProjection = import("./projection.ts").ActiveProjection;
export { projectActiveReveries } from "./projection.ts";
export type FactGraphProjection = import("./projection.ts").FactGraphProjection;
export { factGraphDiagnostics, projectFactGraph } from "./projection.ts";
export type TransitionAttestationProjection = import("./projection.ts").TransitionAttestationProjection;
export { projectTransitionAttestation } from "./projection.ts";
export type { ContinuityInput, ContinuityReport, ContinuityDisposition, ContinuityObligation } from "./continuity.ts";
export { analyzeContinuity } from "./continuity.ts";
