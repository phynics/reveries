export const NOTES_REF = "refs/notes/reveries" as const;
export const LEDGER_REF = "refs/heads/reveries-ledger" as const;

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
export type TransitionId = Brand<`tr:${string}`, "transition-id">;
export type CorrectionId = Brand<`cr:${string}`, "correction-id">;
export type ResolutionId = Brand<`rs:${string}`, "resolution-id">;
export type RedactionId = Brand<`rd:${string}`, "redaction-id">;
export type SignatureId = Brand<`sg:${string}`, "signature-id">;
/** Opaque, non-bearer vault locator for confidential rationale held elsewhere. */
export type ConfidentialPointer = Brand<`vault:v1:${string}`, "confidential-pointer">;
/**
 * Occurrence-specific evidence (RVR-014). An occurrence is addressed, not
 * content-addressed, so it takes a prefix of its own: the same canonical
 * decision about two occurrences of one blob must be two distinct records.
 */
export type OccurrenceId = Brand<`oc:${string}`, "occurrence-id">;
/**
 * A durable subject pairing (RVR-014). It is an immutable structural fact
 * about two sets of repository coordinates, never a decision about content.
 */
export type LineageId = Brand<`lg:${string}`, "lineage-id">;

/**
 * Heads a correction or resolution edge may name: reveries and the new
 * immutable fact kinds. Transition facts keep their RVR-004 identity and
 * fail-closed duplicate handling; they are never superseded, only redacted.
 * Occurrence and lineage records are nodes here (RVR-014): they carry no
 * outgoing edges of their own, so reusing this graph keeps them correctable
 * and conflict-visible instead of inventing a parallel supersession graph.
 */
export type FactHeadId = ReverieId | OccurrenceId | LineageId | CorrectionId | ResolutionId;
/** Every fact a soft redaction may suppress from normal display. */
export type FactTargetId = FactHeadId | TransitionId;

export type SourceRelation =
  | "caused-by"
  | "constrained-by"
  | "requested-by"
  | "derived-from"
  | "implements"
  | "corroborated-by";

export type SourceKind = "commit" | "blob" | "tree" | "path" | "note" | "git-email" | "issue" | "confidential-pointer";

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

export type Retirement = {
  reverie: ReverieId;
  /**
   * The annotated predecessor subject this retirement releases.
   * The wire key stays `from_blob` byte-for-byte for V1 compatibility; its
   * value is a blob-or-tree subject ID (RVR-013). A changed causal statement
   * receives a new reverie that supersedes the predecessor; a retirement
   * records why the predecessor no longer applies.
   */
  from_blob: SubjectId;
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

/**
 * Ledger envelope manifest (RVR-005). It describes the boundary of one
 * `refs/heads/reveries-ledger` checkpoint: the exact notes commit and notes
 * tree it transports, the checkpoint it follows, the optional retention
 * checkpoint it anchors, and the reserved authority name.
 *
 * This is deliberately not a `NoteRecord`. A manifest describes the notes state
 * rather than living inside it, so it must not inherit note placement, union, or
 * fork rules. It carries no timestamp so that a checkpoint rebuilt from the same
 * evidence reproduces the same object ID; RVR-009 signs these canonical bytes.
 */
export type LedgerManifest = {
  v: 1;
  type: "ledger-manifest";
  protocol: 1;
  ledger_ref: typeof LEDGER_REF;
  notes_ref: typeof NOTES_REF;
  /** The exact notes commit transported as a typed parent; null when no notes exist. */
  notes_commit: CommitId | null;
  /** The notes tree OID grafted at the ledger `notes` entry; null exactly when `notes_commit` is null. */
  notes_tree: ObjectId | null;
  /** The previous ledger checkpoint; null only on a genesis checkpoint. */
  previous_ledger: CommitId | null;
  /** The retention checkpoint this ledger anchors; null when no vault exists. */
  retention_commit: CommitId | null;
  /**
   * The primary remote this checkpoint is published on behalf of, or null
   * (RVR-017). This field was reserved by RVR-005 and signed by RVR-009, so
   * both tickets extended a stable field rather than adding a key: the role
   * vocabulary lives in configuration and in verification, never in the signed
   * bytes. A repository with no determined authority writes null.
   */
  authority: string | null;
  /** Informational totals recomputed from the grafted notes tree. */
  annotated_subjects: number;
  records: number;
  note_bytes: number;
};

export type LedgerManifestInput = {
  readonly notes_commit: string | null;
  readonly notes_tree: string | null;
  readonly previous_ledger: string | null;
  readonly retention_commit: string | null;
  readonly authority: string | null;
  readonly annotated_subjects: number;
  readonly records: number;
  readonly note_bytes: number;
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

/**
 * One concrete occurrence of a subject: a revision, the path inside it, and
 * the exact blob or tree object found there (RVR-014). This triple is the
 * coordinate an occurrence record or a lineage endpoint is anchored to, and
 * it is what makes "the same blob in `src/` and in `vendor/`" two addressable
 * things rather than one universal fact.
 */
export type OccurrenceCoordinate = {
  commit: CommitId;
  path: string;
  subject: SubjectId;
};

export type OccurrenceSemantic = {
  v: 1;
  /** The occurrence this evidence is about. Part of the record identity. */
  occurrence: OccurrenceCoordinate;
  driving_event: string;
  decision: string;
  impact: string;
  recurrence_control: string | null;
  alternatives: string[];
  sources: Source[];
};

/**
 * Occurrence-specific evidence: a decision that holds for exactly one
 * occurrence and not for every occurrence of that content.
 *
 * The coordinate participates in the identity, so two occurrences of one blob
 * can carry different rationale, and a universal reverie is untouched: this is
 * opt-in narrowing, never a replacement. The record rides the note of
 * `occurrence.subject`, so the note is content-addressed while the evidence
 * inside it is path- and revision-specific. There is no `supersedes` field:
 * a mistaken occurrence is corrected through the existing correction and
 * resolution records, never by rewriting this one.
 */
export type OccurrenceRecord = OccurrenceSemantic & ReverieMetadata & {
  type: "occurrence";
  id: OccurrenceId;
};

export type OccurrenceInput = OccurrenceSemantic;

/**
 * One endpoint of a lineage edge: a path and the subject found there in the
 * edge's `parent` (for `from`) or `commit` (for `to`).
 */
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
  /** The RVR-004 tree transition this relation belongs to, when one exists. */
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
 * It rides the note of `commit`, beside that commit's session summary, so an
 * edge is bound to the exact parent→commit change it describes and travels
 * with publication of that commit's evidence.
 */
export type LineageRecord = LineageSemantic & ReverieMetadata & {
  type: "lineage";
  id: LineageId;
};

export type LineageInput = LineageSemantic;

/**
 * Signed payload domains (RVR-009). The domain is inside the signed payload, so
 * a signature produced for a fact record can never be replayed as a checkpoint
 * signature or vice versa. Both are fixed strings: a caller may not invent a
 * domain, because a self-chosen domain would let a signer assert a scope this
 * protocol never agreed to.
 */
export const SIGNATURE_DOMAIN_RECORD = "reveries/v1/record";
export const SIGNATURE_DOMAIN_MANIFEST = "reveries/v1/ledger-manifest";

/** Who is attesting. The role is inside the signed payload, so it cannot be swapped. */
export type SignatureRole = "author" | "reviewer" | "publisher";

export const SIGNATURE_ROLES: readonly SignatureRole[] = ["author", "reviewer", "publisher"];

/**
 * What a publishing remote is for (RVR-017).
 *
 * A `SignatureRole` says who is attesting; a `RemoteRole` says where evidence
 * travels. They are deliberately separate closed sets: a repository that has not
 * adopted roles is ordinary, so the vocabulary is only ever consulted once an
 * operator has declared one.
 */
export type RemoteRole = "primary" | "mirror" | "archive" | "import-only";

export const REMOTE_ROLES: readonly RemoteRole[] = ["primary", "mirror", "archive", "import-only"];

/**
 * What a sync from a remote of this role may do to canonical state.
 *
 * Only the primary promotes. A mirror already holds evidence the primary has, an
 * import is foreign history, and an archive is a destination rather than a
 * source; all three are fetched, fully validated, and kept, but none becomes
 * `refs/notes/reveries`. That is what makes "import-only evidence cannot enter
 * canonical state silently" a property of the code path rather than a convention.
 */
export type RolePromotion = "promote" | "quarantine";

export function rolePromotion(role: RemoteRole): RolePromotion {
  return role === "primary" ? "promote" : "quarantine";
}

/**
 * Whether this repository may push published evidence *to* a remote of this
 * role. This is a different question from promotion: a mirror and an archive are
 * replicas this repository writes to, so they accept publication even though
 * neither is merged back. An `import-only` remote is a source of someone else's
 * history, and publishing into it would forge provenance, so it never does.
 */
export function rolePublishable(role: RemoteRole): boolean {
  return role !== "import-only";
}

/**
 * Whether a remote of this role is a legitimate synchronization source. An
 * archive keeps evidence rather than supplying it, so syncing from one has
 * nothing legitimate to do and is refused instead of silently importing.
 */
export function roleSyncSource(role: RemoteRole): boolean {
  return role !== "archive";
}

/**
 * How much authority this repository has over its publication (RVR-017).
 *
 * `absent` and `unconfigured` are ordinary states, not damage: they are what a
 * repository that never adopted roles looks like, and reporting them as damage
 * would flip every existing V1 setup. Only `invalid` means the configuration
 * contradicts itself.
 */
export type AuthorityState = "absent" | "inferred" | "configured" | "unconfigured" | "invalid";

export type AuthorityResolution = {
  readonly state: AuthorityState;
  /** The single authoritative remote, or null when none is determined. */
  readonly primary: string | null;
  /** Every declared role, keyed by remote name. */
  readonly roles: ReadonlyMap<string, RemoteRole>;
  /** A human-readable summary of why there is no primary. */
  readonly notice: string;
  /** Contradictions only. Absent and inferred authority produce none. */
  readonly diagnostics: readonly string[];
};

const REMOTE_ROLE_SET: ReadonlySet<string> = new Set(REMOTE_ROLES);

export function remoteRole(value: unknown): RemoteRole {
  if (typeof value !== "string" || !REMOTE_ROLE_SET.has(value)) {
    throw new Error(`reveries.remoteRole must name a role from ${REMOTE_ROLES.join(", ")}; found ${String(value)}`);
  }
  return value as RemoteRole;
}

/**
 * Every `reveries.remoteRole` declaration, in one `git config --get-regexp` pass.
 *
 * Two additive encodings exist, and both must be read together or a role becomes
 * invisible:
 *
 * - Flat: `reveries.remoteRole.<remote>`. Git rejects `/` in such a key, so flat
 *   names are necessarily slash-free.
 * - Subsection: `reveries.remoteRole/<remote>.role`, stored as
 *   `[reveries "remoteRole/<remote>"]` with key `role`. This is the only encoding
 *   that can represent a remote whose name contains a slash (`team/vendor`),
 *   which Git permits.
 *
 * The character class **must** be `[./]` and the pattern must continue past it.
 * A pattern that stops at the boundary matches nothing: on git 2.39.5,
 * `--get-regexp '^reveries\.remoteRole'` and `'^reveries\.remoteRole/'` both
 * return zero rows even when subsection keys exist, and `'^reveries\.remoteRole\.'`
 * silently returns only the flat keys. Narrowing this pattern therefore does not
 * degrade loudly — it makes every slash remote's role unreadable, leaving
 * authority silently `unconfigured`. `roleConfigKeys` is the single owner of this
 * string so that failure cannot be reintroduced by a second reader.
 */
export const REMOTE_ROLE_CONFIG_PATTERN = "^reveries\\.remoteRole[./]";

/** The key suffix that marks a subsection entry as a role declaration. */
const REMOTE_ROLE_SUFFIX = ".role";

/**
 * The configuration key that holds `remote`'s role.
 *
 * Flat names keep the legacy key byte for byte, so adopting a slash remote never
 * rewrites configuration a repository already has. Only a name Git could not
 * express as a flat key uses the subsection form. A remote whose own name ends
 * in `.role` is still written unambiguously: the flat branch is chosen by the
 * presence of `/`, not by the suffix, and the subsection branch appends its own
 * `.role` so the reader strips exactly one.
 */
export function remoteRoleConfigKey(remote: string): string {
  return remote.includes("/")
    ? `reveries.remoteRole/${remote}${REMOTE_ROLE_SUFFIX}`
    : `reveries.remoteRole.${remote}`;
}

/**
 * The remote a `reveries.remoteRole` key declares a role for, or null when the
 * key is not a role declaration.
 *
 * Anything else under the prefix is refused rather than misread: a
 * `reveries.remoteRole/team.someOtherSetting` decoy is a different key that
 * happens to share a subsection, and treating it as a role would invent an
 * authority boundary nobody declared.
 */
export function remoteFromRoleConfigKey(key: string): string | null {
  const flat = "reveries.remoteRole.";
  if (key.startsWith(flat)) {
    const remote = key.slice(flat.length);
    return remote.length === 0 ? null : remote;
  }
  const subsection = "reveries.remoteRole/";
  if (!key.startsWith(subsection)) return null;
  const scoped = key.slice(subsection.length);
  if (!scoped.endsWith(REMOTE_ROLE_SUFFIX)) return null;
  const remote = scoped.slice(0, -REMOTE_ROLE_SUFFIX.length);
  return remote.length === 0 ? null : remote;
}

/**
 * Parse the `<key> <value>` lines `git config --get-regexp` prints into roles.
 *
 * Pure so the encoding rules can be tested without a repository, and shared so
 * the CLI, core, and install converge on one reader instead of three
 * hand-rolled ones — three readers is how the CLI came to read roles the core
 * could not, and the drift was invisible until a slash remote existed.
 */
export function parseRemoteRoleConfigLines(stdout: string): Record<string, RemoteRole> {
  const roles: Record<string, RemoteRole> = {};
  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    // `--get-regexp` prints "<key> <value>" separated by the first space, and a
    // remote name cannot contain whitespace, so the split is unambiguous.
    const separator = line.indexOf(" ");
    if (separator < 0) continue;
    const remote = remoteFromRoleConfigKey(line.slice(0, separator));
    if (remote === null) continue;
    roles[remote] = remoteRole(line.slice(separator + 1).trim());
  }
  return roles;
}

/**
 * Derive the authoritative publication configuration from declared roles.
 *
 * This is the whole of RVR-017's "exactly one primary" rule, and it is pure so
 * the rule can be tested without a repository. Exactly one declared primary is
 * authoritative; two is a contradiction that names both offenders so an
 * operator knows which to demote. With nothing declared, a single publishing
 * remote is an unambiguous source and is reported as `inferred`, while zero or
 * several is `unconfigured`. Absence is never damage.
 *
 * `knownRemotes` is the set of remotes Git actually has. A role for a name that
 * does not exist is a contradiction rather than a dormant setting, because a
 * typo would otherwise silently leave a repository believing it has a mirror it
 * does not have. Only a `primary` must also publish; the other three roles are
 * not publishers by definition.
 */
export function resolveAuthorityRoles(
  publishingRemotes: readonly string[],
  declaredRoles: Readonly<Record<string, RemoteRole>>,
  knownRemotes?: readonly string[],
): AuthorityResolution {
  const roles = new Map<string, RemoteRole>();
  for (const [remote, role] of Object.entries(declaredRoles)) {
    roles.set(remote, remoteRole(role));
  }
  const publishing = new Set(publishingRemotes);
  const known = knownRemotes === undefined ? null : new Set(knownRemotes);
  const diagnostics: string[] = [];

  for (const [remote, role] of [...roles].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (known !== null && !known.has(remote)) {
      diagnostics.push(`reveries.remoteRole.${remote} names a role for a remote that does not exist`);
    }
    if (role === "primary" && !publishing.has(remote)) {
      diagnostics.push(`reveries.remoteRole.${remote} names a primary that is not a publishing remote`);
    }
  }

  const declared = [...roles].filter(([, role]) => role === "primary").map(([remote]) => remote).sort();
  if (declared.length > 1) {
    diagnostics.push(
      `Authority must name exactly one primary; reveries.remoteRole declares ${declared.length} (${declared.join(", ")})`,
    );
  }
  if (diagnostics.length > 0) {
    return {
      state: "invalid",
      primary: null,
      roles,
      notice: `Authority configuration is invalid: ${diagnostics.length} problem(s).`,
      diagnostics,
    };
  }

  if (declared.length === 1) {
    const primary = declared[0] as string;
    return {
      state: "configured",
      primary,
      roles,
      notice: `Primary authority is ${primary}.`,
      diagnostics: [],
    };
  }

  const publishers = [...publishing].sort();
  if (publishers.length === 1 && roles.size === 0) {
    const primary = publishers[0] as string;
    return {
      state: "inferred",
      primary,
      roles,
      notice: `Primary authority is ${primary}, inferred from the only publishing remote.`,
      diagnostics: [],
    };
  }
  if (publishers.length === 0 && roles.size === 0) {
    return {
      state: "absent",
      primary: null,
      roles,
      notice: "No publishing remote is configured; this repository publishes nothing.",
      diagnostics: [],
    };
  }
  return {
    state: "unconfigured",
    primary: null,
    roles,
    notice: publishers.length === 0
      ? `No primary is declared; ${roles.size} remote(s) have a non-publishing role.`
      : `No primary is declared among publishing remotes (${publishers.join(", ")}); declare one with reveries.remoteRole.<remote>=primary.`,
    diagnostics: [],
  };
}

/**
 * Where an authority's own append-only signed stream lives under optional
 * federation (RVR-017). This names the grammar only: federation is off unless
 * configured, and consuming an origin stream is later work.
 */
export const ORIGIN_REF_PREFIX = "refs/heads/reveries-origin/" as const;

const REF_UNSAFE = /[~^?*[\]@{} \t\n\r\0\\]/;

/**
 * One authority id, which becomes a single ref segment. It is refused here
 * rather than left to Git because an id Git would rewrite is an id that no
 * longer names the authority the operator meant.
 */
export function authorityId(value: unknown): string {
  if (typeof value !== "string") throw new Error("authority id must be a string");
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error("authority id must be a nonempty string");
  if (trimmed !== value) throw new Error("authority id must not have surrounding whitespace");
  if (trimmed.includes("/")) throw new Error("authority id must be a single ref path segment");
  if (REF_UNSAFE.test(trimmed)) throw new Error("authority id must not contain whitespace, control, or ref-unsafe characters");
  if (trimmed.includes("..")) throw new Error("authority id must not contain ..");
  if (trimmed.startsWith(".")) throw new Error("authority id must not start with a dot");
  if (trimmed.endsWith(".lock")) throw new Error("authority id must not end with .lock");
  return trimmed;
}

/** The full ref an authority's origin stream occupies. */
export function originStreamRef(value: string): string {
  return `${ORIGIN_REF_PREFIX}${authorityId(value)}`;
}

/**
 * A signature over a fact record or a ledger manifest (RVR-009).
 *
 * This is a separate record type on purpose. The semantic IDs of `rv:`, `tr:`,
 * `cr:`, `rs:`, and `rd:` are content hashes of causal fields only, so a
 * signature must never enter one of those payloads: rotating a key would then
 * change a decision ID. A signature therefore carries its own `sg:` identity
 * derived from its own content and references its target by ID, which is what
 * makes key rotation a no-op for semantic identity.
 *
 * `signer` is the stable identity and `key_id` is the rotating one. Rotating a
 * key adds a second signature over the same target; it never edits the first.
 */
export type SignatureRecord = ReverieMetadata & {
  v: 1;
  type: "signature";
  id: SignatureId;
  /** The domain separator; one of the two exported `SIGNATURE_DOMAIN_*` values. */
  domain: string;
  role: SignatureRole;
  /** The signed record ID, or `ledger-manifest` for a checkpoint signature. */
  target: string;
  /** The annotated object the signature is attached to. */
  subject: ObjectId;
  signer: string;
  key_id: string;
  algorithm: string;
  /** The signature over `signingPayload(record)`, base64. */
  signature: string;
  /**
   * Repository object ID of the target's exact canonical bytes: the record's
   * canonical line without its trailing LF, or `ledgerManifestPayload`. Binding
   * a hash rather than the bytes keeps the payload O(1) and works for both
   * SHA-1 and SHA-256 repositories through the injected `HashObject`.
   */
  content_id: ObjectId;
};

export type SignatureInput = {
  readonly domain: string;
  readonly role: SignatureRole;
  readonly target: string;
  readonly subject: string;
  readonly signer: string;
  readonly key_id: string;
  readonly algorithm: string;
  readonly signature: string;
  readonly content_id: string;
};

export type NoteRecord =
  | ReverieRecord
  | SessionSummary
  | ReveriesInit
  | TransitionSummary
  | PublicationAttestation
  | CorrectionRecord
  | ResolutionRecord
  | RedactionRecord
  | SignatureRecord
  | OccurrenceRecord
  | LineageRecord;

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
  maxSignatures: number;
  maxSignaturesPerTarget: number;
  /** RVR-014: occurrence records on one note. */
  maxOccurrences: number;
  /** RVR-014: `from`/`to` endpoints on one lineage edge. */
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
  maxSignatures: 64,
  maxSignaturesPerTarget: 16,
  maxOccurrences: 64,
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
const TRANSITION_ID = /^tr:[0-9a-f]{40}$|^tr:[0-9a-f]{64}$/;
const CORRECTION_ID = /^cr:[0-9a-f]{40}$|^cr:[0-9a-f]{64}$/;
const RESOLUTION_ID = /^rs:[0-9a-f]{40}$|^rs:[0-9a-f]{64}$/;
const REDACTION_ID = /^rd:[0-9a-f]{40}$|^rd:[0-9a-f]{64}$/;
const SIGNATURE_ID = /^sg:[0-9a-f]{40}$|^sg:[0-9a-f]{64}$/;
const OCCURRENCE_ID = /^oc:[0-9a-f]{40}$|^oc:[0-9a-f]{64}$/;
const LINEAGE_ID = /^lg:[0-9a-f]{40}$|^lg:[0-9a-f]{64}$/;
const CONFIDENTIAL_POINTER = /^vault:v1:[A-Za-z0-9_-]{43}$/;
/** Every ID-bearing fact a signature may attest, in both repository formats. */
const SIGNATURE_TARGET = /^(?:rv|tr|cr|rs|rd|oc|lg):[0-9a-f]{40}$|^(?:rv|tr|cr|rs|rd|oc|lg):[0-9a-f]{64}$/;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const RELATIONS = new Set<SourceRelation>([
  "caused-by", "constrained-by", "requested-by", "derived-from", "implements", "corroborated-by",
]);
const KINDS = new Set<SourceKind>(["commit", "blob", "tree", "path", "note", "git-email", "issue", "confidential-pointer"]);
const HOSTS = new Set(["pi", "claude", "opencode", "codex", "gemini"]);
/** The exact key set of a canonical ledger manifest; anything else is rejected. */
const LEDGER_MANIFEST_KEYS = new Set([
  "v",
  "type",
  "protocol",
  "ledger_ref",
  "notes_ref",
  "notes_commit",
  "notes_tree",
  "previous_ledger",
  "retention_commit",
  "authority",
  "annotated_subjects",
  "records",
  "note_bytes",
]);
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

export function signatureId(value: string): SignatureId {
  if (!SIGNATURE_ID.test(value)) throw new Error(`Invalid signature ID: ${value}`);
  return value as SignatureId;
}

export function occurrenceId(value: string): OccurrenceId {
  if (!OCCURRENCE_ID.test(value)) throw new Error(`Invalid occurrence ID: ${value}`);
  return value as OccurrenceId;
}

export function lineageId(value: string): LineageId {
  if (!LINEAGE_ID.test(value)) throw new Error(`Invalid lineage ID: ${value}`);
  return value as LineageId;
}

/** Parse the distinct wire syntax for an opaque confidential-evidence locator. */
export function confidentialPointer(value: string): ConfidentialPointer {
  if (!CONFIDENTIAL_POINTER.test(value)) {
    throw new Error("Confidential pointers must use vault:v1:<43-character-base64url-id>");
  }
  return value as ConfidentialPointer;
}

export function factHeadId(value: string): FactHeadId {
  if (REVERIE_ID.test(value)) return value as ReverieId;
  if (OCCURRENCE_ID.test(value)) return value as OccurrenceId;
  if (LINEAGE_ID.test(value)) return value as LineageId;
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
    || record.type === "redaction"
    || record.type === "occurrence"
    || record.type === "lineage") {
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

/**
 * The exact canonical JSON a ledger checkpoint stores as `manifest.json`.
 * The key order below is the contract; it never depends on object insertion
 * order in the parsed manifest.
 */
function canonicalLedgerManifestValue(manifest: LedgerManifest): Record<string, unknown> {
  return {
    v: 1,
    type: "ledger-manifest",
    protocol: 1,
    ledger_ref: LEDGER_REF,
    notes_ref: NOTES_REF,
    notes_commit: manifest.notes_commit,
    notes_tree: manifest.notes_tree,
    previous_ledger: manifest.previous_ledger,
    retention_commit: manifest.retention_commit,
    authority: manifest.authority,
    annotated_subjects: manifest.annotated_subjects,
    records: manifest.records,
    note_bytes: manifest.note_bytes,
  };
}

/** Canonical manifest bytes, without the trailing LF that the stored blob carries. */
export function ledgerManifestPayload(manifest: LedgerManifest): string {
  return JSON.stringify(canonicalLedgerManifestValue(manifest));
}

/** Canonical manifest bytes exactly as the ledger tree stores them. */
export function canonicalLedgerManifest(manifest: LedgerManifest): string {
  return `${ledgerManifestPayload(manifest)}\n`;
}

function validateCount(value: unknown, field: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a nonnegative integer`);
  }
}

/**
 * The primary remote name (RVR-017). Shape only: one trimmed token with no
 * whitespace or control characters. The role vocabulary is deliberately not
 * encoded here, because a checkpoint rebuilt from the same evidence must
 * reproduce the same object ID, and a value that encodes a role would make the
 * signed bytes depend on configuration the manifest cannot see.
 */
function validateAuthority(value: unknown, limits: Readonly<ResourceLimits>): void {
  if (value === null) return;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("authority must be a nonempty string or null");
  }
  const authority = value;
  checkChars(authority, limits.maxRefChars, "maxRefChars", "authority");
  if (authority !== authority.trim()) throw new Error("authority must not have surrounding whitespace");
  if (/\s/.test(authority)) throw new Error("authority must be a single token without whitespace");
  if (/[\u0000-\u001f\u007f]/.test(authority)) throw new Error("authority must not contain control characters");
}

/** Wrap a branded-ID constructor so the manifest field name reaches the diagnostic. */
function identifiedField(
  value: unknown,
  field: string,
  narrow: (candidate: string) => unknown,
): string {
  const candidate = typeof value === "string" ? value : String(value);
  try {
    return narrow(candidate) as string;
  } catch (error: unknown) {
    throw new Error(`${field}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function validateLedgerManifest(
  manifest: LedgerManifest,
  limits: Partial<ResourceLimits> = {},
): LedgerManifest {
  const resolved = resolveLimits(limits);
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("ledger manifest must be a JSON object");
  }
  const value = manifest as unknown as Record<string, unknown>;
  if (value.type !== "ledger-manifest") throw new Error("type must be ledger-manifest");
  if (value.v !== 1) throw new Error("v must be exactly 1");
  if (value.protocol !== 1) throw new Error("protocol must be exactly 1");
  for (const key of Object.keys(value)) {
    if (!LEDGER_MANIFEST_KEYS.has(key)) throw new Error(`unknown ledger manifest field: ${key}`);
  }
  for (const key of LEDGER_MANIFEST_KEYS) {
    if (!(key in value)) throw new Error(`ledger manifest is missing ${key}`);
  }
  if (value.ledger_ref !== LEDGER_REF) throw new Error(`ledger_ref must be ${LEDGER_REF}`);
  if (value.notes_ref !== NOTES_REF) throw new Error(`notes_ref must be ${NOTES_REF}`);

  const commit = (field: string): void => void identifiedField(value[field], field, commitId);
  const anyObject = (field: string): void => void identifiedField(value[field], field, objectId);
  if (value.notes_commit !== null) commit("notes_commit");
  if (value.notes_tree !== null) anyObject("notes_tree");
  // A notes commit names the exact notes tree that travels with it, so the two
  // are present or absent together. A manifest that claims a notes tree without
  // a notes commit would let a grafted subtree claim an authority it has none of.
  if ((value.notes_commit === null) !== (value.notes_tree === null)) {
    throw new Error("notes_commit and notes_tree must both be present or both be null");
  }
  if (value.previous_ledger !== null) commit("previous_ledger");
  if (value.retention_commit !== null) commit("retention_commit");
  if (value.previous_ledger !== null && value.previous_ledger === value.retention_commit) {
    throw new Error("previous_ledger and retention_commit must be distinct parents");
  }
  validateAuthority(value.authority, resolved);
  validateCount(value.annotated_subjects, "annotated_subjects");
  validateCount(value.records, "records");
  validateCount(value.note_bytes, "note_bytes");
  return manifest;
}

export function createLedgerManifest(input: LedgerManifestInput, limits: Partial<ResourceLimits> = {}): LedgerManifest {
  // The brands are asserted here and actually narrowed by `validateLedgerManifest`,
  // so a malformed identifier is reported with its manifest field name instead of a
  // bare "Invalid Git object ID".
  const manifest: LedgerManifest = {
    v: 1,
    type: "ledger-manifest",
    protocol: 1,
    ledger_ref: LEDGER_REF,
    notes_ref: NOTES_REF,
    notes_commit: input.notes_commit as CommitId | null,
    notes_tree: input.notes_tree as ObjectId | null,
    previous_ledger: input.previous_ledger as CommitId | null,
    retention_commit: input.retention_commit as CommitId | null,
    authority: input.authority,
    annotated_subjects: input.annotated_subjects,
    records: input.records,
    note_bytes: input.note_bytes,
  };
  const resolved = resolveLimits(limits);
  validateLedgerManifest(manifest, resolved);
  assertNoteSize(utf8Length(canonicalLedgerManifest(manifest)), resolved);
  return manifest;
}

function asLedgerManifest(value: unknown): LedgerManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("ledger manifest must be a JSON object");
  }
  return value as LedgerManifest;
}

export type ParsedLedgerManifest = {
  /** The validated manifest, or null when the bytes could not be trusted. */
  readonly manifest: LedgerManifest | null;
  readonly diagnostics: Diagnostic[];
};

/**
 * Parse a stored `manifest.json`. `strict` requires the exact canonical bytes,
 * so a reordered, reformatted, or extended body is rejected rather than
 * silently accepted; `tolerant` reports the problem and returns no manifest.
 */
export function parseLedgerManifest(
  text: string,
  mode: "strict" | "tolerant",
  options: ValidateOptions = {},
): ParsedLedgerManifest {
  const limits = resolveLimits(options.limits);
  const diagnostics: Diagnostic[] = [];
  const fail = (message: string): ParsedLedgerManifest => {
    if (mode === "strict") throw new Error(message);
    if (diagnostics.length < limits.maxDiagnostics) diagnostics.push({ message });
    return { manifest: null, diagnostics };
  };
  if (text.length === 0) return fail("manifest is empty");
  if (!text.endsWith("\n")) return fail("manifest must end with one LF");
  if (text.includes("\r")) return fail("manifest must not contain CR");
  try {
    assertNoteSize(utf8Length(text), limits);
    // A manifest is one record-sized document, so it answers to the per-record
    // budget as well as the whole-note budget.
    const bytes = utf8Length(text);
    if (bytes > limits.maxRecordBytes) {
      throw new LimitExceededError("maxRecordBytes", bytes, limits.maxRecordBytes, "ledger manifest");
    }
  } catch (error: unknown) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const body = text.slice(0, -1);
  let manifest: LedgerManifest;
  try {
    manifest = asLedgerManifest(JSON.parse(body));
    validateLedgerManifest(manifest, limits);
  } catch (error: unknown) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  // Canonical bytes are the storage contract: a manifest that parses but was
  // written with different key order or spacing is not the manifest this
  // protocol publishes, so it is reported rather than normalized on read.
  if (ledgerManifestPayload(manifest) !== body) return fail("manifest is not canonical JSON");
  return { manifest, diagnostics };
}

/** Parse a stored manifest and fail closed on any structural problem. */
export function readLedgerManifest(
  text: string,
  options: ValidateOptions = {},
): LedgerManifest {
  const parsed = parseLedgerManifest(text, "strict", options);
  return parsed.manifest as LedgerManifest;
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

/**
 * A repository path as an occurrence coordinate uses it. `.` is the root tree
 * display path and stays legal; an absolute path, a `..` segment, or NUL is
 * not a coordinate Git can resolve, so it is refused here rather than becoming
 * an unverifiable claim.
 */
function occurrencePath(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a nonempty repository path`);
  }
  if (value.includes("\0")) throw new Error(`${field} cannot contain NUL`);
  if (value.startsWith("/")) throw new Error(`${field} must be relative to the repository root`);
  if (value.split("/").some((segment) => segment === "..")) {
    throw new Error(`${field} cannot contain a ".." segment`);
  }
  return value;
}

function normalizeCoordinate(value: OccurrenceCoordinate, field: string): OccurrenceCoordinate {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return {
    commit: commitId(String(value.commit)),
    path: occurrencePath(value.path, `${field}.path`),
    subject: objectId(String(value.subject)),
  };
}

function normalizeOccurrenceSemantic(input: OccurrenceSemantic): OccurrenceSemantic {
  if (input.v !== 1) throw new Error("v must be exactly 1");
  const recurrence = input.recurrence_control === null
    ? null
    : recurrenceText(input.recurrence_control, "recurrence_control");
  return {
    v: 1,
    occurrence: normalizeCoordinate(input.occurrence, "occurrence"),
    driving_event: trimText(input.driving_event, "driving_event"),
    decision: trimText(input.decision, "decision"),
    impact: trimText(input.impact, "impact"),
    recurrence_control: recurrence,
    alternatives: sortedUnique(input.alternatives),
    sources: sortedUniqueSources(input.sources),
  };
}

/**
 * Exact bytes hashed for an occurrence identity: version, the coordinate, and
 * normalized causal content. The coordinate is inside the hash on purpose —
 * that is what makes two occurrences of one blob two records instead of one
 * universal claim. Author metadata stays outside, so an amend keeps the ID.
 */
export function occurrencePayload(record: OccurrenceSemantic): string {
  return JSON.stringify(normalizeOccurrenceSemantic(record));
}

export function createOccurrence(
  input: OccurrenceInput,
  metadata: ReverieMetadata,
  hashObject: HashObject,
  limits: Partial<ResourceLimits> = {},
): OccurrenceRecord {
  const resolved = resolveLimits(limits);
  const semantic = normalizeOccurrenceSemantic(input);
  validateTimestamp(metadata.created_at, "created_at");
  const id = `oc:${hashObject(Buffer.from(`${JSON.stringify(semantic)}\n`, "utf8"))}` as OccurrenceId;
  const record: OccurrenceRecord = {
    ...semantic,
    type: "occurrence",
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
 * The exact bytes hashed for a signature identity: the whole attestation
 * except its own ID. Including the signature bytes is deliberate, so two
 * different signers over the same target are two distinct records rather than
 * one record with ambiguous content.
 */
export function signatureIdentityPayload(record: SignatureInput): string {
  const domain = signatureDomain(record.domain);
  const role = signatureRoleValue(record.role);
  const target = signatureTarget(record.domain, record.target);
  return JSON.stringify({
    v: 1,
    domain,
    role,
    target,
    // Wrap the object-ID constructors so a bad field is reported by name instead
    // of a bare "Invalid Git object ID", which is indistinguishable across fields.
    subject: identifiedField(record.subject, "subject", objectId),
    signer: trimText(record.signer, "signer"),
    key_id: trimText(record.key_id, "key_id"),
    algorithm: trimText(record.algorithm, "algorithm"),
    signature: trimText(record.signature, "signature"),
    content_id: identifiedField(record.content_id, "content_id", objectId),
  });
}

function signatureDomain(value: string): string {
  if (value !== SIGNATURE_DOMAIN_RECORD && value !== SIGNATURE_DOMAIN_MANIFEST) {
    throw new Error(`domain must be ${SIGNATURE_DOMAIN_RECORD} or ${SIGNATURE_DOMAIN_MANIFEST}`);
  }
  return value;
}

function signatureRoleValue(value: string): SignatureRole {
  if (value !== "author" && value !== "reviewer" && value !== "publisher") {
    throw new Error(`role must be one of ${SIGNATURE_ROLES.join(", ")}`);
  }
  return value;
}

/**
 * A target must be a real fact ID, except that the reserved `ledger-manifest`
 * target is reachable only under the manifest domain. A record-domain signature
 * naming `ledger-manifest` would let a signer claim to have attested a
 * checkpoint without ever producing a checkpoint payload.
 *
 * Every ID-bearing fact is a valid target, including `rd:`. Redactions are never
 * supersession heads, so they are absent from `FactTargetId`, but a reviewer may
 * still want to attest that a redaction was deliberate.
 */
function signatureTarget(domain: string, value: string): string {
  const target = trimText(value, "target");
  if (target === "ledger-manifest") {
    if (domain !== SIGNATURE_DOMAIN_MANIFEST) {
      throw new Error("target ledger-manifest requires the manifest signature domain");
    }
    return target;
  }
  if (!SIGNATURE_TARGET.test(target)) {
    throw new Error(`Invalid signature target: ${target}`);
  }
  return target;
}

export function createSignature(
  input: SignatureInput,
  metadata: ReverieMetadata,
  hashObject: HashObject,
  limits: Partial<ResourceLimits> = {},
): SignatureRecord {
  const resolved = resolveLimits(limits);
  const identity = signatureIdentityPayload(input);
  validateTimestamp(metadata.created_at, "created_at");
  const id = `sg:${hashObject(Buffer.from(`${identity}\n`, "utf8"))}` as SignatureId;
  const record: SignatureRecord = {
    v: 1,
    type: "signature",
    id,
    domain: input.domain,
    role: input.role,
    target: input.target,
    subject: input.subject as ObjectId,
    signer: trimRef(input.signer, "signer", resolved),
    key_id: trimRef(input.key_id, "key_id", resolved),
    algorithm: trimRef(input.algorithm, "algorithm", resolved),
    signature: trimRef(input.signature, "signature", resolved),
    content_id: input.content_id as ObjectId,
    // `author_email` records who ran the helper; `signer` is the attesting
    // identity trust policy matches on. They are separate on purpose, so a
    // shared runner does not masquerade as the signer.
    author_email: trimRef(metadata.author_email, "author_email", resolved),
    session: metadata.session === null ? null : trimRef(metadata.session, "session", resolved),
    created_at: metadata.created_at,
  };
  validateRecord(record, hashObject, resolved);
  return record;
}

/**
 * The exact canonical bytes a signature signs. This is the contract's core: it
 * binds the protocol domain, the target ID, the annotated subject, the signer,
 * the algorithm, and the target's content hash. It deliberately omits the
 * signature itself, the record ID, and all author metadata, so a signature stays
 * verifiable across a metadata-only rewrite while remaining bound to the exact
 * content it attests.
 */
export function signingPayload(record: SignatureRecord): string {
  const domain = signatureDomain(record.domain);
  const target = signatureTarget(domain, record.target);
  return JSON.stringify({
    v: 1,
    domain,
    role: signatureRoleValue(record.role),
    target,
    subject: identifiedField(record.subject, "subject", objectId),
    signer: trimText(record.signer, "signer"),
    algorithm: trimText(record.algorithm, "algorithm"),
    content_id: identifiedField(record.content_id, "content_id", objectId),
  });
}

/**
 * How far a signature's trust has been established. The order is a strict
 * refinement, so each state is a strictly stronger claim than the one before it
 * and no signature can satisfy two of them at once:
 *
 * - `unknown`: nothing is claimed. The key is not in the trust store.
 * - `valid`: the bytes verify, but no trust store entry binds this key to this
 *   signer. Cryptographic validity is not identity.
 * - `trusted`: the bytes verify and the trust store binds this key to this
 *   signer. Identity is established.
 * - `policy-satisfying`: `trusted` and the signed role is one the policy
 *   requires. A repository with no configured roles can never reach this.
 *
 * `invalid` and `revoked` are deliberately states rather than deletions: the
 * record stays in the note bytes and stays reported, so a reader can always see
 * that an attestation once existed and why it no longer counts.
 */
export type TrustState =
  | "unknown"
  | "valid"
  | "trusted"
  | "policy-satisfying"
  | "invalid"
  | "revoked";

/** One authorized (or explicitly revoked) key in a local trust store. */
export type TrustStoreEntry = {
  readonly key_id: string;
  /** The signer identity this key is authorized to speak for. */
  readonly signer: string;
  readonly revoked: boolean;
};

/**
 * The local trust store (RVR-009). Public key material and revocation live here
 * rather than in the ledger manifest, so the manifest keeps the byte-reproducibility
 * RVR-005 guarantees and needs no signing-policy field of its own.
 */
export type TrustStore = {
  readonly keys: readonly TrustStoreEntry[];
};

/** Role requirements, from `reveries.signingRoles` and the trust-store policy. */
export type SigningPolicy = {
  readonly requiredRoles: readonly SignatureRole[];
};

/** The cryptographic verdict, injected so this module never verifies anything. */
export type SignatureVerdict = {
  readonly verified: boolean;
  readonly diagnostic?: string;
};

export type SignatureTrustReport = {
  readonly id: SignatureId;
  readonly target: string;
  readonly subject: ObjectId;
  readonly signer: string;
  readonly key_id: string;
  readonly role: SignatureRole;
  readonly state: TrustState;
  readonly diagnostics: readonly string[];
};

/**
 * Classify one signature against an injected verdict, trust store, and policy.
 *
 * This is pure and performs no cryptography, which is what keeps the trust
 * vocabulary the actual contract and the verifier backend swappable. Trust is
 * resolved before the cryptographic verdict: an unknown key is `unknown` even
 * when its bytes do not verify, because unverifiable material about a key we
 * know nothing about is not a claim of forgery.
 */
export function classifySignature(
  record: SignatureRecord,
  input: {
    readonly verdict: SignatureVerdict;
    readonly trust: TrustStore;
    readonly policy: SigningPolicy;
  },
): SignatureTrustReport {
  const diagnostics: string[] = [];
  if (input.verdict.diagnostic !== undefined) diagnostics.push(input.verdict.diagnostic);
  const report = (state: TrustState): SignatureTrustReport => ({
    id: record.id,
    target: record.target,
    subject: record.subject,
    signer: record.signer,
    key_id: record.key_id,
    role: record.role,
    state,
    diagnostics,
  });

  const entry = trustStoreEntry(input.trust, record.key_id);
  if (entry === null) return report("unknown");
  if (entry.revoked) return report("revoked");
  if (!input.verdict.verified) return report("invalid");
  if (entry.signer !== record.signer) return report("valid");
  if (input.policy.requiredRoles.includes(record.role)) return report("policy-satisfying");
  return report("trusted");
}

function trustStoreEntry(store: TrustStore, keyId: string): TrustStoreEntry | null {
  const matches: TrustStoreEntry[] = [];
  for (const entry of store.keys) {
    if (trimText(entry.key_id, "key_id") === keyId) matches.push(entry);
  }
  for (const entry of matches) trimText(entry.signer, "signer");
  // Two entries for one key would let the same key claim two identities, so the
  // store is rejected rather than resolved by ordering.
  if (matches.length > 1) {
    throw new Error(`Trust store has ${matches.length} entries for key ${keyId}`);
  }
  return matches[0] ?? null;
}

function validateSignature(
  record: SignatureRecord,
  hashObject?: HashObject,
  limits: Readonly<ResourceLimits> = DEFAULT_LIMITS,
): void {
  if (!SIGNATURE_ID.test(record.id)) throw new Error("invalid signature ID");
  const domain = signatureDomain(record.domain);
  signatureRoleValue(record.role);
  signatureTarget(domain, record.target);
  identifiedField(record.subject, "subject", objectId);
  identifiedField(record.content_id, "content_id", objectId);
  trimRef(record.signer, "signer", limits);
  trimRef(record.key_id, "key_id", limits);
  trimRef(record.algorithm, "algorithm", limits);
  // A base64 signature is opaque bytes, so only the size budget applies here.
  checkChars(record.signature, limits.maxRecordBytes, "maxRecordBytes", "signature");
  if (!record.signature.trim()) throw new Error("signature must be a nonempty string");
  validateEmail(record.author_email, "author_email", limits);
  if (record.session !== null) trimRef(record.session, "session", limits);
  validateTimestamp(record.created_at, "created_at");
  if (hashObject) {
    const expected = `sg:${hashObject(Buffer.from(`${signatureIdentityPayload(record)}\n`, "utf8"))}`;
    if (expected !== record.id) throw new Error(`signature ID mismatch: expected ${expected}, got ${record.id}`);
  }
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
      ...(semantic.region === undefined ? {} : { region: semantic.region }),
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
  if (record.type === "signature") {
    return {
      v: 1,
      type: "signature",
      id: record.id,
      domain: record.domain,
      role: record.role,
      target: record.target,
      subject: record.subject,
      signer: trimText(record.signer, "signer"),
      key_id: trimText(record.key_id, "key_id"),
      algorithm: trimText(record.algorithm, "algorithm"),
      signature: trimText(record.signature, "signature"),
      content_id: record.content_id,
      author_email: trimText(record.author_email, "author_email"),
      session: record.session === null ? null : trimText(record.session, "session"),
      created_at: record.created_at,
    };
  }
  if (record.type === "occurrence") {
    const semantic = normalizeOccurrenceSemantic(record);
    return {
      v: 1,
      type: "occurrence",
      id: record.id,
      occurrence: semantic.occurrence,
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
  if (record.type === "lineage") {
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

const KNOWN_RECORD_TYPES = new Set<string>([
  "reverie",
  "lineage",
  "session-summary",
  "reveries-init",
  "transition-summary",
  "publication-attestation",
  "correction",
  "resolution",
  "redaction",
  "signature",
  "occurrence",
]);

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
  if (record.type === "signature") return record as unknown as SignatureRecord;
  if (record.type === "occurrence") return record as unknown as OccurrenceRecord;
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
  else if (value.kind === "issue" && !ISSUE.test(value.ref)) throw new Error("invalid issue source reference");
  else if (value.kind === "confidential-pointer") confidentialPointer(value.ref);
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
    objectId(retirement.from_blob);
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

function validateOccurrence(
  record: OccurrenceRecord,
  hashObject?: HashObject,
  limits: Readonly<ResourceLimits> = DEFAULT_LIMITS,
): void {
  if (!OCCURRENCE_ID.test(record.id)) throw new Error("invalid occurrence ID");
  normalizeCoordinate(record.occurrence, "occurrence");
  if (!Array.isArray(record.alternatives) || !Array.isArray(record.sources)) {
    throw new Error("occurrence arrays are required");
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
    const expected = `oc:${hashObject(Buffer.from(`${occurrencePayload(record)}\n`, "utf8"))}`;
    if (expected !== record.id) throw new Error(`occurrence ID mismatch: expected ${expected}, got ${record.id}`);
  }
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
      for (const source of entry.sources) {
        validateSource(source, limits);
        if (source.kind === "confidential-pointer") {
          throw new Error("Confidential pointers require an ID-bearing record; session summaries cannot carry them");
        }
      }
      for (const id of entry.reveries) reverieId(id);
      for (const retirement of entry.retirements) {
        reverieId(retirement.reverie);
        objectId(retirement.from_blob);
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
  if (record.type === "signature") {
    validateSignature(record, hashObject, limits);
    return;
  }
  if (record.type === "occurrence") {
    validateOccurrence(record, hashObject, limits);
    return;
  }
  if (record.type === "lineage") {
    validateLineage(record, hashObject, limits);
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
  checkArrayLength(
    records.filter((record) => record.type === "signature"),
    limits.maxSignatures,
    "maxSignatures",
    "signatures",
  );
  // RVR-014: occurrence records are addressed evidence, so a bounded number of
  // them may share one content-addressed note; a lineage edge is bounded by
  // its endpoint count instead (see `normalizeEndpoints`).
  checkArrayLength(
    records.filter((record) => record.type === "occurrence"),
    limits.maxOccurrences,
    "maxOccurrences",
    "occurrences",
  );
  // A target may be attested by several roles and several keys, so the per-target
  // budget is a fan-out bound rather than a duplicate check: it stops one record
  // from accumulating unbounded attestations.
  const signaturesByTarget = new Map<string, number>();
  for (const record of records) {
    if (record.type !== "signature") continue;
    const count = (signaturesByTarget.get(record.target) ?? 0) + 1;
    signaturesByTarget.set(record.target, count);
    if (count > limits.maxSignaturesPerTarget) {
      throw new LimitExceededError(
        "maxSignaturesPerTarget",
        count,
        limits.maxSignaturesPerTarget,
        `signatures over ${record.target}`,
      );
    }
  }
  // Tree notes carry transition summaries and reveries side by side (RVR-013),
  // and commit notes may carry publication attestations; object-type placement
  // beyond this is enforced by the snapshot validator, which knows each
  // annotated object's type. Corrections, resolutions, and redactions are
  // global facts that may ride on blob, tree, or commit notes within the
  // snapshot placement rules.
  // A signature is a global fact about an annotated subject, so it may ride on
  // any note that also carries a record, just like a correction or redaction.
  if (summaries.length === 0 && inits.length === 0
    && records.some((record) => record.type !== "reverie"
      && record.type !== "transition-summary"
      && record.type !== "publication-attestation"
      && record.type !== "correction"
      && record.type !== "resolution"
      && record.type !== "redaction"
      && record.type !== "signature"
      && record.type !== "occurrence"
      && record.type !== "lineage")) {
    throw new Error("blob note contains a non-reverie record");
  }
  const byId = new Map<ReverieId, string>();
  const occurrencesById = new Map<OccurrenceId, string>();
  const lineagesById = new Map<LineageId, string>();
  const transitionsById = new Map<TransitionId, string>();
  const correctionsById = new Map<CorrectionId, string>();
  const resolutionsById = new Map<ResolutionId, string>();
  const redactionsById = new Map<RedactionId, string>();
  const signaturesById = new Map<SignatureId, string>();
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
    if (record.type === "signature") {
      // Signatures are monotonic facts with no edges, but they still cost a
      // visit so a note full of attestations is budgeted like any other fact.
      chargeGraph(1, "signature graph");
      const payload = signatureIdentityPayload(record);
      const previous = signaturesById.get(record.id);
      checkDuplicate(previous, payload, `conflicting duplicate signature ID: ${record.id}`);
      signaturesById.set(record.id, payload);
      continue;
    }
    if (record.type === "occurrence") {
      chargeGraph(1, "occurrence graph");
      const payload = occurrencePayload(record);
      const previous = occurrencesById.get(record.id);
      checkDuplicate(previous, payload, `conflicting duplicate occurrence ID: ${record.id}`);
      occurrencesById.set(record.id, payload);
      continue;
    }
    if (record.type === "lineage") {
      chargeGraph(1 + record.from.length + record.to.length, "lineage graph");
      const payload = lineagePayload(record, limits);
      const previous = lineagesById.get(record.id);
      checkDuplicate(previous, payload, `conflicting duplicate lineage ID: ${record.id}`);
      lineagesById.set(record.id, payload);
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
      const raw: unknown = JSON.parse(line);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("record must be a JSON object");
      const type = (raw as { type?: unknown }).type;
      // Lean readers keep unknown bytes (legacy or future records) untouched
      // and never interpret them. Tolerant mode skips them silently; strict
      // mode still refuses a record this build cannot validate.
      if (typeof type !== "string" || !KNOWN_RECORD_TYPES.has(type)) {
        if (mode === "strict") throw new Error(`unknown record type: ${String(type)}`);
        continue;
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
  return { records, diagnostics, truncated };
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
