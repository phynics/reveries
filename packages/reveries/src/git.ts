import { spawn } from "node:child_process";
import {
  createHash,
  randomUUID,
} from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  assertNoteSize,
  blobId,
  commitId,
  objectId,
  type BlobId,
  type CommitId,
  type ObjectId,
  type ResourceLimits,
} from "./protocol.ts";

export const NOTES_REF = "refs/notes/reveries";
export const RETENTION_REF = "refs/reveries/retention";

/**
 * Environment that disables on-demand (lazy) fetching of promisor objects.
 * Verified against git 2.39.5: with the variable set, access to a missing
 * promisor object fails fast (`fatal: could not fetch ... from promisor
 * remote`) instead of transparently fetching. Every evidence read must use it;
 * only explicit user-invoked sync/fetch/push commands may touch the network.
 */
export const NO_LAZY_FETCH_ENV = { GIT_NO_LAZY_FETCH: "1" } as const;

/**
 * How authoritative a local evidence view is. Incomplete local state must
 * never be reported as authoritative evidence absence; every grade other
 * than `complete` refuses that claim.
 */
export type CompletenessGrade =
  | "complete"
  | "notes-unfetched"
  | "notes-stale"
  | "shallow-boundary"
  | "promisor-object-missing"
  | "unknown";

/**
 * Grade a clone from its local shape alone, without touching the network.
 * A missing note or object under a shallow or promisor clone is
 * incompleteness, never authoritative absence.
 */
export function cloneEvidenceGrade(input: {
  readonly shallow: boolean;
  readonly promisor: boolean;
}): CompletenessGrade {
  if (input.promisor) return "promisor-object-missing";
  if (input.shallow) return "shallow-boundary";
  return "complete";
}

const RETENTION_IDENTITY = {
  GIT_AUTHOR_NAME: "Reveries Retention",
  GIT_AUTHOR_EMAIL: "retention@reveries.local",
  GIT_AUTHOR_DATE: "@0 +0000",
  GIT_COMMITTER_NAME: "Reveries Retention",
  GIT_COMMITTER_EMAIL: "retention@reveries.local",
  GIT_COMMITTER_DATE: "@0 +0000",
} as const;

export interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

interface RunOptions {
  readonly input?: string;
  readonly allowExitCodes?: readonly number[];
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

/** The Git command failed and no caller-provided exit code allowed it. */
export class GitCommandError extends Error {
  readonly args: readonly string[];
  readonly exitCode: number;
  readonly stderr: string;

  constructor(args: readonly string[], result: GitResult) {
    super(`git ${args.join(" ")} exited with ${result.exitCode}: ${result.stderr.trim()}`);
    this.name = "GitCommandError";
    this.args = args;
    this.exitCode = result.exitCode;
    this.stderr = result.stderr;
  }
}

/**
 * Thrown when a notes mutation exhausts its bounded compare-and-swap
 * retries without publishing. Every attempt preserved the records it
 * raced against (the winner's tip is always the replay base), so this
 * failure is explicit contention, never silent record loss.
 */
export class NotesContentionError extends Error {
  constructor(
    readonly ref: string,
    readonly attempts: number,
    readonly expectedTip: ObjectId | null,
    readonly actualTip: ObjectId | null,
  ) {
    super(`The Reveries notes ref ${ref} changed concurrently during ${attempts} write attempts`);
    this.name = "NotesContentionError";
  }
}

/** Private namespace for per-attempt notes-transaction refs. Disposable. */
export const NOTES_TXN_REF_PREFIX = "refs/notes/reveries-txn/";

export interface TemporaryNotesRef {
  readonly ref: string;
  /** Committer-date of the temp ref tip, or null when Git reports none. */
  readonly createdAtUnix: number | null;
}

export interface WithNotesWriteOptions {
  /** Total CAS attempts before bounded-contention failure. Defaults to 15. */
  readonly attempts?: number;
  /** Base backoff between attempts in milliseconds. Defaults to 10. */
  readonly baseDelayMs?: number;
  /** Backoff cap in milliseconds. Defaults to 200. */
  readonly maxDelayMs?: number;
}

/** Exponential backoff with jitter, capped; never holds a lock (there is none). */
async function boundedBackoff(attempt: number, baseDelayMs: number, maxDelayMs: number): Promise<void> {
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
  const delay = Math.floor(exponential * (0.5 + Math.random() * 0.5));
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
}

export class AtomicPushUnavailableError extends Error {
  constructor(readonly remote: string) {
    super(`Remote ${remote} does not support atomic pushes; refusing to publish code and Reveries notes`);
    this.name = "AtomicPushUnavailableError";
  }
}

export interface NoteListEntry {
  readonly note: ObjectId;
  readonly object: ObjectId;
}

export interface PathResolution {
  readonly path: string;
  readonly revision: "HEAD" | "index" | string;
}

export interface NotesTransaction {
  readonly ref: string;
  read(object: ObjectId): Promise<string | null>;
  append(object: ObjectId, canonicalLine: string): Promise<void>;
  replace(object: ObjectId, canonicalBody: string): Promise<void>;
}

export type TreeEntry =
  | { readonly mode: string; readonly type: "blob"; readonly object: BlobId; readonly path: string }
  | { readonly mode: string; readonly type: "commit"; readonly object: CommitId; readonly path: string }
  | { readonly mode: string; readonly type: "tree"; readonly object: ObjectId; readonly path: string };

export const RETENTION_MESSAGE = "Reveries retention checkpoint\n";

/** One blob, tree, or commit the retention ref anchors. */
export interface RetentionSubject {
  readonly object: ObjectId;
  readonly type: "blob" | "tree" | "commit" | "tag";
}

export type NotesRefValidator = (temporaryRef: string) => Promise<void>;
export type NotesValidationFailure = (
  temporaryRef: string,
  candidate: ObjectId,
  error: unknown,
) => Promise<void>;

export interface BatchReadOptions {
  readonly limits?: Partial<ResourceLimits> | undefined;
}

/** Pure Git blob hash of UTF-8 text or bytes; must match `git hash-object`. */
export function hashBlobContent(
  content: string | Uint8Array,
  format: "sha1" | "sha256",
): ObjectId {
  const body = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
  const header = Buffer.from(`blob ${body.byteLength}\0`, "utf8");
  return parseObjectId(createHash(format).update(header).update(body).digest("hex"), "blob content hash");
}

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}

function isObjectId(value: string): value is ObjectId {
  return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value);
}

/**
 * The annotated subject a Git notes tree path names. Git uses a flat `<oid>`
 * path below 256 notes and a fanout `<oid[0:2]>/<oid[2:]>` path above, so both
 * shapes are accepted and the fanout prefix is rejoined.
 */
function notesSubjectFromPath(path: string): ObjectId {
  const separator = path.indexOf("/");
  if (separator < 0) {
    if (!/^[0-9a-f]+$/.test(path) || (path.length !== 40 && path.length !== 64)) {
      throw new Error(`Malformed Git notes tree path: ${path}`);
    }
    return objectId(path);
  }
  const prefix = path.slice(0, separator);
  const suffix = path.slice(separator + 1);
  if (separator !== 2 || !/^[0-9a-f]{2}$/.test(prefix) || !/^[0-9a-f]+$/.test(suffix)
    || (suffix.length !== 38 && suffix.length !== 62)) {
    throw new Error(`Malformed Git notes tree path: ${path}`);
  }
  return objectId(`${prefix}${suffix}`);
}

function parseObjectId(value: string, context: string): ObjectId {
  const trimmed = value.trim();
  if (!isObjectId(trimmed)) {
    throw new Error(`${context} did not return a full Git object ID`);
  }
  return trimmed;
}

function validateCanonicalBody(body: string): void {
  if (!body.endsWith("\n") || body.includes("\r") || body.includes("\0")) {
    throw new Error("A note mutation requires LF-terminated UTF-8 text without CR or NUL bytes");
  }
}

class TemporaryNotesTransaction implements NotesTransaction {
  constructor(
    private readonly repository: GitRepository,
    private readonly temporaryRef: string,
  ) {}

  get ref(): string {
    return this.temporaryRef;
  }

  async read(object: ObjectId): Promise<string | null> {
    return this.repository.readNoteFromRef(this.temporaryRef, object);
  }

  async append(object: ObjectId, canonicalLine: string): Promise<void> {
    validateCanonicalBody(canonicalLine);
    const existing = await this.read(object);
    await this.replace(object, `${existing ?? ""}${canonicalLine}`);
  }

  async replace(object: ObjectId, canonicalBody: string): Promise<void> {
    validateCanonicalBody(canonicalBody);
    await this.repository.run(
      ["notes", `--ref=${this.temporaryRef}`, "add", "-f", "-F", "-", object],
      { input: canonicalBody },
    );
  }
}

export class GitRepository {
  private constructor(
    readonly root: string,
    private readonly commonDir: string,
    private readonly commandCwd = root,
    private readonly noLazyFetch = false,
    /**
     * The object format resolved at open time. Cached so `hashObjectSync` can
     * hand a bound `HashObject` to the pure protocol constructors without a
     * second Git round trip.
     */
    public readonly cachedObjectFormat: "sha1" | "sha256" | undefined = undefined,
  ) {}

  static async open(cwd: string): Promise<GitRepository> {
    const rootResult = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
    const root = rootResult.stdout.trim();
    const commonResult = await runGit(root, ["rev-parse", "--git-common-dir"]);
    const commonOutput = commonResult.stdout.trim();
    const commonDir = isAbsolute(commonOutput) ? commonOutput : resolve(root, commonOutput);
    const repository = new GitRepository(root, commonDir);
    // Resolve the object format once so synchronous hashing can hand a bound
    // `HashObject` to the pure protocol constructors.
    return new GitRepository(root, commonDir, undefined, undefined, await repository.objectFormat());
  }

  /** Open a repository from a bare or worktree Git directory. */
  async run(args: readonly string[], options: RunOptions = {}): Promise<GitResult> {
    return runGit(this.commandCwd, args, this.suppressLazyFetch(options));
  }

  async commonDirectory(): Promise<string> {
    return this.commonDir;
  }

  /**
   * Diagnostic path of the retired `write.lock` directory. No write path
   * consults it; `doctor()` reports leftovers as a notice. Kept so existing
   * tooling and tests can locate the path a killed pre-RVR-016 writer left.
   *
   * @deprecated The lock is not a correctness dependency. Do not `mkdir` or
   * throw on this path in any write path.
   */
  writeLockPath(): string {
    return join(this.commonDir, "reveries", "write.lock");
  }

  async objectFormat(): Promise<"sha1" | "sha256"> {
    if (this.cachedObjectFormat !== undefined) return this.cachedObjectFormat;
    const result = await this.run(["rev-parse", "--show-object-format"]);
    const format = result.stdout.trim();
    if (format !== "sha1" && format !== "sha256") {
      throw new Error(`Unsupported Git object format: ${format}`);
    }
    return format;
  }

  async hashObject(input: string): Promise<ObjectId> {
    const result = await this.run(["hash-object", "--stdin"], { input });
    return parseObjectId(result.stdout, "git hash-object");
  }

  /**
   * The `HashObject` the protocol constructors take, bound to this repository's
   * object format. Protocol code derives every ID through this, so SHA-1 and
   * SHA-256 repositories are both supported with no format branching.
   */
  hashObjectSync(input: Uint8Array): ObjectId {
    // The object format is resolved at open time and cached on the instance, so
    // this stays synchronous and safe to hand to a pure protocol constructor.
    return hashBlobContent(Buffer.from(input), this.cachedObjectFormat ?? "sha1");
  }

  /** Hash text into a blob and store it, so a tree can reference it. */
  async writeBlob(input: string): Promise<ObjectId> {
    const result = await this.run(["hash-object", "-w", "--stdin"], { input });
    return parseObjectId(result.stdout, "git hash-object");
  }

  async resolvePath(input: PathResolution): Promise<BlobId> {
    if (input.path.length === 0 || input.path.includes("\0")) {
      throw new Error("A Git path must be nonempty and cannot contain NUL");
    }
    const expression = input.revision === "index" ? `:${input.path}` : `${input.revision}:${input.path}`;
    const result = await this.run(["rev-parse", "--verify", expression]);
    const object = parseObjectId(result.stdout, `git rev-parse ${expression}`);
    const type = (await this.run(["cat-file", "-t", object])).stdout.trim();
    if (type !== "blob") {
      throw new Error(`${expression} does not resolve to a blob`);
    }
    return blobId(object);
  }

  /**
   * Resolve a worktree path to its blob-or-tree subject (RVR-013). Directory
   * paths resolve to tree objects; file paths resolve to blobs. The `index`
   * revision resolves staged file blobs; staged trees resolve through
   * `indexPathsForSubject`, which materializes the index tree. Raw object IDs
   * are handled by the caller via `objectType`, never by this path resolver.
   */
  async resolveSubject(input: PathResolution): Promise<{ readonly object: ObjectId; readonly type: "blob" | "tree" }> {
    if (input.path.length === 0 || input.path.includes("\0")) {
      throw new Error("A Git path must be nonempty and cannot contain NUL");
    }
    if (input.revision === "index") {
      const staged = await this.listIndex();
      const match = staged.find((entry) => entry.path === input.path || entry.path.startsWith(`${input.path}/`));
      if (match === undefined) {
        throw new Error(`:${input.path} does not resolve to a staged blob or tree`);
      }
      if (match.path === input.path) {
        return { object: match.object, type: "blob" };
      }
      const tree = await this.indexTree();
      const oid = await this.subtreeForPath(tree, input.path);
      if (oid === null) {
        throw new Error(`:${input.path} does not resolve to a staged blob or tree`);
      }
      return { object: oid, type: "tree" };
    }
    const expression = `${input.revision}:${input.path}`;
    const result = await this.run(["rev-parse", "--verify", expression]);
    const object = parseObjectId(result.stdout, `git rev-parse ${expression}`);
    const type = (await this.run(["cat-file", "-t", object])).stdout.trim();
    if (type !== "blob" && type !== "tree") {
      throw new Error(`${expression} does not resolve to a blob or tree`);
    }
    return { object, type };
  }

  /** The subtree OID at `path` below `tree`, or null when no such directory exists. */
  private async subtreeForPath(tree: ObjectId, path: string): Promise<ObjectId | null> {
    const segments = path.split("/").filter((segment) => segment.length > 0);
    let current = tree;
    for (const segment of segments) {
      const children = await this.listTreeDirect(current);
      const match = children.find((entry) => entry.type === "tree" && entry.path === segment);
      if (match === undefined) return null;
      current = match.object;
    }
    return current;
  }

  /** Immediate children of one tree object (non-recursive). */
  private async listTreeDirect(tree: ObjectId): Promise<readonly TreeEntry[]> {
    const result = await this.run(["ls-tree", "-z", tree]);
    return result.stdout
      .split("\0")
      .filter((record) => record.length > 0)
      .map((record) => {
        const separator = record.indexOf("\t");
        if (separator < 0) {
          throw new Error("Malformed git ls-tree record");
        }
        const metadata = record.slice(0, separator).split(" ");
        const [mode, type, objectValue] = metadata;
        if (
          mode === undefined ||
          objectValue === undefined ||
          (type !== "blob" && type !== "commit" && type !== "tree")
        ) {
          throw new Error("Malformed git ls-tree metadata");
        }
        const object = parseObjectId(objectValue, "git ls-tree");
        const path = record.slice(separator + 1);
        if (type === "blob") return { mode, type, object: blobId(object), path };
        if (type === "commit") return { mode, type, object: commitId(object), path };
        return { mode, type, object, path };
      });
  }

  async resolveCommit(revision: string): Promise<CommitId> {
    if (revision.length === 0 || revision.includes("\0")) {
      throw new Error("A revision must be nonempty and cannot contain NUL");
    }
    const result = await this.run(["rev-parse", "--verify", `${revision}^{commit}`]);
    return commitId(parseObjectId(result.stdout, `git rev-parse ${revision}`));
  }

  async treeForCommit(revision: string): Promise<ObjectId> {
    const commit = await this.resolveCommit(revision);
    const result = await this.run(["rev-parse", "--verify", `${commit}^{tree}`]);
    return parseObjectId(result.stdout, `git rev-parse ${commit}^{tree}`);
  }

  /** Result tree for an already-resolved commit. */
  async resultTreeForCommit(commit: CommitId): Promise<ObjectId> {
    const result = await this.run(["rev-parse", "--verify", `${commit}^{tree}`]);
    return parseObjectId(result.stdout, `git rev-parse ${commit}^{tree}`);
  }

  /**
   * Compute a candidate merge result tree without creating a commit, for
   * pre-final-commit (squash / merge-queue) transition validation. The
   * given parent order is the merge order callers must record.
   */
  async treeExists(object: ObjectId): Promise<boolean> {
    const result = await this.run(["cat-file", "-t", object], { allowExitCodes: [0, 1, 128] });
    return result.exitCode === 0 && result.stdout.trim() === "tree";
  }

  async objectType(object: ObjectId): Promise<"blob" | "tree" | "commit" | "tag" | null> {
    const result = await this.run(["cat-file", "-t", object], { allowExitCodes: [0, 1, 128] });
    if (result.exitCode !== 0) return null;
    const type = result.stdout.trim();
    return type === "blob" || type === "tree" || type === "commit" || type === "tag" ? type : null;
  }

  async objectExists(kind: "blob" | "tree" | "commit", object: ObjectId): Promise<boolean> {
    const result = await this.run(["cat-file", "-e", `${object}^{${kind}}`], { allowExitCodes: [0, 1, 128] });
    return result.exitCode === 0;
  }

  async readNote(object: ObjectId): Promise<string | null> {
    return this.readNoteFromRef(NOTES_REF, object);
  }

  async readNoteFromRef(ref: string, object: ObjectId): Promise<string | null> {
    const result = await this.run(["notes", `--ref=${ref}`, "show", object], { allowExitCodes: [0, 1] });
    return result.exitCode === 0 ? result.stdout : null;
  }

  async batchObjectDetails(
    objects: readonly ObjectId[],
  ): Promise<ReadonlyMap<ObjectId, { readonly type: string; readonly size: number } | null>> {
    const unique = [...new Set(objects)];
    if (this.noLazyFetch) {
      const assessed = await Promise.all(unique.map(async (object) => {
        const detail = await this.batchObjectDetailIndividually(object);
        return [object, detail] as const;
      }));
      return new Map(assessed);
    }
    const details = new Map<ObjectId, { readonly type: string; readonly size: number } | null>();
    if (unique.length === 0) return details;
    const raw = await this.runBinary(
      ["cat-file", "--batch-check"],
      { input: unique.map((object) => `${object}\n`).join("") },
    );
    for (const line of raw.toString("utf8").split("\n").filter((entry) => entry.length > 0)) {
      const [oid, kind, sizeText] = line.split(" ");
      if (oid === undefined || kind === undefined) throw new Error("Malformed git cat-file --batch-check line");
      if (kind === "missing") {
        details.set(oid as ObjectId, null);
        continue;
      }
      const size = Number(sizeText);
      if (!Number.isInteger(size) || size < 0) throw new Error("Malformed git cat-file --batch-check size");
      details.set(oid as ObjectId, { type: kind, size });
    }
    for (const object of unique) {
      if (!details.has(object)) details.set(object, null);
    }
    return details;
  }

  /**
   * One object's type and size without ever fetching. Any failure (unfetched
   * promisor object, unknown OID) maps to null; the caller grades the cause.
   */
  private async batchObjectDetailIndividually(
    object: ObjectId,
  ): Promise<{ readonly type: string; readonly size: number } | null> {
    const result = await this.run(["cat-file", "--batch-check"], {
      input: `${object}\n`,
      allowExitCodes: [0, 128],
    });
    if (result.exitCode !== 0) return null;
    const line = result.stdout.split("\n").find((entry) => entry.length > 0);
    if (line === undefined) return null;
    const [oid, kind, sizeText] = line.split(" ");
    if (oid === undefined || kind === undefined) throw new Error("Malformed git cat-file --batch-check line");
    if (kind === "missing") return null;
    const size = Number(sizeText);
    if (!Number.isInteger(size) || size < 0) throw new Error("Malformed git cat-file --batch-check size");
    return { type: kind, size };
  }

  /**
   * Report every object size with one `cat-file --batch-check` process.
   * Missing objects map to null; the caller decides whether that is an error.
   */
  async batchObjectSizes(objects: readonly ObjectId[]): Promise<ReadonlyMap<ObjectId, number | null>> {
    const details = await this.batchObjectDetails(objects);
    return new Map([...details].map(([object, detail]) => [object, detail === null ? null : detail.size] as const));
  }

  async readNotesBatch(
    entries: readonly NoteListEntry[],
    options: BatchReadOptions = {},
  ): Promise<ReadonlyMap<ObjectId, string | null>> {
    const bodies = new Map<ObjectId, string | null>();
    if (entries.length === 0) return bodies;
    // A suppressed handle cannot use the batch fast paths: one unfetched
    // promisor body aborts the whole batch with a fatal exit. Read
    // individually (in parallel) instead, keeping the size gate before every
    // body load. Missing bodies map to null; the caller grades the cause.
    if (this.noLazyFetch) {
      await Promise.all(entries.map(async (entry) => {
        bodies.set(entry.object, await this.readNoteBodyIndividually(entry.note, options));
      }));
      return bodies;
    }
    const noteToObject = new Map<ObjectId, ObjectId>();
    for (const entry of entries) noteToObject.set(entry.note, entry.object);
    const sizes = await this.batchObjectSizes([...noteToObject.keys()]);
    const wanted: ObjectId[] = [];
    for (const [note, object] of noteToObject) {
      const size = sizes.get(note);
      if (size === null || size === undefined) {
        bodies.set(object, null);
        continue;
      }
      assertNoteSize(size, options.limits);
      wanted.push(note);
    }
    if (wanted.length === 0) return bodies;
    const raw = await this.runBinary(
      ["cat-file", "--batch"],
      { input: wanted.map((note) => `${note}\n`).join("") },
    );
    const bodyByNote = new Map<ObjectId, string | null>();
    let offset = 0;
    while (offset < raw.length) {
      const newline = raw.indexOf(0x0a, offset);
      if (newline < 0) throw new Error("Malformed git cat-file --batch output");
      const [oid, kind, sizeText] = raw.subarray(offset, newline).toString("utf8").split(" ");
      offset = newline + 1;
      if (kind === "missing") {
        bodyByNote.set(oid as ObjectId, null);
        continue;
      }
      const size = Number(sizeText);
      if (oid === undefined || !Number.isInteger(size) || size < 0) {
        throw new Error("Malformed git cat-file --batch header");
      }
      const body = raw.subarray(offset, offset + size);
      if (body.length !== size) throw new Error("Truncated git cat-file --batch output");
      offset += size;
      if (raw[offset] !== 0x0a) throw new Error("Malformed git cat-file --batch terminator");
      offset += 1;
      bodyByNote.set(oid as ObjectId, body.toString("utf8"));
    }
    for (const [note, object] of noteToObject) {
      if (bodies.has(object)) continue;
      bodies.set(object, bodyByNote.get(note) ?? null);
    }
    return bodies;
  }

  /**
   * One note body without ever fetching. The size gate runs before the body
   * load, mirroring the batch path. Any local absence maps to null.
   */
  private async readNoteBodyIndividually(
    note: ObjectId,
    options: BatchReadOptions,
  ): Promise<string | null> {
    const detail = await this.batchObjectDetailIndividually(note);
    if (detail === null) return null;
    assertNoteSize(detail.size, options.limits);
    const body = await this.run(["cat-file", "-p", note], { allowExitCodes: [0, 128] });
    return body.exitCode === 0 ? body.stdout : null;
  }

  async runBinary(args: readonly string[], options: RunOptions = {}): Promise<Buffer> {
    return runGitBinary(this.commandCwd, args, this.suppressLazyFetch(options));
  }

  /**
   * A view over the same repository whose Git invocations never lazily
   * fetch promisor objects. Use it for every automatic or evidence-read
   * path; explicit sync/fetch/push commands keep using the live repository.
   */
  withoutLazyFetch(): GitRepository {
    if (this.noLazyFetch) return this;
    // Carry the cached object format across: the suppressed handle is the one
    // callers actually use, and dropping it would make synchronous hashing fall
    // back to SHA-1 inside a SHA-256 repository.
    return new GitRepository(this.root, this.commonDir, this.commandCwd, true, this.cachedObjectFormat);
  }

  private suppressLazyFetch(options: RunOptions): RunOptions {
    if (!this.noLazyFetch || options.environment?.["GIT_NO_LAZY_FETCH"] !== undefined) {
      return options;
    }
    return { ...options, environment: { ...options.environment, ...NO_LAZY_FETCH_ENV } };
  }

  /**
   * Local clone-shape signals for completeness grading. Every detector is a
   * local read: none may fetch, and none consult the network.
   */
  async isShallowRepository(): Promise<boolean> {
    return (await this.run(["rev-parse", "--is-shallow-repository"])).stdout.trim() === "true";
  }

  async hasPromisorRemote(): Promise<boolean> {
    const extension = await this.run(["config", "--get", "extensions.partialClone"], {
      allowExitCodes: [0, 1],
    });
    if (extension.exitCode === 0 && extension.stdout.trim().length > 0) return true;
    const promisors = await this.run(["config", "--get-regexp", "\\.promisor$"], {
      allowExitCodes: [0, 1],
    });
    if (promisors.exitCode !== 0) return false;
    return promisors.stdout.split("\n").some((line) => /\s+true\s*$/i.test(line));
  }

  /**
   * Locally missing objects, probed one by one without ever fetching.
   * Prefer a suppressed handle (`withoutLazyFetch`): through a live handle
   * the probe itself would lazily fetch a promisor object and report it
   * present. Any local absence (unfetched, unknown, or corrupt) maps to
   * membership; the caller grades the cause from the clone shape.
   */
  async missingObjects(objects: readonly ObjectId[]): Promise<ReadonlySet<ObjectId>> {
    const unique = [...new Set(objects)];
    const probed = await Promise.all(unique.map(async (object) => {
      const result = await this.run(["cat-file", "-e", object], { allowExitCodes: [0, 1, 128] });
      return [object, result.exitCode !== 0] as const;
    }));
    return new Set(probed.filter(([, missing]) => missing).map(([object]) => object));
  }

  /** Local remote-tracking tips for the notes ref, keyed by full refname. */
  async notesTrackingTips(): Promise<ReadonlyMap<string, ObjectId>> {
    const result = await this.run(
      ["for-each-ref", "--format=%(objectname) %(refname)", "refs/notes/remotes/"],
    );
    const tips = new Map<string, ObjectId>();
    for (const line of result.stdout.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      const [oid, ref] = trimmed.split(" ");
      if (oid === undefined || ref === undefined || !ref.endsWith("/reveries")) continue;
      tips.set(ref, objectId(oid));
    }
    return tips;
  }

  async isAncestor(object: ObjectId, descendant: ObjectId): Promise<boolean> {
    const result = await this.run(["merge-base", "--is-ancestor", object, descendant], {
      allowExitCodes: [0, 1],
    });
    return result.exitCode === 0;
  }

  /** Disposable snapshot-index directory; the index is a cache, never authority. */
  async notesTip(ref = NOTES_REF): Promise<ObjectId | null> {
    const result = await this.run(["rev-parse", "--verify", ref], { allowExitCodes: [0, 128] });
    return result.exitCode === 0 ? parseObjectId(result.stdout, `git rev-parse ${ref}`) : null;
  }

  async remoteObject(remote: string, ref: string): Promise<ObjectId | null> {
    if (remote.length === 0 || remote.includes("\0") || ref.length === 0 || ref.includes("\0")) {
      throw new Error("A remote and ref must be nonempty and cannot contain NUL");
    }
    const result = await this.run(["ls-remote", "--refs", remote, ref]);
    const matches = result.stdout.trim().split("\n").filter((line) => line.endsWith(`\t${ref}`));
    if (matches.length === 0) return null;
    if (matches.length !== 1) throw new Error(`Remote ${remote} returned more than one ${ref}`);
    const oid = matches[0]?.split("\t", 1)[0];
    if (oid === undefined) throw new Error(`Remote ${remote} returned a malformed ${ref}`);
    return parseObjectId(oid, `git ls-remote ${remote} ${ref}`);
  }

  async listNotes(ref = NOTES_REF): Promise<readonly NoteListEntry[]> {
    const result = await this.run(["notes", `--ref=${ref}`, "list"], { allowExitCodes: [0, 1] });
    if (result.exitCode !== 0 || result.stdout.length === 0) {
      return [];
    }
    return result.stdout
      .trimEnd()
      .split("\n")
      .map((line) => {
        const [noteValue, objectValue, extra] = line.split(" ");
        if (noteValue === undefined || objectValue === undefined || extra !== undefined) {
          throw new Error(`Malformed git notes list line: ${line}`);
        }
        return {
          note: parseObjectId(noteValue, "git notes list note"),
          object: parseObjectId(objectValue, "git notes list object"),
        };
      });
  }

  async listTree(revision = "HEAD"): Promise<readonly TreeEntry[]> {
    const result = await this.run(["ls-tree", "-r", "-z", revision]);
    return result.stdout
      .split("\0")
      .filter((record) => record.length > 0)
      .map((record) => {
        const separator = record.indexOf("\t");
        if (separator < 0) {
          throw new Error("Malformed git ls-tree record");
        }
        const metadata = record.slice(0, separator).split(" ");
        const [mode, type, objectValue] = metadata;
        if (
          mode === undefined ||
          objectValue === undefined ||
          (type !== "blob" && type !== "commit" && type !== "tree")
        ) {
          throw new Error("Malformed git ls-tree metadata");
        }
        const object = parseObjectId(objectValue, "git ls-tree");
        const path = record.slice(separator + 1);
        if (type === "blob") return { mode, type, object: blobId(object), path };
        if (type === "commit") return { mode, type, object: commitId(object), path };
        return { mode, type, object, path };
      });
  }

  async pathsForBlob(object: BlobId, revision = "HEAD"): Promise<readonly string[]> {
    const tree = await this.listTree(revision);
    return tree.filter((entry) => entry.type === "blob" && entry.object === object).map((entry) => entry.path);
  }

  /**
   * Every entry of a revision including intermediate trees (`ls-tree -r -t`).
   * `listTree` stays blob-oriented for existing callers; tree-subject paths
   * (RVR-013) need the tree entries it omits.
   */
  async listTreeIncludingTrees(revision: string | ObjectId): Promise<readonly TreeEntry[]> {
    const result = await this.run(["ls-tree", "-r", "-t", "-z", revision]);
    return result.stdout
      .split("\0")
      .filter((record) => record.length > 0)
      .map((record) => {
        const separator = record.indexOf("\t");
        if (separator < 0) {
          throw new Error("Malformed git ls-tree record");
        }
        const metadata = record.slice(0, separator).split(" ");
        const [mode, type, objectValue] = metadata;
        if (
          mode === undefined ||
          objectValue === undefined ||
          (type !== "blob" && type !== "commit" && type !== "tree")
        ) {
          throw new Error("Malformed git ls-tree metadata");
        }
        const object = parseObjectId(objectValue, "git ls-tree");
        const path = record.slice(separator + 1);
        if (type === "blob") return { mode, type, object: blobId(object), path };
        if (type === "commit") return { mode, type, object: commitId(object), path };
        return { mode, type, object, path };
      });
  }

  /** Every directory path at `revision` whose subtree OID equals `object`. */
  async pathsForTree(object: ObjectId, revision: string | ObjectId = "HEAD"): Promise<readonly string[]> {
    const tree = await this.listTreeIncludingTrees(revision);
    const paths = tree.filter((entry) => entry.type === "tree" && entry.object === object).map((entry) => entry.path);
    if (paths.length > 0) return paths;
    // The revision root tree lists no paths under itself; report the stable
    // display path "." instead of an empty list (RVR-013). Callers that need
    // raw listing emptiness should read `listTreeIncludingTrees` directly.
    try {
      const name = String(revision);
      const root = parseObjectId(
        (await this.run(["rev-parse", "--verify", `${name}^{tree}`])).stdout,
        `git rev-parse ${name}^{tree}`,
      );
      if (root === object) return ["."];
    } catch {
      // An unresolvable revision keeps the empty listing.
    }
    return paths;
  }

  /** Blob or tree paths for an annotated subject at `revision`. */
  async pathsForSubject(object: ObjectId, revision: string | ObjectId = "HEAD"): Promise<readonly string[]> {
    if (await this.treeExists(object)) {
      return this.pathsForTree(object, revision);
    }
    return this.pathsForBlob(blobId(object), typeof revision === "string" ? revision : String(revision));
  }

  async listIndex(): Promise<readonly TreeEntry[]> {
    const result = await this.run(["ls-files", "--stage", "-z"]);
    return result.stdout
      .split("\0")
      .filter((record) => record.length > 0)
      .map((record) => {
        const separator = record.indexOf("\t");
        if (separator < 0) throw new Error("Malformed git ls-files record");
        const [mode, objectValue, stage] = record.slice(0, separator).split(" ");
        if (mode === undefined || objectValue === undefined || stage !== "0") {
          throw new Error("The index contains an unresolved merge stage");
        }
        return {
          mode,
          type: "blob" as const,
          object: blobId(parseObjectId(objectValue, "git ls-files")),
          path: record.slice(separator + 1),
        };
      });
  }

  async indexPathsForBlob(object: BlobId): Promise<readonly string[]> {
    return (await this.listIndex()).filter((entry) => entry.object === object).map((entry) => entry.path);
  }

  /** The staged index tree OID (`git write-tree`). */
  async indexTree(): Promise<ObjectId> {
    return parseObjectId((await this.run(["write-tree"])).stdout, "git write-tree");
  }

  /** Staged directory paths whose subtree OID equals `object`. */
  async indexPathsForTree(object: ObjectId): Promise<readonly string[]> {
    return this.pathsForTree(object, await this.indexTree());
  }

  /** Staged blob or tree paths for an annotated subject. */
  async indexPathsForSubject(object: ObjectId): Promise<readonly string[]> {
    if (await this.treeExists(object)) {
      return this.indexPathsForTree(object);
    }
    return this.indexPathsForBlob(blobId(object));
  }

  async blobIsDurable(object: BlobId): Promise<boolean> {
    if ((await this.indexPathsForBlob(object)).length > 0) return true;
    const result = await this.run(["rev-list", "--objects", "--all"]);
    return result.stdout.split("\n").some((line) => line === object || line.startsWith(`${object} `));
  }

  /** True when a tree is staged or reachable from any commit's history. */
  async treeIsDurable(object: ObjectId): Promise<boolean> {
    if (!(await this.treeExists(object))) return false;
    if ((await this.indexPathsForTree(object)).length > 0) return true;
    // The staged root tree lists no paths under itself, so it needs the
    // identity check; committed roots are covered by rev-list below.
    try {
      if ((await this.indexTree()) === object) return true;
    } catch {
      // An unreadable index simply falls through to history reachability.
    }
    const result = await this.run(["rev-list", "--objects", "--all"]);
    return result.stdout.split("\n").some((line) => line === object || line.startsWith(`${object} `));
  }

  /** True when a blob-or-tree subject is staged or reachable from a commit. */
  async subjectIsDurable(object: ObjectId): Promise<boolean> {
    if (await this.treeExists(object)) {
      return this.treeIsDurable(object);
    }
    if ((await this.objectType(object)) !== "blob") return false;
    return this.blobIsDurable(blobId(object));
  }

  async withNotesWrite<T>(
    operation: (notes: NotesTransaction) => Promise<T>,
    validate: NotesRefValidator = async () => undefined,
    options: WithNotesWriteOptions = {},
  ): Promise<T> {
    const maxAttempts = Math.max(1, Math.floor(options.attempts ?? 15));
    const baseDelayMs = Math.max(0, options.baseDelayMs ?? 10);
    const maxDelayMs = Math.max(baseDelayMs, options.maxDelayMs ?? 200);
    let expectedTip: ObjectId | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      expectedTip = await this.notesTip();
      const temporaryRef = `${NOTES_TXN_REF_PREFIX}${process.pid}-${randomUUID()}-a${attempt}`;
      try {
        if (expectedTip !== null) {
          await this.run(["update-ref", temporaryRef, expectedTip]);
        }
        const transaction = new TemporaryNotesTransaction(this, temporaryRef);
        const value = await operation(transaction);
        const newTip = await this.notesTip(temporaryRef);
        if (newTip === null) {
          return value;
        }
        await validate(temporaryRef);
        const format = await this.objectFormat();
        const absent = "0".repeat(format === "sha1" ? 40 : 64);
        const update = await this.run(["update-ref", NOTES_REF, newTip, expectedTip ?? absent], {
          allowExitCodes: [0, 1, 128],
        });
        if (update.exitCode === 0) {
          return value;
        }
      } finally {
        await this.run(["update-ref", "-d", temporaryRef], { allowExitCodes: [0, 1, 128] });
      }
      if (attempt < maxAttempts) {
        await boundedBackoff(attempt, baseDelayMs, maxDelayMs);
      }
    }
    throw new NotesContentionError(NOTES_REF, maxAttempts, expectedTip, await this.notesTip());
  }

  /**
   * Build a root notes commit from sanitized bodies without inheriting the
   * current notes history. The private candidate ref is removed on every exit;
   * callers publish the returned commit with a separate compare-and-swap.
   */
  async listTemporaryNotesRefs(): Promise<readonly TemporaryNotesRef[]> {
    const result = await this.run(
      ["for-each-ref", "--format=%(refname)%00%(creatordate:unix)", NOTES_TXN_REF_PREFIX],
    );
    const refs: TemporaryNotesRef[] = [];
    for (const line of result.stdout.split("\n")) {
      if (line.length === 0) continue;
      const separator = line.indexOf("\0");
      const ref = separator < 0 ? line : line.slice(0, separator);
      const rawDate = separator < 0 ? "" : line.slice(separator + 1).trim();
      const createdAtUnix = /^\d+$/.test(rawDate) ? Number(rawDate) : null;
      if (!ref.startsWith(NOTES_TXN_REF_PREFIX)) continue;
      refs.push({ ref, createdAtUnix });
    }
    return refs.sort((left, right) => left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0);
  }

  /** Delete one disposable transaction ref; never touches the canonical ref. */
  async deleteTemporaryNotesRef(ref: string): Promise<void> {
    if (!ref.startsWith(NOTES_TXN_REF_PREFIX) || ref.includes("\0") || ref.includes(" ")) {
      throw new Error(`Not a disposable Reveries transaction ref: ${ref}`);
    }
    await this.run(["update-ref", "-d", ref], { allowExitCodes: [0, 1, 128] });
  }

  private async updateRefsAtomically(updates: readonly {
    readonly ref: string;
    readonly next: ObjectId | null;
    readonly expected: ObjectId | null;
  }[]): Promise<void> {
    const format = await this.objectFormat();
    const absent = "0".repeat(format === "sha1" ? 40 : 64);
    const transaction = [
      "start",
      ...updates.map(({ ref, next, expected }) => {
        if (next !== null) return `update ${ref} ${next} ${expected ?? absent}`;
        return expected === null
          ? `verify ${ref} ${absent}`
          : `delete ${ref} ${expected}`;
      }),
      "prepare",
      "commit",
      "",
    ].join("\n");
    await this.run(["update-ref", "--stdin"], { input: transaction });
  }

  // ---------------------------------------------------------------------------
  // Retention
  // ---------------------------------------------------------------------------

  /** Read a blob's UTF-8 contents. */
  async readBlobAt(object: ObjectId): Promise<string> {
    return (await this.runBinary(["cat-file", "blob", object])).toString("utf8");
  }

  /** Build the retention tree from the selected blob and tree subjects. */
  async writeRetentionObjects(subjects: readonly RetentionSubject[]): Promise<ObjectId> {
    const unique = new Map<string, RetentionSubject["type"]>();
    for (const subject of subjects) {
      if (subject.type === "tag") {
        throw new Error(`Retention cannot anchor annotated tag ${subject.object}`);
      }
      const existing = unique.get(subject.object);
      if (existing !== undefined) {
        if (existing !== subject.type) {
          throw new Error(`Retention subject ${subject.object} is both a ${existing} and a ${subject.type}`);
        }
        continue;
      }
      unique.set(subject.object, subject.type);
    }
    const environment = { GIT_INDEX_FILE: join(this.commonDir, "reveries", `retention-index-${randomUUID()}`) };
    await mkdir(dirname(environment.GIT_INDEX_FILE), { recursive: true });
    try {
      for (const [object, type] of [...unique].sort(([left], [right]) => compareUtf8(left, right))) {
        const mode = type === "tree" ? "040000" : "100644";
        await this.run(
          ["update-index", "--add", "--cacheinfo", `${mode},${object},${object.slice(0, 2)}/${object.slice(2)}`],
          { environment },
        );
      }
      return parseObjectId((await this.run(["write-tree"], { environment })).stdout, "git write-tree");
    } finally {
      await rm(environment.GIT_INDEX_FILE, { force: true });
      await rm(`${environment.GIT_INDEX_FILE}.lock`, { force: true });
    }
  }

  /**
   * Build the single retention checkpoint commit.
   *
   * One commit carries every retained blob and tree in its tree and every
   * retained commit as a parent. The fixed identity, fixed epoch date, and
   * fixed message make the commit object ID a pure function of the evidence,
   * so a rebuild from the same notes reproduces the same ref target. There is
   * no append-only chain and no second database.
   */
  async writeRetention(subjects: readonly RetentionSubject[]): Promise<ObjectId> {
    const tree = await this.writeRetentionObjects(subjects.filter((subject) => subject.type !== "commit"));
    const commits = [...new Set(subjects.filter((subject) => subject.type === "commit").map((subject) => subject.object))]
      .sort(compareUtf8);
    const argumentsList = ["commit-tree", tree];
    for (const commit of commits) argumentsList.push("-p", commit);
    argumentsList.push("-F", "-");
    return parseObjectId(
      (await this.run(argumentsList, {
        input: RETENTION_MESSAGE,
        environment: { ...RETENTION_IDENTITY },
      })).stdout,
      "git commit-tree",
    );
  }

  /**
   * Read `refs/reveries/retention` without interpreting it: the checkpoint
   * commit, the blobs and trees in its tree, and the commits named as parents.
   */
  async readRetention(): Promise<{
    readonly commit: ObjectId | null;
    readonly objects: readonly ObjectId[];
    readonly commits: readonly ObjectId[];
  }> {
    const commit = await this.notesTip(RETENTION_REF);
    if (commit === null) return { commit: null, objects: [], commits: [] };
    return {
      commit,
      objects: await this.listRetentionObjects(),
      commits: await this.listRetentionCommits(),
    };
  }

  async listRetentionObjects(ref = RETENTION_REF): Promise<readonly ObjectId[]> {
    const result = await this.run(["ls-tree", "-r", "-z", ref], { allowExitCodes: [0, 1, 128] });
    if (result.exitCode !== 0) return [];
    return result.stdout
      .split("\0")
      .filter((record) => record.length > 0)
      .map((record) => {
        const separator = record.indexOf("\t");
        if (separator < 0) throw new Error("Malformed git ls-tree record");
        const metadata = record.slice(0, separator).split(" ");
        if (metadata.length !== 3) throw new Error("Malformed git ls-tree metadata");
        return parseObjectId(metadata[2] ?? "", "git ls-tree");
      });
  }

  async listRetentionCommits(): Promise<readonly ObjectId[]> {
    const commit = await this.notesTip(RETENTION_REF);
    if (commit === null) return [];
    const result = await this.run(["show", "-s", "--format=%P", commit], { allowExitCodes: [0, 1, 128] });
    if (result.exitCode !== 0) return [];
    return result.stdout.trim().split(" ").filter((parent) => parent.length > 0).map((parent) => objectId(parent));
  }

  async updateRetentionRef(update: {
    readonly next: ObjectId | null;
    readonly expected?: ObjectId | null;
  }): Promise<void> {
    await this.moveRetentionRef({ ref: RETENTION_REF, next: update.next, expected: update.expected ?? null });
  }

  async deleteRetentionRef(expected: ObjectId | null): Promise<void> {
    await this.moveRetentionRef({ ref: RETENTION_REF, next: null, expected });
  }

  private async moveRetentionRef(update: {
    readonly ref: string;
    readonly next: ObjectId | null;
    readonly expected: ObjectId | null;
  }): Promise<void> {
    try {
      await this.updateRefsAtomically([update]);
    } catch (error: unknown) {
      throw new Error("The Reveries retention ref changed concurrently", { cause: error });
    }
  }

  async fetchNotes(remote: string): Promise<"fetched" | "absent"> {
    if (await this.remoteObject(remote, NOTES_REF) === null) return "absent";
    await this.run([
      "fetch",
      remote,
      `+${NOTES_REF}:refs/notes/remotes/${remote}/reveries`,
    ]);
    return "fetched";
  }

  /**
   * Merge a fetched notes ref into canonical state and return the new tip.
   */
  async mergeFetchedNotes(
    remote: string,
    validate: NotesRefValidator = async () => undefined,
  ): Promise<ObjectId | null> {
    await this.withNotesWrite(async (notes) => {
      await this.run([
        "notes",
        `--ref=${notes.ref}`,
        "merge",
        "-s",
        "cat_sort_uniq",
        `refs/notes/remotes/${remote}/reveries`,
      ]);
    }, validate);
    return this.notesTip();
  }

  async pushAtomically(remote: string, options: {
    /** The local branch ref HEAD is pushed to (enables the branch lease). */
    readonly branchRef?: string;
    /** Expected remote OIDs; absent (undefined) means the lease is omitted. */
    readonly expectedBranch?: ObjectId | null;
    readonly expectedNotes?: ObjectId | null;
    readonly expectedRetention?: ObjectId | null;
    /**
     * Include `${NOTES_REF}:${NOTES_REF}` in the transaction. A repository that
     * has never written a note has no such ref, and "src refspec does not match
     * any" would fail the whole atomic push for a branch that is perfectly
     * publishable. Such a repository publishes the branch alone.
     */
    readonly includeNotes?: boolean;
    /**
     * Include `${RETENTION_REF}:${RETENTION_REF}` in the transaction. A
     * repository that has never built the retention ref omits it, for the same
     * reason as the notes ref.
     */
    readonly includeRetention?: boolean;
  } = {}): Promise<void> {
    const includeNotes = options.includeNotes ?? true;
    const includeRetention = options.includeRetention ?? false;
    const branchSpec = options.branchRef === undefined ? "HEAD" : `HEAD:${options.branchRef}`;
    const refspecs = [branchSpec];
    if (includeNotes) refspecs.push(`${NOTES_REF}:${NOTES_REF}`);
    if (includeRetention) refspecs.push(`${RETENTION_REF}:${RETENTION_REF}`);
    const leases: string[] = [];
    const format = await this.objectFormat();
    const absent = "0".repeat(format === "sha1" ? 40 : 64);
    const leaseFor = (ref: string, expected: ObjectId | null | undefined): void => {
      if (expected !== undefined) leases.push(`--force-with-lease=${ref}:${expected ?? absent}`);
    };
    if (options.branchRef !== undefined) leaseFor(options.branchRef, options.expectedBranch);
    if (includeNotes) leaseFor(NOTES_REF, options.expectedNotes);
    if (includeRetention) leaseFor(RETENTION_REF, options.expectedRetention);
    const probe = [
      "push",
      "--atomic",
      "--dry-run",
      "--no-verify",
      remote,
      ...refspecs,
    ];
    const result = await this.run(probe, { allowExitCodes: [0, 1, 128] });
    if (result.exitCode !== 0) {
      if (/atomic(?: pushes?)?[^\n]*(?:not supported|unsupported)|does not support[^\n]*atomic/i.test(result.stderr)) {
        throw new AtomicPushUnavailableError(remote);
      }
      throw new GitCommandError(probe, result);
    }
    await this.run(
      ["push", "--atomic", ...leases, remote, ...refspecs],
    );
  }
}

async function runGitBinary(cwd: string, args: readonly string[], options: RunOptions = {}): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: { ...process.env, ...options.environment },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.on("close", (exitCode) => {
      const code = exitCode ?? 128;
      const allowed = options.allowExitCodes ?? [0];
      if (!allowed.includes(code)) {
        reject(new GitCommandError(args, {
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          exitCode: code,
        }));
        return;
      }
      resolvePromise(Buffer.concat(stdout));
    });
    if (options.input !== undefined) {
      child.stdin.end(options.input, "utf8");
    } else {
      child.stdin.end();
    }
  });
}

async function runGit(cwd: string, args: readonly string[], options: RunOptions = {}): Promise<GitResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: { ...process.env, ...options.environment },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.on("close", (exitCode) => {
      const result: GitResult = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: exitCode ?? 128,
      };
      const allowed = options.allowExitCodes ?? [0];
      if (!allowed.includes(result.exitCode)) {
        reject(new GitCommandError(args, result));
        return;
      }
      resolvePromise(result);
    });
    if (options.input !== undefined) {
      child.stdin.end(options.input, "utf8");
    } else {
      child.stdin.end();
    }
  });
}
