export const NOTES_REF = "refs/notes/reveries" as const;
export type Brand<T, Name extends string> = T & { readonly __brand: Name };
export type ObjectId = Brand<string, "git-object-id">;
export type BlobId = ObjectId & { readonly __blobBrand: "blob-id" };
export type CommitId = ObjectId & { readonly __commitBrand: "commit-id" };
/**
 * An annotated content subject: a blob (file) or a tree (subtree).
 * RVR-013 generalizes object evidence from blob-only to blob|tree while
 * keeping every content-addressed identity byte-identical: the same
 * canonical record carries the same `rv:` ID on either subject kind.
 */
export type SubjectId = ObjectId;
export type ReverieId = Brand<`rv:${string}`, "reverie-id">;
export type LineageId = Brand<`lg:${string}`, "lineage-id">;

/**
 * How a source reference relates to the decision. The core stores the relation,
 * the kind, an opaque reference, and an optional timestamp; it does not model
 * the referenced system.
 */
export type SourceRelation =
  | "caused-by"
  | "constrained-by"
  | "requested-by"
  | "derived-from"
  | "implements"
  | "corroborated-by";

export type SourceKind = "commit" | "blob" | "tree" | "path" | "note" | "git-email" | "issue";

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
  /**
   * Optional arbitrary-region scope (lean core). Identity is the blob object
   * ID plus the exact region fingerprint; every hint is navigation only and
   * never participates in the record ID.
   */
  region?: RegionSubject;
};

/**
 * A region inside one blob. `exact_hash` is the Git object hash of the
 * selected bytes, so the region is exactly as durable as the data it names.
 * Line numbers, prefix, and suffix are hints: they help a human find the
 * bytes again and never define identity.
 */
export type RegionSubject = {
  kind: "region";
  blob: ObjectId;
  exact_hash: string;
  start_line_hint: number;
  end_line_hint: number;
  prefix_hint: string;
  suffix_hint: string;
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

export type LineageEndpoint = {
  path: string;
  subject: SubjectId;
};

/**
 * The N-to-M relations a lineage edge may assert.
 *
 * - `preserve`: 1 to 1, the same intent at a new place.
 * - `split`: 1 to N, one subject became several.
 * - `merge`: N to 1, several subjects became one.
 * - `derive`: N to M with N ≥ 1 and M ≥ 1, the general case (including 2:3),
 *   used when neither a pure split nor a pure merge describes the change.
 * - `retire`: 1 to 0, the occurrence ended with no successor.
 *
 * `derive` is what makes a true N-to-M relation representable without
 * pretending it was a split or a merge. Its fan-out is bounded like every other
 * protocol dimension: `maxLineageRefs` caps the endpoints on one edge, so a
 * wide relation stays a bounded fact rather than an unbounded one.
 */
export type LineageKind = "preserve" | "split" | "merge" | "derive" | "retire";

export const LINEAGE_KINDS: readonly LineageKind[] = ["preserve", "split", "merge", "derive", "retire"];

export type LineageSemantic = {
  v: 1;
  kind: LineageKind;
  /** The direct parent revision whose state `from` describes. */
  parent: CommitId;
  /** The commit that establishes this relation; also the annotated subject. */
  commit: CommitId;
  from: LineageEndpoint[];
  to: LineageEndpoint[];
  /** The reserved transition slot, always null in the lean core. Kept because
   * the lineage identity hashes it; see `protocol/v1.md`. */
  transition: TransitionId | null;
  driving_event: string;
  decision: string;
  impact: string;
  recurrence_control: string | null;
  alternatives: string[];
  sources: Source[];
};

/**
 * A durable, explicit pairing between occurrences (RVR-014).
 *
 * The edge says only *which subjects are related and why*. It never carries a
 * decision, so it discharges nothing on its own: for every active decision on
 * a `from` subject, each `to` subject still needs its own continuation,
 * supersession, or a causal retirement. This is what keeps an edge from
 * becoming a back door around per-decision continuity.
 *
 * It rides the note of every endpoint subject, so an edge is discoverable from
 * either end and travels with publication of that evidence.
 */
export type LineageRecord = LineageSemantic & ReverieMetadata & {
  type: "lineage";
  id: LineageId;
};

export type LineageInput = LineageSemantic;

/** The lean core defines exactly two record types. */
export type NoteRecord = ReverieRecord | LineageRecord;

/**
 * A `tr:` transition identifier. Transitions are not part of the lean core,
 * but the lineage payload carries the field, so the type stays to keep lineage
 * identities byte-stable.
 */
export type TransitionId = Brand<`tr:${string}`, "transition-id">;

/** Validate a `tr:` transition identifier. */
export function transitionId(value: string): TransitionId {
  if (!/^tr:[0-9a-f]{40}$|^tr:[0-9a-f]{64}$/.test(value)) throw new Error(`Invalid transition ID: ${value}`);
  return value as TransitionId;
}

export type Diagnostic = {
  line?: number;
  message: string;
};

export type ParsedNote = {
  records: NoteRecord[];
  diagnostics: Diagnostic[];
  truncated: boolean;
  /**
   * Record lines skipped because their type is unknown to this build. They are
   * preserved bytes from an earlier or future version, never damage: a reader
   * reports the count but does not reject the note.
   */
  unknown: number;
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
  maxGraphVisits: number;
  maxDiagnostics: number;
  /** `from`/`to` endpoints on one lineage edge. */
  maxLineageRefs: number;
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
  maxGraphVisits: 131_072,
  maxDiagnostics: 32,
  maxLineageRefs: 64,
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
const LINEAGE_ID = /^lg:[0-9a-f]{40}$|^lg:[0-9a-f]{64}$/;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const RELATIONS = new Set<SourceRelation>([
  "caused-by", "constrained-by", "requested-by", "derived-from", "implements", "corroborated-by",
]);
const KINDS = new Set<SourceKind>(["commit", "blob", "tree", "path", "note", "git-email", "issue"]);
const EMAIL = /^[^\s@]+@[^\s@]+$/;

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

export function lineageId(value: string): LineageId {
  if (!LINEAGE_ID.test(value)) throw new Error(`Invalid lineage ID: ${value}`);
  return value as LineageId;
}

/** Parse the region descriptor for an exact source region. */
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

function normalizeRegion(region: RegionSubject): RegionSubject {
  if (region.kind !== "region") throw new Error("region.kind must be region");
  objectId(region.blob);
  const exact = trimText(region.exact_hash, "region.exact_hash");
  if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(exact)) {
    throw new Error("region.exact_hash must be a Git object hash");
  }
  if (!Number.isInteger(region.start_line_hint) || region.start_line_hint < 1) {
    throw new Error("region.start_line_hint must be a positive integer");
  }
  if (!Number.isInteger(region.end_line_hint) || region.end_line_hint < region.start_line_hint) {
    throw new Error("region.end_line_hint must be at least region.start_line_hint");
  }
  if (typeof region.prefix_hint !== "string" || typeof region.suffix_hint !== "string") {
    throw new Error("region hints must be strings");
  }
  return {
    kind: "region",
    blob: region.blob,
    exact_hash: exact,
    start_line_hint: region.start_line_hint,
    end_line_hint: region.end_line_hint,
    prefix_hint: region.prefix_hint,
    suffix_hint: region.suffix_hint,
  };
}

function normalizeSemantic(input: ReverieSemantic): ReverieSemantic {
  if (input.v !== 1) throw new Error("v must be exactly 1");
  const recurrence = input.recurrence_control === null
    ? null
    : recurrenceText(input.recurrence_control, "recurrence_control");
  const normalized: ReverieSemantic = {
    v: 1,
    driving_event: trimText(input.driving_event, "driving_event"),
    decision: trimText(input.decision, "decision"),
    impact: trimText(input.impact, "impact"),
    recurrence_control: recurrence,
    alternatives: sortedUnique(input.alternatives),
    sources: sortedUniqueSources(input.sources),
    supersedes: [...new Set(input.supersedes)].sort(compareUtf8),
  };
  if (input.region !== undefined && input.region !== null) normalized.region = normalizeRegion(input.region);
  return normalized;
}

export function semanticPayload(record: ReverieSemantic): string {
  const normalized = normalizeSemantic(record);
  // Region line numbers and surrounding-text hints are navigation only, so
  // they are excluded from the identity payload. Two records that name the
  // same blob bytes with different hints share one ID.
  const payload = normalized.region === undefined
    ? normalized
    : {
      ...normalized,
      region: {
        kind: normalized.region.kind,
        blob: normalized.region.blob,
        exact_hash: normalized.region.exact_hash,
      },
    };
  return JSON.stringify(payload);
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
  const id = `rv:${hashObject(Buffer.from(`${semanticPayload(semantic)}\n`, "utf8"))}` as ReverieId;
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

function endpointSort(left: LineageEndpoint, right: LineageEndpoint): number {
  return compareUtf8(`${left.path}\u0000${left.subject}`, `${right.path}\u0000${right.subject}`);
}

function occurrencePath(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a nonempty string`);
  const path = value.trim();
  if (path.startsWith("/") || /(^|\/)\.\.(\/|$)/.test(path)) throw new Error(`${field} must be repository-relative`);
  return path;
}

function normalizeEndpoints(
  endpoints: readonly LineageEndpoint[],
  field: string,
  limits: Readonly<ResourceLimits>,
): LineageEndpoint[] {
  if (!Array.isArray(endpoints)) throw new Error(`${field} must be an array`);
  checkArrayLength(endpoints, limits.maxLineageRefs, "maxLineageRefs", field);
  const normalized = endpoints.map((endpoint) => {
    if (!endpoint || typeof endpoint !== "object" || Array.isArray(endpoint)) {
      throw new Error(`${field} item must be an object`);
    }
    return {
      path: occurrencePath(endpoint.path, `${field} path`),
      subject: objectId(String(endpoint.subject)),
    };
  });
  normalized.sort(endpointSort);
  for (let index = 1; index < normalized.length; index += 1) {
    const previous = normalized[index - 1] as LineageEndpoint;
    const current = normalized[index] as LineageEndpoint;
    if (previous.path === current.path && previous.subject === current.subject) {
      throw new Error(`${field} lists the same endpoint twice: ${current.path}`);
    }
  }
  return normalized;
}

function lineageKind(value: unknown): LineageKind {
  if (typeof value !== "string" || !LINEAGE_KINDS.includes(value as LineageKind)) {
    throw new Error(`lineage kind must be one of ${LINEAGE_KINDS.join(", ")}; found ${String(value)}`);
  }
  return value as LineageKind;
}

/**
 * The declared shape of each kind. `derive` is the open N-to-M case, so a
 * relation that is neither a pure split nor a pure merge is still exactly
 * representable instead of being forced into the wrong word.
 */
function checkLineageShape(kind: LineageKind, from: number, to: number): void {
  if (from < 1) throw new Error("lineage from must name at least one occurrence");
  if (kind === "retire") {
    if (to !== 0) throw new Error(`a retire lineage edge must have no successor, found ${to}`);
    if (from !== 1) throw new Error(`a retire lineage edge must name exactly one occurrence, found ${from}`);
    return;
  }
  if (to < 1) throw new Error(`a ${kind} lineage edge must name at least one successor`);
  if (kind === "preserve" && (from !== 1 || to !== 1)) {
    throw new Error(`a preserve lineage edge must be one to one, found ${from} to ${to}`);
  }
  if (kind === "split" && (from !== 1 || to < 2)) {
    throw new Error(`a split lineage edge must be one to many, found ${from} to ${to}`);
  }
  if (kind === "merge" && (from < 2 || to !== 1)) {
    throw new Error(`a merge lineage edge must be many to one, found ${from} to ${to}`);
  }
}

function normalizeLineageSemantic(input: LineageSemantic, limits: Readonly<ResourceLimits>): LineageSemantic {
  if (input.v !== 1) throw new Error("v must be exactly 1");
  const kind = lineageKind(input.kind);
  const from = normalizeEndpoints(input.from, "lineage.from", limits);
  const to = normalizeEndpoints(input.to, "lineage.to", limits);
  checkLineageShape(kind, from.length, to.length);
  const recurrence = input.recurrence_control === null
    ? null
    : recurrenceText(input.recurrence_control, "recurrence_control");
  return {
    v: 1,
    kind,
    parent: commitId(String(input.parent)),
    commit: commitId(String(input.commit)),
    from,
    to,
    transition: input.transition === null ? null : transitionId(String(input.transition)),
    driving_event: trimText(input.driving_event, "driving_event"),
    decision: trimText(input.decision, "decision"),
    impact: trimText(input.impact, "impact"),
    recurrence_control: recurrence,
    alternatives: sortedUnique(input.alternatives),
    sources: sortedUniqueSources(input.sources),
  };
}

/**
 * Exact bytes hashed for a lineage identity: version, kind, the bound
 * parent→commit pair, both sorted endpoint sets, the optional transition link,
 * and normalized causal content. Endpoints are sorted, so the order an author
 * lists them in cannot change the ID.
 */
export function lineagePayload(record: LineageSemantic, limits: Partial<ResourceLimits> = {}): string {
  return JSON.stringify(normalizeLineageSemantic(record, resolveLimits(limits)));
}

export function createLineage(
  input: LineageInput,
  metadata: ReverieMetadata,
  hashObject: HashObject,
  limits: Partial<ResourceLimits> = {},
): LineageRecord {
  const resolved = resolveLimits(limits);
  const semantic = normalizeLineageSemantic(input, resolved);
  validateTimestamp(metadata.created_at, "created_at");
  const id = `lg:${hashObject(Buffer.from(`${JSON.stringify(semantic)}\n`, "utf8"))}` as LineageId;
  const record: LineageRecord = {
    ...semantic,
    type: "lineage",
    id,
    author_email: trimRef(metadata.author_email, "author_email", resolved),
    session: metadata.session === null ? null : trimRef(metadata.session, "session", resolved),
    created_at: metadata.created_at,
  };
  validateRecord(record, hashObject, resolved);
  return record;
}

/**
 * The canonical key order for one record. The `id` is the content hash of the
 * semantic payload, not of these bytes, so metadata such as `author_email`,
 * `session`, and `created_at` never changes an identity.
 */
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
      ...(semantic.region === undefined ? {} : { region: semantic.region }),
      author_email: trimText(record.author_email, "author_email"),
      session: record.session === null ? null : trimText(record.session, "session"),
      created_at: record.created_at,
    };
  }
  const semantic = normalizeLineageSemantic(record, DEFAULT_LIMITS);
  return {
    v: 1,
    type: "lineage",
    id: record.id,
    kind: semantic.kind,
    parent: semantic.parent,
    commit: semantic.commit,
    from: semantic.from,
    to: semantic.to,
    transition: semantic.transition,
    driving_event: semantic.driving_event,
    decision: semantic.decision,
    impact: semantic.impact,
    recurrence_control: semantic.recurrence_control,
    alternatives: semantic.alternatives,
    sources: semantic.sources,
    author_email: trimText(record.author_email, "author_email"),
    session: record.session === null ? null : trimText(record.session, "session"),
    created_at: record.created_at,
  };
}
export function canonicalRecord(record: NoteRecord): string {
  return `${JSON.stringify(canonicalRecordValue(record))}\n`;
}

const KNOWN_RECORD_TYPES = new Set<string>(["reverie", "lineage"]);
function asRecord(value: unknown): NoteRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("record must be a JSON object");
  const record = value as Record<string, unknown>;
  if (record.type === "reverie") return record as unknown as ReverieRecord;
  if (record.type === "lineage") return record as unknown as LineageRecord;
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
  if (value.kind === "commit" || value.kind === "blob" || value.kind === "tree") objectId(value.ref);
  else if (value.kind === "note") reverieId(value.ref);
  else if (value.kind === "git-email") validateEmail(value.ref, "source.ref", limits);
  // An `issue` source is an opaque external reference (kind, ref, relation,
  // optional timestamp). The core does not know GitHub, Linear, or Jira and
  // must not validate a tracker's grammar; a nonempty ref is the whole rule.
}

function validateLineage(
  record: LineageRecord,
  hashObject?: HashObject,
  limits: Readonly<ResourceLimits> = DEFAULT_LIMITS,
): void {
  if (!LINEAGE_ID.test(record.id)) throw new Error("invalid lineage ID");
  normalizeLineageSemantic(record, limits);
  if (!Array.isArray(record.alternatives) || !Array.isArray(record.sources)) {
    throw new Error("lineage arrays are required");
  }
  checkArrayLength(record.alternatives, limits.maxAlternatives, "maxAlternatives", "alternatives");
  checkArrayLength(record.sources, limits.maxSources, "maxSources", "sources");
  for (const alternative of record.alternatives) trimNarrative(alternative, "alternatives item", limits);
  for (const source of record.sources) validateSource(source, limits);
  trimNarrative(record.driving_event, "driving_event", limits);
  trimNarrative(record.decision, "decision", limits);
  trimNarrative(record.impact, "impact", limits);
  if (record.recurrence_control !== null) recurrenceText(record.recurrence_control, "recurrence_control", limits);
  validateEmail(record.author_email, "author_email", limits);
  if (record.session !== null) trimRef(record.session, "session", limits);
  validateTimestamp(record.created_at, "created_at");
  if (hashObject) {
    const expected = `lg:${hashObject(Buffer.from(`${lineagePayload(record, limits)}\n`, "utf8"))}`;
    if (expected !== record.id) throw new Error(`lineage ID mismatch: expected ${expected}, got ${record.id}`);
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
    if (record.region !== undefined) normalizeRegion(record.region);
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
  validateLineage(record, hashObject, limits);
}
export type ForkPolicy = "reject" | "project";

export type ValidateOptions = {
  hashObject?: HashObject;
  requireCanonical?: boolean;
  verifyIds?: boolean;
  limits?: Partial<ResourceLimits>;
  /**
   * How to treat unions that are structurally valid but forked: a conflicting
   * duplicate ID or a forked supersession. `reject` (the default) fails closed
   * so sync and mutation paths never accept damaged evidence; `project` keeps
   * every record so the projection can surface the conflict. Malformed bytes
   * and limit violations always throw.
   */
  forkPolicy?: ForkPolicy;
  /**
   * When true, a record whose type this build does not know is skipped and
   * preserved instead of rejected, in strict mode as well as tolerant mode.
   * This is the ref-wide read and write path: legacy bytes from an earlier
   * version must never block a mutation, a merge, or `doctor`. Malformed bytes
   * and invalid known records still fail.
   */
  ignoreUnknown?: boolean;
};

/**
 * Monotonic evidence union: set-union over canonical lines. Associative,
 * commutative, and idempotent by construction, so replica merge order never
 * changes the fact set. Earlier canonical lines are preserved verbatim;
 * no record is rewritten or discarded.
 */
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
  if (records.some((record) => record.type !== "reverie" && record.type !== "lineage")) {
    throw new Error("note contains a record type this build does not know");
  }
  const byId = new Map<ReverieId, string>();
  const lineagesById = new Map<LineageId, string>();
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
    if (record.type === "lineage") {
      chargeGraph(1 + record.from.length + record.to.length, "lineage graph");
      const payload = lineagePayload(record, limits);
      const previous = lineagesById.get(record.id);
      checkDuplicate(previous, payload, `conflicting duplicate lineage ID: ${record.id}`);
      lineagesById.set(record.id, payload);
      continue;
    }
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
  let unknown = 0;
  const pushDiagnostic = (diagnostic: Diagnostic): void => {
    if (diagnostics.length < limits.maxDiagnostics) diagnostics.push(diagnostic);
    else truncated = true;
  };
  if (text.length === 0) return { records, diagnostics, truncated, unknown };
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
      const raw: unknown = JSON.parse(line);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("record must be a JSON object");
      const type = (raw as { type?: unknown }).type;
      // Lean readers keep unknown bytes (legacy or future records) untouched
      // and never interpret them. They are preserved and counted, never
      // rejected on the ref-wide path (`ignoreUnknown`); strict mode without
      // that option still refuses a record this build cannot validate.
      if (typeof type !== "string" || !KNOWN_RECORD_TYPES.has(type)) {
        if (options.ignoreUnknown === true || mode === "tolerant") {
          unknown += 1;
          continue;
        }
        throw new Error(`unknown record type: ${String(type)}`);
      }
      const parsed = asRecord(raw);
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
  return { records, diagnostics, truncated, unknown };
}

/**
 * The visible state of a set of reverie records: active, historical, and the
 * structural anomalies (duplicate IDs, forks, cycles) a reader must not ignore.
 */
export type ActiveProjection = {
  active: ReverieRecord[];
  historical: ReverieRecord[];
  duplicates: ReverieId[];
  forks: ReverieId[][];
  cycles: ReverieId[][];
  conflicts?: ReverieId[];
};

function projectionSemanticKey(record: ReverieRecord): string {
  return JSON.stringify({
    v: record.v,
    driving_event: record.driving_event,
    decision: record.decision,
    impact: record.impact,
    recurrence_control: record.recurrence_control,
    alternatives: record.alternatives,
    sources: record.sources,
    supersedes: record.supersedes,
  });
}

/**
 * Project the active state of reveries. A supersession edge makes its
 * predecessor historical; a record no other record supersedes is active.
 * Pure: pass already-loaded records, in any order.
 */
export function projectActiveReveries(records: readonly ReverieRecord[]): ActiveProjection {
  const byId = new Map<ReverieId, ReverieRecord>();
  const duplicateIds = new Set<ReverieId>();
  const conflictIds = new Set<ReverieId>();
  for (const record of records) {
    const existing = byId.get(record.id);
    if (existing === undefined) {
      byId.set(record.id, record);
      continue;
    }
    if (projectionSemanticKey(existing) === projectionSemanticKey(record)) duplicateIds.add(record.id);
    else conflictIds.add(record.id);
  }

  const children = new Map<ReverieId, ReverieId[]>();
  const superseded = new Set<ReverieId>();
  for (const record of byId.values()) {
    for (const predecessor of record.supersedes) {
      superseded.add(predecessor);
      const list = children.get(predecessor) ?? [];
      list.push(record.id);
      children.set(predecessor, list);
    }
  }

  const active = [...byId.values()]
    .filter((record) => !superseded.has(record.id))
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const historical = [...byId.values()]
    .filter((record) => superseded.has(record.id))
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const forks: ReverieId[][] = [];
  for (const predecessor of children.keys()) {
    const terminals = new Set<ReverieId>();
    const visitedDescendants = new Set<ReverieId>();
    const collectTerminals = (id: ReverieId): void => {
      if (visitedDescendants.has(id)) return;
      visitedDescendants.add(id);
      const descendants = children.get(id) ?? [];
      if (descendants.length === 0) {
        terminals.add(id);
        return;
      }
      for (const descendant of descendants) collectTerminals(descendant);
    };
    for (const child of children.get(predecessor) ?? []) collectTerminals(child);
    if (terminals.size > 1) forks.push([predecessor, ...[...terminals].sort()]);
  }

  const cycles: ReverieId[][] = [];
  const visited = new Set<ReverieId>();
  const activePath = new Map<ReverieId, number>();
  const walk = (id: ReverieId, path: ReverieId[]): void => {
    const position = activePath.get(id);
    if (position !== undefined) {
      cycles.push(path.slice(position).concat(id));
      return;
    }
    if (visited.has(id)) return;
    const record = byId.get(id);
    if (record === undefined) {
      visited.add(id);
      return;
    }
    activePath.set(id, path.length);
    for (const predecessor of record.supersedes) walk(predecessor, [...path, id]);
    activePath.delete(id);
    visited.add(id);
  };
  for (const id of byId.keys()) walk(id, []);

  return {
    active,
    historical,
    duplicates: [...duplicateIds].sort(),
    forks,
    cycles,
    ...(conflictIds.size === 0 ? {} : { conflicts: [...conflictIds].sort() }),
  };
}
