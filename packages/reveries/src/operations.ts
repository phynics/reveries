import {
  analyzeContinuity,
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
  factGraphDiagnostics,
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
  projectFactGraph,
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
  type FactGraphProjection,
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
import type { SubjectPairing } from "./continuity.ts";
import { suggestLineage, type LineageSuggestion } from "./lineage.ts";
import { projectTransitionAttestation } from "./projection.ts";
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
import { assertNoSecretMaterial, SECRET_SCAN_WARNING, scanSecretMaterial } from "./sensitive-evidence.ts";

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
  /** Structural fact projection over the note, including redacted facts. */
  readonly factGraph: FactGraphProjection;
  /**
   * Occurrence records on this subject, split by whether they are about the
   * occurrence on screen (RVR-014). Universal `active` output is unaffected.
   */
  readonly occurrences: readonly OccurrenceAnchor[];
  /** Lineage edges that name this subject as a predecessor or successor. */
  readonly lineage: readonly LineageRecord[];
}

/**
 * One occurrence record as it relates to a particular occurrence being shown
 * (RVR-014).
 *
 * The two groups are the display contract. `applicable` evidence is about the
 * occurrence on screen: either it is anchored at exactly this coordinate, or
 * explicit durable lineage derives this coordinate from its anchor. Anything
 * else is `anchored` — real evidence about a different occurrence, reported
 * with its own coordinate and never presented as if the shared blob made it
 * universal.
 */
export interface OccurrenceAnchor {
  readonly record: OccurrenceRecord;
  readonly occurrence: OccurrenceCoordinate;
  readonly applicable: boolean;
  /** Why the record is not applicable here, when it is not. */
  readonly reason: string | null;
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
  /** Fact-graph projection over the note's reverie, correction, and resolution records. */
  readonly factGraph: FactGraphProjection;
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
  readonly transitions: ReadonlyMap<TransitionId, { readonly record: TransitionSummary; readonly object: ObjectId }>;
  readonly attestations: ReadonlyMap<CommitId, readonly PublicationAttestation[]>;
  /** Lineage edges indexed by the commit whose note carries them (RVR-014). */
  readonly lineages: ReadonlyMap<CommitId, readonly LineageRecord[]>;
  readonly backlinks: ReadonlyMap<ReverieId, readonly ObjectId[]>;
  /** Structural fact projection across every entry: forks stay visible until resolved. */
  readonly factGraph: FactGraphProjection;
  /** Soft-redacted fact IDs, sorted: hidden from show/search, retained in bytes. */
  readonly redacted: readonly string[];
  /** First annotated object carrying each fact ID, for failure attribution. */
  readonly factLocations: ReadonlyMap<string, ObjectId>;
  readonly init: { readonly commit: CommitId; readonly record: ReveriesInit } | null;
  readonly initError: string | null;
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
    transitions: new Map(),
    attestations: new Map(),
    lineages: new Map(),
    backlinks: new Map(),
    factGraph: projectFactGraph([]),
    redacted: [],
    factLocations: new Map(),
    init: null,
    initError: null,
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

  static async openBareForReceive(cwd: string, notesTip: ObjectId): Promise<Reveries> {
    const repository = await GitRepository.openBare(cwd);
    if (await repository.objectType(notesTip) !== "commit") {
      throw new Error(`Proposed Reveries notes object is not a commit: ${notesTip}`);
    }
    return new Reveries(repository.withoutLazyFetch(), repository, notesTip);
  }

  /**
   * Grade the local evidence behind a result without touching the network.
   * Accepts an already-loaded snapshot view to avoid rescanning notes, and
   * an explicit object list whose local presence is required.
   */
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
  async recordOccurrence(input: RecordOccurrenceInput): Promise<OccurrenceResult> {
    if (input.revision === "index") {
      throw new Error(
        "An occurrence coordinate needs a commit, and staged content has none: commit the change first, then record the occurrence at that commit",
      );
    }
    const commit = await this.repository.resolveCommit(input.revision);
    const resolved = await this.repository.resolveSubject({ path: input.path, revision: input.revision });
    const occurrence: OccurrenceCoordinate = {
      commit,
      path: normalizeCoordinatePath(input.path),
      subject: resolved.object,
    };
    const record = createOccurrence(
      { ...input.semantic, occurrence },
      input.metadata,
      (bytes) => this.repository.hashObjectSync(bytes),
    );
    await this.mutateNotes(async (notes) => {
      await notes.append(occurrence.subject, canonicalRecord(record));
    });
    return {
      object: occurrence.subject,
      record,
      occurrence,
      paths: input.revision === "index"
        ? await this.repository.indexPathsForSubject(occurrence.subject)
        : await this.repository.pathsForSubject(occurrence.subject, input.revision),
    };
  }

  /**
   * Record a durable subject pairing on the commit that establishes it
   * (RVR-014). Every endpoint is resolved in the revision the edge names, and
   * the edge is refused unless `parent` really is a direct parent of `commit`,
   * because an unbound pairing could be applied to a change it does not
   * describe.
   */
  async recordLineage(input: RecordLineageInput): Promise<LineageResult> {
    const commit = await this.repository.resolveCommit(input.commit);
    const parent = await this.repository.resolveCommit(input.parent);
    const direct = (await this.repository.run([
      "show", "-s", "--format=%P", commit,
    ])).stdout.trim().split(" ").filter((value) => value.length > 0);
    if (!direct.includes(String(parent))) {
      throw new Error(
        `A lineage edge must bind the direct parent of ${commit}; ${parent} is not one of ${direct.join(", ") || "its parents"}`,
      );
    }
    const from: LineageEndpoint[] = [];
    for (const path of input.from) {
      from.push(await this.lineageEndpoint(path, parent, "from"));
    }
    const to: LineageEndpoint[] = [];
    for (const path of input.to) {
      to.push(await this.lineageEndpoint(path, commit, "to"));
    }
    // Every predecessor must actually carry evidence: pairing an unannotated
    // subject would create lineage about a decision that does not exist.
    const annotated = new Set((await this.evidenceNotes()).map((entry) => String(entry.object)));
    for (const endpoint of from) {
      if (!annotated.has(String(endpoint.subject))) {
        throw new Error(
          `Lineage from endpoint ${endpoint.path} has no annotated evidence at ${parent}; record the decision before pairing it`,
        );
      }
    }
    // The edge must already satisfy the same authority rule the check will
    // apply: every `from` occurrence disturbed by exactly this parent→commit
    // change, every `to` occurrence present in its result. An unchanged move
    // or copy disturbs nothing — the same subject is still reachable, so
    // continuity already holds and no edge is needed — and recording one
    // anyway would only fail later as contradictory-lineage. Refusing here
    // names the real problem instead of deferring it to the check.
    const changeTransitions = [
      ...await this.commitTransitions(String(parent), String(commit)),
      ...await this.treeSubjectTransitions(String(parent), String(commit), false),
    ];
    const disturbed = this.disturbedCoordinates(parent, changeTransitions);
    const resultCoordinates = await this.coordinatesInCommit(commit);
    const undisturbed = from.filter((endpoint) =>
      !disturbed.has(coordinateKey(String(parent), endpoint.path, String(endpoint.subject))));
    const absent = to.filter((endpoint) =>
      !resultCoordinates.has(coordinateKey(String(commit), endpoint.path, String(endpoint.subject))));
    if (undisturbed.length > 0 || absent.length > 0) {
      throw new Error(
        [
          `A lineage edge may only pair occurrences this change disturbs with occurrences present in its result:`,
          ...undisturbed.map((endpoint) =>
            `${endpoint.path} at ${endpoint.subject.slice(0, 12)} is not disturbed by ${parent} to ${commit}; an unchanged move or copy needs no lineage edge`),
          ...absent.map((endpoint) =>
            `${endpoint.path} at ${endpoint.subject.slice(0, 12)} is not present in ${commit}`),
        ].join(" "),
      );
    }
    const record = createLineage(
      {
        v: 1,
        kind: input.kind,
        parent,
        commit,
        from,
        to,
        transition: input.transition ?? null,
        ...input.semantic,
      },
      input.metadata,
      (bytes) => this.repository.hashObjectSync(bytes),
    );
    if (record.transition !== null && !(await this.loadCachedEvidenceSnapshot({})).transitions.has(record.transition)) {
      throw new Error(`Lineage transition ${record.transition} has no transition record`);
    }
    await this.mutateNotes(async (notes) => {
      await notes.append(commit, canonicalRecord(record));
    });
    return { commit, record, from: record.from, to: record.to };
  }

  /**
   * Record explicit lineage on the notes of its endpoints.
   *
   * Similarity may suggest an edge, never establish one, so this writes only
   * what the caller names: no disturbance test and no continuity obligation.
   * The same immutable record is written to every `to` endpoint's note when
   * `to` is non-empty, otherwise to every `from` endpoint's note. Note-level
   * union dedupes by record ID, so an edge stays discoverable from either end
   * and survives a rebase because endpoints are object IDs.
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
    if (note === null) {
      const completeness = await this.assessCompleteness({ annotatedObjects: [target.object] });
      const diagnostics = completeness.authoritative
        ? []
        : [`Evidence may be incomplete (${completeness.grade}): ${completeness.reasons.join("; ")}`];
      return {
        ...target,
        records: [],
        active: [],
        historical: [],
        diagnostics,
        paths: target.paths,
        completeness,
        factGraph: projectFactGraph([]),
        occurrences: [],
        lineage: await this.lineageTouching(target.object, input.includeRedacted === true),
      };
    }
    const parsed = parseNote(note, "tolerant", { verifyIds: false });
    const diagnostics = parsed.diagnostics.map((diagnostic) => diagnostic.message);
    const validRecords: NoteRecord[] = [];
    for (const record of parsed.records) {
      if (record.type === "reverie") {
        const expected = `rv:${await this.repository.hashObject(`${semanticPayload(record)}\n`)}`;
        if (expected !== record.id) {
          diagnostics.push(`semantic ID mismatch for ${record.id}`);
          continue;
        }
      }
      if (record.type === "correction") {
        const expected = `cr:${await this.repository.hashObject(`${correctionPayload(record)}\n`)}`;
        if (expected !== record.id) {
          diagnostics.push(`correction ID mismatch for ${record.id}`);
          continue;
        }
      }
      if (record.type === "resolution") {
        const expected = `rs:${await this.repository.hashObject(`${resolutionPayload(record)}\n`)}`;
        if (expected !== record.id) {
          diagnostics.push(`resolution ID mismatch for ${record.id}`);
          continue;
        }
      }
      if (record.type === "redaction") {
        const expected = `rd:${await this.repository.hashObject(`${redactionPayload(record)}\n`)}`;
        if (expected !== record.id) {
          diagnostics.push(`redaction ID mismatch for ${record.id}`);
          continue;
        }
      }
      validRecords.push(record);
    }
    const factGraph = projectFactGraph(validRecords);
    const includeRedacted = input.includeRedacted === true;
    const redacted = new Set(factGraph.redacted);
    const visibleRecords = includeRedacted
      ? validRecords
      : validRecords.filter((record) => {
        const id = recordFactId(record);
        return id === null || !redacted.has(id);
      });
    const suppressed = validRecords.length - visibleRecords.length;
    if (suppressed > 0) {
      diagnostics.push(`${suppressed} redacted record(s) suppressed from display; history retains them`);
    }
    const activeFacts = new Set(factGraph.active.map((record) => recordFactId(record)));
    const projection = projectActiveReveries(
      visibleRecords.filter((record): record is ReverieRecord => record.type === "reverie"),
    );
    diagnostics.push(...this.projectionDiagnostics(projection));
    diagnostics.push(...factGraphDiagnostics(factGraph));
    const completeness = await this.assessCompleteness({});
    return {
      ...target,
      records: visibleRecords,
      active: projection.active,
      historical: projection.historical,
      diagnostics,
      paths: target.paths,
      completeness,
      factGraph,
      occurrences: await this.occurrenceAnchors(
        target,
        // A corrected or superseded occurrence is historical, so it is reported
        // as history rather than as current evidence for this occurrence.
        visibleRecords.filter((record): record is OccurrenceRecord =>
          record.type === "occurrence" && activeFacts.has(record.id)),
        input.revision ?? "HEAD",
      ),
      lineage: await this.lineageTouching(target.object, input.includeRedacted === true),
    };
  }

  /**
   * Split the occurrence records on one subject into the ones that are about
   * the occurrence on screen and the ones that are anchored elsewhere
   * (RVR-014).
   *
   * A shared blob is exactly why this distinction matters: two paths holding
   * one blob have different rationales, and reporting the `vendor/` decision as
   * if it applied to `src/` because the object IDs match would be a false
   * claim about applicability. Evidence about the current occurrence is
   * applicable only when the anchor is this coordinate, or when explicit
   * durable lineage derives this coordinate from the anchor. An unchanged
   * descendant commit is therefore reported as anchored historical evidence —
   * never silently re-applied to every occurrence.
   */
  private async occurrenceAnchors(
    target: {
      readonly object: ObjectId;
      readonly paths: readonly string[];
      readonly requestedPath: string | null;
    },
    records: readonly OccurrenceRecord[],
    revision: string,
  ): Promise<readonly OccurrenceAnchor[]> {
    if (records.length === 0) return [];
    const shownPaths = new Set(
      (target.requestedPath === null ? target.paths : [target.requestedPath]).map(normalizeCoordinatePath),
    );
    let shownCommit: CommitId | null = null;
    try {
      shownCommit = revision === "index" ? null : await this.repository.resolveCommit(revision);
    } catch {
      shownCommit = null;
    }
    const { derivation } = shownCommit === null
      ? { derivation: new Map() as OccurrenceDerivation }
      : await this.occurrenceDerivation(shownCommit);
    const anchors: OccurrenceAnchor[] = [];
    for (const record of records) {
      const coordinate = record.occurrence;
      // The direct anchor: this record is about this path holding this subject.
      if (shownCommit !== null
        && String(coordinate.commit) === String(shownCommit)
        && coordinate.subject === target.object
        && shownPaths.has(normalizeCoordinatePath(coordinate.path))) {
        anchors.push({ record, occurrence: coordinate, applicable: true, reason: null });
        continue;
      }
      const shownPath = target.requestedPath ?? target.paths[0];
      const shown: OccurrenceCoordinate | null = shownCommit === null || shownPath === undefined ? null : {
        commit: shownCommit,
        path: normalizeCoordinatePath(shownPath),
        subject: target.object,
      };
      const via = shown === null ? [] : deriveLineage(derivation, shown, coordinate);
      if (via.length > 0) {
        anchors.push({
          record,
          occurrence: coordinate,
          applicable: true,
          reason: `carried forward by lineage ${via.join(", ")}`,
        });
        continue;
      }
      anchors.push({
        record,
        occurrence: coordinate,
        applicable: false,
        reason: `anchored at ${coordinate.path}@${coordinate.commit}; it describes that occurrence, not this one`,
      });
    }
    return anchors.sort((left, right) => (left.record.id < right.record.id ? -1 : left.record.id > right.record.id ? 1 : 0));
  }

  /**
   * Every durable edge in the snapshot as a backward map from a coordinate to
   * the coordinates it derives from. Used for display and path history, never
   * for a continuity verdict, which re-derives authority per checked change.
   */
  /** Every durable lineage edge in the evidence, indexed by its commit. */
  private async lineageEdges(): Promise<ReadonlyMap<CommitId, readonly LineageRecord[]>> {
    const tip = this.proposedNotesTip ?? await this.repository.notesTip(NOTES_REF);
    const key = `${String(tip)}`;
    if (this.lineageIndex?.key === key) return this.lineageIndex.edges;
    const view = await this.evidenceView();
    this.lineageIndex = { key, edges: view.lineages };
    return view.lineages;
  }

  /**
   * Every durable edge in the snapshot as a backward map from a coordinate to
   * the coordinates it derives from. Used for display and path history, never
   * for a continuity verdict, which re-derives authority per checked change.
   *
   * Coordinates are bound to the commit that established them, so after an
   * unrelated later commit no key matches the reference revision. Each edge is
   * therefore also carried forward by same-path OID identity: when the
   * reference revision still holds the same subject at the same path, and the
   * edge's commit is a real ancestor of it, the walk may step from the current
   * coordinate back to the edge's coordinate under the same edge ID. Without
   * this an unrelated commit would silently drop an explicit trail; with it a
   * moved path keeps its history until the path itself moves on. Branches can
   * never borrow each other's lineage: the ancestry check refuses that.
   */
  private async occurrenceDerivation(reference: CommitId | null): Promise<{
    readonly derivation: OccurrenceDerivation;
    readonly silent: ReadonlySet<string>;
  }> {
    const index = await this.lineageEdges();
    const derivation = new Map<string, { coordinate: OccurrenceCoordinate; lineage: LineageId }[]>();
    const silent = new Set<string>();
    const stepId = (from: OccurrenceCoordinate, lineage: LineageId): string =>
      `${coordinateKey(String(from.commit), from.path, String(from.subject))}\u0001${lineage}`;
    const link = (
      at: OccurrenceCoordinate,
      from: OccurrenceCoordinate,
      lineage: LineageId,
      bridge: boolean,
    ): void => {
      const key = coordinateKey(String(at.commit), at.path, String(at.subject));
      const previous = coordinateKey(String(from.commit), from.path, String(from.subject));
      const list = derivation.get(key) ?? [];
      if (!list.some((entry) =>
        entry.lineage === lineage
        && coordinateKey(
          String(entry.coordinate.commit),
          entry.coordinate.path,
          String(entry.coordinate.subject),
        ) === previous)) {
        list.push({ coordinate: from, lineage });
        if (bridge) silent.add(stepId(from, lineage));
      }
      derivation.set(key, list);
    };
    for (const edges of index.values()) {
      for (const edge of edges) {
        for (const endpoint of edge.to) {
          const at: OccurrenceCoordinate = {
            commit: edge.commit,
            path: endpoint.path,
            subject: endpoint.subject,
          };
          for (const source of edge.from) {
            link(at, { commit: edge.parent, path: source.path, subject: source.subject }, edge.id, false);
          }
          if (reference !== null && String(edge.commit) !== String(reference)) {
            try {
              const ancestor = await this.repository.run(
                ["merge-base", "--is-ancestor", String(edge.commit), String(reference)],
                { allowExitCodes: [0, 1] },
              );
              if (ancestor.exitCode !== 0) continue;
              const current = await this.repository.resolveSubject({
                path: endpoint.path,
                revision: String(reference),
              });
              if (current.object !== endpoint.subject) continue;
              link(
                {
                  commit: reference,
                  path: normalizeCoordinatePath(endpoint.path),
                  subject: endpoint.subject,
                },
                at,
                edge.id,
                true,
              );
            } catch {
              // The path moved on or is unreadable at the reference revision:
              // no bridge, and no claim about where it went.
            }
          }
        }
      }
    }
    return { derivation, silent };
  }

  /** Lineage edges that name a subject on either side of the relation. */
  private async lineageTouching(
    subject: ObjectId,
    includeRedacted = false,
  ): Promise<readonly LineageRecord[]> {
    const index = await this.lineageEdges();
    // Redactions of lineage edges live on commit notes, beside the edges, so
    // the note-local graph that filters `records` never sees them: only the
    // global redacted set hides them here.
    const redacted = includeRedacted ? new Set<string>() : new Set((await this.evidenceView()).redacted);
    const touching: LineageRecord[] = [];
    for (const edges of index.values()) {
      for (const edge of edges) {
        if (redacted.has(edge.id)) continue;
        if (edge.from.some((endpoint) => endpoint.subject === subject)
          || edge.to.some((endpoint) => endpoint.subject === subject)) {
          touching.push(edge);
        }
      }
    }
    return touching.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  }

  /**
   * Notes-mutation operation wrapper: owns the retry/replay policy while
   * `GitRepository.withNotesWrite` owns ref updates and temporary-ref
   * handling. The canonical-tip compare-and-swap stays the final
   * publication guard; contention replays this pure mutation against the
   * new tip with bounded backoff, and exhaustion throws
   * `NotesContentionError` (explicit bounded contention, never silent loss).
   *
   * Replay contract: `mutation` may run more than once per call. Every read
   * must go through `notes.read` inside the closure; no consumed iterators
   * or single-use state may be captured outside it.
   */
  async mutateNotes<T>(
    mutation: (notes: NotesTransaction) => Promise<T>,
    options: WithNotesWriteOptions = {},
  ): Promise<T> {
    return this.repository.withNotesWrite(
      async (notes) => mutation({
        ref: notes.ref,
        read: (object) => notes.read(object),
        append: async (object, canonicalLine) => {
          assertNoSecretMaterial(canonicalLine, "Evidence record");
          await notes.append(object, canonicalLine);
        },
        replace: async (object, canonicalBody) => {
          const existing = await notes.read(object);
          const existingLines = new Set(existing?.split("\n").filter((line) => line.length > 0) ?? []);
          const additions = canonicalBody.split("\n").filter((line) => line.length > 0 && !existingLines.has(line));
          assertNoSecretMaterial(additions.join("\n"), "Evidence record");
          await notes.replace(object, canonicalBody);
        },
      }),
      (ref) => this.validateNotesRef(ref),
      undefined,
      options,
    );
  }

  async summarize(input: {
    readonly commit: string;
    readonly summary: SessionSummary;
    readonly replace?: boolean;
  }): Promise<void> {
    const commit = await this.repository.resolveCommit(input.commit);
    validateNote([input.summary], { verifyIds: false });
    await this.mutateNotes(async (notes) => {
      if (input.replace !== true) {
        await notes.append(commit, canonicalRecord(input.summary));
        return;
      }
      const existing = await notes.read(commit);
      const records = existing === null ? [] : parseNote(existing, "strict", { verifyIds: false }).records;
      const retained = records.filter((record) => record.type !== "session-summary");
      await notes.replace(commit, [input.summary, ...retained].map(canonicalRecord).join(""));
    });
  }

  async commitWithSummary(input: {
    readonly message: string;
    readonly summary: SessionSummary;
  }): Promise<CommitId> {
    validateNote([input.summary], { verifyIds: false });
    assertNoSecretMaterial(canonicalRecord(input.summary), "Session summary");
    return this.repository.commitWithNote({
      message: input.message,
      note: canonicalRecord(input.summary),
      validateNotesRef: (ref) => this.validateNotesRef(ref),
    });
  }

  /**
   * Resolved tree pair for a commit: ordered parent trees (`[]` for a root)
   * plus the result tree. The pair plus causal fields is the RVR-004
   * transition identity; it survives metadata-only amends and publication
   * rewrites, while a rebase onto a changed tree yields a new pair.
   */
  async transitionTreesForCommit(commit: CommitId): Promise<TransitionTrees> {
    const [parents, result] = await Promise.all([
      this.repository.parentTreesForCommit(commit),
      this.repository.resultTreeForCommit(commit),
    ]);
    return { parents, result };
  }

  /** Canonical `tr:` identity for a tree pair plus causal content. */
  async transitionIdentityFor(input: TransitionInput): Promise<TransitionId> {
    const format = await this.repository.objectFormat();
    return transitionId(`tr:${hashBlobContent(`${transitionPayload(input)}\n`, format)}`);
  }

  /** Tree pair plus identity for an existing commit and causal content. */
  async transitionIdentityForCommit(commit: CommitId, causal: TransitionCausal): Promise<
    TransitionTrees & { readonly transition: TransitionId }
  > {
    const trees = await this.transitionTreesForCommit(commit);
    const transition = await this.transitionIdentityFor({ ...causal, ...trees });
    return { ...trees, transition };
  }

  /**
   * Record a transition summary on its result tree object. Adapted evidence
   * for a rebased transition cites the previous commit with a
   * `derived-from` commit-kind source in its causal fields.
   */
  async recordTransition(input: {
    readonly parents: readonly ObjectId[];
    readonly result: ObjectId;
    readonly causal: TransitionCausal;
    readonly metadata: TransitionMetadata;
  }): Promise<{ readonly record: TransitionSummary }> {
    for (const parent of input.parents) {
      if (!(await this.repository.treeExists(parent))) {
        throw new Error(`Parent tree ${parent} is not a tree`);
      }
    }
    if (!(await this.repository.treeExists(input.result))) {
      throw new Error(`Result tree ${input.result} is not a tree`);
    }
    const format = await this.repository.objectFormat();
    const record = createTransition(
      { ...input.causal, parents: input.parents, result: input.result },
      input.metadata,
      (bytes) => hashBlobContent(bytes, format),
    );
    await this.mutateNotes(async (notes) => {
      await notes.append(input.result, canonicalRecord(record));
    });
    return { record };
  }

  /** Record a minimal publication attestation on its commit. */
  async recordAttestation(input: {
    readonly commit: string;
    readonly transition: TransitionId;
    readonly publisher: string;
    readonly metadata: TransitionMetadata;
  }): Promise<{ readonly record: PublicationAttestation }> {
    const commit = await this.repository.resolveCommit(input.commit);
    const record = createAttestation(
      { commit, transition: input.transition, publisher: input.publisher },
      input.metadata,
    );
    await this.mutateNotes(async (notes) => {
      await notes.append(commit, canonicalRecord(record));
    });
    return { record };
  }

  /**
   * Append a correction fact to an existing object. Never rewrites an old
   * canonical line: a correction that overlaps another correction's heads
   * forms a visible fork until a resolution names every head.
   */
  async recordCorrection(input: {
    readonly object: ObjectId;
    readonly correction: CorrectionInput;
    readonly metadata: ReverieMetadata;
  }): Promise<{ readonly record: CorrectionRecord }> {
    if (await this.repository.objectType(input.object) === null) {
      throw new Error(`Cannot attach a correction to missing object ${input.object}`);
    }
    const format = await this.repository.objectFormat();
    const record = createCorrection(
      input.correction,
      input.metadata,
      (bytes) => hashBlobContent(bytes, format),
    );
    await this.mutateNotes(async (notes) => {
      await notes.append(input.object, canonicalRecord(record));
    });
    return { record };
  }

  /**
   * Append a resolution fact that names conflicting heads. The fork
   * converges only when `resolves` covers every terminal head; partial
   * coverage stays visible as a fork.
   */
  async recordResolution(input: {
    readonly object: ObjectId;
    readonly resolution: ResolutionInput;
    readonly metadata: ReverieMetadata;
  }): Promise<{ readonly record: ResolutionRecord }> {
    if (await this.repository.objectType(input.object) === null) {
      throw new Error(`Cannot attach a resolution to missing object ${input.object}`);
    }
    const format = await this.repository.objectFormat();
    const record = createResolution(
      input.resolution,
      input.metadata,
      (bytes) => hashBlobContent(bytes, format),
    );
    await this.mutateNotes(async (notes) => {
      await notes.append(input.object, canonicalRecord(record));
    });
    return { record };
  }

  /**
   * Append a soft-redaction fact. Normal display and search skip the target
   * afterwards; history and snapshot bytes keep the immutable record.
   */
  async recordRedaction(input: {
    readonly object: ObjectId;
    readonly target: FactTargetId;
    readonly reason: string;
    readonly metadata: ReverieMetadata;
  }): Promise<{ readonly record: RedactionRecord }> {
    if (await this.repository.objectType(input.object) === null) {
      throw new Error(`Cannot attach a redaction to missing object ${input.object}`);
    }
    const format = await this.repository.objectFormat();
    const record = createRedaction(
      { v: 1, target: input.target, reason: input.reason },
      input.metadata,
      (bytes) => hashBlobContent(bytes, format),
    );
    await this.mutateNotes(async (notes) => {
      await notes.append(input.object, canonicalRecord(record));
    });
    return { record };
  }

  /**
   * Hard redaction (RVR-018): remove named facts from every local copy of the
   * evidence and leave a verifiable discontinuity checkpoint behind.
   *
   * Soft redaction hides a record from normal projection while its bytes stay in
   * the repository. This is the deliberate alternative, so it is deliberately
   * narrow about what it claims:
   *
   * - Only the named ID-bearing facts, and the signatures that attest exactly
   *   them, leave the snapshot. Everything else is copied byte for byte, so
   *   surviving history keeps its identities and its continuity claims.
   * - The rewritten notes commit is a **new root**, not a descendant: the
   *   removed lines are not reachable from the new canonical tip.
   * - The new genesis ledger checkpoint names that commit and no previous
   *   ledger, which is what makes the discontinuity visible to a reader who
   *   follows the envelope. Ordinary append-only verification does not apply
   *   across it, and that is the point rather than a defect.
   * - The local retention refs and the stale remote-tracking and quarantine refs
   *   are deleted in one transaction with the two canonical moves.
   * - Nothing here contacts a mirror, an archive, a bundle, or any other clone.
   *   Those requests are returned as `remoteActions`, and `disclaimer` states
   *   that local completion is not proof of deletion anywhere else.
   */
  async hardRedact(input: {
    readonly targets: readonly FactTargetId[];
    /** Non-sensitive justification kept in the tombstone redaction records. */
    readonly reason: string;
    readonly metadata: ReverieMetadata;
    /** Expected canonical tips; omitted defaults to what is present now. */
    readonly expectedNotes?: ObjectId | null;
    readonly expectedLedger?: ObjectId | null;
    /** Sign the discontinuity checkpoint when a signer is configured. */
    readonly sign?: boolean;
    readonly signingRole?: SignatureRole;
  }): Promise<HardRedactionResult> {
    const disclaimer = HARD_REDACTION_DISCLAIMER;
    const format = await this.repository.objectFormat();
    const notesBefore = await this.repository.notesTip();
    const ledgerBefore = await this.repository.ledgerTip();
    const empty = (diagnostics: string[], state: "unchanged" | "refused", extra: Partial<HardRedactionResult> = {}): HardRedactionResult => ({
      ok: state !== "refused",
      diagnostics,
      state,
      removed: [],
      rewrittenSubjects: [],
      notesBefore,
      notesAfter: notesBefore,
      ledgerBefore,
      ledgerAfter: ledgerBefore,
      severedRefs: [],
      remoteActions: [],
      disclaimer,
      ...extra,
    });

    const targets = [...new Set(input.targets)].sort(compareUtf8Ids);
    if (targets.length === 0) {
      return empty(["Hard redaction requires at least one fact ID"], "refused");
    }
    if (notesBefore === null) {
      return empty(["The local Reveries notes ref does not exist, so there is nothing to redact"], "unchanged");
    }
    const activeTransactions = await this.repository.listTemporaryNotesRefs();
    if (activeTransactions.length > 0) {
      return empty(
        [`Hard redaction refused: ${activeTransactions.length} live Reveries note transaction(s) must finish or be repaired first`],
        "refused",
      );
    }

    // Locate every target before changing anything. An unknown ID is a refusal,
    // not a silent no-op: an operator who named a wrong ID must not be told the
    // repository was cleaned.
    const view = await this.loadEvidenceSnapshot({});
    const removedSet = new Set<string>(targets as readonly string[]);
    const located = new Map<string, ObjectId[]>();
    for (const entry of view.entries) {
      for (const record of entry.records) {
        const id = recordFactId(record);
        if (id === null || !removedSet.has(id)) continue;
        located.set(id, [...(located.get(id) ?? []), entry.object]);
      }
    }
    const alreadyRemoved = new Set<string>(
      view.entries.flatMap((entry) => entry.records.flatMap((record) => record.type === "redaction" ? [record.target] : [])),
    );
    const missing = targets.filter((id) => !located.has(id as string));
    if (missing.length > 0) {
      // A repeat of a completed redaction converges instead of failing: the
      // record is gone because this operation already removed it and left a
      // tombstone. An ID that was never here is still a refusal.
      const unredacted = missing.filter((id) => !alreadyRemoved.has(id as string));
      if (unredacted.length > 0) {
        return empty([`Hard redaction refused: no record in this repository carries ${unredacted.join(", ")}`], "refused");
      }
      return empty(
        [`Hard redaction already removed ${missing.join(", ")}; the sanitized snapshot is unchanged`],
        "unchanged",
      );
    }
    const rewritten = new Set<ObjectId>([...located.values()].flat());

    // Build the sanitized bodies. Only the target lines and the signatures that
    // attest exactly those targets are dropped; a signature over anything else
    // still attests what it claims.
    const sanitized = [...view.entries].map((entry) => {
      const kept = entry.records.filter((record) => {
        const id = recordFactId(record);
        if (id !== null && removedSet.has(id)) return false;
        return !(record.type === "signature" && removedSet.has(record.target));
      });
      const tombstones = targets
        .filter((id) => located.get(id as string)?.includes(entry.object))
        .map((id) => createRedaction(
          { v: 1, target: id, reason: input.reason },
          input.metadata,
          (bytes) => hashBlobContent(bytes, format),
        ));
      // Surviving lines keep their relative order and their exact bytes; the
      // tombstones are appended. A repeated hard redaction converges because an
      // identical tombstone is written once rather than accumulated.
      const lines = [...kept.map((record) => canonicalRecord(record))];
      for (const tombstone of tombstones) {
        const line = canonicalRecord(tombstone);
        if (!lines.includes(line)) lines.push(line);
      }
      return { subject: entry.object, body: lines.join("") };
    }).filter((note) => note.body.length > 0);

    let notesAfter: ObjectId;
    try {
      notesAfter = await this.repository.createNotesSnapshotFromEmpty(
        sanitized,
        async (ref) => this.validateNotesRef(ref),
      );
    } catch (error: unknown) {
      return empty([`Hard redaction refused: ${error instanceof Error ? error.message : String(error)}`], "refused");
    }
    if (notesAfter === notesBefore) {
      return empty(["Hard redaction left the notes snapshot unchanged"], "unchanged", {
        notesAfter,
        ledgerAfter: ledgerBefore,
      });
    }

    // The discontinuity checkpoint is a genesis checkpoint over the sanitized
    // commit: `previous_ledger` is null because the old chain still describes
    // history this repository has just removed.
    const notesTree = await this.repository.treeForCommit(notesAfter);
    let totals = { subjects: 0, records: 0, noteBytes: 0 };
    for (const note of sanitized) {
      totals = {
        subjects: totals.subjects + 1,
        records: totals.records + note.body.split("\n").filter((line) => line.length > 0).length,
        noteBytes: totals.noteBytes + Buffer.byteLength(note.body, "utf8"),
      };
    }
    let authority: string | null;
    try {
      authority = (await this.authorityStatus()).primary;
    } catch (error: unknown) {
      return empty(
        [`Hard redaction refused: ${error instanceof Error ? error.message : String(error)}`],
        "refused",
        { notesAfter },
      );
    }
    let checkpoint: ObjectId;
    try {
      const manifest = createLedgerManifest({
        notes_commit: notesAfter,
        notes_tree: notesTree,
        previous_ledger: null,
        retention_commit: null,
        authority,
        annotated_subjects: totals.subjects,
        records: totals.records,
        note_bytes: totals.noteBytes,
      });
      const signed = input.sign === false ? null : await this.signLedgerManifest(manifest, input.signingRole ?? "publisher");
      checkpoint = await this.repository.commitLedgerCheckpoint({
        manifest,
        ...(signed === null ? {} : { signatures: signed }),
      });
    } catch (error: unknown) {
      return empty(
        [`Hard redaction refused: the discontinuity checkpoint could not be built: ${error instanceof Error ? error.message : String(error)}`],
        "refused",
        { notesAfter },
      );
    }
    const verification = await this.verifyLedgerEnvelope(checkpoint);
    if (!verification.ok) {
      return empty(
        [`Hard redaction refused: the discontinuity checkpoint failed verification: ${verification.diagnostics.join("; ")}`],
        "refused",
        { notesAfter },
      );
    }

    const vault = await this.retentionVault();
    const obsolete = await this.staleEvidenceRefs([notesBefore, ledgerBefore].filter((tip): tip is ObjectId => tip !== null));
    const expectedNotes = input.expectedNotes === undefined ? notesBefore : input.expectedNotes;
    const expectedLedger = input.expectedLedger === undefined ? ledgerBefore : input.expectedLedger;
    try {
      await this.repository.replaceEvidenceRefsAfterHardRedaction({
        notesCommit: notesAfter,
        ledgerCheckpoint: checkpoint,
        expectedNotes,
        expectedLedger,
        expectedRetention: vault.commit,
        obsoleteRefs: obsolete,
      });
    } catch (error: unknown) {
      // Nothing moved: the candidate snapshot and checkpoint exist only as
      // unreachable objects, so the report names the tips that are still live
      // rather than the candidates it could not publish.
      return empty(
        [`Hard redaction refused: ${error instanceof Error ? error.message : String(error)}`],
        "refused",
      );
    }

    return {
      ok: true,
      diagnostics: [],
      state: "redacted",
      removed: targets,
      rewrittenSubjects: [...rewritten].sort(compareUtf8Ids),
      notesBefore,
      notesAfter,
      ledgerBefore,
      ledgerAfter: checkpoint,
      severedRefs: obsolete.map(({ ref }) => ref).sort(compareUtf8Ids),
      remoteActions: await this.hardRedactionRemoteActions(),
      disclaimer,
    };
  }

  /**
   * Local refs that still hold the pre-redaction evidence: fetched remote-tracking
   * notes and envelopes plus every held quarantine candidate. Remote-tracking
   * *code* branches are untouched because they are ordinary code, not evidence.
   */
  private async staleEvidenceRefs(removedTips: readonly ObjectId[]): Promise<{ ref: string; expected: ObjectId }[]> {
    if (removedTips.length === 0) return [];
    const listed = await this.repository.run(["for-each-ref", "--format=%(refname) %(objectname)"], {
      allowExitCodes: [0, 1, 128],
    });
    const stale: { ref: string; expected: ObjectId }[] = [];
    for (const line of listed.stdout.split("\n")) {
      if (line.length === 0) continue;
      const [ref, value] = line.split(" ");
      if (ref === undefined || value === undefined) continue;
      if (!isStaleEvidenceRef(ref)) continue;
      const tip = objectId(value);
      for (const removed of removedTips) {
        if (tip === removed || await this.repository.isAncestor(tip, removed)) {
          stale.push({ ref, expected: tip });
          break;
        }
      }
    }
    return stale;
  }

  /**
   * The remote-side work a hard redaction cannot do. It names each configured
   * remote and the command an operator runs from a clone that has that remote
   * configured; it never contacts the remote itself, so a mirror that ignores
   * the request is never reported as done.
   */
  private async hardRedactionRemoteActions(): Promise<readonly HardRedactionRemoteAction[]> {
    const roles = (await this.authorityStatus()).roles;
    return [...(await this.configuredRemoteNames())].sort(compareUtf8Ids).map((remote) => ({
      remote,
      role: roles.get(remote) ?? "unassigned",
      action: `git push ${remote} --delete refs/notes/reveries refs/heads/reveries-ledger`,
    }));
  }

  /**
   * Validate transition evidence for a tree pair without requiring a final
   * commit ID, so squash and merge-group candidates validate before
   * publication creates the commit. Fails closed when no transition record
   * covers the exact pair, when several competing records cover it, or when
   * an expected identity names no matching record.
   */
  async checkCandidateTransition(input: {
    readonly parents: readonly ObjectId[];
    readonly result: ObjectId;
    readonly transition?: TransitionId;
  }): Promise<TransitionCheckResult> {
    for (const parent of input.parents) {
      if (!(await this.repository.treeExists(parent))) {
        return { ok: false, diagnostics: [`Parent tree ${parent} is not a tree`], coverage: "none", transition: null };
      }
    }
    if (!(await this.repository.treeExists(input.result))) {
      return { ok: false, diagnostics: [`Result tree ${input.result} is not a tree`], coverage: "none", transition: null };
    }
    const view = await this.loadCachedEvidenceSnapshot({});
    const onResult = [...view.transitions.values()].filter(({ record }) =>
      record.result === input.result
      && record.parents.length === input.parents.length
      && record.parents.every((parent, index) => parent === input.parents[index]));
    const pair = `parents [${input.parents.join(", ")}] → ${input.result}`;
    if (input.transition !== undefined) {
      const match = onResult.find(({ record }) => record.id === input.transition);
      if (match === undefined) {
        return {
          ok: false,
          diagnostics: [`Transition ${input.transition} has no record for ${pair}`],
          coverage: "none",
          transition: null,
        };
      }
      return { ok: true, diagnostics: [], coverage: "transition", transition: match.record.id };
    }
    if (onResult.length === 0) {
      return {
        ok: false,
        diagnostics: [`No transition evidence for ${pair}; record a transition summary or adapted evidence`],
        coverage: "none",
        transition: null,
      };
    }
    const ids = onResult.map(({ record }) => record.id).sort();
    if (ids.length > 1) {
      return {
        ok: false,
        diagnostics: [`${pair} has more than one transition explanation: ${ids.join(", ")}`],
        coverage: "none",
        transition: null,
      };
    }
    return { ok: true, diagnostics: [], coverage: "transition", transition: ids[0] as TransitionId };
  }

  /**
   * Validate a published commit's transition coverage: an exact attested
   * transition wins; otherwise a readable V1 session summary covers the
   * commit through the bridge projection. Commits with neither fail.
   */
  async checkCommitTransition(revision: string): Promise<TransitionCheckResult> {
    const commit = await this.repository.resolveCommit(revision);
    const trees = await this.transitionTreesForCommit(commit);
    const view = await this.loadCachedEvidenceSnapshot({});
    const projection = projectTransitionAttestation({
      commit,
      parents: trees.parents,
      result: trees.result,
      attestations: view.attestations.get(commit) ?? [],
      transitions: [...view.transitions.values()].map((entry) => entry.record),
    });
    if (projection.transition !== null) {
      return { ok: true, diagnostics: [], coverage: "transition", transition: projection.transition.id };
    }
    if (await this.projectV1SummaryForTransition(commit) !== null) {
      return { ok: true, diagnostics: [], coverage: "v1-summary", transition: null };
    }
    return { ok: false, diagnostics: projection.diagnostics, coverage: "none", transition: null };
  }

  /**
   * V1 bridge: project a commit's session summary onto its resolved tree
   * pair when both sides are known. V1 summaries stay readable as
   * transition coverage without inventing a `tr:` identity for them.
   */
  async projectV1SummaryForTransition(commit: CommitId): Promise<{
    readonly parents: readonly ObjectId[];
    readonly result: ObjectId;
    readonly summary: SessionSummary;
  } | null> {
    const summary = await this.commitSessionSummary(commit);
    if (summary === null) return null;
    const trees = await this.transitionTreesForCommit(commit);
    return { ...trees, summary };
  }

  /**
   * Validate claimed transition evidence against the proposed notes tip.
   * Used by the receive checker: every item needs a self-consistent
   * transition record on its result tree. Never requires a final commit.
   */
  async checkProposedTransitions(
    items: readonly { parents: readonly ObjectId[]; result: ObjectId; transition: TransitionId }[],
  ): Promise<CheckResult> {
    const diagnostics: string[] = [];
    const format = await this.repository.objectFormat();
    for (const item of items) {
      const note = await this.readEvidenceNote(item.result);
      if (note === null) {
        diagnostics.push(`Transition ${item.transition} has no evidence on result tree ${item.result}`);
        continue;
      }
      let records: readonly NoteRecord[];
      try {
        records = parseNote(note, "strict", { verifyIds: false }).records;
      } catch (error: unknown) {
        diagnostics.push(`Result tree ${item.result}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      const found = records.find((record): record is TransitionSummary =>
        record.type === "transition-summary" && record.id === item.transition);
      if (found === undefined) {
        diagnostics.push(`Result tree ${item.result} carries no ${item.transition} transition record`);
        continue;
      }
      const expected = `tr:${hashBlobContent(`${transitionPayload(found)}\n`, format)}`;
      if (expected !== found.id) {
        diagnostics.push(`Transition record ${found.id} fails identity verification`);
        continue;
      }
      const parentsMatch = found.parents.length === item.parents.length
        && found.parents.every((parent, index) => parent === item.parents[index]);
      if (!parentsMatch || found.result !== item.result) {
        diagnostics.push(`Transition ${found.id} does not match the claimed trees`);
      }
    }
    return { ok: diagnostics.length === 0, diagnostics };
  }

  async synthesizeHostedSummary(input: HostedSummaryInput): Promise<HostedSummaryPlan> {
    const commit = await this.repository.resolveCommit(input.commit);
    if (await this.commitSessionSummary(commit) !== null) {
      return {
        commit,
        state: "already-summarized",
        entries: [],
        diagnostics: [`Commit ${commit} already has a valid session summary`],
      };
    }
    const diagnostics: string[] = [];
    if (input.sourceCommits.length === 0) {
      return { commit, state: "unsummarizable", entries: [], diagnostics: [`Commit ${commit} has no source commits`] };
    }
    const [firstParent] = await this.commitParents(commit);
    const changedFrom = firstParent === undefined
      ? new Set<ObjectId>()
      : new Set<ObjectId>((await this.commitTransitions(firstParent, commit)).map((transition) => transition.from));
    const entries: SummaryEntry[] = [];
    for (const source of input.sourceCommits) {
      const sourceCommit = await this.repository.resolveCommit(source);
      const summary = await this.commitSessionSummary(sourceCommit);
      if (summary === null) {
        diagnostics.push(`Source commit ${sourceCommit} has no valid session summary`);
        continue;
      }
      for (const entry of summary.entries) {
        entries.push({
          ...entry,
          sources: [...entry.sources, { relation: "derived-from", kind: "commit", ref: sourceCommit }],
          retirements: entry.retirements.filter((retirement) => changedFrom.has(retirement.from_blob)),
        });
      }
    }
    if (entries.length === 0) {
      return { commit, state: "unsummarizable", entries: [], diagnostics };
    }
    return { commit, state: "ready", entries, diagnostics };
  }

  async attachHostedSummary(input: AttachHostedSummaryInput): Promise<AttachHostedSummaryResult> {
    const commit = await this.repository.resolveCommit(input.commit);
    validateNote([input.summary], { verifyIds: false });
    const check = await this.checkCommitAgainst(commit, input.summary);
    if (!check.ok) {
      throw new Error(
        `Session summary for ${commit} fails strict validation: ${check.diagnostics.join("; ")}`,
      );
    }
    return this.mutateNotes(async (notes) => {
      const existing = await notes.read(commit);
      const records = existing === null
        ? []
        : parseNote(existing, "strict", { verifyIds: false }).records;
      const summary = records.find((record): record is SessionSummary => record.type === "session-summary");
      if (summary !== undefined) {
        return {
          commit,
          state: "already-summarized" as const,
          summary,
          diagnostics: [`Commit ${commit} already has a session summary`],
        };
      }
      await notes.append(commit, canonicalRecord(input.summary));
      return { commit, state: "attached" as const, summary: input.summary, diagnostics: [] };
    });
  }

  async publishNotes(input: PublishNotesInput): Promise<PublishNotesResult> {
    const remote = input.remote;
    const maximum = input.attempts ?? 3;
    if (await this.repository.notesTip() === null) {
      return {
        ok: false,
        attempts: 0,
        remoteTip: null,
        diagnostics: ["The local Reveries notes ref does not exist"],
      };
    }
    const secretDiagnostics = await this.secretMaterialDiagnostics(await this.evidenceView());
    if (secretDiagnostics.length > 0) {
      return {
        ok: false,
        attempts: 0,
        remoteTip: null,
        diagnostics: secretDiagnostics,
      };
    }
    const diagnostics: string[] = [];
    for (let attempt = 1; attempt <= maximum; attempt += 1) {
      const expected = await this.liveRepository.remoteObject(remote, NOTES_REF);
      const incorporated = await this.checkRemoteNotesIncorporated(remote, expected);
      if (!incorporated.ok) {
        const synced = await this.syncPull(remote);
        if (!synced.ok) {
          return {
            ok: false,
            attempts: attempt,
            remoteTip: expected,
            diagnostics: [...incorporated.diagnostics, ...synced.diagnostics],
          };
        }
      }
      const lease = expected ?? "0".repeat((await this.repository.objectFormat()) === "sha1" ? 40 : 64);
      const push = await this.liveRepository.run(
        [
          "push",
          `--force-with-lease=${NOTES_REF}:${lease}`,
          remote,
          `${NOTES_REF}:${NOTES_REF}`,
        ],
        { allowExitCodes: [0, 1, 128] },
      );
      if (push.exitCode === 0) {
        return { ok: true, attempts: attempt, remoteTip: await this.repository.notesTip(), diagnostics };
      }
      diagnostics.push(`Notes publication attempt ${attempt} was rejected: ${push.stderr.trim()}`);
    }
    return {
      ok: false,
      attempts: maximum,
      remoteTip: await this.liveRepository.remoteObject(remote, NOTES_REF),
      diagnostics,
    };
  }

  async attachInitialization(input: { readonly commit: string; readonly record: ReveriesInit }): Promise<void> {
    const commit = await this.repository.resolveCommit(input.commit);
    await this.mutateNotes(async (notes) => {
      await notes.append(commit, canonicalRecord(input.record));
    });
  }

  async attachAdoption(input: {
    readonly commit: string;
    readonly summary: SessionSummary;
    readonly initialization: ReveriesInit;
  }): Promise<void> {
    const commit = await this.repository.resolveCommit(input.commit);
    validateNote([input.summary, input.initialization], { verifyIds: false });
    await this.mutateNotes(async (notes) => {
      const existing = await notes.read(commit);
      const records = existing === null
        ? []
        : parseNote(existing, "strict", { verifyIds: false }).records;
      const summary = records.find((record) => record.type === "session-summary");
      const initialization = records.find((record) => record.type === "reveries-init");
      if (summary !== undefined && canonicalRecord(summary) !== canonicalRecord(input.summary)) {
        throw new Error(`Commit ${commit} already has a different session summary`);
      }
      if (initialization !== undefined && canonicalRecord(initialization) !== canonicalRecord(input.initialization)) {
        throw new Error(`Commit ${commit} already has a different initialization record`);
      }
      const retained = records.filter(
        (record) => record.type !== "session-summary" && record.type !== "reveries-init",
      );
      await notes.replace(
        commit,
        [input.summary, input.initialization, ...retained].map(canonicalRecord).join(""),
      );
    });
  }

  async checkStaged(explicitSuccessors: ReadonlyMap<string, string> = new Map()): Promise<CheckResult> {
    const transitions = [...await this.stagedTransitions()];
    for (const [oldPath, newPath] of explicitSuccessors) {
      const from = await this.repository.resolveSubject({ path: oldPath, revision: "HEAD" });
      const to = await this.repository.resolveSubject({ path: newPath, revision: "index" });
      if (from.type !== "blob" || to.type !== "blob") {
        throw new Error(
          `reveries check --successor maps file (blob) paths only, and it is a local aid rather than publication proof: a renamed-and-edited directory needs a durable lineage edge on the resulting commit (old: ${oldPath}, new: ${newPath})`,
        );
      }
      const existing = transitions.findIndex((transition) => transition.oldPath === oldPath);
      const mapped: DiffTransition = { from: from.object, to: to.object, oldPath, newPath };
      if (existing < 0) transitions.push(mapped);
      else transitions.splice(existing, 1, mapped);
    }
    const summary = emptySummary();
    const tree = await this.treeSubjectTransitions("HEAD", "HEAD", true);
    // No commit exists yet, so there is no durable lineage edge and no session
    // summary to read: the staged gate stays fail-closed and says which route
    // actually closes the obligation. `--successor` is a local aid for files and
    // is never evidence that publication will pass.
    return this.checkTransitions(
      [...transitions, ...tree],
      summary,
      [],
      STAGED_ROUTE_GUIDANCE,
    );
  }

  async checkCommit(revision: string): Promise<CheckResult> {
    const commit = await this.repository.resolveCommit(revision);
    const diagnostics: string[] = [];
    let summary: SessionSummary | null = null;
    try {
      const note = await this.strictRead(commit);
      summary = note.records.find((record): record is SessionSummary => record.type === "session-summary") ?? null;
    } catch (error: unknown) {
      diagnostics.push(error instanceof Error ? error.message : String(error));
    }
    const check = await this.checkCommitAgainst(commit, summary);
    return { ok: check.ok, diagnostics: [...diagnostics, ...check.diagnostics] };
  }

  private async checkCommitAgainst(commit: CommitId, summary: SessionSummary | null): Promise<CheckResult> {
    const initialization = await this.findInitialization();
    if (initialization === null) {
      return { ok: false, diagnostics: ["Reveries initialization boundary is missing"] };
    }
    const ancestor = await this.repository.run(
      ["merge-base", "--is-ancestor", initialization.commit, commit],
      { allowExitCodes: [0, 1] },
    );
    if (ancestor.exitCode !== 0) {
      return { ok: false, diagnostics: ["Commit is not a descendant of the Reveries initialization boundary"] };
    }
    if (summary === null) {
      return { ok: false, diagnostics: [`Commit ${commit} requires exactly one valid session summary`] };
    }
    const diagnostics: string[] = [];
    for (const parent of await this.commitParents(commit)) {
      const transitions = [...await this.commitTransitions(parent, commit)];
      // Directory renames pair through durable lineage when one exists, and stay
      // fail-closed without one: same-path identity is the only pairing inferred
      // automatically, and similarity is never inferred at all.
      const tree = await this.treeSubjectTransitions(parent, commit, false);
      const disturbed = this.disturbedCoordinates(parent, [...transitions, ...tree]);
      const lineage = await this.classifyLineage({ commit, parent, disturbed });
      for (const use of lineage.used.filter((entry) => entry.authority === "contradictory")) {
        diagnostics.push(`contradictory-lineage ${use.id} for ${commit}: ${use.detail}`);
      }
      const result = await this.checkTransitions([...transitions, ...tree], summary, lineage.pairings);
      diagnostics.push(...result.diagnostics.map((diagnostic) => `${parent}: ${diagnostic}`));
    }
    return { ok: diagnostics.length === 0, diagnostics };
  }

  private async commitParents(commit: CommitId): Promise<readonly CommitId[]> {
    const result = await this.repository.run(["show", "-s", "--format=%P", commit]);
    return result.stdout.trim().split(" ").filter((parent) => parent.length > 0).map(commitId);
  }

  private async commitSessionSummary(commit: CommitId): Promise<SessionSummary | null> {
    try {
      const note = await this.strictRead(commit);
      return note.records.find((record): record is SessionSummary => record.type === "session-summary") ?? null;
    } catch {
      return null;
    }
  }

  async checkProposedRef(
    localObject: CommitId,
    remoteObject: ObjectId | null,
    remoteRef: string,
  ): Promise<CheckResult> {
    const initialization = await this.findInitialization();
    if (initialization === null) {
      return { ok: false, diagnostics: ["Reveries initialization boundary is missing"] };
    }
    const diagnostics = await this.checkOutgoingRange(
      initialization.commit,
      localObject,
      remoteObject,
      remoteRef,
    );
    return { ok: diagnostics.length === 0, diagnostics };
  }

  /**
   * Validate a proposed notes tip as evidence, on the receiver side and before
   * any authority is derived from it.
   *
   * Shape, identity, and sources are checked per note, and the addressed
   * records are checked against the repository as well: an occurrence must
   * still resolve at its coordinate, and a lineage edge must bind a direct
   * parent whose endpoints hold the subjects it names. That second layer is
   * what keeps a hand-written record from steering a check, and it runs on the
   * proposed tip rather than the ref the receiver already holds.
   */
  async checkProposedEvidence(): Promise<CheckResult> {
    if (this.proposedNotesTip === undefined) {
      throw new Error("Proposed evidence is available only to a receive checker");
    }
    const diagnostics: string[] = [];
    for (const entry of await this.evidenceNotes()) {
      try {
        await this.strictRead(entry.object);
      } catch (error: unknown) {
        diagnostics.push(`${entry.object}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const diagnostic of await this.addressedEvidenceDiagnostics()) {
      diagnostics.push(diagnostic);
    }
    diagnostics.push(...await this.secretMaterialDiagnostics(await this.evidenceView()));
    return { ok: diagnostics.length === 0, diagnostics };
  }

  private async secretMaterialDiagnostics(view: EvidenceSnapshotView): Promise<string[]> {
    const diagnostics: string[] = [];
    for (const entry of view.entries) {
      for (const record of entry.records) {
        const findings = scanSecretMaterial(canonicalRecord(record));
        const id = recordFactId(record) ?? record.type;
        if (findings.length > 0) {
          const kinds = [...new Set(findings.map(({ kind }) => kind))].join(", ");
          diagnostics.push(
            `Evidence ${id} on ${entry.object} contains likely secret material (${kinds}); publication is refused. ${SECRET_SCAN_WARNING}`,
          );
        }
        if (!allSources(record).some((source) => source.kind === "confidential-pointer")) continue;
        const factId = recordFactId(record);
        const content = canonicalRecord(record).replace(/\n$/, "");
        const contentId = await this.repository.hashObject(content);
        const signed = factId !== null && entry.records.some((candidate) =>
          candidate.type === "signature"
          && candidate.domain === SIGNATURE_DOMAIN_RECORD
          && candidate.target === factId
          && candidate.subject === entry.object
          && candidate.content_id === contentId);
        if (!signed) {
          diagnostics.push(
            `Confidential pointer in evidence ${id} on ${entry.object} requires a signature over the enclosing record before publication.`,
          );
        }
      }
    }
    return diagnostics;
  }

  private async secretMaterialDiagnosticsAtNotesCommit(notesCommit: ObjectId): Promise<string[]> {
    const listed = await this.repository.listNotesAt(notesCommit);
    const bodies = await this.repository.readNotesBatch(listed, {});
    const view = await this.buildSnapshotView(notesCommit, listed, bodies, resolveLimits(), false);
    return this.secretMaterialDiagnostics(view);
  }

  /**
   * Coordinates of every occurrence and lineage record in the proposed
   * evidence, checked against the repository. Coordinates, not objects: a
   * record may name a real subject at a path that does not hold it.
   */
  private async addressedEvidenceDiagnostics(): Promise<readonly string[]> {
    const view = await this.evidenceView();
    const diagnostics: string[] = [];
    for (const entry of view.entries) {
      for (const record of entry.records) {
        if (record.type === "occurrence") {
          try {
            await this.validateCoordinate(record.occurrence);
          } catch (error: unknown) {
            diagnostics.push(
              `Occurrence ${record.id}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          continue;
        }
        if (record.type !== "lineage") continue;
        try {
          await this.validateLineageRecord(record);
        } catch (error: unknown) {
          diagnostics.push(`Lineage ${record.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    return diagnostics;
  }

  async checkOutgoing(remote: string): Promise<CheckResult> {
    const initialization = await this.findInitialization();
    if (initialization === null) {
      return { ok: false, diagnostics: ["Reveries initialization boundary is missing"] };
    }
    const branchResult = await this.repository.run(
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      { allowExitCodes: [0, 1] },
    );
    const branch = branchResult.stdout.trim();
    if (branchResult.exitCode !== 0 || branch.length === 0) {
      return { ok: false, diagnostics: ["Outgoing checks require an attached branch"] };
    }
    const localObject = await this.repository.resolveCommit("HEAD");
    const remoteObject = await this.repository.notesTip(`refs/remotes/${remote}/${branch}`);
    const remoteNotes = await this.repository.notesTip(`refs/notes/remotes/${remote}/reveries`);
    if (remoteNotes === null) {
      return {
        ok: false,
        diagnostics: [`Remote ${remote} notes state is unavailable; fetch it before publication`],
      };
    }
    return this.checkOutgoingUpdates(remote, [{
      localRef: `refs/heads/${branch}`,
      localObject,
      remoteRef: `refs/heads/${branch}`,
      remoteObject,
    }, {
      localRef: NOTES_REF,
      localObject: await this.repository.notesTip(),
      remoteRef: NOTES_REF,
      remoteObject: remoteNotes,
    }]);
  }

  async checkOutgoingUpdates(remote: string, updates: readonly PushUpdate[]): Promise<CheckResult> {
    const diagnostics: string[] = [];
    // An import-only remote is a source of someone else's history. Publishing
    // into it would assert that this repository authored what is already there.
    // This is checked before the adoption boundary because a destination that
    // cannot be published to is wrong regardless of whether the repository has
    // been adopted, and reporting only the missing boundary would hide the one
    // problem the operator has to fix in configuration.
    const role = await this.roleOf(remote);
    if (role !== null && !rolePublishable(role)) {
      diagnostics.push(`Remote ${remote} is an ${role} remote and is not a publication destination`);
    }
    const initialization = await this.findInitialization();
    if (initialization === null) {
      diagnostics.push("Reveries initialization boundary is missing");
      return { ok: false, diagnostics };
    }
    const notesUpdate = updates.find((update) => update.remoteRef === NOTES_REF);
    const ledgerUpdate = updates.find((update) => update.remoteRef === LEDGER_REF);
    // The ledger branch lives under refs/heads but carries evidence, not code,
    // so it must not be held to session-summary and transition coverage.
    const branchUpdates = updates.filter((update) =>
      update.localRef.startsWith("refs/heads/")
      && update.localRef !== LEDGER_REF
      && update.localObject !== null);
    if (branchUpdates.length > 0 && notesUpdate === undefined) {
      diagnostics.push("The push publishes a branch without refs/notes/reveries");
    }
    if (notesUpdate !== undefined) {
      const localNotes = await this.repository.notesTip();
      if (notesUpdate.localObject !== localNotes) {
        diagnostics.push("The pushed notes object is not the current local Reveries notes tip");
      }
      diagnostics.push(...(await this.checkRemoteNotesIncorporated(remote, notesUpdate.remoteObject)).diagnostics);
      if (notesUpdate.localObject !== null) {
        diagnostics.push(...await this.secretMaterialDiagnostics(await this.evidenceView()));
      }
    }
    for (const update of branchUpdates) {
      diagnostics.push(...await this.checkOutgoingRange(
        initialization.commit,
        commitId(update.localObject!),
        update.remoteObject,
        update.remoteRef,
      ));
    }
    if (ledgerUpdate !== undefined && ledgerUpdate.localObject !== null) {
      const verification = await this.verifyLedgerEnvelope(ledgerUpdate.localObject);
      diagnostics.push(...verification.diagnostics);
      if (verification.ok) {
        const stored = await this.repository.readLedgerManifestAt(ledgerUpdate.localObject);
        if (stored !== null) {
          const manifest = readLedgerManifest(stored);
          if (manifest.notes_commit !== null) {
            diagnostics.push(...await this.secretMaterialDiagnosticsAtNotesCommit(manifest.notes_commit));
          }
        }
      }
      if (verification.ok && ledgerUpdate.remoteObject !== null) {
        if (!(await this.repository.objectExists("commit", ledgerUpdate.remoteObject))) {
          diagnostics.push(
            `Remote ledger ${ledgerUpdate.remoteObject} is unavailable locally; fetch it and rebuild from the current remote tip before publishing`,
          );
        } else if (!(await this.repository.isAncestor(ledgerUpdate.remoteObject, ledgerUpdate.localObject))) {
          diagnostics.push(
            `The proposed ledger ${ledgerUpdate.localObject} does not extend remote ledger ${ledgerUpdate.remoteObject}; fetch and rebuild from the current remote tip before publishing`,
          );
        }
      }
    }
    try {
      await this.validateNotesRef(NOTES_REF);
    } catch (error: unknown) {
      diagnostics.push(error instanceof Error ? error.message : String(error));
    }
    return { ok: diagnostics.length === 0, diagnostics };
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
    const walk = await this.occurrenceDerivation(start?.commit ?? null);
    if (start !== null) {
      history.push(...await this.lineageHistory(walk.derivation, walk.silent, start, seen));
    }
    return history;
  }

  /**
   * Follow explicit lineage backwards from a path at its current revision,
   * appending the earlier coordinates a rename-plus-edit, split, or join would
   * otherwise hide. Ordering stays deterministic: commit descending, then path.
   *
   * A path that no longer resolves at the reference revision (deleted, or
   * moved on) contributes nothing here: the `git log` walk above already
   * reported the commits that touched it, and there is no current coordinate
   * to walk backwards from.
   */
  private async lineageHistory(
    derivation: OccurrenceDerivation,
    silent: ReadonlySet<string>,
    start: OccurrenceCoordinate,
    seen: Set<string>,
  ): Promise<readonly HistoryEntry[]> {
    const view = await this.loadCachedEvidenceSnapshot({});
    if (view.lineages.size === 0) return [];
    const startKey = coordinateKey(String(start.commit), start.path, String(start.subject));
    // Collect every coordinate the edges derive this one from. The start itself
    // is left out: `git log` already reported it. Bridge steps are
    // traversal-only for the same reason: they name the coordinate the walk
    // already stands on, so emitting them would duplicate the entry the
    // current revision (or an earlier edge step) already produced.
    const earlier: { coordinate: OccurrenceCoordinate; lineage: LineageId }[] = [];
    const visited = new Set<string>([startKey]);
    const queue: OccurrenceCoordinate[] = [start];
    while (queue.length > 0) {
      const coordinate = queue.shift() as OccurrenceCoordinate;
      for (const step of derivation.get(coordinateKey(
        String(coordinate.commit),
        coordinate.path,
        String(coordinate.subject),
      )) ?? []) {
        const previous = coordinateKey(
          String(step.coordinate.commit),
          step.coordinate.path,
          String(step.coordinate.subject),
        );
        if (visited.has(previous)) continue;
        visited.add(previous);
        if (!silent.has(`${previous}\u0001${step.lineage}`)) earlier.push(step);
        queue.push(step.coordinate);
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
  async loadCachedEvidenceSnapshot(options: SnapshotLoadOptions = {}): Promise<EvidenceSnapshotView> {
    const ref = options.ref ?? NOTES_REF;
    const limits = resolveLimits(options.limits);
    const tip = await this.repository.notesTip(ref);
    if (tip === null) return emptySnapshotView(limits);
    const raw = await this.repository.readSnapshotIndex(tip);
    if (raw !== null) {
      try {
        const payload = parseSnapshotIndexPayload(raw, tip);
        const cached = new Map<ObjectId, string | null>(
          payload.bodies.map((entry) => [objectId(entry.object), entry.body] as const),
        );
        return await this.buildSnapshotView(tip, await this.repository.listNotes(ref), cached, limits, true);
      } catch (error: unknown) {
        if (!(error instanceof SnapshotIndexCorruptError)) throw error;
      }
    }
    const listed = await this.repository.listNotes(ref);
    const bodies = await this.repository.readNotesBatch(listed, { limits: options.limits });
    const view = await this.buildSnapshotView(tip, listed, bodies, limits, false);
    await this.repository.writeSnapshotIndex(tip, JSON.stringify({
      v: 1,
      tip,
      bodies: listed.map((entry) => ({
        object: entry.object,
        body: bodies.get(entry.object) ?? null,
      })),
    }));
    return view;
  }

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
          if (record.type === "transition-summary") {
            const expected = `tr:${hashBlobContent(`${transitionPayload(record)}\n`, format)}`;
            if (expected !== record.id) {
              throw new Error(`Transition ID mismatch for ${record.id}; expected ${expected}`);
            }
            continue;
          }
          if (record.type === "correction") {
            const expected = `cr:${hashBlobContent(`${correctionPayload(record)}\n`, format)}`;
            if (expected !== record.id) {
              throw new Error(`Correction ID mismatch for ${record.id}; expected ${expected}`);
            }
            continue;
          }
          if (record.type === "resolution") {
            const expected = `rs:${hashBlobContent(`${resolutionPayload(record)}\n`, format)}`;
            if (expected !== record.id) {
              throw new Error(`Resolution ID mismatch for ${record.id}; expected ${expected}`);
            }
            continue;
          }
          if (record.type === "redaction") {
            const expected = `rd:${hashBlobContent(`${redactionPayload(record)}\n`, format)}`;
            if (expected !== record.id) {
              throw new Error(`Redaction ID mismatch for ${record.id}; expected ${expected}`);
            }
            continue;
          }
          if (record.type === "occurrence") {
            const expected = `oc:${hashBlobContent(`${occurrencePayload(record)}\n`, format)}`;
            if (expected !== record.id) {
              throw new Error(`Occurrence ID mismatch for ${record.id}; expected ${expected}`);
            }
            continue;
          }
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
          factGraph: projectFactGraph([]),
          objectType: await this.snapshotObjectType(details, entry.object),
          error: message,
          snapshot: createEvidenceSnapshot({ notesTip: tip, records: [], limits }),
        });
        continue;
      }
      const projection = projectActiveReveries(
        records.filter((record): record is ReverieRecord => record.type === "reverie"),
      );
      const factGraph = projectFactGraph(records);
      const projectionDiagnostics = [
        ...this.projectionDiagnostics(projection),
        ...factGraphDiagnostics(factGraph),
      ];
      const objectType = await this.snapshotObjectType(details, entry.object);
      entries.push({
        object: entry.object,
        records,
        projection,
        factGraph,
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
    const backlinkSets = new Map<ReverieId, Set<ObjectId>>();
    for (const entry of entries) {
      for (const record of entry.records) {
        for (const source of allSources(record)) {
          if (source.kind !== "note") continue;
          const set = backlinkSets.get(source.ref as ReverieId) ?? new Set<ObjectId>();
          set.add(entry.object);
          backlinkSets.set(source.ref as ReverieId, set);
        }
      }
    }
    const backlinks = new Map<ReverieId, readonly ObjectId[]>(
      [...backlinkSets].map(([id, objects]) => [id, [...objects].sort()]),
    );
    const transitions = new Map<TransitionId, { readonly record: TransitionSummary; readonly object: ObjectId }>();
    const attestationLists = new Map<CommitId, PublicationAttestation[]>();
    const lineageLists = new Map<CommitId, LineageRecord[]>();
    for (const entry of entries) {
      for (const record of entry.records) {
        if (record.type === "transition-summary") {
          if (!transitions.has(record.id)) transitions.set(record.id, { record, object: entry.object });
        } else if (record.type === "publication-attestation") {
          const list = attestationLists.get(record.commit) ?? [];
          list.push(record);
          attestationLists.set(record.commit, list);
        } else if (record.type === "lineage") {
          const list = lineageLists.get(record.commit) ?? [];
          list.push(record);
          lineageLists.set(record.commit, list);
        }
      }
    }
    const attestations = new Map<CommitId, readonly PublicationAttestation[]>(attestationLists);
    const lineages = new Map<CommitId, readonly LineageRecord[]>(lineageLists);
    const globalRecords = entries.flatMap((entry) => entry.records);
    const factGraph = projectFactGraph(globalRecords);
    const redacted = [...factGraph.redacted];
    const factLocations = new Map<string, ObjectId>();
    for (const entry of entries) {
      for (const record of entry.records) {
        const id = recordFactId(record);
        if (id !== null && !factLocations.has(id)) factLocations.set(id, entry.object);
      }
    }
    let init: EvidenceSnapshotView["init"] = null;
    let initError: string | null = null;
    for (const entry of entries) {
      for (const record of entry.records) {
        if (record.type !== "reveries-init") continue;
        if (init !== null) {
          initError = "More than one Reveries initialization boundary exists";
          break;
        }
        if (entry.objectType !== "commit") {
          initError = "The Reveries initialization record is not attached to a commit";
          break;
        }
        init = { commit: commitId(entry.object), record };
      }
      if (initError !== null) break;
    }
    return {
      tip,
      entries,
      byId,
      transitions,
      attestations,
      lineages,
      backlinks,
      factGraph,
      redacted,
      factLocations,
      init,
      initError,
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
    let initialization: ObjectId | null = null;
    for (const entry of view.entries) {
      try {
        if (entry.error !== null) throw new Error(entry.error);
        if (entry.records.some((record) => record.type === "reveries-init")) {
          if (entry.objectType !== "commit") {
            throw new Error(`Initialization record ${entry.object} is not attached to a commit`);
          }
          if (initialization !== null) {
            throw new Error("More than one Reveries initialization boundary exists");
          }
          initialization = entry.object;
        }
        // A signature is a global fact about an annotated subject, so it may
        // ride on blob, tree, and commit notes alongside the records that live
        // there. It is not evidence about the subject's content, so it never
        // disqualifies the subject as a transition result or publication.
        // A lineage edge is a fact about object endpoints, so it rides the note
        // of every endpoint subject: `to` when one exists, otherwise `from`.
        // Lineage is protocol evidence in its own right, not a file reverie, so
        // a blob carrying it is still a valid endpoint.
        if (entry.objectType === "blob" && entry.records.some((record) =>
          record.type !== "reverie"
          && record.type !== "occurrence"
          && record.type !== "correction"
          && record.type !== "resolution"
          && record.type !== "redaction"
          && record.type !== "signature"
          && record.type !== "lineage")) {
          throw new Error(`Blob ${entry.object} has a non-reverie protocol record`);
        }
        if (entry.objectType === "commit" && entry.records.some((record) =>
          record.type === "reverie"
          || record.type === "occurrence"
          || record.type === "correction"
          || record.type === "resolution")) {
          throw new Error(`Commit ${entry.object} has a file reverie record`);
        }
        if (entry.objectType === "commit"
          && entry.records.some((record) => record.type === "transition-summary")) {
          throw new Error(`Commit ${entry.object} has a tree transition record`);
        }
        if (entry.objectType === "tree"
          && entry.records.some((record) =>
            record.type !== "reverie"
            && record.type !== "occurrence"
            && record.type !== "transition-summary"
            && record.type !== "correction"
            && record.type !== "resolution"
            && record.type !== "redaction"
            && record.type !== "signature"
            && record.type !== "lineage")) {
          throw new Error(`Tree ${entry.object} has a non-tree protocol record`);
        }
        for (const record of entry.records) {
          if (record.type === "publication-attestation" && record.commit !== entry.object) {
            throw new Error(`Attestation for ${record.commit} is attached to ${entry.object}`);
          }
          // A lineage edge is about object endpoints, not about the change it
          // was recorded beside, so it may ride any endpoint subject's note.
          if (record.type === "lineage" && record.commit !== entry.object) {
            const endpoints = [...record.from, ...record.to].map((endpoint) => String(endpoint.subject));
            if (!endpoints.includes(String(entry.object))) {
              throw new Error(`Lineage edge ${record.id} is attached to ${entry.object}, which is not one of its endpoints`);
            }
          }
          // An occurrence rides the note of the subject it names, and its
          // coordinate must still resolve to that subject. Without this a
          // record could claim a path that never held this content.
          if (record.type === "occurrence") {
            if (record.occurrence.subject !== entry.object) {
              throw new Error(
                `Occurrence ${record.id} names subject ${record.occurrence.subject} but is attached to ${entry.object}`,
              );
            }
            await this.validateCoordinate(record.occurrence);
          }
          if (record.type === "lineage") {
            await this.validateLineageRecord(record);
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
    // Cross-note forks: corrections on different notes may supersede the same
    // heads. Sync and mutation stay fail-closed on them; only a candidate
    // whose resolution names every head passes validation. Session summaries
    // attach per commit, so summary forks stay a per-note diagnostic and are
    // excluded from the global check.
    const globalDiagnostics = factGraphDiagnostics({ ...view.factGraph, summaryFork: false });
    if (globalDiagnostics.length > 0) {
      const involved = new Set<string>([
        ...view.factGraph.forks.flat(),
        ...view.factGraph.cycles.flat(),
        ...(view.factGraph.conflicts ?? []),
      ]);
      let annotated: ObjectId | null = null;
      for (const id of involved) {
        const location = view.factLocations.get(id);
        if (location !== undefined) {
          annotated = location;
          break;
        }
      }
      const firstEntry = view.entries[0];
      throw new NotesRefValidationError(
        annotated ?? (firstEntry !== undefined ? firstEntry.object : view.tip as ObjectId),
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
    return this.searchWithView(await this.loadCachedEvidenceSnapshot({}), input);
  }

  private async searchWithView(view: EvidenceSnapshotView, input: SearchInput): Promise<readonly SearchHit[]> {
    const revision = input.revision ?? "HEAD";
    let revisionCommit: CommitId | null = null;
    try {
      if (revision !== "index") revisionCommit = await this.repository.resolveCommit(revision);
    } catch {
      revisionCommit = null;
    }
    const occurrenceWalk = revisionCommit === null
      ? { derivation: new Map() as OccurrenceDerivation, silent: new Set<string>() }
      : await this.occurrenceDerivation(revisionCommit);
    const allowed = input.all === true
      ? new Set(view.entries.map((entry) => entry.object as string))
      : new Set((await this.snapshotTargets(view, revision)).map((entry) => entry.object as string));
    const redacted = input.includeRedacted === true ? new Set<string>() : new Set(view.redacted);
    const hits: SearchHit[] = [];
    for (const entry of view.entries) {
      if (!allowed.has(entry.object as string)) continue;
      for (const record of entry.records) {
        const id = recordFactId(record);
        if (id !== null && redacted.has(id)) continue;
        if (input.query !== undefined && !searchText(record).includes(input.query.toLocaleLowerCase())) continue;
        if (input.source !== undefined && !allSources(record).some((source) => source.ref === input.source)) continue;
        if (input.author !== undefined && recordAuthor(record) !== input.author) continue;
        const paths = await this.pathsForObject(entry.object, revision);
        hits.push(record.type === "occurrence"
          ? {
              object: entry.object,
              record,
              paths,
              occurrence: record.occurrence,
              applicable: revisionCommit !== null && paths.some((path) => {
                const current: OccurrenceCoordinate = {
                  commit: revisionCommit as CommitId,
                  path: normalizeCoordinatePath(path),
                  subject: entry.object,
                };
                const anchor = record.occurrence;
                if (String(anchor.commit) === String(current.commit)
                  && normalizeCoordinatePath(anchor.path) === current.path
                  && anchor.subject === current.subject) {
                  return true;
                }
                return deriveLineage(occurrenceWalk.derivation, current, anchor).length > 0;
              }),
            }
          : { object: entry.object, record, paths });
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
  async syncPull(remote: string): Promise<SyncResult> {
    const role = await this.roleOf(remote);
    if (role !== null && !roleSyncSource(role)) {
      return {
        ok: false,
        diagnostics: [`Remote ${remote} is an ${role} remote and is not a source of Reveries evidence`],
        state: "fetched",
        conflicts: [],
      };
    }
    const promotes = role === null || rolePromotion(role) === "promote";
    const fetched = await this.liveRepository.fetchNotes(remote);
    if (fetched === "absent") {
      return { ok: true, diagnostics: [], state: "remote-notes-absent", conflicts: [] };
    }
    const localNotes = await this.repository.notesTip();
    const remoteNotes = await this.repository.notesTip(`refs/notes/remotes/${remote}/reveries`);
    if (remoteNotes === null) {
      return {
        ok: false,
        diagnostics: [`Fetched notes for ${remote} have no remote-tracking tip`],
        state: "fetched",
        conflicts: [],
      };
    }
    let quarantineRef: string | null = null;
    let conflict: SyncConflict | null = null;
    // A non-primary sync takes the same path and the same validation, then stops
    // short of the compare-and-swap. Promotion is withheld by construction, so
    // an import cannot reach canonical state even if a caller expects it to.
    const promotion: WithNotesWriteOptions = promotes
      ? {}
      : {
          promote: false,
          onCandidate: async (candidate: ObjectId) => {
            quarantineRef = await this.repository.quarantineNotes(remote, candidate);
          },
        };
    try {
      await this.repository.mergeFetchedNotes(
        remote,
        async (ref) => {
          await this.validateNotesRef(ref);
          const findings = await this.secretMaterialDiagnostics(await this.loadEvidenceSnapshot({ ref }));
          if (findings.length > 0) throw new Error(findings.join("; "));
        },
        async (candidateRef, candidate, error) => {
          quarantineRef = await this.repository.quarantineNotes(remote, candidate);
          conflict = await this.describeSyncConflict({
            remote,
            candidateRef,
            candidate,
            error,
            localNotes,
            remoteNotes,
            quarantineRef,
          });
        },
        promotion,
      );
      if (quarantineRef !== null) {
        // A quarantined union is a success: the evidence is held, validated, and
        // inspectable. Reporting it as a failure would train an operator to
        // ignore this state, which is how silent promotion happens.
        return {
          ok: true,
          diagnostics: [
            `Notes from ${remote} are validated but quarantined at ${quarantineRef}; `
            + `canonical ${NOTES_REF} is unchanged because ${remote} is ${role}`,
          ],
          state: "fetched",
          conflicts: [],
          quarantineRef,
        };
      }
      return { ok: true, diagnostics: [], state: "fetched", conflicts: [], quarantineRef: null };
    } catch (error: unknown) {
      const diagnostics = [error instanceof Error ? error.message : String(error)];
      if (quarantineRef !== null) {
        diagnostics.push(`Invalid fetched notes union quarantined at ${quarantineRef}`);
      }
      return {
        ok: false,
        diagnostics,
        state: "fetched",
        conflicts: conflict === null ? [] : [conflict],
        quarantineRef,
      };
    }
  }

  private async describeSyncConflict(input: {
    readonly remote: string;
    readonly candidateRef: string;
    readonly candidate: ObjectId;
    readonly error: unknown;
    readonly localNotes: ObjectId | null;
    readonly remoteNotes: ObjectId;
    readonly quarantineRef: string;
  }): Promise<SyncConflict> {
    const message = input.error instanceof Error ? input.error.message : String(input.error);
    const conflictType = syncConflictType(message);
    const annotatedObject = input.error instanceof NotesRefValidationError
      ? input.error.annotatedObject
      : null;
    const records = annotatedObject === null || conflictType === "secret-material"
      ? []
      : await this.describeConflictRecords(
          annotatedObject,
          input.candidateRef,
          input.localNotes,
          input.remoteNotes,
        );
    return {
      kind: "invalid-notes-union",
      conflictType,
      message,
      annotatedObject,
      records,
      provenance: {
        localNotes: input.localNotes,
        remoteNotes: input.remoteNotes,
        candidate: input.candidate,
        quarantineRef: input.quarantineRef,
      },
      resolutionActions: [
        { kind: "inspect-quarantine", ref: input.quarantineRef },
        { kind: "construct-replacement-candidate", sourceRef: input.quarantineRef },
        { kind: "retry-sync", remote: input.remote },
      ],
    };
  }

  private async describeConflictRecords(
    object: ObjectId,
    candidateRef: string,
    localNotes: ObjectId | null,
    remoteNotes: ObjectId,
  ): Promise<readonly SyncConflictRecord[]> {
    const candidate = await this.repository.readNoteFromRef(candidateRef, object);
    if (candidate === null) return [];
    const local = localNotes === null ? null : await this.repository.readNoteAt(localNotes, object);
    const remote = await this.repository.readNoteAt(remoteNotes, object);
    const localLines = new Set(noteLines(local));
    const remoteLines = new Set(noteLines(remote));
    return noteLines(candidate).map((canonicalLine) => ({
      recordId: recordIdFromCanonicalLine(canonicalLine),
      canonicalLine,
      origins: recordOrigins(canonicalLine, localLines, remoteLines),
    }));
  }

  /**
   * Publish HEAD and refs/notes/reveries in one atomic Git transaction.
   *
   * The single transaction is the only thing this command adds: a plain
   * `git push origin HEAD refs/notes/reveries` is equally valid, and the two
   * refspecs in one push are already atomic on the server. This uses an
   * explicit lease for each ref so a concurrent remote advance fails the whole
   * transaction closed rather than publishing a partial set.
   *
   * It no longer runs an outgoing continuity check. Refusing a push because a
   * commit lacks a session summary made publication a workflow gate; a reader
   * now discovers unresolved continuity from the evidence itself, and Git's own
   * `--force-with-lease` is the operator's tool for refusing history rewrites.
   * The aggregate result therefore reports what Git did, not permission.
   */
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

  async postCommitCheck(): Promise<CheckResult> {
    const initialization = await this.findInitialization();
    if (initialization === null) return { ok: true, diagnostics: [] };
    const descendant = await this.repository.run(
      ["merge-base", "--is-ancestor", initialization.commit, "HEAD"],
      { allowExitCodes: [0, 1] },
    );
    return descendant.exitCode === 0 ? this.checkCommit("HEAD") : { ok: true, diagnostics: [] };
  }

  /**
   * Read the configured retention policy. An unset key means the default, which keeps
   * only the annotated objects that currently carry an active reverie.
   */
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
    const view = await this.loadCachedEvidenceSnapshot({});
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
  async verifyLedgerEnvelope(revision?: string): Promise<CheckResult> {
    const diagnostics: string[] = [];
    const checkpoint = revision === undefined ? await this.repository.ledgerTip() : await this.repository.resolveCommit(revision);
    if (checkpoint === null) return { ok: false, diagnostics: ["The Reveries ledger branch does not exist"] };
    if (!(await this.repository.isLedgerCheckpoint(checkpoint))) {
      return { ok: false, diagnostics: [`${checkpoint} is not a Reveries ledger checkpoint`] };
    }

    // The envelope may carry only the manifest, the grafted notes subtree, and
    // the signature lines over the manifest. `review/` belongs to RVR-019 and is
    // rejected until that contract is agreed. RVR-009 amended RVR-005's two-entry
    // allow-list to exactly three; no existing check is dropped.
    const entries = await this.repository.ledgerTreeEntries(checkpoint);
    const allowed = new Set([LEDGER_MANIFEST_PATH, LEDGER_NOTES_PATH, LEDGER_SIGNATURES_PATH]);
    for (const entry of entries) {
      if (!allowed.has(entry.path)) diagnostics.push(`Ledger tree entry ${entry.path} is not part of the ledger envelope`);
    }

    let manifest: LedgerManifest | null = null;
    const stored = await this.repository.readLedgerManifestAt(checkpoint);
    if (stored === null) {
      diagnostics.push("Ledger checkpoint has no manifest.json");
    } else {
      const parsed = parseLedgerManifest(stored, "tolerant");
      manifest = parsed.manifest;
      for (const diagnostic of parsed.diagnostics) diagnostics.push(`Ledger manifest: ${diagnostic.message}`);
    }

    if (manifest === null) return { ok: false, diagnostics };

    // Parent roles are positional and validated, never inferred: the manifest
    // names the previous ledger, the notes commit, and the optional retention
    // checkpoint, and the commit must carry exactly those parents in that order.
    const parents = await this.repository.ledgerParents(checkpoint);
    const expected: readonly ObjectId[] = [
      manifest.previous_ledger,
      manifest.notes_commit,
      manifest.retention_commit,
    ].filter((parent): parent is CommitId => parent !== null);
    if (parents.length !== expected.length || parents.some((parent, index) => parent !== expected[index])) {
      diagnostics.push(
        `Ledger parents [${parents.join(", ") || "none"}] do not match the manifest `
        + `[previous_ledger ${manifest.previous_ledger ?? "null"}, notes_commit ${manifest.notes_commit ?? "null"}, `
        + `retention_commit ${manifest.retention_commit ?? "null"}]`,
      );
    }

    // The grafted subtree must be the exact notes tree the manifest claims, and
    // that tree must belong to the notes commit the manifest claims. Comparing
    // both directions is what detects a graft swap.
    let notesTree: ObjectId | null = null;
    try {
      notesTree = await this.repository.notesTreeAt(checkpoint);
    } catch (error: unknown) {
      diagnostics.push(error instanceof Error ? error.message : String(error));
    }
    if (notesTree !== null && manifest.notes_tree !== null && notesTree !== manifest.notes_tree) {
      diagnostics.push(`Ledger notes subtree ${notesTree} does not match manifest notes_tree ${manifest.notes_tree}`);
    }
    if (manifest.notes_commit !== null) {
      if (await this.repository.objectType(manifest.notes_commit) !== "commit") {
        diagnostics.push(`Ledger manifest notes_commit ${manifest.notes_commit} is not available as a commit`);
      } else if (notesTree !== null && (await this.repository.treeForCommit(manifest.notes_commit)) !== notesTree) {
        diagnostics.push(`Ledger notes commit ${manifest.notes_commit} does not carry the grafted notes tree ${notesTree}`);
      }
    }

    if (manifest.retention_commit !== null
      && !(await this.repository.isRetentionCommit(manifest.retention_commit))) {
      diagnostics.push(`Ledger retention_commit ${manifest.retention_commit} is not a retention checkpoint`);
    }

    // Append-only: every canonical line the previous checkpoint carried must
    // still be present. Comparing per-subject line sets is stronger than tree
    // monotonicity, because a modified note blob can still lose a line.
    if (manifest.previous_ledger !== null && notesTree !== null) {
      const previous = await this.repository.isLedgerCheckpoint(manifest.previous_ledger)
        ? await this.repository.ledgerNotesLines(manifest.previous_ledger)
        : new Map<ObjectId, readonly string[]>();
      const current = await this.repository.ledgerNotesLines(checkpoint);
      for (const [subject, lines] of previous) {
        const now = new Set(current.get(subject) ?? []);
        for (const line of lines) {
          if (!now.has(line)) {
            diagnostics.push(`Ledger update removes canonical line from ${subject}, which is not append-only`);
            break;
          }
        }
      }
    }

    // The same append-only rule covers signature lines (RVR-009): a later
    // checkpoint may add attestations, never drop or rewrite one. Without this a
    // trusted signature could be silently retracted by the next checkpoint.
    // The stronger guarantee is that once a chain is signed it stays signed, so
    // dropping the signer cannot be used to shed accountability.
    if (manifest.previous_ledger !== null) {
      const previousSignatures = await this.repository.readLedgerSignaturesAt(manifest.previous_ledger);
      const currentSignatures = await this.repository.readLedgerSignaturesAt(checkpoint);
      if (previousSignatures !== null && currentSignatures === null) {
        diagnostics.push("Ledger update drops the signatures entry of a signed checkpoint");
      }
      const nowLines = new Set(
        (currentSignatures ?? "").split("\n").filter((line) => line.length > 0),
      );
      for (const line of (previousSignatures ?? "").split("\n")) {
        if (line.length > 0 && !nowLines.has(line)) {
          diagnostics.push(`Ledger update removes signature ${line}, which is not append-only`);
          break;
        }
      }
    }

    if (notesTree !== null) {
      const totals = Reveries.summarizeNoteLines(await this.repository.ledgerNotesLines(checkpoint));
      if (manifest.annotated_subjects !== totals.subjects) {
        diagnostics.push(`Ledger manifest annotated_subjects ${manifest.annotated_subjects} does not match ${totals.subjects}`);
      }
      if (manifest.records !== totals.records) {
        diagnostics.push(`Ledger manifest records ${manifest.records} does not match ${totals.records}`);
      }
      if (manifest.note_bytes !== totals.noteBytes) {
        diagnostics.push(`Ledger manifest note_bytes ${manifest.note_bytes} does not match ${totals.noteBytes}`);
      }
    }

    // The manifest signature binds the exact notes, ledger, and retention tips
    // because all three are inside the signed bytes. Structural verification does
    // not depend on it: an unsigned or untrusted checkpoint is still a valid
    // envelope, so trust is reported separately and never silently required.
    //
    // The entry is a growing log, so only the newest line can cover *this*
    // manifest; earlier lines were checked against their own checkpoint when it
    // was current. Every line must still be a manifest-domain signature, so a
    // record-domain signature can never be smuggled into the envelope.
    const signatures = await this.repository.readLedgerSignaturesAt(checkpoint);
    if (signatures !== null) {
      const records = this.parseSignatureLines(signatures);
      if (records.length === 0) {
        diagnostics.push("Ledger signatures entry carries no signature records");
      }
      for (const record of records) {
        if (record.domain !== SIGNATURE_DOMAIN_MANIFEST) {
          diagnostics.push(`Ledger signature ${record.id} is not a manifest-domain signature`);
        }
      }
      const newest = records[records.length - 1];
      if (newest !== undefined) {
        const contentId = await this.signatureContentId(Buffer.from(ledgerManifestPayload(manifest), "utf8"));
        if (newest.content_id !== contentId) {
          diagnostics.push(
            `Ledger signature ${newest.id} covers content ${newest.content_id}, not this manifest ${contentId}`,
          );
        }
      }
    }

    return { ok: diagnostics.length === 0, diagnostics };
  }

  /** Informational totals recomputed from a set of per-subject canonical lines. */
  private static summarizeNoteLines(lines: ReadonlyMap<ObjectId, readonly string[]>): {
    readonly subjects: number;
    readonly records: number;
    readonly noteBytes: number;
  } {
    let records = 0;
    let noteBytes = 0;
    for (const body of lines.values()) {
      records += body.length;
      noteBytes += [...body].reduce((total, line) => total + Buffer.byteLength(`${line}\n`, "utf8"), 0);
    }
    return { subjects: lines.size, records, noteBytes };
  }

  /** The canonical lines the local notes ref currently holds, keyed by subject. */
  private async canonicalNotesLines(notesTip: ObjectId): Promise<Map<ObjectId, readonly string[]>> {
    const lines = new Map<ObjectId, readonly string[]>();
    for (const entry of await this.repository.listNotes()) {
      const body = await this.repository.readNoteAt(notesTip, entry.object);
      if (body === null) continue;
      lines.set(entry.object, body.split("\n").filter((line) => line.length > 0));
    }
    return lines;
  }

  /**
   * Advance the ledger envelope. The new checkpoint's first parent is the
   * current ledger tip, so every update is a fast-forward, and the notes it
   * carries may only add canonical lines. Nothing moves when either check fails.
   */
  async buildLedgerCheckpoint(input: {
    /**
     * The primary remote this checkpoint is published on behalf of. Omitted
     * resolves it from configuration, which is how RVR-017 finally gives the
     * reserved `authority` field a value; pass `null` to declare a checkpoint
     * with no authority at all.
     */
    readonly authority?: string | null;
    /** The local ledger tip this ref update expects to replace; defaults to the current tip. */
    readonly expectedLedger?: ObjectId | null;
    /**
     * The ledger checkpoint this new manifest extends. Defaults to the local
     * expected tip; callers may supply a validated remote-tracking base when
     * bootstrapping a fresh clone whose local ledger ref is absent.
     */
    readonly previousLedger?: ObjectId | null;
    readonly retentionCommit?: ObjectId | null;
    /**
     * Sign the manifest into a `signatures` tree entry. Defaults to true when a
     * signer is configured. Passing false builds an unsigned RVR-005 checkpoint,
     * which remains valid: an absent signature entry is a normal state.
     */
    readonly sign?: boolean;
    readonly signingRole?: SignatureRole;
  }): Promise<LedgerCheckpointResult> {
    const expectedLocalLedger = input.expectedLedger !== undefined ? input.expectedLedger : await this.repository.ledgerTip();
    const notesTip = await this.repository.notesTip();
    const notesTree = notesTip === null ? null : await this.repository.treeForCommit(notesTip);
    const retentionCommit = input.retentionCommit !== undefined
      ? input.retentionCommit
      : (await this.repository.readRetention()).commit;
    let totals = { subjects: 0, records: 0, noteBytes: 0 };
    if (notesTip !== null) {
      // The totals come from the canonical notes ref rather than from the ledger
      // being built, so a manifest never describes itself.
      totals = Reveries.summarizeNoteLines(await this.canonicalNotesLines(notesTip));
    }

    // The reserved authority field names the single remote this repository
    // publishes on behalf of (RVR-017). The signed bytes do not change, because
    // the field already existed and RVR-009 already signs it; only its meaning
    // stops being reserved.
    let authority: string | null;
    let resolvedAuthority: AuthorityStatus;
    try {
      resolvedAuthority = await this.authorityStatus();
      // Explicit null is intentionally distinct from omission. It controls
      // only the manifest stamp, never which trusted primary supplies an
      // existing ledger chain on a fresh clone.
      authority = input.authority !== undefined ? input.authority : resolvedAuthority.primary;
    } catch (error: unknown) {
      return {
        ok: false,
        diagnostics: [error instanceof Error ? error.message : String(error)],
        state: "refused",
        checkpoint: null,
        previousLedger: expectedLocalLedger,
        notesTip,
      };
    }

    // The local ref expectation and the manifest's predecessor are distinct on
    // a fresh clone. Keep CAS expectation null so the local branch is created
    // only if still absent, while extending a verified primary tracking tip.
    let previousLedger = input.previousLedger !== undefined ? input.previousLedger : expectedLocalLedger;
    if (input.previousLedger === undefined && expectedLocalLedger === null && resolvedAuthority.primary !== null) {
      const primary = resolvedAuthority.primary;
      const trackingRef = `refs/remotes/${primary}/reveries-ledger`;
      const tracked = await this.repository.ledgerTip(trackingRef);
      if (tracked !== null) {
        if (resolvedAuthority.state !== "configured" && resolvedAuthority.state !== "inferred") {
          return {
            ok: false,
            diagnostics: [`Cannot use ${trackingRef} as a ledger base because the publishing authority is ${resolvedAuthority.state}`],
            state: "refused",
            checkpoint: null,
            previousLedger: null,
            notesTip,
          };
        }
        const base = await this.verifyLedgerEnvelope(tracked);
        if (!base.ok) {
          return {
            ok: false,
            diagnostics: [`The primary ledger base ${tracked} is invalid: ${base.diagnostics.join("; ")}`],
            state: "refused",
            checkpoint: null,
            previousLedger: null,
            notesTip,
          };
        }
        previousLedger = tracked;
      }
    }
    if (previousLedger !== null) {
      const base = await this.verifyLedgerEnvelope(previousLedger);
      if (!base.ok) {
        return {
          ok: false,
          diagnostics: [`The ledger base ${previousLedger} is invalid: ${base.diagnostics.join("; ")}`],
          state: "refused",
          checkpoint: null,
          previousLedger,
          notesTip,
        };
      }
    }

    let manifest: LedgerManifest;
    try {
      manifest = createLedgerManifest({
        notes_commit: notesTip,
        notes_tree: notesTree,
        previous_ledger: previousLedger,
        retention_commit: retentionCommit,
        authority,
        annotated_subjects: totals.subjects,
        records: totals.records,
        note_bytes: totals.noteBytes,
      });
    } catch (error: unknown) {
      return {
        ok: false,
        diagnostics: [error instanceof Error ? error.message : String(error)],
        state: "refused",
        checkpoint: null,
        previousLedger,
        notesTip,
      };
    }

    // Sign before committing, so the signature and the envelope it covers are
    // built together and a signing failure moves no ref at all.
    let signatures: string | undefined;
    if (input.sign !== false) {
      const signed = await this.signLedgerManifest(manifest, input.signingRole ?? "publisher");
      if (signed !== null) {
        // The signature entry is an append-only log of manifest attestations.
        // A signature covers one manifest, so every checkpoint necessarily has a
        // different one; carrying the previous lines forward is what makes the
        // entry grow-only and preserves the whole chain of attestations instead
        // of replacing the previous checkpoint's.
        const carried = previousLedger === null
          ? []
          : (await this.repository.readLedgerSignaturesAt(previousLedger) ?? "")
            .split("\n")
            .filter((line) => line.length > 0);
        signatures = [...carried, signed.trimEnd()].join("\n").concat("\n");
      }
    }
    const checkpoint = await this.repository.commitLedgerCheckpoint({ manifest, ...(signatures === undefined ? {} : { signatures }) });
    if (checkpoint === await this.repository.ledgerTip()) {
      return {
        ok: true,
        diagnostics: [],
        state: "unchanged",
        checkpoint,
        previousLedger,
        notesTip,
      };
    }

    // A proposed checkpoint is verified on its own object before it can become
    // the branch tip, so an append-only or structural failure never publishes.
    const verification = await this.verifyLedgerEnvelope(checkpoint);
    if (!verification.ok) {
      return {
        ok: false,
        diagnostics: verification.diagnostics,
        state: "refused",
        checkpoint: null,
        previousLedger,
        notesTip,
      };
    }
    try {
      await this.repository.updateLedgerRef({ next: checkpoint, expected: expectedLocalLedger });
    } catch (error: unknown) {
      return {
        ok: false,
        diagnostics: [error instanceof Error ? error.message : String(error)],
        state: "refused",
        checkpoint: null,
        previousLedger,
        notesTip,
      };
    }
    return {
      ok: true,
      diagnostics: [],
      state: "created",
      checkpoint,
      previousLedger,
      notesTip,
    };
  }

  /**
   * Verify the ledger envelope, then move the local notes ref to the notes
   * commit the envelope transports. The ref move is guarded by an
   * expected-old-OID compare-and-swap, so it never overwrites a tip the caller
   * did not expect and never runs against an unverified envelope.
   */
  // Signatures and signed checkpoints (RVR-009)
  // ---------------------------------------------------------------------------

  /**
   * The canonical bytes a signature over a fact record commits to: the record's
   * canonical line without its trailing LF. Signing the line rather than the
   * parsed object is what makes the signature unforgeable by reordering keys.
   */
  private async signatureContentId(bytes: Uint8Array): Promise<ObjectId> {
    return this.repository.hashObject(Buffer.from(bytes).toString("utf8"));
  }

  /**
   * Sign a fact record and append the signature to the same annotated subject.
   *
   * A signature is a separate record referencing its target by ID, so rotating a
   * key adds a second signature and leaves every semantic ID untouched. Returns
   * `unavailable` rather than throwing when no signer is configured, so an
   * unsigned repository is an ordinary state.
   */
  async signRecord(input: {
    readonly target: NoteRecord;
    readonly subject: ObjectId;
    readonly role: SignatureRole;
    readonly metadata: ReverieMetadata;
  }): Promise<SignRecordResult> {
    const signer = this.signing.signer;
    if (signer === undefined) {
      return { ok: true, diagnostics: [], state: "unavailable", record: null };
    }
    // Only ID-bearing facts can be attested. A session summary, an init record,
    // and a publication attestation have no stable semantic ID to reference, so
    // signing one would produce a signature that no reader could resolve.
    const target = input.target;
    const attested = target.type === "reverie"
      || target.type === "transition-summary"
      || target.type === "correction"
      || target.type === "resolution"
      || target.type === "redaction"
      || target.type === "occurrence"
      || target.type === "lineage";
    if (!attested) {
      return {
        ok: false,
        diagnostics: [`A ${target.type} record has no identity to attest`],
        state: "unavailable",
        record: null,
      };
    }
    // The canonical line without its trailing LF: the exact bytes the ID
    // ecosystem already treats as a record's identity.
    const content = canonicalRecord(target).replace(/\n$/, "");
    const contentId = await this.signatureContentId(Buffer.from(content, "utf8"));
    const draft = {
      domain: SIGNATURE_DOMAIN_RECORD,
      role: input.role,
      target: target.id,
      subject: input.subject,
      signer: signer.signer,
      key_id: signer.keyId,
      algorithm: signer.algorithm,
      signature: "",
      content_id: contentId,
    };
    // The signature covers everything but the signature itself, so it is computed
    // over the draft payload and then folded into the finished record.
    const provisional = createSignature(
      { ...draft, signature: "placeholder" },
      input.metadata,
      (bytes) => this.repository.hashObjectSync(bytes),
    );
    const signature = signer.sign(Buffer.from(signingPayload(provisional), "utf8"));
    const record = createSignature(
      { ...draft, signature: Buffer.from(signature).toString("base64") },
      input.metadata,
      (bytes) => this.repository.hashObjectSync(bytes),
    );
    await this.mutateNotes(async (notes) => {
      await notes.append(input.subject, canonicalRecord(record));
    });
    return { ok: true, diagnostics: [], state: "signed", record };
  }

  /** Verify one signature record and classify it. Never throws for bad bytes. */
  verifySignatureRecord(record: SignatureRecord, policy: SigningPolicy = { requiredRoles: [] }): SignatureTrustReport {
    const verifier = this.signing.verifier;
    const payload = Buffer.from(signingPayload(record), "utf8");
    const verified = verifier === undefined
      ? false
      : verifier.verify({
        payload,
        signature: Buffer.from(record.signature, "base64"),
        keyId: record.key_id,
      });
    return classifySignature(record, {
      verdict: { verified },
      trust: this.signing.trust ?? { keys: [] },
      policy,
    });
  }

  /**
   * The effective role policy: explicit `SigningOptions.requiredRoles` when the
   * caller stated one, otherwise `reveries.signingRoles`. This is where the Q4
   * decision lives — without this read the `policy-satisfying` trust state would
   * be unreachable and the decision would be hollow.
   *
   * An explicit option wins outright, including an explicit empty list, so a
   * caller's intent is never silently overridden by repository configuration.
   */
  async signingPolicy(): Promise<SigningPolicy> {
    if (this.signing.requiredRoles !== undefined) {
      return { requiredRoles: this.signing.requiredRoles };
    }
    return { requiredRoles: await this.readSigningRoles() };
  }

  /**
   * Read the declared remote roles (RVR-017). Two additive encodings, one map:
   *
   * - Legacy flat keys, unchanged: `reveries.remoteRole.<remote>` holds the
   *   role. Git forbids `/` in such a key, so flat names stay slash-free.
   * - Slash-name subsection keys: `reveries.remoteRole/<remote>.role` holds
   *   the role (stored as subsection `[reveries "remoteRole/<remote>"]`, key
   *   `role`; written via
   *   `git config reveries.remoteRole/<remote>.role <role>`). The `/` after
   *   `remoteRole` versus `.` keeps the two forms structurally distinct, and
   *   only the trailing `.role` suffix is stripped, so a remote whose own
   *   name contains dots still resolves exactly.
   *
   * An absent key yields no roles, which is the ordinary V1 state. An unknown
   * role throws, naming the offending value and the valid set, because
   * silently ignoring a typo would leave a repository believing it has an
   * authority boundary it does not have.
   */
  private async readRemoteRoles(): Promise<Record<string, RemoteRole>> {
    const result = await this.repository.run(
      ["config", "--get-regexp", REMOTE_ROLE_CONFIG_PATTERN],
      { allowExitCodes: [0, 1] },
    );
    return parseRemoteRoleConfigLines(result.stdout);
  }

  /**
   * The publishing remotes this repository has adopted, from the initialization
   * record when it exists and from configuration otherwise. This is the same
   * resolution `doctor` already uses, so authority and the remote loop can never
   * disagree about which remotes publish.
   */
  private async publishingRemotes(): Promise<readonly string[]> {
    const initialization = await this.findInitialization();
    if (initialization !== null) return initialization.record.publishing_remotes;
    const configured = await this.repository.run(
      ["config", "--get-all", "reveries.publishingRemote"],
      { allowExitCodes: [0, 1] },
    );
    return configured.stdout.trim().split("\n").filter(Boolean);
  }

  private async configuredRemoteNames(): Promise<readonly string[]> {
    return (await this.repository.run(["remote"])).stdout.trimEnd().split("\n").filter(Boolean);
  }

  /**
   * The configured remote a remote-tracking revision belongs to, or null.
   *
   * `refs/remotes/<remote>/reveries-ledger` is the shape an operator names by
   * hand, and the remote in it is exactly whose evidence the revision carries.
   *
   * This is the single entry point for that question. The matcher resolves by
   * longest exact `refs/remotes/<name>/` prefix, so a remote whose name contains
   * a slash (`team/vendor`) resolves to itself rather than to its first segment
   * — and the command layer calls this instead of parsing the ref itself. It
   * previously did, and the two answers disagreed: the command layer read
   * `team` from `refs/remotes/team/vendor/reveries-ledger` and applied *that*
   * remote's role to another remote's evidence, refusing promotions the direct
   * API allowed. One question, one answer.
   */
  async trackingRemote(revision: string | undefined): Promise<string | null> {
    if (revision === undefined) return null;
    return matchTrackingRefRemote(revision, await this.configuredRemoteNames());
  }

  /**
   * Resolve the authoritative publication configuration (RVR-017). This is the
   * single place roles are resolved, so the doctor report, the sync routing, the
   * push refusal, and the manifest stamp can never read a different primary.
   */
  async authorityStatus(): Promise<AuthorityStatus> {
    const [publishing, declared, known] = await Promise.all([
      this.publishingRemotes(),
      this.readRemoteRoles(),
      this.configuredRemoteNames(),
    ]);
    const resolution: AuthorityResolution = resolveAuthorityRoles(publishing, declared, known);
    return {
      state: resolution.state,
      primary: resolution.primary,
      roles: resolution.roles,
      notice: resolution.notice,
      diagnostics: resolution.diagnostics,
    };
  }

  /**
   * The effective role of a remote, or null when it declared none. A remote with
   * no declared role keeps the pre-RVR-017 behaviour, so a repository that never
   * adopted roles publishes and syncs exactly as it did before.
   */
  private async roleOf(remote: string): Promise<RemoteRole | null> {
    const { roles } = await this.authorityStatus();
    return roles.get(remote) ?? null;
  }

  /**
   * Read the configured role requirements. A comma-separated list of roles, in
   * the order written. An absent or empty key requires no role. An unknown role
   * is refused with a diagnostic naming the offending value and the valid set,
   * because silently ignoring a typo would leave a repository believing it has a
   * policy it does not have.
   */
  private async readSigningRoles(): Promise<readonly SignatureRole[]> {
    const result = await this.repository.run(["config", "--get", "reveries.signingRoles"], {
      allowExitCodes: [0, 1],
    });
    const value = result.stdout.trim();
    if (value === "") return [];
    const names = value
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
    for (const name of names) {
      if (!(SIGNATURE_ROLES as readonly string[]).includes(name)) {
        throw new Error(
          `reveries.signingRoles must name roles from ${SIGNATURE_ROLES.join(", ")}; found ${name}`,
        );
      }
    }
    return names as readonly SignatureRole[];
  }

  /**
   * Signatures over fact records in the current notes snapshot, keyed by the
   * record they attest. Multiple signatures per target are expected: that is
   * what a key rotation and a multi-role review both produce.
   */
  async signatureReports(): Promise<Map<string, SignatureTrustReport[]>> {
    const reports = new Map<string, SignatureTrustReport[]>();
    // Resolve the policy once: reading configuration per record would be both
    // wasteful and, for a bad value, repeated failure.
    const policy = await this.signingPolicy();
    const notesTip = await this.repository.notesTip();
    if (notesTip === null) return reports;
    for (const entry of await this.repository.listNotes()) {
      const body = await this.repository.readNoteAt(notesTip, entry.object);
      if (body === null) continue;
      for (const record of this.parseSignatureLines(body)) {
        const report = this.verifySignatureRecord(record, policy);
        reports.set(record.target, [...(reports.get(record.target) ?? []), report]);
      }
    }
    return reports;
  }

  private parseSignatureLines(body: string): SignatureRecord[] {
    const records: SignatureRecord[] = [];
    for (const line of body.split("\n")) {
      if (!line) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        // A malformed line is a note-level diagnostic handled by the snapshot
        // validator; the signature pass only reads what it can understand.
        continue;
      }
      if (value && typeof value === "object" && (value as { type?: unknown }).type === "signature") {
        records.push(value as SignatureRecord);
      }
    }
    return records;
  }

  /**
   * Sign the ledger manifest and return the canonical signature lines, or null
   * when this repository has no signer. The signed bytes are exactly
   * `ledgerManifestPayload`, which already contains the notes, ledger, and
   * retention tips, so the checkpoint is bound without new manifest fields.
   */
  async signLedgerManifest(manifest: LedgerManifest, role: SignatureRole = "publisher"): Promise<string | null> {
    const signer = this.signing.signer;
    if (signer === undefined) return null;
    const content = ledgerManifestPayload(manifest);
    const contentId = await this.signatureContentId(Buffer.from(content, "utf8"));
    // The subject is the commit the signature travels with. A genesis checkpoint
    // with no notes, previous ledger, or retention commit has no such commit yet,
    // so it falls back to the manifest's own hash, which is still a stable and
    // verifiable object ID for the exact bytes being signed.
    const subject = manifest.notes_commit
      ?? manifest.previous_ledger
      ?? manifest.retention_commit
      ?? await this.signatureContentId(Buffer.from(content, "utf8"));
    const draft = {
      domain: SIGNATURE_DOMAIN_MANIFEST,
      role,
      target: "ledger-manifest",
      subject,
      signer: signer.signer,
      key_id: signer.keyId,
      algorithm: signer.algorithm,
      signature: "",
      content_id: contentId,
    };
    const provisional = createSignature(
      { ...draft, signature: "placeholder" },
      { author_email: signer.signer, session: null, created_at: LEDGER_SIGNATURE_TIMESTAMP },
      (bytes) => this.repository.hashObjectSync(bytes),
    );
    const signature = signer.sign(Buffer.from(signingPayload(provisional), "utf8"));
    const record = createSignature(
      { ...draft, signature: Buffer.from(signature).toString("base64") },
      { author_email: signer.signer, session: null, created_at: LEDGER_SIGNATURE_TIMESTAMP },
      (bytes) => this.repository.hashObjectSync(bytes),
    );
    return canonicalRecord(record);
  }

  /**
   * Report how signing relates to local evidence. Mirrors the RVR-005 ledger
   * rule that only genuinely broken evidence is damage: an absent signer, an
   * unknown key, and an unsigned-but-valid checkpoint are all ordinary.
   */
  async signatureStatus(): Promise<SignatureStatus> {
    const counts: Record<TrustState, number> = {
      unknown: 0,
      valid: 0,
      trusted: 0,
      "policy-satisfying": 0,
      invalid: 0,
      revoked: 0,
    };
    const diagnostics: string[] = [];
    const policy = await this.signingPolicy();
    const requiredRoles = policy.requiredRoles;
    const reports = await this.signatureReports();
    for (const entries of reports.values()) {
      for (const report of entries) {
        counts[report.state] += 1;
        if (report.state === "invalid" || report.state === "revoked") {
          diagnostics.push(
            `Signature ${report.id} over ${report.target} by ${report.signer} is ${report.state}`,
          );
        }
      }
    }
    const checkpoint = await this.repository.ledgerTip();
    if (checkpoint === null) {
      return { state: "absent", counts, checkpoint: null, checkpointSigned: false, requiredRoles, diagnostics };
    }
    const stored = await this.repository.readLedgerSignaturesAt(checkpoint);
    if (stored === null) {
      return { state: "unsigned", counts, checkpoint, checkpointSigned: false, requiredRoles, diagnostics };
    }
    // The checkpoint's own attestations are counted with the record signatures so
    // a reader sees one trust picture rather than two partial ones.
    let checkpointSigned = false;
    for (const record of this.parseSignatureLines(stored)) {
      const report = this.verifySignatureRecord(record, policy);
      counts[report.state] += 1;
      if (report.state === "policy-satisfying" || report.state === "trusted") {
        checkpointSigned = true;
      }
      if (report.state === "invalid" || report.state === "revoked") {
        diagnostics.push(`Checkpoint signature ${report.id} is ${report.state}`);
      }
    }
    return {
      state: "signed",
      counts,
      checkpoint,
      checkpointSigned,
      requiredRoles,
      diagnostics,
    };
  }

  /**
   * Whether an envelope may become canonical state through the envelope route.
   *
   * The notes route (`syncPull`) withholds promotion for non-primary roles by
   * construction, but the envelope route carries the *same* evidence through a
   * different transport. Without this gate, a direct API caller could route
   * around the quarantine decision via `materializeNotesFromLedger` with a
   * mirror/import-only remote-tracking revision — or with the same checkpoint
   * named by raw OID, which carries no provenance at all. Withholding is
   * therefore a property of the evidence enforced here, not of whichever
   * caller or spelling runs first.
   *
   * A remote with no declared role keeps its pre-role behaviour: it promotes.
   * A contradictory configuration is not an undeclared remote, and nothing
   * promotes while the repository cannot say which remote is authoritative.
   * The local ledger tip (`revision === undefined`) carries no foreign
   * provenance to judge, so it is allowed through to verification. An explicit
   * revision that names no configured remote is an unknown source: refused
   * whenever any role is declared, allowed only in a repository that never
   * adopted roles at all.
   */
  private async envelopePromotionPolicy(
    revision: string | undefined,
  ): Promise<{ readonly allowed: boolean; readonly diagnostic: string | null }> {
    const authority = await this.authorityStatus();
    if (authority.state === "invalid") {
      return {
        allowed: false,
        diagnostic: `Authority configuration is invalid, so no envelope may become canonical state: ${authority.diagnostics.join("; ")}`,
      };
    }
    const match = await this.trackingRemote(revision);
    const remote = match ?? null;
    if (remote === null) {
      // An explicit revision with no configured remote-tracking provenance —
      // a raw OID, a local branch, a tag — cannot be attributed to any role.
      // Refuse it as an unknown source whenever roles are declared; a legacy
      // repository without roles keeps its historical behaviour.
      if (revision !== undefined && authority.roles.size > 0) {
        return {
          allowed: false,
          diagnostic: `The revision ${revision} names no configured remote, so its evidence cannot be attributed to a role; materialize was refused`,
        };
      }
      return { allowed: true, diagnostic: null };
    }
    const role = await this.roleOf(remote);
    if (role === null) return { allowed: true, diagnostic: null };
    if (rolePromotion(role) === "promote") return { allowed: true, diagnostic: null };
    return {
      allowed: false,
      diagnostic: `${remote} is an ${role} remote, so its evidence is quarantined rather than promoted, and the ledger envelope transports the same notes; materialize was refused`,
    };
  }

  async materializeNotesFromLedger(input: {
    /** The local notes tip this call expects to replace; null when absent. */
    readonly expectedNotes: ObjectId | null;
    /**
     * The envelope to materialize. Defaults to the local ledger branch tip; a
     * fresh clone passes its remote-tracking ref, because that is the only
     * place an ordinary branch fetch leaves the envelope.
     */
    readonly revision?: string;
  }): Promise<LedgerMaterializeResult> {
    const { revision } = input;
    // The promotion decision runs before verification or any ref move, so a
    // withheld envelope never reaches canonical state through this route and
    // the local refs are left exactly as they were.
    const promotion = await this.envelopePromotionPolicy(revision);
    if (!promotion.allowed) {
      return {
        ok: false,
        diagnostics: [promotion.diagnostic ?? "The ledger envelope was refused"],
        state: "unchanged",
        notesTip: await this.repository.notesTip(),
      };
    }
    const verification = await this.verifyLedgerEnvelope(revision);
    if (!verification.ok) {
      return { ok: false, diagnostics: verification.diagnostics, state: "unchanged", notesTip: await this.repository.notesTip() };
    }
    const checkpoint = revision === undefined ? await this.repository.ledgerTip() : await this.repository.resolveCommit(revision);
    const manifest = checkpoint === null
      ? null
      : readLedgerManifest((await this.repository.readLedgerManifestAt(checkpoint)) as string);
    if (manifest === null || manifest.notes_commit === null) {
      return {
        ok: false,
        diagnostics: ["The verified ledger envelope transports no notes commit"],
        state: "unchanged",
        notesTip: await this.repository.notesTip(),
      };
    }
    const secretDiagnostics = await this.secretMaterialDiagnosticsAtNotesCommit(manifest.notes_commit);
    if (secretDiagnostics.length > 0) {
      return {
        ok: false,
        diagnostics: secretDiagnostics,
        state: "unchanged",
        notesTip: await this.repository.notesTip(),
      };
    }
    const current = await this.repository.notesTip();
    if (current === manifest.notes_commit) {
      return { ok: true, diagnostics: [], state: "unchanged", notesTip: current };
    }
    // The envelope REPLACES the notes ref rather than unioning into it, so a
    // local tip the envelope does not contain must never be overwritten here.
    // An absent ref is the fresh-clone case the envelope exists for, and a
    // strict ancestor is a fast-forward; every other state is refused exactly
    // as the caller-facing gate does, so direct API callers get the same
    // protection as the command layer.
    if (current !== null && !(await this.repository.isAncestor(current, manifest.notes_commit))) {
      return {
        ok: false,
        diagnostics: [
          `The local ${NOTES_REF} carries notes the ledger envelope does not contain, so it was left unchanged`,
        ],
        state: "unchanged",
        notesTip: current,
      };
    }
    const format = await this.repository.objectFormat();
    const absent = "0".repeat(format === "sha1" ? 40 : 64);
    const moved = await this.repository.run(
      ["update-ref", NOTES_REF, manifest.notes_commit, input.expectedNotes ?? absent],
      { allowExitCodes: [0, 1, 128] },
    );
    if (moved.exitCode !== 0) {
      return {
        ok: false,
        diagnostics: [`The local ${NOTES_REF} ref changed while materializing the ledger envelope`],
        state: "unchanged",
        notesTip: await this.repository.notesTip(),
      };
    }
    return { ok: true, diagnostics: [], state: "materialized", notesTip: manifest.notes_commit };
  }

  /** Report how the ledger envelope relates to local notes state. */
  /**
   * Compare each configured mirror's checkpoint against the primary's (RVR-017).
   *
   * A mirror is a replica, so the check is about agreement rather than
   * correctness: the mirror must name the same authority, and it must not carry
   * a notes commit the primary does not, which is what an independent write to a
   * replica looks like. The signature comparison only runs when the primary's own
   * checkpoint is signed; otherwise the mirror is reported `unsigned`, because
   * demanding a signature nothing produces would make the check unpassable rather
   * than strict.
   *
   * This is deliberately network-free. It reads only local remote-tracking refs,
   * so `doctor` stays a local operation and a mirror that has not been fetched is
   * `unavailable` rather than a fetch.
   */
  async verifyMirrorEnvelopes(): Promise<readonly MirrorStatus[]> {
    const authority = await this.authorityStatus();
    // An invalid authority configuration already reported itself, and its
    // diagnostics are not mirror problems. Re-reporting them here would
    // duplicate every message and make one root cause look like several.
    if (authority.state === "invalid") return [];
    const mirrors = [...authority.roles]
      .filter(([, role]) => role === "mirror")
      .map(([remote]) => remote)
      .sort();
    if (mirrors.length === 0) return [];
    const local = await this.repository.ledgerTip();
    const localStored = local === null ? null : await this.repository.readLedgerManifestAt(local);
    const localManifest = localStored === null
      ? null
      : parseLedgerManifest(localStored, "tolerant").manifest;
    const primarySigned = (await this.signatureStatus()).checkpointSigned;

    const statuses: MirrorStatus[] = [];
    for (const remote of mirrors) {
      const ref = `refs/remotes/${remote}/reveries-ledger`;
      const checkpoint = await this.repository.ledgerTip(ref);
      if (checkpoint === null) {
        // A mirror that has not been fetched is an ordinary state. The message
        // stays in `diagnostics` because that is the detail field, but `doctor`
        // promotes it to a notice by state, so an unfetched mirror is never
        // reported as damage.
        statuses.push({
          remote,
          state: "unavailable",
          checkpoint: null,
          signature: null,
          diagnostics: [`Mirror ${remote} has no fetched ledger checkpoint at ${ref}`],
        });
        continue;
      }
      const stored = await this.repository.readLedgerManifestAt(checkpoint);
      const manifest = stored === null ? null : parseLedgerManifest(stored, "tolerant").manifest;
      if (manifest === null) {
        statuses.push({
          remote,
          state: "divergent",
          checkpoint,
          signature: null,
          diagnostics: [`Mirror ${remote} checkpoint ${checkpoint} has no readable ledger manifest`],
        });
        continue;
      }
      const diagnostics: string[] = [];
      // The envelope structure itself must hold before its claims are compared,
      // so a malformed mirror is damage rather than a trusted peer opinion.
      const envelope = await this.verifyLedgerEnvelope(checkpoint);
      diagnostics.push(...envelope.diagnostics.map((entry) => `Mirror ${remote}: ${entry}`));
      let mismatchedAuthority = false;
      if (manifest.authority !== authority.primary) {
        mismatchedAuthority = true;
        diagnostics.push(
          `Mirror ${remote} names authority ${manifest.authority ?? "none"}, not the primary ${authority.primary ?? "none"}`,
        );
      }
      if (localManifest?.notes_commit != null && manifest.notes_commit !== localManifest.notes_commit) {
        const incorporated = manifest.notes_commit === null
          ? 1
          : (await this.repository.run(
            ["merge-base", "--is-ancestor", manifest.notes_commit, localManifest.notes_commit],
            { allowExitCodes: [0, 1] },
          )).exitCode;
        if (incorporated !== 0) {
          diagnostics.push(
            `Mirror ${remote} transports notes commit ${manifest.notes_commit ?? "none"}, `
            + `which the primary checkpoint does not contain`,
          );
        }
      }
      const signatureState = primarySigned
        ? await this.mirrorSignatureState(checkpoint, manifest)
        : null;
      if (primarySigned && signatureState === null) {
        diagnostics.push(
          `Mirror ${remote} checkpoint ${checkpoint} carries no signature over its own manifest, `
          + `while the primary checkpoint is signed`,
        );
      } else if (signatureState === "invalid" || signatureState === "revoked") {
        diagnostics.push(`Mirror ${remote} manifest signature is ${signatureState}`);
      }
      const state: MirrorState = mismatchedAuthority
        ? "authority-mismatch"
        : diagnostics.length > 0
          ? "divergent"
          : signatureState === null ? "unsigned" : "matching";
      statuses.push({ remote, state, checkpoint, signature: signatureState, diagnostics });
    }
    return statuses;
  }

  /**
   * The trust state of a checkpoint's newest manifest signature, or null when the
   * checkpoint carries none. A mirror has to sign *its own* manifest bytes, so
   * this compares `content_id` against the mirror's manifest rather than reusing
   * the primary's verdict.
   */
  private async mirrorSignatureState(
    checkpoint: ObjectId,
    manifest: LedgerManifest,
  ): Promise<TrustState | null> {
    const stored = await this.repository.readLedgerSignaturesAt(checkpoint);
    if (stored === null) return null;
    const records = this.parseSignatureLines(stored);
    const newest = records[records.length - 1];
    if (newest === undefined) return null;
    const contentId = await this.signatureContentId(Buffer.from(ledgerManifestPayload(manifest), "utf8"));
    if (newest.content_id !== contentId) return "invalid";
    return this.verifySignatureRecord(newest, await this.signingPolicy()).state;
  }

  /** Report how the ledger envelope relates to local notes state. */
  async ledgerStatus(): Promise<LedgerStatus> {
    const notesTip = await this.repository.notesTip();
    const tip = await this.repository.ledgerTip();
    if (tip === null) {
      return {
        state: "absent",
        tip: null,
        notesCommit: null,
        notesTip,
        previousLedger: null,
        retentionCommit: null,
        annotatedSubjects: 0,
        diagnostics: [],
      };
    }
    const stored = await this.repository.readLedgerManifestAt(tip);
    let manifest: LedgerManifest | null = null;
    const diagnostics: string[] = [];
    if (stored === null) {
      diagnostics.push("Ledger checkpoint has no manifest.json");
    } else {
      const parsed = parseLedgerManifest(stored, "tolerant");
      manifest = parsed.manifest;
      for (const diagnostic of parsed.diagnostics) diagnostics.push(`Ledger manifest: ${diagnostic.message}`);
    }
    const verification = manifest === null ? { ok: false, diagnostics } : await this.verifyLedgerEnvelope(tip);
    const annotatedSubjects = manifest?.annotated_subjects ?? 0;
    if (!verification.ok) {
      return {
        state: "invalid",
        tip,
        notesCommit: manifest?.notes_commit ?? null,
        notesTip,
        previousLedger: manifest?.previous_ledger ?? null,
        retentionCommit: manifest?.retention_commit ?? null,
        annotatedSubjects,
        diagnostics: [...diagnostics, ...verification.diagnostics],
      };
    }
    // A structurally valid envelope that no longer describes the local notes
    // ref is stale. That is an ordinary unpublished state, not damage.
    const state: LedgerState = notesTip !== manifest?.notes_commit ? "stale" : "valid";
    return {
      state,
      tip,
      notesCommit: manifest?.notes_commit ?? null,
      notesTip,
      previousLedger: manifest?.previous_ledger ?? null,
      retentionCommit: manifest?.retention_commit ?? null,
      annotatedSubjects,
      diagnostics: [],
    };
  }

  /**
   * Report the health of the evidence, and nothing else.
   *
   * Doctor used to answer four questions at once: whether the evidence was
   * sound, whether local hooks were installed, whether a ledger envelope agreed
   * with the notes ref, and whether signatures covered it. The last three were
   * enforcement, and they reported "damaged" for choices an operator is
   * entitled to make. What remains is integrity: `ok` is false only for damage
   * a reader must not ignore, namely a record the protocol cannot parse or a
   * retained object that is no longer reachable. Everything else is a notice.
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

  private async checkRemoteNotesIncorporated(remote: string, remoteObject: ObjectId | null): Promise<CheckResult> {
    if (remoteObject === null) {
      const established = await this.repository.notesTip(`refs/notes/remotes/${remote}/reveries`);
      return established === null
        ? { ok: true, diagnostics: [] }
        : {
            ok: false,
            diagnostics: [`Remote ${remote} notes ref is absent despite established remote notes history`],
          };
    }
    const localObject = await this.repository.notesTip();
    if (localObject === null || !await this.repository.objectExists("commit", remoteObject)) {
      return {
        ok: false,
        diagnostics: [`Remote ${remote} notes are unavailable locally; fetch and merge them before publication`],
      };
    }
    const incorporated = await this.repository.run(
      ["merge-base", "--is-ancestor", remoteObject, localObject],
      { allowExitCodes: [0, 1] },
    );
    return incorporated.exitCode === 0
      ? { ok: true, diagnostics: [] }
      : { ok: false, diagnostics: [`Remote ${remote} notes have not been incorporated`] };
  }

  private async checkOutgoingRange(
    initialization: CommitId,
    localObject: CommitId,
    remoteObject: ObjectId | null,
    remoteRef: string,
  ): Promise<readonly string[]> {
    const containsInitialization = await this.repository.run(
      ["merge-base", "--is-ancestor", initialization, localObject],
      { allowExitCodes: [0, 1] },
    );
    if (containsInitialization.exitCode !== 0) {
      return [`${remoteRef}: outgoing branch must merge or rebase the Reveries initialization boundary`];
    }
    const argumentsList = ["rev-list", localObject];
    if (remoteObject !== null) argumentsList.push(`^${remoteObject}`);
    const result = await this.repository.run(argumentsList, { allowExitCodes: [0, 128] });
    if (result.exitCode !== 0) {
      return [`${remoteRef}: cannot establish the exact outgoing commit range`];
    }
    const diagnostics: string[] = [];
    for (const value of result.stdout.trim().split("\n").filter((line) => line.length > 0).reverse()) {
      const commit = commitId(value);
      const postInitialization = await this.repository.run(
        ["merge-base", "--is-ancestor", initialization, commit],
        { allowExitCodes: [0, 1] },
      );
      if (postInitialization.exitCode !== 0) continue;
      const check = await this.checkCommit(commit);
      diagnostics.push(...check.diagnostics.map((diagnostic) => `${remoteRef} ${commit}: ${diagnostic}`));
    }
    return diagnostics;
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
  private async validateCoordinate(coordinate: OccurrenceCoordinate): Promise<void> {
    let resolved;
    try {
      resolved = await this.repository.resolveSubject({
        path: coordinate.path,
        revision: String(coordinate.commit),
      });
    } catch (error: unknown) {
      await this.gradedFailure(error, [coordinate.commit, coordinate.subject]);
      throw new Error(
        `Occurrence coordinate ${coordinate.path}@${coordinate.commit} does not resolve: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (resolved.object !== coordinate.subject) {
      throw new Error(
        `Occurrence coordinate ${coordinate.path}@${coordinate.commit} holds ${resolved.object}, not ${coordinate.subject}`,
      );
    }
  }

  /**
   * A lineage edge is checked against the repository before it can influence
   * any verdict: the parent must be a direct parent of the commit, every
   * endpoint must resolve in the revision it names, and every predecessor must
   * carry evidence. Anything else is a claim about a change this edge does not
   * describe, so it fails closed rather than being stored and ignored.
   */
  private async validateLineageRecord(record: LineageRecord): Promise<void> {
    const parents = (await this.repository.run([
      "show", "-s", "--format=%P", String(record.commit),
    ])).stdout.trim().split(" ").filter((value) => value.length > 0);
    if (!parents.includes(String(record.parent))) {
      throw new Error(
        `Lineage ${record.id} binds parent ${record.parent}, which is not a direct parent of commit ${record.commit}`,
      );
    }
    for (const endpoint of record.from) {
      await this.validateLineageEndpoint(endpoint, record.parent, record, "from");
    }
    for (const endpoint of record.to) {
      await this.validateLineageEndpoint(endpoint, record.commit, record, "to");
    }
    if (record.transition !== null) {
      const view = await this.loadCachedEvidenceSnapshot({});
      if (!view.transitions.has(record.transition)) {
        throw new Error(`Lineage ${record.id} names transition ${record.transition}, which has no transition record`);
      }
    }
  }

  private async validateLineageEndpoint(
    endpoint: LineageEndpoint,
    revision: CommitId,
    record: LineageRecord,
    field: string,
  ): Promise<void> {
    let resolved;
    try {
      resolved = await this.repository.resolveSubject({ path: endpoint.path, revision: String(revision) });
    } catch (error: unknown) {
      await this.gradedFailure(error, [revision, endpoint.subject]);
      throw new Error(
        `Lineage ${record.id} ${field} endpoint ${endpoint.path} does not resolve at ${revision}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (resolved.object !== endpoint.subject) {
      throw new Error(
        `Lineage ${record.id} ${field} endpoint ${endpoint.path} holds ${resolved.object} at ${revision}, not ${endpoint.subject}`,
      );
    }
    if (field !== "from") return;
    const annotated = (await this.readEvidenceNote(endpoint.subject)) !== null;
    if (!annotated) {
      throw new Error(
        `Lineage ${record.id} pairs ${endpoint.path}, which has no annotated evidence to pair`,
      );
    }
  }

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

  private async findInitialization(): Promise<{ readonly commit: CommitId; readonly record: ReveriesInit } | null> {
    const view = await this.loadCachedEvidenceSnapshot({});
    if (view.initError !== null) throw new Error(view.initError);
    return view.init;
  }

  /**
   * Staged blob transitions. Rename detection is deliberately absent: `-M`
   * would let Git's similarity score decide that a renamed-and-edited blob is
   * the predecessor of the new one, and a copied record would then discharge
   * the obligation without anyone asserting the relation. An unchanged rename
   * keeps the same blob OID, so it is filtered below by the subject still being
   * reachable and never needs a pairing.
   */
  private async stagedTransitions(): Promise<readonly DiffTransition[]> {
    const result = await this.repository.run([
      "diff", "--cached", "--raw", "-z", "--abbrev=64", "HEAD",
    ]);
    const successorBlobs = new Set((await this.repository.listIndex()).map((entry) => entry.object));
    return this.parseTransitions(result.stdout).filter(
      (transition) => transition.to !== undefined || !successorBlobs.has(transition.from),
    );
  }

  /**
   * Committed blob transitions for one parent, without similarity pairing. A
   * renamed-and-edited blob is a deletion plus an addition, so the annotated
   * predecessor has no successor until an explicit durable lineage edge or a
   * causal retirement says what happened to it.
   */
  private async commitTransitions(parent: string, commit: string): Promise<readonly DiffTransition[]> {
    const result = await this.repository.run([
      "diff-tree", "--raw", "-z", "--abbrev=64", "-r", "--no-commit-id", parent, commit,
    ]);
    const successorBlobs = new Set((await this.repository.listTree(commit)).map((entry) => entry.object));
    return this.parseTransitions(result.stdout).filter(
      (transition) => transition.to !== undefined || !successorBlobs.has(transition.from),
    );
  }

  private parseTransitions(raw: string): readonly DiffTransition[] {
    const fields = raw.split("\0");
    const transitions: DiffTransition[] = [];
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
      const renamed = status.startsWith("R") || status.startsWith("C");
      const newPath = renamed ? fields[index + 1] : oldPath;
      index += renamed ? 2 : 1;
      if (zeroObject(oldValue)) continue;
      if (!isFullObjectId(oldValue)) throw new Error("Git diff returned an abbreviated predecessor object ID");
      if (oldValue === newValue) continue;
      const from = blobId(oldValue);
      if (zeroObject(newValue)) transitions.push({ from, ...(oldPath === undefined ? {} : { oldPath }) });
      else {
        if (!isFullObjectId(newValue)) throw new Error("Git diff returned an abbreviated successor object ID");
        transitions.push({
          from,
          to: blobId(newValue),
          ...(oldPath === undefined ? {} : { oldPath }),
          ...(newPath === undefined ? {} : { newPath }),
        });
      }
    }
    return transitions;
  }

  private async projectionFor(blob: ObjectId): Promise<ActiveProjection> {
    return (await this.strictRead(blob)).projection;
  }

  /**
   * Tree-subject continuity pairs between two revisions (RVR-013). A
   * descendant blob edit produces a new ancestor tree OID, so every
   * annotated old ancestor tree needs an explicit disposition. Pairing is
   * by identical directory path and never by similarity or by notes evidence
   * on unrelated trees: an unchanged move or copy keeps the same OID
   * reachable and needs no disposition, while a vanished directory path
   * yields a successor-less pair that a durable lineage edge (RVR-014) or a
   * causal retirement must resolve.
   *
   * The revision root tree is paired explicitly because `ls-tree -r -t`
   * lists nested subtrees but never the root itself; without this pair a
   * reverie on the exact root tree would record and show but never oblige.
   * Root transition summaries (RVR-004) co-locate on the same note
   * unaffected: placement already allows both record kinds on trees.
   *
   * Membership comes from one `git notes list` snapshot, so unannotated
   * directories cost no note reads (RVR-012).
   */
  private async treeSubjectTransitions(
    oldRevision: string,
    newRevision: string,
    newIsIndex: boolean,
  ): Promise<readonly DiffTransition[]> {
    const oldRoot = await this.repository.resultTreeForCommit(await this.repository.resolveCommit(oldRevision));
    const newTree = newIsIndex
      ? await this.repository.indexTree()
      : await this.repository.resultTreeForCommit(await this.repository.resolveCommit(newRevision));
    const annotated = new Set((await this.evidenceNotes()).map((entry) => entry.object as string));
    const transitions: DiffTransition[] = [];
    const oldEntries = (await this.repository.listTreeIncludingTrees(oldRevision))
      .filter((entry) => entry.type === "tree");
    if (oldEntries.length !== 0) {
      const newEntries = await this.repository.listTreeIncludingTrees(newTree);
      const newOids = new Set(newEntries.map((entry) => entry.object as string));
      // Same-path successors are trees only: replacing a directory with a file
      // at the same path leaves a successor-less pair that requires retirement.
      // Same-path successors are trees only: replacing a directory with a file
      // at the same path leaves a successor-less pair that requires retirement.
      const newByPath = new Map(
        newEntries
          .filter((entry) => entry.type === "tree")
          .map((entry) => [entry.path, entry.object]),
      );
      const seen = new Set<string>();
      for (const old of oldEntries) {
        const from = old.object as string;
        if (seen.has(from)) continue;
        seen.add(from);
        // Universal applicability: the exact subtree still exists somewhere.
        if (newOids.has(from)) continue;
        if (!annotated.has(from)) continue;
        const successor = newByPath.get(old.path);
        transitions.push(successor === undefined
          ? { from: old.object, oldPath: old.path }
          : { from: old.object, to: successor, oldPath: old.path, newPath: old.path });
      }
    }
    if (oldRoot !== newTree && annotated.has(oldRoot as string)) {
      transitions.push({ from: oldRoot, to: newTree, oldPath: ".", newPath: "." });
    }
    return transitions;
  }

  /**
   * Suggest lineage candidates for a change using Git's similarity detection
   * (RVR-014).
   *
   * This is the only place in the product that asks Git to detect renames, and
   * nothing here can discharge an obligation: the rows are unconfirmed
   * proposals, and the authoritative matcher deliberately runs with rename
   * detection off. Turning a suggestion into evidence requires recording a
   * lineage edge and a per-decision disposition.
   */
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
      const parents = await this.commitParents(commit);
      parent = parents[0] ?? null;
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

  private async checkTransitions(
    transitions: readonly DiffTransition[],
    summary: SessionSummary,
    pairings: readonly SubjectPairing[] = [],
    guidance: string | null = null,
  ): Promise<CheckResult> {
    const predecessors = new Map<ObjectId, ActiveProjection>();
    const successors = new Map<ObjectId, ActiveProjection>();
    const subjects = new Set<ObjectId>();
    for (const transition of transitions) {
      subjects.add(transition.from);
      if (transition.to !== undefined) subjects.add(transition.to);
    }
    for (const pairing of pairings) {
      subjects.add(pairing.from);
      for (const successor of pairing.to) subjects.add(successor);
    }
    for (const subject of subjects) {
      if (await this.readEvidenceNote(subject) !== null) {
        const projection = await this.projectionFor(subject);
        predecessors.set(subject, projection);
        successors.set(subject, projection);
      }
    }
    const report = analyzeContinuity({ transitions, pairings, predecessors, successors, summary });
    const diagnostics = [
      ...report.conflicts,
      ...report.obligations.map((obligation) => {
        const where = obligation.missing_at === undefined || obligation.missing_at.length === 0
          ? ""
          : ` (no disposition at ${obligation.missing_at.join(", ")})`;
        const route = obligation.to_blob === undefined && guidance !== null ? ` ${guidance}` : "";
        return `${obligation.id} from ${obligation.from_blob}: ${obligation.reason}${where}${route}`;
      }),
    ];
    return { ok: report.ok, diagnostics };
  }

  /**
   * Classify every lineage edge that claims this exact parent→commit change
   * (RVR-014), and turn the authoritative ones into successor sets.
   *
   * An edge is bound to a direct parent and a result commit, so authority
   * cannot be borrowed: an edge for another commit, another parent, or an
   * endpoint that is not part of this change is history or a contradiction,
   * never a pairing. Edges are read from the note of the commit they describe,
   * because that is the only place placement allows them.
   */
  async classifyLineage(input: {
    readonly commit: CommitId;
    readonly parent: CommitId;
    /**
     * Coordinates this change disturbs, as `parent\0path\0subject`. A
     * subject OID alone is not enough: the same object at another path is a
     * different occurrence, so an edge may only claim the path it names.
     */
    readonly disturbed: ReadonlySet<string>;
  }): Promise<{
    readonly pairings: SubjectPairing[];
    readonly used: LineageUse[];
    readonly historyOnly: LineageId[];
  }> {
    // Every known edge is classified, not only the ones on this commit: an edge
    // that describes another change is history, and saying so is the honest
    // answer. The authority pass itself reads only this commit's edges.
    const index = await this.lineageEdges();
    const edges: LineageRecord[] = [...(index.get(input.commit) ?? [])];
    const historyOnly: LineageId[] = [];
    const pairings: SubjectPairing[] = [];
    const used: LineageUse[] = [];
    // Every other edge in the evidence is history: it describes a different
    // change and can never authorize this one.
    for (const [commit, recorded] of index) {
      if (String(commit) === String(input.commit)) continue;
      for (const edge of recorded) historyOnly.push(edge.id);
    }
    if (edges.length === 0) return { pairings, used, historyOnly };
    const resultCoordinates = await this.coordinatesInCommit(input.commit);
    for (const edge of edges) {
      if (String(edge.commit) !== String(input.commit)) {
        historyOnly.push(edge.id);
        continue;
      }
      if (String(edge.parent) !== String(input.parent)) {
        historyOnly.push(edge.id);
        continue;
      }
      const undisturbed = edge.from.filter((endpoint) =>
        !input.disturbed.has(coordinateKey(String(edge.parent), endpoint.path, String(endpoint.subject))));
      const absent = edge.to.filter((endpoint) =>
        !resultCoordinates.has(coordinateKey(String(edge.commit), endpoint.path, String(endpoint.subject))));
      if (undisturbed.length > 0 || absent.length > 0) {
        used.push({
          id: edge.id,
          authority: "contradictory",
          detail: [
            ...undisturbed.map((endpoint) =>
              `${endpoint.path} at ${endpoint.subject.slice(0, 12)} is not a subject this commit disturbs`),
            ...absent.map((endpoint) =>
              `${endpoint.path} at ${endpoint.subject.slice(0, 12)} is not present in ${input.commit}`),
          ].join("; "),
        });
        continue;
      }
      const to = edge.to.map((endpoint) => endpoint.subject).sort();
      for (const endpoint of edge.from) {
        pairings.push({ from: endpoint.subject, to, lineage: edge.id });
      }
      used.push({
        id: edge.id,
        authority: "authoritative",
        detail: `pairs ${edge.from.map((endpoint) => endpoint.path).join(", ")} with ${edge.to.length === 0 ? "no successor" : edge.to.map((endpoint) => endpoint.path).join(", ")}`,
      });
    }
    return { pairings, used, historyOnly };
  }

  /**
   * The evidence view every lineage-aware read uses.
   *
   * A receive checker evaluates a *proposed* notes tip, so it must read the
   * edges from that candidate rather than from the ref the receiver currently
   * holds. Otherwise the gate would rule on continuity using yesterday's
   * evidence and reject a push that the proposed notes actually justify — which
   * is precisely the local-green/remote-red failure this protocol refuses to
   * have.
   */
  private async evidenceView(): Promise<EvidenceSnapshotView> {
    if (this.proposedNotesTip === undefined) return this.loadCachedEvidenceSnapshot({});
    const limits = resolveLimits();
    const listed = await this.repository.listNotesAt(this.proposedNotesTip);
    const bodies = await this.repository.readNotesBatch(listed, {});
    return this.buildSnapshotView(this.proposedNotesTip, listed, bodies, limits, false);
  }

  /**
   * Every coordinate a commit's tree holds: each path and the blob or tree
   * found there, plus the root tree at `.`.
   *
   * Paths matter as much as objects. Two paths can hold the same object, and an
   * edge that names the right object at the wrong path is a claim about a
   * different occurrence, so authority is matched on the whole coordinate.
   */
  private async coordinatesInCommit(commit: CommitId): Promise<ReadonlySet<string>> {
    const coordinates = new Set<string>();
    try {
      for (const entry of await this.repository.listTreeIncludingTrees(commit)) {
        coordinates.add(coordinateKey(String(commit), entry.path, String(entry.object)));
      }
      const root = await this.repository.resultTreeForCommit(commit);
      coordinates.add(coordinateKey(String(commit), ".", String(root)));
    } catch {
      // An unreadable tree leaves the set empty, which makes every edge
      // contradictory rather than authoritative: fail closed.
    }
    return coordinates;
  }

  /** Coordinates of the annotated predecessors a change disturbs. */
  private disturbedCoordinates(
    parent: CommitId,
    transitions: readonly DiffTransition[],
  ): Set<string> {
    const disturbed = new Set<string>();
    for (const transition of transitions) {
      if (transition.oldPath === undefined) continue;
      disturbed.add(coordinateKey(String(parent), transition.oldPath, String(transition.from)));
    }
    return disturbed;
  }
}
import { access, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
