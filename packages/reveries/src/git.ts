import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
export const LEDGER_REF = "refs/heads/reveries-ledger";
export const RETENTION_OBJECTS_REF = "refs/reveries/retention/objects";
export const RETENTION_COMMITS_REF = "refs/reveries/retention/commits";
export const RETENTION_BUNDLE_REFS = [
  NOTES_REF,
  LEDGER_REF,
  RETENTION_OBJECTS_REF,
  RETENTION_COMMITS_REF,
] as const;
export const INTERNAL_ATOMIC_PUSH_ENV = "REVERIES_INTERNAL_ATOMIC_PUSH";

/**
 * Environment that disables on-demand (lazy) fetching of promisor objects.
 * Verified against git 2.39.5: with the variable set, access to a missing
 * promisor object fails fast (`fatal: could not fetch ... from promisor
 * remote`) instead of transparently fetching. Automatic paths (hooks,
 * evidence reads) must use it; only explicit user-invoked sync/fetch/push
 * commands may touch the network.
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
  | "subject-pruned"
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
 * Never thrown since the lock-free publication change (RVR-016). The
 * `write.lock` directory is no longer consulted by any write path, so a
 * stale lock can neither block nor serialize writers. Kept exported for
 * backward compatibility with external importers catching it.
 *
 * @deprecated Publication is guarded by expected-old-OID compare-and-swap;
 * a stale lock directory is reported by `doctor()` as a notice, never an error.
 */
export class NotesLockError extends Error {
  constructor(readonly lockPath: string) {
    super(`Reveries notes are locked at ${lockPath}`);
    this.name = "NotesLockError";
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

interface GitStateFileSnapshot {
  readonly name: string;
  readonly path: string;
  readonly contents: Buffer | null;
}

export class SnapshotIndexCorruptError extends Error {
  constructor(readonly tip: string) {
    super(`Reveries snapshot index for ${tip} is corrupt and must be rebuilt`);
    this.name = "SnapshotIndexCorruptError";
  }
}

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
  ) {}

  static async open(cwd: string): Promise<GitRepository> {
    const rootResult = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
    const root = rootResult.stdout.trim();
    const commonResult = await runGit(root, ["rev-parse", "--git-common-dir"]);
    const commonOutput = commonResult.stdout.trim();
    const commonDir = isAbsolute(commonOutput) ? commonOutput : resolve(root, commonOutput);
    return new GitRepository(root, commonDir);
  }

  /** Open a repository from a receive hook without assuming a worktree exists. */
  static async openBare(cwd: string): Promise<GitRepository> {
    const gitDirectory = (await runGit(cwd, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
    const commonOutput = (await runGit(cwd, ["rev-parse", "--git-common-dir"])).stdout.trim();
    const commonDir = isAbsolute(commonOutput) ? commonOutput : resolve(cwd, commonOutput);
    return new GitRepository(gitDirectory, commonDir, cwd);
  }

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

  async objectType(object: ObjectId): Promise<"blob" | "tree" | "commit" | "tag" | null> {
    const result = await this.run(["cat-file", "-t", object], { allowExitCodes: [0, 1, 128] });
    if (result.exitCode !== 0) return null;
    const type = result.stdout.trim();
    return type === "blob" || type === "tree" || type === "commit" || type === "tag" ? type : null;
  }

  async objectExists(kind: "blob" | "commit", object: ObjectId): Promise<boolean> {
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

  async readNoteAt(revision: ObjectId, object: ObjectId): Promise<string | null> {
    for (const path of [object, `${object.slice(0, 2)}/${object.slice(2)}`]) {
      const result = await this.run(["show", `${revision}:${path}`], { allowExitCodes: [0, 1, 128] });
      if (result.exitCode === 0) return result.stdout;
    }
    return null;
  }

  /**
   * Report every object type and size with one `cat-file --batch-check`
   * process. Missing objects map to null; the caller decides whether that is
   * an error.
   *
   * A suppressed handle (`withoutLazyFetch`) cannot use the batch fast path:
   * one unfetched promisor object aborts the whole batch with a fatal exit
   * instead of a per-object `missing` line. Suppressed reads therefore probe
   * objects individually (in parallel), mapping any failure to null. Call
   * `missingObjects` on a suppressed handle when the goal is assessment:
   * probing through a live handle would lazily fetch what it measures.
   */
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

  /**
   * Read every note body with one size pass and one body pass, no matter how
   * many notes the snapshot holds. Note blobs over budget throw
   * `LimitExceededError` before any body is loaded. The result maps each
   * annotated object to its note body (null when the note blob is missing).
   */
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
    return new GitRepository(this.root, this.commonDir, this.commandCwd, true);
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
  snapshotIndexDirectory(): string {
    return join(this.commonDir, "reveries", "snapshot-index");
  }

  snapshotIndexPath(notesTip: ObjectId | string): string {
    const tip = String(notesTip);
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(tip)) {
      throw new Error(`Invalid snapshot index tip: ${tip}`);
    }
    return join(this.snapshotIndexDirectory(), `${tip}.json`);
  }

  async readSnapshotIndex(notesTip: ObjectId | string): Promise<string | null> {
    try {
      return await readFile(this.snapshotIndexPath(notesTip), "utf8");
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
  }

  async writeSnapshotIndex(notesTip: ObjectId | string, payload: string): Promise<void> {
    await mkdir(this.snapshotIndexDirectory(), { recursive: true });
    await writeFile(this.snapshotIndexPath(notesTip), payload, "utf8");
  }

  async clearSnapshotIndex(notesTip?: ObjectId | string): Promise<void> {
    if (notesTip === undefined) {
      await rm(this.snapshotIndexDirectory(), { recursive: true, force: true });
      return;
    }
    await rm(this.snapshotIndexPath(notesTip), { force: true });
  }

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

  async listNotesAt(revision: ObjectId): Promise<readonly NoteListEntry[]> {
    return (await this.listTree(revision))
      .filter((entry) => entry.type === "blob")
      .map((entry) => {
        const separator = entry.path.indexOf("/");
        if (separator < 0 && (entry.path.length === 40 || entry.path.length === 64) && /^[0-9a-f]+$/.test(entry.path)) {
          return { note: entry.object, object: objectId(entry.path) };
        }
        const prefix = entry.path.slice(0, separator);
        const suffix = entry.path.slice(separator + 1);
        if (separator !== 2 || !/^[0-9a-f]{2}$/.test(prefix) || !/^[0-9a-f]+$/.test(suffix)
          || (suffix.length !== 38 && suffix.length !== 62)) {
          throw new Error(`Malformed Git notes tree path: ${entry.path}`);
        }
        return { note: entry.object, object: objectId(`${prefix}${suffix}`) };
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

  async blobIsDurable(object: BlobId): Promise<boolean> {
    if ((await this.indexPathsForBlob(object)).length > 0) return true;
    const result = await this.run(["rev-list", "--objects", "--all"]);
    return result.stdout.split("\n").some((line) => line === object || line.startsWith(`${object} `));
  }

  async commitWithNote(input: {
    readonly message: string;
    readonly note: string;
    readonly validateNotesRef: NotesRefValidator;
  }): Promise<CommitId> {
    if (input.message.trim().length === 0) throw new Error("Commit message must be nonempty");

    // Lock-free: the ref-transaction below is the publication guard, so a
    // killed process leaves only a disposable temp ref, an orphan commit
    // object, and a message file — never a repository-wide blockage.
    const branchRef = await this.currentBranchRef();
    const branchTip = await this.refTip(branchRef);
    const notesTip = await this.notesTip();
    const mergeHead = await this.readGitStateFile("MERGE_HEAD");
    const mergeState = mergeHead.contents === null
      ? []
      : [mergeHead, await this.readGitStateFile("MERGE_MSG"), await this.readGitStateFile("MERGE_MODE")];
    const temporaryRef = `${NOTES_TXN_REF_PREFIX}${process.pid}-${randomUUID()}`;
    // The message file lives beside the retired lock directory, never inside
    // it, so a stale lock dir is not a dependency of this path.
    const messageDir = join(this.commonDir, "reveries", "tmp");
    const messagePath = join(messageDir, `commit-message-${process.pid}-${randomUUID()}.txt`);
    let commit: CommitId;
    try {
      if (notesTip !== null) await this.run(["update-ref", temporaryRef, notesTip]);
      await mkdir(messageDir, { recursive: true });
      await writeFile(messagePath, `${input.message.replace(/\n*$/, "")}\n`, { encoding: "utf8", flag: "wx" });
      await this.run(["hook", "run", "--ignore-missing", "pre-commit"]);
      await this.run([
        "hook",
        "run",
        "--ignore-missing",
        "prepare-commit-msg",
        "--",
        messagePath,
        "message",
      ]);
      await this.run(["hook", "run", "--ignore-missing", "commit-msg", "--", messagePath]);
      const tree = parseObjectId((await this.run(["write-tree"])).stdout, "git write-tree");
      const parents = this.commitParents(branchTip, mergeHead.contents);
      const message = await readFile(messagePath, "utf8");
      if (message.trim().length === 0) throw new Error("Commit message hook produced an empty message");
      const signing = await this.run(["config", "--bool", "--get", "commit.gpgSign"], {
        allowExitCodes: [0, 1],
      });
      const argumentsList = ["commit-tree", tree];
      for (const parent of parents) argumentsList.push("-p", parent);
      if (signing.stdout.trim() === "true") argumentsList.push("-S");
      argumentsList.push("-F", "-");
      const newCommit = commitId(parseObjectId(
        (await this.run(argumentsList, { input: message })).stdout,
        "git commit-tree",
      ));

      const notes = new TemporaryNotesTransaction(this, temporaryRef);
      await notes.append(newCommit, input.note);
      const newNotesTip = await this.notesTip(temporaryRef);
      if (newNotesTip === null) throw new Error("Prepared Reveries notes transaction has no tip");
      await input.validateNotesRef(temporaryRef);
      const currentHead = await this.run(["symbolic-ref", "--quiet", "HEAD"], { allowExitCodes: [0, 1] });
      if (currentHead.exitCode !== 0 || currentHead.stdout.trim() !== branchRef) {
        throw new Error("The current branch changed concurrently during commit preparation");
      }

      await this.updateRefsAtomically([
        { ref: branchRef, next: newCommit, expected: branchTip },
        { ref: NOTES_REF, next: newNotesTip, expected: notesTip },
      ]);
      await this.clearMergeState(mergeState);
      commit = newCommit;
    } finally {
      await this.run(["update-ref", "-d", temporaryRef], { allowExitCodes: [0, 1, 128] });
      await rm(messagePath, { force: true });
    }
    try {
      await this.run(["hook", "run", "--ignore-missing", "post-commit"]);
    } catch {
      // A post-commit hook cannot undo a commit after its refs have been published.
    }
    return commit;
  }

  /**
   * Lock-free notes mutation. Each attempt reads the canonical tip, builds
   * and validates the mutation on a unique private ref, then publishes with
   * an expected-old-OID compare-and-swap. On contention the pure `operation`
   * replays against the new tip after bounded backoff; when retries exhaust,
   * a `NotesContentionError` reports explicit bounded contention — never
   * silent loss. A killed process leaves only a disposable temp ref and
   * orphan objects, never a write blockage.
   *
   * Replay contract: `operation` must be pure — every read through
   * `notes.read`, no consumed iterators or single-use state captured outside
   * the closure — because it may run more than once per call.
   */
  async withNotesWrite<T>(
    operation: (notes: NotesTransaction) => Promise<T>,
    validate: NotesRefValidator = async () => undefined,
    onValidationFailure?: NotesValidationFailure,
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
        try {
          await validate(temporaryRef);
        } catch (error: unknown) {
          if (onValidationFailure !== undefined) {
            await onValidationFailure(temporaryRef, newTip, error);
          }
          throw error;
        }
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

  /** Every live transaction ref under the disposable `reveries-txn` namespace. */
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

  private async currentBranchRef(): Promise<string> {
    const result = await this.run(["symbolic-ref", "--quiet", "HEAD"], { allowExitCodes: [0, 1] });
    const ref = result.stdout.trim();
    if (result.exitCode !== 0 || !ref.startsWith("refs/heads/")) {
      throw new Error("Atomic commit-and-summary creation requires an attached branch");
    }
    return ref;
  }

  private async refTip(ref: string): Promise<CommitId | null> {
    const result = await this.run(["rev-parse", "--verify", ref], { allowExitCodes: [0, 128] });
    return result.exitCode === 0 ? commitId(parseObjectId(result.stdout, `git rev-parse ${ref}`)) : null;
  }

  private commitParents(branchTip: CommitId | null, mergeHead: Buffer | null): readonly CommitId[] {
    const parents: CommitId[] = branchTip === null ? [] : [branchTip];
    if (mergeHead !== null) {
      const additional = mergeHead.toString("utf8").trim().split("\n").filter(Boolean);
      for (const parent of additional) parents.push(commitId(parseObjectId(parent, "MERGE_HEAD")));
    }
    return parents;
  }

  private async readGitStateFile(name: string): Promise<GitStateFileSnapshot> {
    const result = await this.run(["rev-parse", "--git-path", name]);
    const path = result.stdout.trim();
    const absolutePath = isAbsolute(path) ? path : join(this.commandCwd, path);
    try {
      return { name, path: absolutePath, contents: await readFile(absolutePath) };
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return { name, path: absolutePath, contents: null };
      }
      throw error;
    }
  }

  private async clearMergeState(snapshots: readonly GitStateFileSnapshot[]): Promise<void> {
    for (const snapshot of snapshots) {
      const current = await this.readGitStateFile(snapshot.name);
      const unchanged = snapshot.contents === null
        ? current.contents === null
        : current.contents !== null && snapshot.contents.equals(current.contents);
      if (!unchanged) return;
    }
    for (const snapshot of snapshots) {
      if (snapshot.contents !== null) await rm(snapshot.path, { force: true });
    }
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

  /** Build the retention fanout tree for blob and tree subjects. */
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

  /** Advance the braided retention chain over the newly selected annotated commits. */
  async writeRetentionCommits(
    subjects: readonly ObjectId[],
    previousTip: ObjectId | null,
  ): Promise<ObjectId | null> {
    const retained = new Set((await this.retentionCommits()).subjects);
    const additions = [...new Set(subjects)]
      .filter((object) => !retained.has(object))
      .sort(compareUtf8);
    if (additions.length === 0) return previousTip;
    const tree = parseObjectId((await this.run(["mktree"], { input: "" })).stdout, "git mktree");
    const argumentsList = ["commit-tree", tree];
    if (previousTip !== null) argumentsList.push("-p", previousTip);
    for (const object of additions) argumentsList.push("-p", object);
    argumentsList.push("-F", "-");
    return parseObjectId(
      (await this.run(argumentsList, {
        input: RETENTION_MESSAGE,
        environment: { ...RETENTION_IDENTITY },
      })).stdout,
      "git commit-tree",
    );
  }

  /** Walk the chain to recover its tip and every annotated commit it anchors. */
  async retentionCommits(): Promise<{ readonly tip: ObjectId | null; readonly subjects: readonly ObjectId[] }> {
    const tip = await this.notesTip(RETENTION_COMMITS_REF);
    if (tip === null) return { tip: null, subjects: [] };
    const subjects: ObjectId[] = [];
    const seen = new Set<string>();
    let current: ObjectId | null = tip;
    while (current !== null && !seen.has(current)) {
      seen.add(current);
      const parents = await this.retentionCheckpointParents(current);
      if (parents === null) break;
      const { chain, retained } = parents;
      subjects.push(...retained);
      current = chain;
    }
    return { tip, subjects: [...new Set(subjects)].sort(compareUtf8) };
  }

  /**
   * A checkpoint is an empty tree carrying the fixed message. Its first parent is the
   * previous checkpoint when that parent is itself a checkpoint; every other parent is
   * an annotated commit the chain anchors.
   */
  private async retentionCheckpointParents(commit: ObjectId): Promise<{
    readonly chain: ObjectId | null;
    readonly retained: readonly ObjectId[];
  } | null> {
    const result = await this.run(["show", "-s", "--format=%T%n%s%n%P", commit]);
    const [tree, subject, parentLine] = result.stdout.split("\n");
    if (tree !== (await this.emptyTree()) || subject !== RETENTION_MESSAGE.trimEnd()) return null;
    const parents = (parentLine ?? "").split(" ").filter((parent) => parent.length > 0);
    const first = parents[0];
    if (first === undefined) return { chain: null, retained: [] };
    if (await this.isRetentionCheckpoint(first)) {
      return { chain: objectId(first), retained: parents.slice(1).map((parent) => objectId(parent)) };
    }
    return { chain: null, retained: parents.map((parent) => objectId(parent)) };
  }

  private async isRetentionCheckpoint(commit: string): Promise<boolean> {
    if (!isObjectId(commit)) return false;
    const result = await this.run(["show", "-s", "--format=%T%n%s", commit], { allowExitCodes: [0, 1, 128] });
    if (result.exitCode !== 0) return false;
    const [tree, subject] = result.stdout.split("\n");
    return tree === (await this.emptyTree()) && subject === RETENTION_MESSAGE.trimEnd();
  }

  async listRetentionObjects(ref = RETENTION_OBJECTS_REF): Promise<readonly ObjectId[]> {
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
    return (await this.retentionCommits()).subjects;
  }

  async updateRetentionRefs(updates: {
    readonly objects: { readonly next: ObjectId; readonly expected?: ObjectId | null };
    readonly commits?: { readonly next: ObjectId | null; readonly expected?: ObjectId | null };
  }): Promise<void> {
    const transactions: { ref: string; next: ObjectId | null; expected: ObjectId | null }[] = [{
      ref: RETENTION_OBJECTS_REF,
      next: updates.objects.next,
      expected: updates.objects.expected ?? null,
    }];
    if (updates.commits !== undefined) {
      transactions.push({
        ref: RETENTION_COMMITS_REF,
        next: updates.commits.next,
        expected: updates.commits.expected ?? null,
      });
    }
    await this.moveRefs(transactions);
  }

  async deleteRetentionRefs(expected: {
    readonly objects: ObjectId | null;
    readonly commits: ObjectId | null;
  }): Promise<void> {
    await this.moveRefs([
      { ref: RETENTION_OBJECTS_REF, next: null, expected: expected.objects },
      { ref: RETENTION_COMMITS_REF, next: null, expected: expected.commits },
    ]);
  }

  private async moveRefs(updates: readonly {
    readonly ref: string;
    readonly next: ObjectId | null;
    readonly expected: ObjectId | null;
  }[]): Promise<void> {
    try {
      await this.updateRefsAtomically(updates);
    } catch (error: unknown) {
      throw new Error("The Reveries retention refs changed concurrently", { cause: error });
    }
  }

  private async emptyTree(): Promise<string> {
    return (await this.run(["mktree"], { input: "" })).stdout.trim();
  }

  /** The bundle refs that exist here; a bundle cannot name a ref it cannot resolve. */
  async existingRetentionBundleRefs(): Promise<readonly string[]> {
    const present: string[] = [];
    for (const ref of RETENTION_BUNDLE_REFS) {
      const result = await this.run(["rev-parse", "--verify", "--quiet", ref], { allowExitCodes: [0, 1, 128] });
      if (result.exitCode === 0) present.push(ref);
    }
    return present;
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

  async mergeFetchedNotes(
    remote: string,
    validate: NotesRefValidator = async () => undefined,
    onValidationFailure?: NotesValidationFailure,
  ): Promise<void> {
    await this.withNotesWrite(async (notes) => {
      await this.run([
        "notes",
        `--ref=${notes.ref}`,
        "merge",
        "-s",
        "cat_sort_uniq",
        `refs/notes/remotes/${remote}/reveries`,
      ]);
    }, validate, onValidationFailure);
  }

  async quarantineNotes(remote: string, candidate: ObjectId): Promise<string> {
    const ref = `refs/reveries/quarantine/${remote}/${candidate}`;
    await this.run(["update-ref", ref, candidate]);
    return ref;
  }

  async pushAtomically(remote: string): Promise<void> {
    const probe = [
      "push",
      "--atomic",
      "--dry-run",
      "--no-verify",
      remote,
      "HEAD",
      `${NOTES_REF}:${NOTES_REF}`,
    ];
    const result = await this.run(probe, { allowExitCodes: [0, 1, 128] });
    if (result.exitCode !== 0) {
      if (/atomic(?: pushes?)?[^\n]*(?:not supported|unsupported)|does not support[^\n]*atomic/i.test(result.stderr)) {
        throw new AtomicPushUnavailableError(remote);
      }
      throw new GitCommandError(probe, result);
    }
    await this.run(
      ["push", "--atomic", remote, "HEAD", `${NOTES_REF}:${NOTES_REF}`],
      { environment: { [INTERNAL_ATOMIC_PUSH_ENV]: "1" } },
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
