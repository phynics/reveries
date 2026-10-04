import { access, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  blobId,
  canonicalRecord,
  classifySignature,
  commitId,
  correctionPayload,
  createAttestation,
  createSignature,
  createCorrection,
  createLedgerManifest,
  createLineage,
  createOccurrence,
  createRedaction,
  createResolution,
  createReverie,
  createTransition,
  createEvidenceSnapshot,
  LEDGER_REF,
  lineageId,
  lineagePayload,
  NOTES_REF,
  objectId,
  occurrenceId,
  occurrencePayload,
  parseLedgerManifest,
  parseNote,
  projectActiveReveries,
  readLedgerManifest,
  redactionPayload,
  recordFactId,
  REMOTE_ROLE_CONFIG_PATTERN,
  parseRemoteRoleConfigLines,
  resolutionPayload,
  resolveAuthorityRoles,
  resolveLimits,
  rolePromotion,
  rolePublishable,
  roleSyncSource,
  semanticPayload,
  SIGNATURE_DOMAIN_MANIFEST,
  SIGNATURE_DOMAIN_RECORD,
  SIGNATURE_ROLES,
  signingPayload,
  transitionId,
  transitionPayload,
  validateNote,
  type ActiveProjection,
  type AuthorityResolution,
  type AuthorityState,
  type BlobId,
  type CommitId,
  type CorrectionId,
  type CorrectionInput,
  type CorrectionRecord,
  type Diagnostic,
  type EvidenceSnapshot,
  type FactTargetId,
  type LedgerManifest,
  ledgerManifestPayload,
  type LineageEndpoint,
  type LineageId,
  type LineageInput,
  type LineageKind,
  type LineageRecord,
  type NoteRecord,
  type ObjectId,
  type OccurrenceCoordinate,
  type OccurrenceId,
  type OccurrenceInput,
  type OccurrenceRecord,
  type PublicationAttestation,
  type RedactionId,
  type RedactionInput,
  type RedactionRecord,
  type RegionSubject,
  type RemoteRole,
  type ResolutionId,
  type ResolutionInput,
  type ResolutionRecord,
  type ResourceLimits,
  type ReverieId,
  type ReverieInput,
  type ReverieMetadata,
  type ReverieRecord,
  type ReveriesInit,
  type SessionSummary,
  type SignatureId,
  type SignatureRecord,
  type SignatureRole,
  type SignatureTrustReport,
  type SigningPolicy,
  type Source,
  type SubjectId,
  type SummaryEntry,
  type TrustState,
  type TransitionCausal,
  type TransitionId,
  type TransitionInput,
  type TransitionMetadata,
  type TransitionSummary,
  type TrustStore,
  reverieId,
} from "./protocol.ts";
import { suggestLineage, type LineageSuggestion } from "./lineage.ts";
import {
  GitRepository,
  cloneEvidenceGrade,
  hashBlobContent,
  LEDGER_MANIFEST_PATH,
  LEDGER_NOTES_PATH,
  LEDGER_SIGNATURES_PATH,
  LEDGER_SIGNATURE_TIMESTAMP,
  matchTrackingRefRemote,
  RETENTION_REF,
  SnapshotIndexCorruptError,
  type CompletenessGrade,
  type NoteListEntry,
  type NotesTransaction,
  type RetentionSubject,
  type SignatureSigner,
  type SignatureVerifier,
  type WithNotesWriteOptions,
} from "./git.ts";

export interface RecordTarget {
  readonly path: string;
  readonly revision: "HEAD" | "index" | string;
}

export interface RecordNewInput extends RecordTarget {
  readonly semantic: ReverieInput;
  readonly metadata: ReverieMetadata;
  /**
   * Optional arbitrary-region scope. The selected lines are hashed into the
   * region fingerprint; line numbers are stored as hints only.
   */
  readonly region?: { readonly start_line: number; readonly end_line: number };
}

export interface RecordResult {
  readonly object: ObjectId;
  readonly record: ReverieRecord;
  readonly paths: readonly string[];
}

/**
 * A record about one occurrence rather than about content (RVR-014). The
 * caller names a path and a revision; the coordinate is resolved here so the
 * stored record cannot claim a subject the repository does not have there.
 */
export interface RecordOccurrenceInput {
  readonly path: string;
  readonly revision: "HEAD" | "index" | string;
  readonly semantic: OccurrenceInput;
  readonly metadata: ReverieMetadata;
}

export interface OccurrenceResult {
  readonly object: ObjectId;
  readonly record: OccurrenceRecord;
  readonly occurrence: OccurrenceCoordinate;
  /** Every current path of the same subject, for the disclosure in the CLI. */
  readonly paths: readonly string[];
}

/**
 * A durable subject pairing (RVR-014). Endpoints are given as paths, never as
 * hand-typed object IDs: the subject at each path is resolved in the revision
 * the edge is bound to, so an edge cannot claim a pairing the repository does
 * not contain.
 */
export interface RecordLineageInput {
  readonly kind: LineageKind;
  readonly parent: string;
  readonly commit: string;
  readonly from: readonly string[];
  readonly to: readonly string[];
  readonly transition?: TransitionId | null;
  readonly semantic: {
    readonly driving_event: string;
    readonly decision: string;
    readonly impact: string;
    readonly recurrence_control: string | null;
    readonly alternatives: string[];
    readonly sources: Source[];
  };
  readonly metadata: ReverieMetadata;
}

export interface LineageResult {
  readonly commit: CommitId;
  readonly record: LineageRecord;
  readonly from: readonly LineageEndpoint[];
  readonly to: readonly LineageEndpoint[];
}

export interface LinkInput {
  readonly kind: LineageKind;
  readonly commit: string;
  readonly parent: string;
  readonly from: readonly string[];
  readonly to: readonly string[];
  readonly semantic: RecordLineageInput["semantic"];
  readonly metadata: ReverieMetadata;
}

export interface LinkResult {
  readonly record: LineageRecord;
  readonly from: readonly LineageEndpoint[];
  readonly to: readonly LineageEndpoint[];
  /** Every note that received the immutable lineage record. */
  readonly subjects: readonly ObjectId[];
}

/**
 * Whether a lineage edge may act as the pairing authority for one checked
 * change (RVR-014).
 *
 * - `authoritative`: the edge is bound to exactly this parent and result
 *   commit, and every endpoint it names is part of that change.
 * - `history`: the edge describes some other change. It is evidence for path
 *   history and never authority for a check.
 * - `contradictory`: the edge claims this exact change while naming an
 *   endpoint that is not part of it. Fail closed: a wrong pairing is worse
 *   than a missing one.
 */
export type LineageAuthority = "authoritative" | "history" | "contradictory";

export type LineageUse = {
  readonly id: LineageId;
  readonly authority: LineageAuthority;
  readonly detail: string;
};

/** How a lineage edge was treated by one check, for evidence and for tests. */
export interface LineageUseReport {
  readonly used: readonly LineageUse[];
  readonly historyOnly: readonly LineageId[];
}

/**
 * One remote-side action a hard redaction cannot perform itself (RVR-018).
 *
 * The local rewrite is the only part Reveries can carry out. A mirror, an
 * archive, and every independent clone are outside this repository's reach, so
 * the operation names the action it requires instead of reporting success it
 * cannot know about.
 */
export interface HardRedactionRemoteAction {
  readonly remote: string;
  /** The declared role, or `unassigned` when configuration declares none. */
  readonly role: RemoteRole | "unassigned";
  /** Human-readable command an operator runs against that remote. */
  readonly action: string;
}

export interface HardRedactionResult extends CheckResult {
  readonly state: "redacted" | "unchanged" | "refused";
  /** Fact IDs removed from the canonical notes snapshot. */
  readonly removed: readonly FactTargetId[];
  /** Subjects whose notes were rewritten because they carried a removed fact. */
  readonly rewrittenSubjects: readonly ObjectId[];
  readonly notesBefore: ObjectId | null;
  readonly notesAfter: ObjectId | null;
  readonly ledgerBefore: ObjectId | null;
  /** New genesis ledger checkpoint over the sanitized snapshot, or null. */
  readonly ledgerAfter: ObjectId | null;
  /** Local refs deleted because they still pointed at the removed history. */
  readonly severedRefs: readonly string[];
  /** Mirror, archive, and remote-side follow-up this repository cannot perform. */
  readonly remoteActions: readonly HardRedactionRemoteAction[];
  /** Always stated: local completion is never proof of distributed deletion. */
  readonly disclaimer: string;
}

export interface ShowInput {
  readonly target: string;
  readonly revision?: "HEAD" | "index" | string;
  /**
   * Include soft-redacted facts in normal display. Default false: redacted
   * facts stay in history and snapshot bytes but leave records/active.
   */
  readonly includeRedacted?: boolean;
}

export interface ShowResult {
  readonly object: ObjectId;
  readonly objectType: string;
  readonly records: readonly NoteRecord[];
  readonly active: readonly ReverieRecord[];
  readonly historical: readonly ReverieRecord[];
  readonly diagnostics: readonly string[];
  readonly paths: readonly string[];
  readonly completeness: CompletenessInfo;
  /** Lineage edges that name this subject as a predecessor or successor. */
  readonly lineage: readonly LineageRecord[];
}

export interface CheckResult {
  readonly ok: boolean;
  readonly diagnostics: readonly string[];
}

export type SyncConflictType =
  | "duplicate-session-summary"
  | "multiple-initialization-boundaries"
  | "secret-material"
  | "invalid-source"
  | "invalid-projection"
  | "invalid-object-attachment"
  | "invalid-record";

export interface SyncConflictRecord {
  readonly recordId: string | null;
  readonly canonicalLine: string;
  readonly origins: readonly [
    "local" | "remote",
    ...("local" | "remote")[],
  ];
}

export type SyncResolutionAction =
  | { readonly kind: "inspect-quarantine"; readonly ref: string }
  | { readonly kind: "construct-replacement-candidate"; readonly sourceRef: string }
  | { readonly kind: "retry-sync"; readonly remote: string };

export interface SyncConflict {
  readonly kind: "invalid-notes-union";
  readonly conflictType: SyncConflictType;
  readonly message: string;
  readonly annotatedObject: ObjectId | null;
  readonly records: readonly SyncConflictRecord[];
  readonly provenance: {
    readonly localNotes: ObjectId | null;
    readonly remoteNotes: ObjectId;
    readonly candidate: ObjectId;
    readonly quarantineRef: string;
  };
  readonly resolutionActions: readonly SyncResolutionAction[];
}

export type SyncResult =
  | {
      readonly ok: true;
      readonly diagnostics: readonly string[];
      readonly state: "fetched" | "remote-notes-absent";
      readonly conflicts: readonly [];
      /**
       * The ref a valid but unpromoted candidate was preserved at, or null when
       * the sync promoted into canonical state (RVR-017).
       */
      readonly quarantineRef?: string | null;
    }
  | {
      readonly ok: false;
      readonly diagnostics: readonly string[];
      readonly state: "fetched";
      readonly conflicts: readonly SyncConflict[];
      readonly quarantineRef?: string | null;
    };

export interface DoctorResult extends CheckResult {
  readonly state: "healthy" | "damaged";
  readonly notices: readonly string[];
  readonly retention: RetentionStatus;
}

/**
 * How the ledger envelope relates to local state. The four states are
 * deliberately distinct so a healthy repository that simply has not published
 * its newest notes is never reported as damaged.
 */
export type LedgerState = "absent" | "valid" | "stale" | "invalid";

export interface LedgerStatus {
  readonly state: LedgerState;
  /** The ledger branch tip, or null when no checkpoint exists. */
  readonly tip: ObjectId | null;
  /** The notes commit the verified envelope transports. */
  readonly notesCommit: ObjectId | null;
  /** The current local notes tip, which may lead the envelope. */
  readonly notesTip: ObjectId | null;
  readonly previousLedger: ObjectId | null;
  readonly retentionCommit: ObjectId | null;
  readonly annotatedSubjects: number;
  readonly diagnostics: readonly string[];
}

export interface LedgerCheckpointResult extends CheckResult {
  readonly state: "created" | "unchanged" | "refused";
  readonly checkpoint: ObjectId | null;
  readonly previousLedger: ObjectId | null;
  readonly notesTip: ObjectId | null;
}

export interface LedgerMaterializeResult extends CheckResult {
  readonly state: "materialized" | "unchanged";
  readonly notesTip: ObjectId | null;
}

/**
 * Signing material, all optional (RVR-009). A repository that never signs
 * configures nothing and every signature operation reports `unavailable`
 * rather than failing.
 */
export interface SigningOptions {
  /** Signs canonical payloads. Absent means this repository cannot sign. */
  readonly signer?: SignatureSigner;
  /** Verifies signatures. Absent means no signature can be trusted here. */
  readonly verifier?: SignatureVerifier;
  /** Public key material and revocation. Absent means every key is unknown. */
  readonly trust?: TrustStore;
  /**
   * Roles a policy requires, normally from `reveries.signingRoles`. Absent or
   * empty means no signature can reach `policy-satisfying`; `trusted` is the
   * honest ceiling.
   */
  readonly requiredRoles?: readonly SignatureRole[];
}

export type TrustStateCounts = Readonly<Record<TrustState, number>>;

export interface SignatureTrustEntry {
  readonly id: string;
  readonly target: string;
  readonly subject: string;
  readonly signer: string;
  readonly keyId: string;
  readonly role: SignatureRole;
  readonly state: TrustState;
  readonly diagnostics: readonly string[];
}

export interface SignRecordResult extends CheckResult {
  readonly state: "signed" | "unavailable";
  readonly record: SignatureRecord | null;
}

/**
 * How signing relates to local evidence (RVR-009). The states mirror
 * `LedgerState`: `absent` and `unknown` are ordinary and never damage, and
 * only `invalid` or `revoked` attestations are diagnostics. A repository that
 * has not adopted signing must never be reported as broken.
 */
export interface SignatureStatus {
  readonly state: "absent" | "unsigned" | "signed";
  /** Count per trust state, so a reader sees all four required states. */
  readonly counts: TrustStateCounts;
  /** The ledger checkpoint tip, or null when no checkpoint exists. */
  readonly checkpoint: ObjectId | null;
  /** True when the checkpoint's manifest carries a verifying signature. */
  readonly checkpointSigned: boolean;
  /** Roles the current policy requires. */
  readonly requiredRoles: readonly SignatureRole[];
  readonly diagnostics: readonly string[];
}

export interface DoctorProtection {
  readonly helper: "available" | "unavailable";
  readonly local: "complete" | "partial" | "not-configured";
  readonly receiveSide: "unknown";
}

/**
 * How authoritative publication is configured (RVR-017).
 *
 * The states mirror `LedgerState` and `SignatureStatus` on purpose: `absent`,
 * `inferred`, and `unconfigured` are all ordinary, so a repository that never
 * adopted roles, or that has a single publisher, is never reported as broken.
 * Only `invalid` means the configuration contradicts itself, and only it
 * contributes diagnostics.
 */
export interface AuthorityStatus {
  readonly state: AuthorityState;
  /** The single authoritative remote, or null when none is determined. */
  readonly primary: string | null;
  /** Every declared role, keyed by remote name, for reporting. */
  readonly roles: ReadonlyMap<string, RemoteRole>;
  /** Why there is no primary, or which remote is authoritative. */
  readonly notice: string;
  readonly diagnostics: readonly string[];
}

/**
 * How one configured mirror relates to the primary checkpoint (RVR-017).
 *
 * A mirror is a replica, so the states are about agreement: `unavailable` means
 * the mirror's envelope has not been fetched and is a notice, `unsigned` means
 * the primary is unsigned so the stronger check could not run, and only
 * `divergent` and `authority-mismatch` are damage.
 */
export type MirrorState = "matching" | "unavailable" | "unsigned" | "divergent" | "authority-mismatch";

export interface MirrorStatus {
  readonly remote: string;
  readonly state: MirrorState;
  /** The mirror's remote-tracking checkpoint, or null when it was never fetched. */
  readonly checkpoint: ObjectId | null;
  /** The trust state of the mirror's own manifest signature, when it has one. */
  readonly signature: TrustState | null;
  readonly diagnostics: readonly string[];
}

/**
 * What every hard-redaction result states about its own reach.
 *
 * The wording is fixed because it is the claim that matters: the local rewrite
 * is complete and auditable, and deletion everywhere else is still unproven.
 */
export const HARD_REDACTION_DISCLAIMER =
  "Local hard redaction removed the named facts from this repository's refs and retention paths. "
  + "Independent clones, bundles, mirrors, archives, caches, and backups may still hold the bytes; "
  + "deletion outside this repository is not guaranteed and must be requested and verified separately.";

/** Stable UTF-8 byte ordering for ID and ref lists, matching the protocol rule. */
function compareUtf8Ids(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}

/**
 * Refs a hard redaction may delete because they hold a copy of the evidence:
 * fetched remote-tracking notes, fetched remote-tracking envelopes, and held
 * quarantine candidates. Ordinary remote-tracking *code* branches are excluded
 * because they are code, not evidence.
 */
function isStaleEvidenceRef(ref: string): boolean {
  return (ref.startsWith("refs/notes/remotes/") && ref.endsWith("/reveries"))
    || /^refs\/remotes\/.+\/reveries-ledger$/.test(ref)
    || ref.startsWith("refs/reveries/quarantine/");
}

export const RETENTION_POLICIES = ["none", "active", "all", "archive"] as const;
export type RetentionPolicy = (typeof RETENTION_POLICIES)[number];

export interface RetentionStatus {
  readonly policy: RetentionPolicy;
  readonly state: "absent" | "current" | "incomplete";
  /** Annotated subjects the policy selects, sorted. */
  readonly expected: readonly ObjectId[];
  /** Annotated subjects the vault currently keeps, sorted. */
  readonly retained: readonly ObjectId[];
  /** Selected subjects the vault does not keep. */
  readonly missing: readonly ObjectId[];
}

export interface RetentionResult extends RetentionStatus {
  readonly changed: boolean;
}

export interface PushUpdate {
  readonly localRef: string;
  readonly localObject: ObjectId | null;
  readonly remoteRef: string;
  readonly remoteObject: ObjectId | null;
}

export interface SearchInput {
  readonly query?: string;
  readonly source?: string;
  readonly author?: string;
  readonly all?: boolean;
  readonly revision?: string;
  /**
   * Opt out of the strict default: return whatever the incomplete local view
   * holds, graded, instead of throwing `IncompleteEvidenceError`. Reads never
   * fetch either way; only explicit sync/fetch commands touch the network.
   */
  readonly allowIncomplete?: boolean;
  /**
   * Include soft-redacted facts in search hits. Default false: redacted
   * facts stay in history and snapshot bytes but leave search results.
   */
  readonly includeRedacted?: boolean;
}

export interface SearchHit {
  readonly object: ObjectId;
  readonly record: NoteRecord;
  readonly paths: readonly string[];
  /**
   * The coordinate an occurrence record is about (RVR-014), so a hit is never
   * read as "applies everywhere this content occurs".
   */
  readonly occurrence?: OccurrenceCoordinate;
  /**
   * False when the occurrence's own coordinate no longer holds this subject in
   * the searched revision. The record is still reported — with its anchor —
   * but it is historical evidence, not a claim about the current paths.
   */
  readonly applicable?: boolean;
}

/**
 * How authoritative the local evidence behind a result is. Any grade other
 * than `complete` means the result must not be read as proof that evidence
 * does not exist.
 */
export interface CompletenessInfo {
  readonly grade: CompletenessGrade;
  readonly reasons: readonly string[];
  /** True only when every reachable evidence object was examined locally. */
  readonly authoritative: boolean;
}

export interface SearchResult {
  readonly hits: readonly SearchHit[];
  readonly completeness: CompletenessInfo;
}

export interface HistoryOptions {
  readonly allowIncomplete?: boolean;
}

/** Thrown instead of reporting incomplete local state as evidence absence. */
export class IncompleteEvidenceError extends Error {
  readonly completeness: CompletenessInfo;

  constructor(completeness: CompletenessInfo, detail?: string) {
    const suffix = detail === undefined ? "" : `: ${detail}`;
    super(
      `incomplete-evidence ${completeness.grade}${suffix}; ${completeness.reasons.join("; ")}`,
    );
    this.name = "IncompleteEvidenceError";
    this.completeness = completeness;
  }
}

export interface HistoryEntry {
  readonly commit: CommitId;
  /** Legacy blob slot; `subject` and `subjectType` are authoritative for trees. */
  readonly blob: BlobId;
  readonly records: readonly NoteRecord[];
  /** The subject found at `path` in `commit`, blob or tree (RVR-014). */
  readonly subject?: ObjectId;
  /** The path this entry describes, which follows a rename through lineage. */
  readonly path?: string;
  readonly subjectType?: string;
  /** The durable edge that carried this coordinate from its predecessor. */
  readonly viaLineage?: LineageId;
}

export interface HostedSummaryInput {
  readonly commit: string;
  readonly sourceCommits: readonly string[];
}

export type HostedSummaryPlanState = "ready" | "already-summarized" | "unsummarizable";

export interface HostedSummaryPlan {
  readonly commit: CommitId;
  readonly state: HostedSummaryPlanState;
  readonly entries: readonly SummaryEntry[];
  readonly diagnostics: readonly string[];
}

export interface AttachHostedSummaryInput {
  readonly commit: string;
  readonly summary: SessionSummary;
}

export type AttachHostedSummaryState = "attached" | "already-summarized";

export interface AttachHostedSummaryResult {
  readonly commit: CommitId;
  readonly state: AttachHostedSummaryState;
  readonly summary: SessionSummary;
  readonly diagnostics: readonly string[];
}

/** Resolved tree pair behind a transition identity. */
export interface TransitionTrees {
  /** Ordered parent trees (`[]` for a root commit); order is significant. */
  readonly parents: readonly ObjectId[];
  readonly result: ObjectId;
}

export type TransitionCoverage = "transition" | "v1-summary" | "none";

export interface TransitionCheckResult extends CheckResult {
  readonly coverage: TransitionCoverage;
  readonly transition: TransitionId | null;
}

export interface PublishNotesInput {
  readonly remote: string;
  readonly attempts?: number;
}

export interface PublishNotesResult {
  readonly ok: boolean;
  readonly attempts: number;
  readonly remoteTip: ObjectId | null;
  readonly diagnostics: readonly string[];
}

interface DiffTransition {
  readonly from: ObjectId;
  readonly to?: ObjectId;
  readonly oldPath?: string;
  readonly newPath?: string;
}

class NotesRefValidationError extends Error {
  constructor(
    readonly annotatedObject: ObjectId,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "NotesRefValidationError";
  }
}

/**
 * The staged gate has no commit note to read, so it cannot see a durable
 * lineage edge or a retirement. Rather than inventing a transient green, the
 * diagnostic names the route that does close the obligation and the gates where
 * that evidence exists.
 */
const STAGED_ROUTE_GUIDANCE = "Record this change, then record its lineage edge on that commit "
  + "(reveries lineage record --parent <parent> --commit <commit> --from <path> --to <path>) together with "
  + "a per-decision continuation, supersession, or causal retirement, and re-check the committed, "
  + "outgoing, and receive gates.";

function isFullObjectId(value: string): boolean {
  return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value);
}

function noteLines(note: string | null): readonly string[] {
  if (note === null) return [];
  return note.endsWith("\n") ? note.slice(0, -1).split("\n") : note.split("\n");
}

function recordIdFromCanonicalLine(line: string): string | null {
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value !== "object" || value === null || !("id" in value)) return null;
    return typeof value.id === "string" ? value.id : null;
  } catch {
    return null;
  }
}

function recordOrigins(
  canonicalLine: string,
  localLines: ReadonlySet<string>,
  remoteLines: ReadonlySet<string>,
): SyncConflictRecord["origins"] {
  const local = localLines.has(canonicalLine);
  const remote = remoteLines.has(canonicalLine);
  if (local && remote) return ["local", "remote"];
  if (local) return ["local"];
  if (remote) return ["remote"];
  throw new Error("A candidate record has neither local nor remote provenance");
}

function syncConflictType(message: string): SyncConflictType {
  if (/likely secret material/i.test(message)) return "secret-material";
  if (/more than one session summary/i.test(message)) return "duplicate-session-summary";
  if (/more than one Reveries initialization boundary/i.test(message)) {
    return "multiple-initialization-boundaries";
  }
  if (/source|referenced reverie|path source/i.test(message)) return "invalid-source";
  if (/supersession|conflicting duplicate/i.test(message)) return "invalid-projection";
  if (/attached|protocol records cannot be attached/i.test(message)) return "invalid-object-attachment";
  return "invalid-record";
}

/**
 * One Git-detected similarity candidate. Only the suggestion surface parses
 * these; the authoritative transition parser never sees a rename.
 */
type SimilarityCandidate = {
  readonly from: { readonly path: string; readonly subject: SubjectId };
  readonly to: { readonly path: string; readonly subject: SubjectId };
  readonly score: number;
};

/**
 * Parse `diff --raw -M` output into similarity candidates. Git's status field
 * carries the score (`R095`, `C080`), which is kept as data rather than as a
 * decision: the caller may only propose.
 */
export function parseSimilarityCandidates(raw: string): readonly SimilarityCandidate[] {
  const fields = raw.split("\0");
  const candidates: SimilarityCandidate[] = [];
  let index = 0;
  while (index < fields.length) {
    const header = fields[index];
    if (header === undefined || header.length === 0) break;
    index += 1;
    const parts = header.split(" ");
    const oldValue = parts[2];
    const newValue = parts[3];
    const status = parts[4] ?? "";
    if (oldValue === undefined || newValue === undefined) throw new Error("Malformed Git raw diff header");
    const oldPath = fields[index];
    const paired = /^([RC])\d*$/.test(status);
    const newPath = paired ? fields[index + 1] : oldPath;
    index += paired ? 2 : 1;
    if (!paired || oldPath === undefined || newPath === undefined) continue;
    if (zeroObject(oldValue) || zeroObject(newValue)) continue;
    if (!isFullObjectId(oldValue) || !isFullObjectId(newValue)) {
      throw new Error("Git diff returned an abbreviated object ID for a rename candidate");
    }
    const score = Number.parseInt(status.slice(1), 10);
    candidates.push({
      from: { path: normalizeCoordinatePath(oldPath), subject: objectId(oldValue) },
      to: { path: normalizeCoordinatePath(newPath), subject: objectId(newValue) },
      score: Number.isNaN(score) ? 100 : score,
    });
  }
  return candidates;
}

function zeroObject(value: string): boolean {
  return /^0+$/.test(value);
}

/**
 * The path as a coordinate stores it: repository-relative and without a
 * leading `./`, so two spellings of one location cannot produce two
 * coordinates that claim to be different occurrences.
 */
function normalizeCoordinatePath(path: string): string {
  return path.replace(/^\.\//, "");
}

export function coordinateKey(commit: string, path: string, subject: string): string {
  return `${commit}\u0000${normalizeCoordinatePath(path)}\u0000${subject}`;
}
/**
 * How a coordinate relates to earlier ones, built from durable lineage edges:
 * one entry per edge endpoint, pointing back at the coordinates that edge says
 * this one came from.
 */
export type OccurrenceDerivation = ReadonlyMap<
  string,
  readonly { readonly coordinate: OccurrenceCoordinate; readonly lineage: LineageId }[]
>;

/**
 * The edges that derive `anchor` into `from`, walking backwards through
 * explicit lineage only. Empty means nothing derives it, which is the honest
 * answer for a path that only ever shared a blob: no edge, no applicability.
 *
 * Every edge on every path from `from` back to `anchor` is reported, so a
 * multi-hop chain names each link rather than only the farthest one.
 */
export function deriveLineage(
  derivation: OccurrenceDerivation,
  from: OccurrenceCoordinate,
  anchor: OccurrenceCoordinate,
): readonly LineageId[] {
  const target = coordinateKey(anchor.commit, anchor.path, anchor.subject);
  const settled = new Map<string, boolean>();
  const used = new Set<LineageId>();
  const walk = (coordinate: OccurrenceCoordinate): boolean => {
    const key = coordinateKey(coordinate.commit, coordinate.path, coordinate.subject);
    if (key === target) return true;
    const known = settled.get(key);
    if (known !== undefined) return known;
    settled.set(key, false);
    let found = false;
    for (const step of derivation.get(key) ?? []) {
      if (walk(step.coordinate)) {
        used.add(step.lineage);
        found = true;
      }
    }
    settled.set(key, found);
    return found;
  };
  walk(from);
  return [...used].sort();
}

function allSources(record: NoteRecord): readonly Source[] {
  if (record.type === "reverie") {
    return record.sources;
  }
  if (record.type === "correction" || record.type === "resolution") {
    return record.sources;
  }
  if (record.type === "transition-summary") {
    return record.sources;
  }
  if (record.type === "occurrence" || record.type === "lineage") {
    return record.sources;
  }
  if (record.type === "session-summary") {
    return record.entries.flatMap((entry) => entry.sources);
  }
  return [];
}

function recordAuthor(record: NoteRecord): string {
  return record.author_email;
}

function searchText(record: NoteRecord): string {
  return JSON.stringify(record).toLocaleLowerCase();
}

function emptySummary(): SessionSummary {
  return {
    v: 1,
    type: "session-summary",
    author_email: "continuity-check@localhost",
    session: null,
    created_at: "1970-01-01T00:00:00Z",
    entries: [{
      driving_event: "Staged continuity analysis.",
      decision: "Analyze dispositions before commit.",
      impact: "No commit summary exists yet.",
      recurrence_control: null,
      alternatives: [],
      sources: [],
      reveries: [],
      retirements: [],
    }],
  };
}

export interface SnapshotNoteEntry {
  readonly object: ObjectId;
  readonly records: readonly NoteRecord[];
  readonly projection: ActiveProjection;
  readonly objectType: string;
  /** Null when the note parses, validates, and projects cleanly; otherwise the first failure. */
  readonly error: string | null;
  readonly snapshot: EvidenceSnapshot;
}

export interface SnapshotStats {
  readonly notesListed: number;
  readonly notesRead: number;
  readonly bytesRead: number;
  readonly notesParsed: number;
  readonly indexHit: boolean;
}

export interface EvidenceSnapshotView {
  readonly tip: ObjectId | null;
  readonly entries: readonly SnapshotNoteEntry[];
  readonly byId: ReadonlyMap<ReverieId, { readonly record: NoteRecord; readonly object: ObjectId }>;
  /** Lineage edges indexed by the commit whose note carries them. */
  readonly lineages: ReadonlyMap<CommitId, readonly LineageRecord[]>;
  readonly diagnostics: readonly Diagnostic[];
  readonly diagnosticsTruncated: boolean;
  readonly limits: Readonly<ResourceLimits>;
  readonly stats: SnapshotStats;
}

export interface SnapshotLoadOptions {
  readonly ref?: string;
  readonly limits?: Partial<ResourceLimits>;
}

interface SnapshotIndexPayload {
  readonly v: 1;
  readonly tip: string;
  readonly bodies: readonly { readonly object: string; readonly body: string | null }[];
}

function emptySnapshotView(limits: Readonly<ResourceLimits>): EvidenceSnapshotView {
  return {
    tip: null,
    entries: [],
    byId: new Map(),
    lineages: new Map(),
    diagnostics: [],
    diagnosticsTruncated: false,
    limits,
    stats: { notesListed: 0, notesRead: 0, bytesRead: 0, notesParsed: 0, indexHit: false },
  };
}

function parseSnapshotIndexPayload(raw: string, tip: ObjectId): SnapshotIndexPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SnapshotIndexCorruptError(tip);
  }
  if (
    !parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || (parsed as { v?: unknown }).v !== 1
    || (parsed as { tip?: unknown }).tip !== tip
    || !Array.isArray((parsed as { bodies?: unknown }).bodies)
  ) {
    throw new SnapshotIndexCorruptError(tip);
  }
  const bodies = (parsed as SnapshotIndexPayload).bodies;
  for (const entry of bodies) {
    if (
      !entry || typeof entry !== "object"
      || typeof entry.object !== "string"
      || (typeof entry.body !== "string" && entry.body !== null)
    ) {
      throw new SnapshotIndexCorruptError(tip);
    }
    objectId(entry.object);
  }
  return parsed as SnapshotIndexPayload;
}

export class Reveries {
  /**
   * Injected signing material (RVR-009). Both are optional: a repository that
   * never signs needs neither, and the ports let a caller substitute a Git SSH
   * backend for the default in-process ed25519 one without changing any caller.
   */
  private constructor(
    /**
     * Evidence reads run through this suppressed handle: no read may lazily
     * fetch promisor objects, so incomplete local state surfaces as a
     * completeness grade instead of healing silently or being misreported.
     */
    readonly repository: GitRepository,
    /**
     * Explicit network operations (fetch, push, ls-remote) and only those
     * use the live handle. RVR-016 note: the notes-mutation retry/replay
     * loop stays on `repository` (suppressed) and publishes through the
     * lock-free `withNotesWrite` compare-and-swap via `mutateNotes`.
     */
    private readonly liveRepository: GitRepository,
    private readonly proposedNotesTip?: ObjectId,
    private readonly signing: SigningOptions = {},
  ) {}

  /**
   * Lineage edges indexed by the commit whose note carries them, memoized per
   * notes tip (RVR-014).
   *
   * An outgoing check asks for lineage once per parent per commit and every
   * answer is the same. Keying the memo on the notes tip means one index serves a
   * whole outgoing range and is discarded as soon as evidence changes, so the
   * per-commit cost stays off the RVR-012 snapshot path without ever serving a
   * stale edge.
   */
  private lineageIndex: {
    readonly key: string;
    readonly edges: ReadonlyMap<CommitId, readonly LineageRecord[]>;
  } | null = null;

  static async open(cwd: string, signing: SigningOptions = {}): Promise<Reveries> {
    const repository = await GitRepository.open(cwd);
    return new Reveries(repository.withoutLazyFetch(), repository, undefined, signing);
  }

  async assessCompleteness(input: {
    readonly annotatedObjects?: readonly ObjectId[];
    readonly view?: EvidenceSnapshotView;
  } = {}): Promise<CompletenessInfo> {
    const reader = this.repository;
    const [shallow, promisor] = await Promise.all([
      reader.isShallowRepository(),
      reader.hasPromisorRemote(),
    ]);
    const view = input.view ?? await this.loadEvidenceSnapshot({});
    const examined = input.annotatedObjects ?? [];
    const missing = examined.length === 0
      ? new Set<ObjectId>()
      : await reader.missingObjects(examined);
    const missingBodies = view.stats.notesListed - view.stats.notesRead;
    const missingSubjects = view.entries.filter((entry) => entry.objectType === "missing").length;
    const missingCount = missing.size + missingBodies + missingSubjects;
    const tracking = await reader.notesTrackingTips();
    const staleRefs: string[] = [];
    if (view.tip !== null) {
      for (const [ref, tip] of tracking) {
        if (tip !== view.tip && !(await reader.isAncestor(tip, view.tip))) {
          staleRefs.push(ref);
        }
      }
    } else if (tracking.size > 0) {
      staleRefs.push(...tracking.keys());
    }
    const reasons: string[] = [];
    if (shallow) {
      reasons.push("the repository is shallow: history before the boundary is unavailable locally");
    }
    if (promisor) {
      reasons.push("the repository has a promisor remote: unmaterialized objects need an explicit fetch");
    }
    if (missingCount > 0) {
      reasons.push(`${missingCount} evidence object(s) are unavailable locally`);
    }
    for (const ref of staleRefs) {
      reasons.push(`fetched notes at ${ref} are not incorporated into the local notes tip`);
    }
    if (view.tip === null && (shallow || promisor)) {
      reasons.push("the local notes ref is absent in an incomplete clone");
    }
    let grade: CompletenessGrade;
    if (missingCount > 0) {
      grade = promisor ? "promisor-object-missing" : shallow ? "shallow-boundary" : "unknown";
    } else if (staleRefs.length > 0) {
      grade = "notes-stale";
    } else if (view.tip === null && (shallow || promisor)) {
      grade = "notes-unfetched";
    } else {
      grade = "complete";
    }
    if (grade === "complete") {
      reasons.push("every reachable evidence object was examined locally");
    }
    return { grade, reasons, authoritative: grade === "complete" };
  }

  /**
   * Reframe a resolution failure as incompleteness when the clone cannot
   * vouch for absence; otherwise rethrow the original error so complete
   * clones keep their authoritative behavior. A raw "unknown revision"
   * error inside an incomplete clone is effectively an absence claim, so
   * incomplete clones always report the grade and keep the original message
   * as detail.
   */
  private async gradedFailure(error: unknown, objects: readonly ObjectId[] = []): Promise<never> {
    const reader = this.repository;
    const [shallow, promisor] = await Promise.all([
      reader.isShallowRepository(),
      reader.hasPromisorRemote(),
    ]);
    const missing = objects.length === 0
      ? new Set<ObjectId>()
      : await reader.missingObjects(objects);
    if (missing.size === 0 && !shallow && !promisor) {
      throw error;
    }
    const reasons: string[] = [];
    if (shallow) {
      reasons.push("the repository is shallow: history before the boundary is unavailable locally");
    }
    if (promisor) {
      reasons.push("the repository has a promisor remote: unmaterialized objects need an explicit fetch");
    }
    if (missing.size > 0) {
      reasons.push(`${missing.size} referenced object(s) are unavailable locally`);
    }
    const grade: CompletenessGrade = missing.size > 0
      ? promisor ? "promisor-object-missing" : shallow ? "shallow-boundary" : "unknown"
      : cloneEvidenceGrade({ shallow, promisor });
    throw new IncompleteEvidenceError(
      { grade, reasons, authoritative: false },
      error instanceof Error ? error.message : String(error),
    );
  }

  /**
   * Record a reverie on a blob-or-tree subject (RVR-013). The reverie ID is
   * content-addressed and identical for either subject kind; the decision
   * applies universally to every occurrence of the exact subject content,
   * including unchanged moves and copies at other paths.
   */
  async recordNew(input: RecordNewInput): Promise<RecordResult> {
    const resolved = await this.repository.resolveSubject(input);
    const object = resolved.object;
    if (!(await this.repository.subjectIsDurable(object))) {
      throw new Error(`Subject ${object} is neither staged nor reachable from a commit`);
    }
    let semanticInput = input.semantic;
    if (input.region !== undefined) {
      semanticInput = {
        ...input.semantic,
        region: await this.regionSubject(object, input.region.start_line, input.region.end_line),
      };
    }
    const semantic = `${semanticPayload(semanticInput)}\n`;
    const oid = await this.repository.hashObject(semantic);
    const record = createReverie(semanticInput, input.metadata, () => oid);
    await this.appendRecord(object, record);
    return {
      object,
      record,
      paths: input.revision === "index"
        ? await this.repository.indexPathsForSubject(object)
        : await this.repository.pathsForSubject(object, input.revision),
    };
  }

  /**
   * Build the region descriptor for a blob: identity is the blob object ID
   * plus the Git object hash of the selected bytes. Line numbers and the
   * prefix/suffix strings ride along as navigation hints only.
   */
  private async regionSubject(object: ObjectId, startLine: number, endLine: number): Promise<RegionSubject> {
    const type = (await this.repository.run(["cat-file", "-t", object])).stdout.trim();
    if (type !== "blob") throw new Error(`A region subject must be a blob; ${object} is a ${type}`);
    if (!Number.isInteger(startLine) || startLine < 1) throw new Error("region start line must be a positive integer");
    if (!Number.isInteger(endLine) || endLine < startLine) throw new Error("region end line must be at least the start line");
    const text = await this.repository.readBlobAt(object);
    const lines = text.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    if (endLine > lines.length) throw new Error(`region end line ${endLine} exceeds ${lines.length} lines in ${object}`);
    const selected = lines.slice(startLine - 1, endLine);
    const exactHash = await this.repository.hashObject(`${selected.join("\n")}\n`);
    return {
      kind: "region",
      blob: object,
      exact_hash: String(exactHash),
      start_line_hint: startLine,
      end_line_hint: endLine,
      prefix_hint: selected[0] ?? "",
      suffix_hint: selected[selected.length - 1] ?? "",
    };
  }

  async recordContinue(input: {
    readonly fromBlob: ObjectId;
    readonly toPath: string;
    readonly toRevision: "HEAD" | "index" | string;
    readonly id: ReverieId;
  }): Promise<RecordResult> {
    const resolved = await this.repository.resolveSubject({ path: input.toPath, revision: input.toRevision });
    return this.recordContinueToBlob({ fromBlob: input.fromBlob, toBlob: resolved.object, id: input.id, path: input.toPath });
  }

  /**
   * Continue an exact reverie record onto a successor subject. The legacy
   * `fromBlob`/`toBlob` names are kept for V1 compatibility; both accept
   * blob-or-tree subject IDs.
   */
  async recordContinueToBlob(input: {
    readonly fromBlob: ObjectId;
    readonly toBlob: ObjectId;
    readonly id: ReverieId;
    readonly path?: string;
  }): Promise<RecordResult> {
    const fromBlob = input.fromBlob;
    const predecessor = await this.strictRead(fromBlob);
    const record = predecessor.records.find(
      (candidate): candidate is ReverieRecord => candidate.type === "reverie" && candidate.id === input.id,
    );
    if (record === undefined) {
      throw new Error(`Reverie ${input.id} is not attached to predecessor subject ${fromBlob}`);
    }
    const object = input.toBlob;
    const type = (await this.repository.run(["cat-file", "-t", object])).stdout.trim();
    if (type !== "blob" && type !== "tree") throw new Error(`${object} is not a blob or tree`);
    if (!(await this.repository.subjectIsDurable(object))) {
      throw new Error(`Successor subject ${object} is neither staged nor reachable from a commit`);
    }
    await this.appendRecord(object, record);
    return {
      object,
      record,
      paths: input.path === undefined ? await this.repository.pathsForSubject(object) : [input.path],
    };
  }

  async recordSupersede(input: RecordNewInput & { readonly old: ReverieId }): Promise<RecordResult> {
    const semantic: ReverieInput = {
      ...input.semantic,
      supersedes: [...new Set([...input.semantic.supersedes, input.old])],
    };
    return this.recordNew({ ...input, semantic });
  }

  /**
   * Record evidence about one occurrence (RVR-014). The coordinate is resolved
   * from the repository, not taken on trust: the record rides the note of the
   * subject it names, so a wrong path fails here instead of becoming an
   * unverifiable claim in the notes.
   */
  async link(input: LinkInput): Promise<LinkResult> {
    const commit = await this.repository.resolveCommit(input.commit);
    const parent = await this.repository.resolveCommit(input.parent);
    const from: LineageEndpoint[] = [];
    for (const path of input.from) {
      from.push(await this.lineageEndpoint(path, parent, "from"));
    }
    const to: LineageEndpoint[] = [];
    for (const path of input.to) {
      to.push(await this.lineageEndpoint(path, commit, "to"));
    }
    const record = createLineage(
      {
        v: 1,
        kind: input.kind,
        parent,
        commit,
        from,
        to,
        transition: null,
        ...input.semantic,
      },
      input.metadata,
      (bytes) => this.repository.hashObjectSync(bytes),
    );
    const subjects = [...new Set((to.length > 0 ? to : from).map((endpoint) => String(endpoint.subject)))] as ObjectId[];
    await this.mutateNotes(async (notes) => {
      for (const subject of subjects) await notes.append(subject, canonicalRecord(record));
    });
    return { record, from: record.from, to: record.to, subjects };
  }

  /**
   * Resolve one endpoint of a lineage edge to the exact subject found at that
   * path in its revision. A path that does not exist there fails the edge
   * rather than silently naming an arbitrary subject.
   */
  private async lineageEndpoint(path: string, revision: CommitId, field: string): Promise<LineageEndpoint> {
    let resolved;
    try {
      resolved = await this.repository.resolveSubject({ path, revision: String(revision) });
    } catch (error: unknown) {
      throw new Error(`Lineage ${field} endpoint ${path} does not resolve at ${revision}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { path: normalizeCoordinatePath(path), subject: resolved.object };
  }

  async show(input: ShowInput): Promise<ShowResult> {
    const target = await this.resolveTarget(input.target, input.revision ?? "HEAD");
    const note = await this.readEvidenceNote(target.object);
    const completeness = await this.assessCompleteness({ annotatedObjects: [target.object] });
    const diagnostics = completeness.authoritative
      ? []
      : [`Evidence may be incomplete (${completeness.grade}): ${completeness.reasons.join("; ")}`];
    if (note === null) {
      return {
        ...target,
        records: [],
        active: [],
        historical: [],
        diagnostics,
        paths: target.paths,
        completeness,
        lineage: await this.lineageForSubject(target.object),
      };
    }
    const parsed = parseNote(note, "tolerant", { verifyIds: false });
    for (const diagnostic of parsed.diagnostics) diagnostics.push(diagnostic.message);
    const validRecords: NoteRecord[] = [];
    for (const record of parsed.records) {
      if (record.type === "reverie") {
        const expected = `rv:${await this.repository.hashObject(`${semanticPayload(record)}\n`)}`;
        if (expected !== record.id) {
          diagnostics.push(`semantic ID mismatch for ${record.id}`);
          continue;
        }
      }
      if (record.type === "lineage") {
        const expected = `lg:${await this.repository.hashObject(`${lineagePayload(record)}\n`)}`;
        if (expected !== record.id) {
          diagnostics.push(`lineage ID mismatch for ${record.id}`);
          continue;
        }
      }
      validRecords.push(record);
    }
    const projection = projectActiveReveries(
      validRecords.filter((record): record is ReverieRecord => record.type === "reverie"),
    );
    diagnostics.push(...this.projectionDiagnostics(projection));
    return {
      ...target,
      records: validRecords,
      active: projection.active,
      historical: projection.historical,
      diagnostics,
      paths: target.paths,
      completeness,
      lineage: await this.lineageForSubject(target.object),
    };
  }

  /**
   * Every lineage edge that names this subject as a predecessor or successor.
   * The note carries the edge on each endpoint, so a reader sees the relation
   * from either end without a separate index.
   */
  private async lineageForSubject(object: ObjectId): Promise<readonly LineageRecord[]> {
    const view = await this.loadEvidenceSnapshot({});
    const edges: LineageRecord[] = [];
    for (const list of view.lineages.values()) {
      for (const edge of list) {
        if ([...edge.from, ...edge.to].some((endpoint) => endpoint.subject === object)) edges.push(edge);
      }
    }
    return edges.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  }
  async mutateNotes<T>(
    mutation: (notes: NotesTransaction) => Promise<T>,
    options: WithNotesWriteOptions = {},
  ): Promise<T> {
    return this.repository.withNotesWrite(
      async (notes) => mutation({
        ref: notes.ref,
        read: (object) => notes.read(object),
        append: async (object, canonicalLine) => {
          await notes.append(object, canonicalLine);
        },
        replace: async (object, canonicalBody) => {
          await notes.replace(object, canonicalBody);
        },
      }),
      (ref) => this.validateNotesRef(ref),
      undefined,
      options,
    );
  }

  async search(input: SearchInput): Promise<readonly SearchHit[]> {
    return (await this.searchWithCompleteness(input)).hits;
  }

  /**
   * Search evidence with its completeness grade. Refuses to report an
   * incomplete local view as authoritative absence unless the caller opts
   * into `allowIncomplete`. Reads never fetch either way.
   */
  async searchWithCompleteness(input: SearchInput): Promise<SearchResult> {
    const view = await this.loadEvidenceSnapshot({});
    const completeness = await this.assessCompleteness({ view });
    if (!completeness.authoritative && input.allowIncomplete !== true) {
      throw new IncompleteEvidenceError(completeness);
    }
    return { hits: await this.searchWithView(view, input), completeness };
  }

  /**
   * Path history for one path.
   *
   * `git log -- path` alone stops at a rename, so the evidence trail of a
   * subject that moved and changed ends there. Explicit durable lineage is
   * therefore followed as well: every entry is reported with the path it really
   * had, and the edge that carried it. Lineage is the only thing followed here
   * — similarity is never consulted — and every edge that exists is history,
   * so this walk needs no change-authority decision.
   */
  async history(path: string, options: HistoryOptions = {}): Promise<readonly HistoryEntry[]> {
    if (options.allowIncomplete !== true && await this.repository.isShallowRepository()) {
      const completeness = await this.assessCompleteness({});
      throw new IncompleteEvidenceError(
        completeness.grade === "complete"
          ? {
              grade: "shallow-boundary",
              reasons: [
                "the repository is shallow: history before the boundary is unavailable locally",
                ...completeness.reasons,
              ],
              authoritative: false,
            }
          : completeness,
      );
    }
    const log = await this.repository.run(["log", "--format=%H", "--", path]);
    const history: HistoryEntry[] = [];
    const seen = new Set<string>();
    let latestOccurrence: OccurrenceCoordinate | null = null;
    for (const value of log.stdout.trim().split("\n").filter((line) => line.length > 0)) {
      const commit = commitId(value);
      try {
        const resolved = await this.repository.resolveSubject({ path, revision: String(commit) });
        const key = coordinateKey(String(commit), path, String(resolved.object));
        if (seen.has(key)) continue;
        seen.add(key);
        const note = await this.readEvidenceNote(resolved.object);
        latestOccurrence ??= {
          commit,
          path: normalizeCoordinatePath(path),
          subject: resolved.object,
        };
        history.push({
          commit,
          // `blob` is retained for API compatibility. For a tree path,
          // `subject` and `subjectType` below carry the actual subject.
          blob: blobId(resolved.object),
          records: note === null ? [] : parseNote(note, "tolerant", { verifyIds: false }).records,
          subject: resolved.object,
          path,
          subjectType: resolved.type,
        });
      } catch (error: unknown) {
        if (options.allowIncomplete !== true
          && (await this.repository.isShallowRepository() || await this.repository.hasPromisorRemote())) {
          await this.gradedFailure(error);
        }
      }
    }
    let start = latestOccurrence;
    try {
      const head = await this.repository.resolveCommit("HEAD");
      const current = await this.repository.resolveSubject({ path, revision: "HEAD" });
      // When the path still exists at HEAD, start there so explicit preserve
      // bridges carry the edge through unrelated descendant commits. When it
      // has been deleted, keep the newest coordinate that actually existed in
      // the path's own log instead of trying to resolve a missing HEAD:path.
      start = {
        commit: head,
        path: normalizeCoordinatePath(path),
        subject: current.object,
      };
    } catch {
      // A deleted or never-present path has no HEAD coordinate. Its most recent
      // extant coordinate from the log is still a valid starting point for the
      // explicit lineage walk.
    }
    if (start !== null) {
      history.push(...await this.lineageHistory(start, seen));
    }
    return history;
  }

  /**
   * Follow explicit lineage backwards from a coordinate, appending the earlier
   * coordinates a rename-plus-edit, split, or join would otherwise hide. Only
   * recorded lineage is followed; similarity is never consulted, and the walk
   * is deterministic: commit descending, then path.
   */
  private async lineageHistory(
    start: OccurrenceCoordinate,
    seen: Set<string>,
  ): Promise<readonly HistoryEntry[]> {
    const view = await this.loadEvidenceSnapshot({});
    if (view.lineages.size === 0) return [];
    const edges = [...view.lineages.values()].flat();
    const key = (commit: string, path: string, subject: string): string =>
      `${commit}\u0000${normalizeCoordinatePath(path)}\u0000${subject}`;
    const visited = new Set<string>([key(String(start.commit), start.path, String(start.subject))]);
    const queue: OccurrenceCoordinate[] = [start];
    const earlier: { coordinate: OccurrenceCoordinate; lineage: LineageId }[] = [];
    while (queue.length > 0) {
      const coordinate = queue.shift() as OccurrenceCoordinate;
      for (const edge of edges) {
        const matches = edge.to.some((endpoint) =>
          endpoint.subject === coordinate.subject
          && normalizeCoordinatePath(endpoint.path) === normalizeCoordinatePath(coordinate.path));
        if (!matches) continue;
        for (const endpoint of edge.from) {
          const previous = key(String(edge.parent), endpoint.path, String(endpoint.subject));
          if (visited.has(previous)) continue;
          visited.add(previous);
          const next: OccurrenceCoordinate = {
            commit: edge.parent,
            path: normalizeCoordinatePath(endpoint.path),
            subject: endpoint.subject,
          };
          earlier.push({ coordinate: next, lineage: edge.id });
          queue.push(next);
        }
      }
    }
    const entries: HistoryEntry[] = [];
    for (const step of earlier) {
      const coordinate = step.coordinate;
      if (seen.has(`${coordinate.commit}:${coordinate.subject}`)) continue;
      seen.add(`${coordinate.commit}:${coordinate.subject}`);
      let subjectType = "blob";
      try {
        subjectType = (await this.repository.run(["cat-file", "-t", coordinate.subject])).stdout.trim();
      } catch {
        continue;
      }
      const note = await this.readEvidenceNote(coordinate.subject);
      entries.push({
        commit: coordinate.commit,
        blob: blobId(coordinate.subject),
        records: note === null ? [] : parseNote(note, "tolerant", { verifyIds: false }).records,
        subject: coordinate.subject,
        path: coordinate.path,
        subjectType,
        viaLineage: step.lineage,
      });
    }
    return entries.sort((left, right) => (left.commit === right.commit
      ? String(left.path).localeCompare(String(right.path))
      : left.commit < right.commit ? 1 : -1));
  }

  /**
   * Load every note under one evidence tip with exactly one parse per note.
   * Bodies travel through the size-gated batch reader, so oversized input is
   * rejected before any body loads. The view carries parsed records, per-note
   * projections, the global ID map, source backlinks, and init discovery, so
   * validation, search, and retention share it instead of rescanning notes.
   */
  async loadEvidenceSnapshot(options: SnapshotLoadOptions = {}): Promise<EvidenceSnapshotView> {
    const ref = options.ref ?? NOTES_REF;
    const limits = resolveLimits(options.limits);
    const tip = await this.repository.notesTip(ref);
    if (tip === null) return emptySnapshotView(limits);
    const listed = await this.repository.listNotes(ref);
    const bodies = await this.repository.readNotesBatch(listed, { limits: options.limits });
    return this.buildSnapshotView(tip, listed, bodies, limits, false);
  }

  /**
   * Load the snapshot through the disposable file index. A hit parses the same
   * bodies once from the cache; a miss, a deletion, or corruption rebuilds
   * from Git and rewrites the index. The index is never authority: every view
   * derives from note bodies either way.
   */
  private async buildSnapshotView(
    tip: ObjectId,
    listed: readonly NoteListEntry[],
    bodies: ReadonlyMap<ObjectId, string | null>,
    limits: Readonly<ResourceLimits>,
    indexHit: boolean,
  ): Promise<EvidenceSnapshotView> {
    const format = await this.repository.objectFormat();
    const details = await this.repository.batchObjectDetails(listed.map((item) => item.object));
    const entries: SnapshotNoteEntry[] = [];
    const diagnostics: Diagnostic[] = [];
    let diagnosticsTruncated = false;
    let bytesRead = 0;
    let notesRead = 0;
    const pushDiagnostic = (diagnostic: Diagnostic): void => {
      if (diagnostics.length >= limits.maxDiagnostics) {
        diagnosticsTruncated = true;
        return;
      }
      diagnostics.push(diagnostic);
    };
    for (const entry of listed) {
      const body = bodies.get(entry.object) ?? null;
      if (body === null) {
        pushDiagnostic({ message: `Note blob is missing for annotated object ${entry.object}` });
        continue;
      }
      notesRead += 1;
      bytesRead += Buffer.byteLength(body, "utf8");
      let records: NoteRecord[];
      try {
        const parsed = parseNote(body, "strict", { limits });
        records = validateNote(parsed, { limits });
        for (const record of records) {
          if (record.type === "lineage") {
            const expected = `lg:${hashBlobContent(`${lineagePayload(record, limits)}\n`, format)}`;
            if (expected !== record.id) {
              throw new Error(`Lineage ID mismatch for ${record.id}; expected ${expected}`);
            }
            continue;
          }
          if (record.type !== "reverie") continue;
          const expected = `rv:${hashBlobContent(`${semanticPayload(record)}\n`, format)}`;
          if (expected !== record.id) {
            throw new Error(`Semantic ID mismatch for ${record.id}; expected ${expected}`);
          }
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        pushDiagnostic({ message: `${entry.object}: ${message}` });
        entries.push({
          object: entry.object,
          records: [],
          projection: projectActiveReveries([]),
          objectType: await this.snapshotObjectType(details, entry.object),
          error: message,
          snapshot: createEvidenceSnapshot({ notesTip: tip, records: [], limits }),
        });
        continue;
      }
      const projection = projectActiveReveries(
        records.filter((record): record is ReverieRecord => record.type === "reverie"),
      );
      const projectionDiagnostics = this.projectionDiagnostics(projection);
      const objectType = await this.snapshotObjectType(details, entry.object);
      entries.push({
        object: entry.object,
        records,
        projection,
        objectType,
        error: projectionDiagnostics.length > 0 ? projectionDiagnostics.join("; ") : null,
        snapshot: createEvidenceSnapshot({ notesTip: tip, records, limits }),
      });
      if (projectionDiagnostics.length > 0) {
        pushDiagnostic({ message: `${entry.object}: ${projectionDiagnostics.join("; ")}` });
      }
    }
    const byId = new Map<ReverieId, { readonly record: NoteRecord; readonly object: ObjectId }>();
    for (const entry of entries) {
      for (const record of entry.records) {
        if (record.type !== "reverie" || byId.has(record.id)) continue;
        byId.set(record.id, { record, object: entry.object });
      }
    }
    const lineageLists = new Map<CommitId, LineageRecord[]>();
    for (const entry of entries) {
      for (const record of entry.records) {
        if (record.type !== "lineage") continue;
        const list = lineageLists.get(record.commit) ?? [];
        list.push(record);
        lineageLists.set(record.commit, list);
      }
    }
    const lineages = new Map<CommitId, readonly LineageRecord[]>(lineageLists);
    return {
      tip,
      entries,
      byId,
      lineages,
      diagnostics,
      diagnosticsTruncated,
      limits,
      stats: {
        notesListed: listed.length,
        notesRead,
        bytesRead,
        notesParsed: notesRead,
        indexHit,
      },
    };
  }
  private async noteObjectType(object: ObjectId): Promise<string> {
    return (await this.repository.run(["cat-file", "-t", object])).stdout.trim();
  }

  /**
   * Annotated-subject type for the snapshot view. A locally missing subject
   * (shallow boundary, unfetched promisor object) is recorded as "missing"
   * so completeness grading can see it instead of crashing the whole load.
   * Validation still fails closed per entry for such subjects.
   */
  private async snapshotObjectType(
    details: ReadonlyMap<ObjectId, { readonly type: string; readonly size: number } | null>,
    object: ObjectId,
  ): Promise<string> {
    const known = details.get(object)?.type;
    if (known !== undefined) return known;
    try {
      return await this.noteObjectType(object);
    } catch {
      return "missing";
    }
  }

  /**
   * Strict authority check over a loaded view: the same rules `validateNotesRef`
   * enforces, with `note`-kind sources resolved from the snapshot ID map
   * instead of rescanning every note.
   */
  async validateNotesSnapshot(view: EvidenceSnapshotView): Promise<void> {
    for (const entry of view.entries) {
      try {
        if (entry.error !== null) throw new Error(entry.error);
        // A blob or tree may carry a reverie or a lineage edge; a commit may
        // carry neither, because a decision is about content, not history.
        if ((entry.objectType === "blob" || entry.objectType === "tree")
          && entry.records.some((record) => record.type !== "reverie" && record.type !== "lineage")) {
          throw new Error(`${entry.objectType === "blob" ? "Blob" : "Tree"} ${entry.object} has a non-reverie protocol record`);
        }
        if (entry.objectType === "commit" && entry.records.some((record) => record.type === "reverie")) {
          throw new Error(`Commit ${entry.object} has a file reverie record`);
        }
        for (const record of entry.records) {
          // A lineage edge is about object endpoints, not about the change it
          // was recorded beside, so it may ride any endpoint subject's note.
          if (record.type === "lineage" && record.commit !== entry.object) {
            const endpoints = [...record.from, ...record.to].map((endpoint) => String(endpoint.subject));
            if (!endpoints.includes(String(entry.object))) {
              throw new Error(`Lineage edge ${record.id} is attached to ${entry.object}, which is not one of its endpoints`);
            }
          }
        }
        if (entry.objectType !== "blob" && entry.objectType !== "commit" && entry.objectType !== "tree"
          && entry.records.length > 0) {
          throw new Error(`Protocol records cannot be attached to ${entry.objectType} object ${entry.object}`);
        }
        await this.validateSourcesWithLookup(entry.records, (id) => view.byId.has(id as ReverieId));
      } catch (error: unknown) {
        throw new NotesRefValidationError(entry.object, error);
      }
    }
    // Cross-note forks: two records may supersede the same predecessor from
    // different notes. A fork or cycle is damage a reader must not ignore.
    const reveries = view.entries.flatMap((entry) =>
      entry.records.filter((record): record is ReverieRecord => record.type === "reverie"));
    const globalDiagnostics = this.projectionDiagnostics(projectActiveReveries(reveries));
    if (globalDiagnostics.length > 0) {
      const firstEntry = view.entries[0];
      throw new NotesRefValidationError(
        firstEntry !== undefined ? firstEntry.object : view.tip as ObjectId,
        new Error(globalDiagnostics.join("; ")),
      );
    }
  }

  private async validateSourcesWithLookup(
    records: readonly NoteRecord[],
    hasReverie: (id: string) => boolean | Promise<boolean>,
  ): Promise<void> {
    for (const record of records) {
      for (const source of allSources(record)) {
        if (source.kind === "commit" || source.kind === "blob" || source.kind === "tree") {
          const object = objectId(source.ref);
          const exists = source.kind === "tree"
            ? await this.repository.treeExists(object)
            : await this.repository.objectExists(source.kind, object);
          if (!exists) {
            throw await this.gradedSourceError(source.kind, source.ref, object);
          }
        } else if (source.kind === "path") {
          if (source.at === undefined) throw new Error("A path source requires an at commit");
          await this.repository.resolvePath({ path: source.ref, revision: source.at });
        } else if (source.kind === "note") {
          if (!(await hasReverie(source.ref))) throw new Error(`Referenced reverie does not exist: ${source.ref}`);
        } else if (source.kind === "git-email") {
          if (!/^[^\s@]+@[^\s@]+$/.test(source.ref)) throw new Error(`Invalid Git email source: ${source.ref}`);
        } else if (source.kind === "confidential-pointer") {
          continue;
        } else if (!/^(?:github|gitlab|linear|jira|generic):\S+$/.test(source.ref)) {
          throw new Error(`Invalid issue source: ${source.ref}`);
        }
      }
    }
  }

  /**
   * A missing source behind an incomplete clone is graded incompleteness,
   * never a broken-source verdict: the clone cannot vouch for absence.
   * Complete clones keep the exact historical message.
   */
  private async gradedSourceError(
    kind: "commit" | "blob" | "tree",
    ref: string,
    object: ObjectId,
  ): Promise<Error> {
    const reader = this.repository;
    const [shallow, promisor] = await Promise.all([
      reader.isShallowRepository(),
      reader.hasPromisorRemote(),
    ]);
    const missing = await reader.missingObjects([object]);
    if (missing.size === 0 || (!shallow && !promisor)) {
      // Present-but-wrong-type, or any absence inside a complete clone, is
      // an authoritative broken-source verdict: the clone can vouch for it.
      return new Error(`Broken local ${kind} source: ${ref}`);
    }
    const reasons: string[] = [];
    if (shallow) {
      reasons.push("the repository is shallow: history before the boundary is unavailable locally");
    }
    if (promisor) {
      reasons.push("the repository has a promisor remote: unmaterialized objects need an explicit fetch");
    }
    if (missing.size > 0) {
      reasons.push(`the ${kind} source ${ref} is unavailable locally`);
    }
    const grade: CompletenessGrade = missing.size > 0
      ? promisor ? "promisor-object-missing" : shallow ? "shallow-boundary" : "unknown"
      : cloneEvidenceGrade({ shallow, promisor });
    return new IncompleteEvidenceError({ grade, reasons, authoritative: false });
  }

  async cachedSearch(input: SearchInput): Promise<readonly SearchHit[]> {
    return this.searchWithView(await this.loadEvidenceSnapshot({}), input);
  }

  private async searchWithView(view: EvidenceSnapshotView, input: SearchInput): Promise<readonly SearchHit[]> {
    const revision = input.revision ?? "HEAD";
    const allowed = input.all === true
      ? new Set(view.entries.map((entry) => entry.object as string))
      : new Set((await this.snapshotTargets(view, revision)).map((entry) => entry.object as string));
    const hits: SearchHit[] = [];
    for (const entry of view.entries) {
      if (!allowed.has(entry.object as string)) continue;
      for (const record of entry.records) {
        if (input.query !== undefined && !searchText(record).includes(input.query.toLocaleLowerCase())) continue;
        if (input.source !== undefined && !allSources(record).some((source) => source.ref === input.source)) continue;
        if (input.author !== undefined && recordAuthor(record) !== input.author) continue;
        const paths = await this.pathsForObject(entry.object, revision);
        hits.push({ object: entry.object, record, paths });
      }
    }
    return hits;
  }

  private async snapshotTargets(
    view: EvidenceSnapshotView,
    revision: string,
  ): Promise<readonly SnapshotNoteEntry[]> {
    // Trees included: an unchanged subtree move keeps its OID reachable at a
    // new path, so its evidence stays in scope without any disposition.
    const tree = await this.repository.listTreeIncludingTrees(revision);
    const available = new Map(view.entries.map((entry) => [entry.object as string, entry]));
    const targets = new Map<string, SnapshotNoteEntry>();
    for (const item of tree) {
      const entry = available.get(item.object as string);
      if (entry !== undefined) targets.set(entry.object as string, entry);
    }
    const commit = await this.repository.resolveCommit(revision);
    const commitEntry = available.get(commit as string);
    if (commitEntry !== undefined) targets.set(commitEntry.object as string, commitEntry);
    // `ls-tree -r -t` lists every nested subtree but never the revision root
    // itself, so a reverie on the exact root tree would otherwise vanish from
    // the current projection and search while still showing by raw OID.
    const root = await this.repository.resultTreeForCommit(commit);
    const rootEntry = available.get(root as string);
    if (rootEntry !== undefined) targets.set(rootEntry.object as string, rootEntry);
    return [...targets.values()];
  }

  /**
   * Fetch a remote's notes and decide what may happen to canonical state.
   *
   * The role decides the outcome before anything is merged (RVR-017). Only the
   * primary, and any remote that declared no role at all, may promote into
   * `refs/notes/reveries`. A mirror, an import-only remote, and anything else
   * non-primary runs the identical full-snapshot validation and is then
   * *quarantined*: the evidence is preserved and inspectable at a quarantine ref
   * while the canonical ref is left exactly as it was. An archive is not a
   * synchronization source and is refused before any fetch.
   */
  /**
   * Fetch a remote's notes and merge them into the canonical ref.
   *
   * The union is a plain `cat_sort_uniq` merge, so it is deterministic and
   * idempotent. There is no quarantine and no promotion gate: a reader
   * discovers a conflicting duplicate ID from `reveries doctor`, which never
   * blocks the union.
   */
  async syncPull(remote: string): Promise<SyncResult> {
    const fetched = await this.liveRepository.fetchNotes(remote);
    if (fetched === "absent") {
      return { ok: true, diagnostics: [], state: "remote-notes-absent", conflicts: [] };
    }
    const remoteNotes = await this.repository.notesTip(`refs/notes/remotes/${remote}/reveries`);
    if (remoteNotes === null) {
      return {
        ok: false,
        diagnostics: [`Fetched notes for ${remote} have no remote-tracking tip`],
        state: "fetched",
        conflicts: [],
      };
    }
    try {
      await this.repository.mergeFetchedNotes(remote, (ref) => this.validateNotesRef(ref));
    } catch (error: unknown) {
      return {
        ok: false,
        diagnostics: [error instanceof Error ? error.message : String(error)],
        state: "fetched",
        conflicts: [],
      };
    }
    return { ok: true, diagnostics: [], state: "fetched", conflicts: [] };
  }

  async push(remote: string): Promise<CheckResult> {
    const branchResult = await this.repository.run(
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      { allowExitCodes: [0, 1] },
    );
    const branch = branchResult.stdout.trim();
    if (branchResult.exitCode !== 0 || branch.length === 0) {
      return { ok: false, diagnostics: ["Publishing requires an attached branch"] };
    }
    const branchRef = `refs/heads/${branch}`;
    const branchRemote = await this.liveRepository.remoteObject(remote, branchRef);
    const notesTip = await this.repository.notesTip();
    const notesRemote = notesTip === null ? null : await this.liveRepository.remoteObject(remote, NOTES_REF);
    try {
      await this.liveRepository.pushAtomically(remote, {
        branchRef,
        expectedBranch: branchRemote,
        includeNotes: notesTip !== null,
        ...(notesTip === null ? {} : { expectedNotes: notesRemote }),
      });
    } catch (error: unknown) {
      return { ok: false, diagnostics: [error instanceof Error ? error.message : String(error)] };
    }
    return { ok: true, diagnostics: [] };
  }

  async retentionPolicy(): Promise<RetentionPolicy> {
    const result = await this.repository.run(["config", "--get", "reveries.retention"], {
      allowExitCodes: [0, 1],
    });
    const value = result.stdout.trim();
    if (value === "") return "active";
    if (!(RETENTION_POLICIES as readonly string[]).includes(value)) {
      throw new Error(`reveries.retention must be one of ${RETENTION_POLICIES.join(", ")}; found ${value}`);
    }
    return value as RetentionPolicy;
  }

  private async retentionSelection(policy: RetentionPolicy): Promise<readonly RetentionSubject[]> {
    const view = await this.loadEvidenceSnapshot({});
    const byObject = new Map(view.entries.map((entry) => [entry.object as string, entry]));
    const subjects: { readonly object: ObjectId; readonly type: RetentionSubject["type"]; readonly reveries: readonly ReverieRecord[] }[] = [];
    for (const listEntry of await this.repository.listNotes()) {
      const entry = byObject.get(listEntry.object as string);
      const type = entry?.objectType ?? await this.repository.objectType(listEntry.object);
      if (type === null) continue;
      if (type === "tag") {
        throw new Error(`Retention cannot anchor annotated tag ${listEntry.object}`);
      }
      if (type !== "blob" && type !== "tree" && type !== "commit") continue;
      subjects.push({
        object: listEntry.object,
        type,
        reveries: (entry?.records ?? []).filter((record): record is ReverieRecord => record.type === "reverie"),
      });
    }
    // A supersession recorded on any subject retires the predecessor everywhere, so the
    // active set must be projected across the whole evidence set rather than per note.
    const activeIds = new Set(
      projectActiveReveries(subjects.flatMap((subject) => subject.reveries)).active.map((record) => record.id),
    );
    const selected = new Map<ObjectId, RetentionSubject["type"]>();
    for (const subject of subjects) {
      if (policy === "active" && !subject.reveries.some((record) => activeIds.has(record.id))) continue;
      selected.set(subject.object, subject.type);
    }
    if (policy === "archive") {
      const vault = await this.repository.readRetention();
      for (const object of vault.commits) {
        if (!selected.has(object)) selected.set(object, "commit");
      }
      for (const object of vault.objects) {
        if (selected.has(object)) continue;
        const type = await this.repository.objectType(object);
        if (type === "blob" || type === "tree") selected.set(object, type);
      }
    }
    return [...selected]
      .map(([object, type]) => ({ object, type }))
      .sort((left, right) => (left.object < right.object ? -1 : left.object > right.object ? 1 : 0));
  }

  private async retentionVault(): Promise<{
    readonly commit: ObjectId | null;
    readonly objects: readonly ObjectId[];
    readonly commits: readonly ObjectId[];
  }> {
    return this.repository.readRetention();
  }

  async retentionStatus(policy?: RetentionPolicy): Promise<RetentionStatus> {
    const resolved = policy ?? await this.retentionPolicy();
    if (resolved === "none") {
      return { policy: "none", state: "absent", expected: [], retained: [], missing: [] };
    }
    const expected = (await this.retentionSelection(resolved)).map((subject) => subject.object);
    const vault = await this.retentionVault();
    const retained = [...new Set([...vault.objects, ...vault.commits])]
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    const missing = expected.filter((object) => !retained.includes(object));
    return {
      policy: resolved,
      state: missing.length > 0 ? "incomplete" : retained.length === 0 ? "absent" : "current",
      expected,
      retained,
      missing,
    };
  }

  /**
   * Rebuild the retention vault from evidence. Only the explicit `none` policy removes
   * retention; an empty selection leaves the existing vault untouched. The single
   * retention ref is a deterministic function of the selected subjects.
   */
  async retain(): Promise<RetentionResult> {
    const policy = await this.retentionPolicy();
    const vault = await this.retentionVault();
    if (policy === "none") {
      if (vault.commit === null) {
        return { ...(await this.retentionStatus("none")), changed: false };
      }
      await this.repository.deleteRetentionRef(vault.commit);
      return { ...(await this.retentionStatus("none")), changed: true };
    }
    const selection = await this.retentionSelection(policy);
    if (selection.length === 0) {
      return { ...(await this.retentionStatus(policy)), changed: false };
    }
    const next = await this.repository.writeRetention(selection);
    await this.repository.updateRetentionRef({ next, expected: vault.commit });
    return { ...(await this.retentionStatus(policy)), changed: true };
  }

  // ---------------------------------------------------------------------------
  // Ledger envelope (RVR-005)
  // ---------------------------------------------------------------------------

  /**
   * Verify a ledger checkpoint against its own manifest, tree, and parents.
   * Fails closed: any structural disagreement is a diagnostic, never a warning.
   * A notes tip that merely leads the envelope is staleness, reported by
   * `ledgerStatus`, not a verification failure.
   */
  async doctor(): Promise<DoctorResult> {
    const diagnostics: string[] = [];
    const notices: string[] = [];
    // The AGENTS.md block is a convenience for agent hosts, not evidence. Its
    // absence never makes the evidence unsound, so it is a notice an operator
    // may act on and never flips `ok` to false.
    let agents = "";
    try {
      agents = await readFile(join(this.repository.root, "AGENTS.md"), "utf8");
    } catch {
      notices.push("AGENTS.md is unavailable; run reveries init to add the owned instructions block");
    }
    if (agents !== "" && (!agents.includes("<!-- reveries:begin -->") || !agents.includes("<!-- reveries:end -->"))) {
      notices.push("AGENTS.md Reveries marker is missing or incomplete; run reveries init to repair it");
    }
    const strategy = await this.repository.run(
      ["config", "--get", "notes.reveries.mergeStrategy"],
      { allowExitCodes: [0, 1] },
    );
    if (strategy.stdout.trim() !== "cat_sort_uniq") {
      notices.push(
        "notes.reveries.mergeStrategy is not cat_sort_uniq; two clones' notes refs will not combine by union",
      );
    }
    try {
      await access(join(await this.repository.commonDirectory(), "NOTES_MERGE_PARTIAL"));
      diagnostics.push("An unresolved Git notes merge is in progress");
    } catch {
      // No unresolved notes merge marker exists.
    }
    // A retired lock directory and disposable transaction refs are
    // collectible leftovers, never damage: they are reported as notices so an
    // operator can clean them up, and they never flip `ok` to false.
    try {
      const lockPath = this.repository.writeLockPath();
      const lockStat = await stat(lockPath).catch(() => null);
      if (lockStat !== null) {
        let owner = "unknown owner";
        try {
          const raw = await readFile(join(lockPath, "owner.json"), "utf8");
          const parsed = JSON.parse(raw) as { pid?: unknown; started_at?: unknown };
          const ageMs = lockStat.mtimeMs;
          const age = Number.isFinite(ageMs) ? `, directory mtime ${new Date(ageMs).toISOString()}` : "";
          owner = `pid ${String(parsed.pid ?? "unknown")} started ${String(parsed.started_at ?? "unknown")}${age}`;
        } catch {
          // Owner metadata is best-effort; the leftover itself is the signal.
        }
        notices.push(
          `A stale Reveries write.lock directory remains at ${lockPath} (${owner}). `
          + "Writers ignore it; remove the directory to silence this notice.",
        );
      }
    } catch {
      // A lock-path probe failure is not a diagnosis.
    }
    try {
      const orphans = await this.repository.listTemporaryNotesRefs();
      if (orphans.length > 0) {
        const names = orphans.map((entry) => entry.ref).sort().join(", ");
        notices.push(
          `Abandoned Reveries transaction ref(s) under refs/notes/reveries-txn `
          + `(${orphans.length}): ${names}. They are disposable; collect them with pruneTemporaryNotesRefs.`,
        );
      }
    } catch {
      // A temp-ref listing failure is not a diagnosis.
    }
    try {
      await this.validateNotesRef(NOTES_REF);
    } catch (error: unknown) {
      diagnostics.push(error instanceof Error ? error.message : String(error));
    }
    let retention: RetentionStatus = {
      policy: "none",
      state: "absent",
      expected: [],
      retained: [],
      missing: [],
    };
    try {
      retention = await this.retentionStatus();
      // Retention is rebuildable from evidence, so an incomplete vault is a
      // notice an operator clears with `reveries retain`, never damage. Only a
      // retained object that no longer resolves is a diagnostic.
      if (retention.missing.length > 0) {
        notices.push(
          `Retention policy ${retention.policy} does not keep ${retention.missing.length} annotated subject(s): `
          + `${retention.missing.join(", ")}. Run reveries retain to rebuild the retention ref.`,
        );
      }
    } catch (error: unknown) {
      diagnostics.push(error instanceof Error ? error.message : String(error));
    }
    notices.push(
      `Retention: policy ${retention.policy}; ${retention.state}; `
      + `${retention.retained.length} of ${retention.expected.length} annotated subject(s) kept.`,
    );
    return {
      ok: diagnostics.length === 0,
      diagnostics,
      notices,
      retention,
      state: diagnostics.length > 0 ? "damaged" : "healthy",
    };
  }

  private async appendRecord(object: ObjectId, record: ReverieRecord): Promise<void> {
    await this.mutateNotes(async (notes) => {
      await notes.append(object, canonicalRecord(record));
    });
  }

  /**
   * Collect disposable transaction refs left by killed writers
   * (`refs/notes/reveries-txn/*`). Refs older than `olderThanMs`
   * (default: one day) are deleted; refs without a readable creation date
   * count as stale. With `dryRun`, report without deleting. Never touches
   * the canonical notes ref. Returns the pruned and kept ref names.
   */
  async pruneTemporaryNotesRefs(input: {
    readonly olderThanMs?: number;
    readonly dryRun?: boolean;
  } = {}): Promise<{ readonly pruned: readonly string[]; readonly kept: readonly string[] }> {
    const cutoff = Date.now() - (input.olderThanMs ?? 24 * 3600 * 1000);
    const pruned: string[] = [];
    const kept: string[] = [];
    for (const entry of await this.repository.listTemporaryNotesRefs()) {
      const stale = entry.createdAtUnix === null || entry.createdAtUnix * 1000 <= cutoff;
      if (!stale) {
        kept.push(entry.ref);
        continue;
      }
      if (input.dryRun !== true) {
        await this.repository.deleteTemporaryNotesRef(entry.ref);
      }
      pruned.push(entry.ref);
    }
    return { pruned: pruned.sort(), kept: kept.sort() };
  }

  private async resolveTarget(target: string, revision: string): Promise<{
    readonly object: ObjectId;
    readonly objectType: string;
    readonly paths: readonly string[];
    /**
     * The path the caller named, when they named one. A subject can occur at
     * several paths, and applicability is per occurrence, so the display layer
     * needs to know which of them is on screen.
     */
    readonly requestedPath: string | null;
  }> {
    let object: ObjectId;
    const requestedPath = isFullObjectId(target) ? null : normalizeCoordinatePath(target);
    try {
      object = isFullObjectId(target)
        ? objectId(target)
        : (await this.repository.resolveSubject({ path: target, revision })).object;
    } catch (error: unknown) {
      return this.gradedFailure(error);
    }
    try {
      const objectType = (await this.repository.run(["cat-file", "-t", object])).stdout.trim();
      const paths = await this.displayPathsForSubject(object, objectType, revision);
      return { object, objectType, paths, requestedPath };
    } catch (error: unknown) {
      return this.gradedFailure(error, [object]);
    }
  }

  private async pathsForObject(object: ObjectId, revision: string): Promise<readonly string[]> {
    const type = (await this.repository.run(["cat-file", "-t", object])).stdout.trim();
    return this.displayPathsForSubject(object, type, revision);
  }

  /**
   * Current display paths for a blob-or-tree subject. The revision root tree
   * has no `ls-tree` listing path, so it reports the stable display path
   * `.` instead of an empty list (RVR-013); every other subject keeps its
   * exact listing paths.
   */
  private async displayPathsForSubject(
    object: ObjectId,
    objectType: string,
    revision: string,
  ): Promise<readonly string[]> {
    if (objectType !== "blob" && objectType !== "tree") return [];
    if (revision === "index") return this.repository.indexPathsForSubject(object);
    const paths = await this.repository.pathsForSubject(object, revision);
    if (paths.length > 0 || objectType !== "tree") return paths;
    try {
      const root = await this.repository.resultTreeForCommit(await this.repository.resolveCommit(revision));
      if (root === object) return ["."];
    } catch {
      // A non-commit revision has no root display path.
    }
    return paths;
  }

  private async evidenceNotes(ref = "refs/notes/reveries"): Promise<readonly NoteListEntry[]> {
    return this.proposedNotesTip !== undefined && ref === "refs/notes/reveries"
      ? this.repository.listNotesAt(this.proposedNotesTip)
      : this.repository.listNotes(ref);
  }

  private async readEvidenceNote(object: ObjectId, ref = "refs/notes/reveries"): Promise<string | null> {
    return this.proposedNotesTip !== undefined && ref === "refs/notes/reveries"
      ? this.repository.readNoteAt(this.proposedNotesTip, object)
      : this.repository.readNoteFromRef(ref, object);
  }

  private async strictRead(object: ObjectId, ref = "refs/notes/reveries"): Promise<{
    readonly records: readonly NoteRecord[];
    readonly projection: ActiveProjection;
  }> {
    const note = await this.readEvidenceNote(object, ref);
    if (note === null) {
      return { records: [], projection: projectActiveReveries([]) };
    }
    const parsed = parseNote(note, "strict", { verifyIds: false });
    const records = validateNote(parsed, { verifyIds: false });
    for (const record of records) {
      if (record.type === "correction") {
        const expected = `cr:${await this.repository.hashObject(`${correctionPayload(record)}\n`)}`;
        if (expected !== record.id) {
          throw new Error(`Correction ID mismatch for ${record.id}; expected ${expected}`);
        }
        continue;
      }
      if (record.type === "resolution") {
        const expected = `rs:${await this.repository.hashObject(`${resolutionPayload(record)}\n`)}`;
        if (expected !== record.id) {
          throw new Error(`Resolution ID mismatch for ${record.id}; expected ${expected}`);
        }
        continue;
      }
      if (record.type === "redaction") {
        const expected = `rd:${await this.repository.hashObject(`${redactionPayload(record)}\n`)}`;
        if (expected !== record.id) {
          throw new Error(`Redaction ID mismatch for ${record.id}; expected ${expected}`);
        }
        continue;
      }
      if (record.type === "occurrence") {
        const expected = `oc:${await this.repository.hashObject(`${occurrencePayload(record)}\n`)}`;
        if (expected !== record.id) {
          throw new Error(`Occurrence ID mismatch for ${record.id}; expected ${expected}`);
        }
        continue;
      }
      if (record.type === "lineage") {
        const expected = `lg:${await this.repository.hashObject(`${lineagePayload(record)}\n`)}`;
        if (expected !== record.id) {
          throw new Error(`Lineage ID mismatch for ${record.id}; expected ${expected}`);
        }
        continue;
      }
      if (record.type !== "reverie") continue;
      const expected = `rv:${await this.repository.hashObject(`${semanticPayload(record)}\n`)}`;
      if (expected !== record.id) {
        throw new Error(`Semantic ID mismatch for ${record.id}; expected ${expected}`);
      }
    }
    const projection = projectActiveReveries(
      records.filter((record): record is ReverieRecord => record.type === "reverie"),
    );
    const projectionDiagnostics = this.projectionDiagnostics(projection);
    if (projectionDiagnostics.length > 0) {
      throw new Error(projectionDiagnostics.join("; "));
    }
    await this.validateSources(records, ref);
    return { records, projection };
  }

  private projectionDiagnostics(projection: ActiveProjection): string[] {
    const diagnostics: string[] = [];
    if (projection.cycles.length > 0) diagnostics.push("Supersession cycle detected");
    if (projection.forks.length > 0) diagnostics.push("Unresolved supersession fork detected");
    if ((projection.conflicts?.length ?? 0) > 0) diagnostics.push("Conflicting duplicate reverie IDs detected");
    return diagnostics;
  }

  /**
   * An occurrence coordinate is only evidence if the repository still supports
   * it: at `commit`, `path` must hold exactly `subject`. A coordinate Git
   * cannot resolve fails closed here, and a missing object inside an incomplete
   * clone is reported as incompleteness rather than as a broken claim.
   */
  private async validateNotesRef(ref: string): Promise<void> {
    await this.validateNotesSnapshot(await this.loadEvidenceSnapshot({ ref }));
  }

  private async validateSources(records: readonly NoteRecord[], ref: string): Promise<void> {
    await this.validateSourcesWithLookup(records, (id) => this.findReverie(id, ref));
  }

  private async findReverie(id: string, ref: string): Promise<boolean> {
    for (const entry of await this.evidenceNotes(ref)) {
      const note = await this.readEvidenceNote(entry.object, ref);
      if (note === null) continue;
      const parsed = parseNote(note, "tolerant", { verifyIds: false });
      if (parsed.records.some((record) => record.type === "reverie" && record.id === id)) return true;
    }
    return false;
  }

  async suggestLineage(input: {
    readonly staged?: boolean;
    readonly revision?: string;
  } = {}): Promise<{
    readonly suggestions: readonly LineageSuggestion[];
    readonly parent: CommitId | null;
    readonly commit: CommitId | null;
  }> {
    const staged = input.staged === true;
    let parent: CommitId | null = null;
    let commit: CommitId | null = null;
    let raw: string;
    if (staged) {
      const head = await this.repository.resolveCommit("HEAD");
      raw = (await this.repository.run([
        "diff", "--cached", "--raw", "-z", "--abbrev=64", "-M50%", "-C50%", "HEAD",
      ])).stdout;
      parent = head;
      commit = null;
    } else {
      const revision = input.revision ?? "HEAD";
      commit = await this.repository.resolveCommit(revision);
      const parents = (await this.repository.run(["rev-list", "--parents", "-n", "1", commit]))
        .stdout.trim().split(" ").slice(1);
      parent = parents[0] === undefined ? null : commitId(parents[0]);
      if (parent === null) return { suggestions: [], parent: null, commit };
      raw = (await this.repository.run([
        "diff-tree", "--raw", "-z", "--abbrev=64", "-r", "-M50%", "-C50%", "--no-commit-id", String(parent), String(commit),
      ])).stdout;
    }
    const annotated = new Set((await this.evidenceNotes()).map((entry) => String(entry.object)));
    const suggestions: LineageSuggestion[] = [];
    for (const candidate of parseSimilarityCandidates(raw)) {
      // A proposal about content nobody decided anything about is noise.
      if (!annotated.has(String(candidate.from.subject))) continue;
      suggestions.push(...suggestLineage({
        from: candidate.from,
        to: candidate.to,
        score: candidate.score,
      }));
    }
    return { suggestions, parent, commit };
  }

}
