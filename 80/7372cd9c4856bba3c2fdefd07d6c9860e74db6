import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { blobId, commitId, type BlobId, type CommitId, type ObjectId } from "./protocol.ts";

export const NOTES_REF = "refs/notes/reveries";

export interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

interface RunOptions {
  readonly input?: string;
  readonly allowExitCodes?: readonly number[];
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

export class NotesLockError extends Error {
  constructor(readonly lockPath: string) {
    super(`Reveries notes are locked at ${lockPath}`);
    this.name = "NotesLockError";
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

type RefValidator = (temporaryRef: string) => Promise<void>;

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
  ) {}

  static async open(cwd: string): Promise<GitRepository> {
    const rootResult = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
    const root = rootResult.stdout.trim();
    const commonResult = await runGit(root, ["rev-parse", "--git-common-dir"]);
    const commonOutput = commonResult.stdout.trim();
    const commonDir = isAbsolute(commonOutput) ? commonOutput : resolve(root, commonOutput);
    return new GitRepository(root, commonDir);
  }

  async run(args: readonly string[], options: RunOptions = {}): Promise<GitResult> {
    return runGit(this.root, args, options);
  }

  async commonDirectory(): Promise<string> {
    return this.commonDir;
  }

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

  async withNotesWrite<T>(
    operation: (notes: NotesTransaction) => Promise<T>,
    validate: RefValidator = async () => undefined,
  ): Promise<T> {
    const lockPath = this.writeLockPath();
    await mkdir(dirname(lockPath), { recursive: true });
    try {
      await mkdir(lockPath);
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        throw new NotesLockError(lockPath);
      }
      throw error;
    }
    await writeFile(
      join(lockPath, "owner.json"),
      `${JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })}\n`,
      { encoding: "utf8", flag: "wx" },
    );

    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const expectedTip = await this.notesTip();
        const temporaryRef = `refs/notes/reveries-txn/${process.pid}-${randomUUID()}`;
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
          if (attempt === 1) {
            throw new Error("The Reveries notes ref changed concurrently during two write attempts");
          }
        } finally {
          await this.run(["update-ref", "-d", temporaryRef], { allowExitCodes: [0, 1, 128] });
        }
      }
      throw new Error("Unreachable notes transaction state");
    } finally {
      await rm(lockPath, { recursive: true, force: true });
    }
  }

  async fetchNotes(remote: string): Promise<void> {
    await this.run([
      "fetch",
      remote,
      `+${NOTES_REF}:refs/notes/remotes/${remote}/reveries`,
    ]);
  }

  async mergeFetchedNotes(remote: string): Promise<void> {
    await this.withNotesWrite(async (notes) => {
      await this.run([
        "notes",
        `--ref=${notes.ref}`,
        "merge",
        "-s",
        "cat_sort_uniq",
        `refs/notes/remotes/${remote}/reveries`,
      ]);
    });
  }

  async pushAtomically(remote: string): Promise<void> {
    await this.run(["push", "--atomic", remote, "HEAD", `${NOTES_REF}:${NOTES_REF}`]);
  }
}

async function runGit(cwd: string, args: readonly string[], options: RunOptions = {}): Promise<GitResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: process.env,
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
