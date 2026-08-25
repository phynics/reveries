import {
  analyzeContinuity,
  blobId,
  canonicalRecord,
  commitId,
  createReverie,
  NOTES_REF,
  objectId,
  parseNote,
  projectActiveReveries,
  semanticPayload,
  validateNote,
  type ActiveProjection,
  type BlobId,
  type CommitId,
  type NoteRecord,
  type ObjectId,
  type ReverieId,
  type ReverieInput,
  type ReverieMetadata,
  type ReverieRecord,
  type ReveriesInit,
  type SessionSummary,
  type Source,
} from "./protocol.ts";
import { GitRepository, type NoteListEntry, type NotesTransaction } from "./git.ts";

export interface RecordTarget {
  readonly path: string;
  readonly revision: "HEAD" | "index" | string;
}

export interface RecordNewInput extends RecordTarget {
  readonly semantic: ReverieInput;
  readonly metadata: ReverieMetadata;
}

export interface RecordResult {
  readonly object: BlobId;
  readonly record: ReverieRecord;
  readonly paths: readonly string[];
}

export interface ShowInput {
  readonly target: string;
  readonly revision?: "HEAD" | "index" | string;
}

export interface ShowResult {
  readonly object: ObjectId;
  readonly objectType: string;
  readonly records: readonly NoteRecord[];
  readonly active: readonly ReverieRecord[];
  readonly historical: readonly ReverieRecord[];
  readonly diagnostics: readonly string[];
  readonly paths: readonly string[];
}

export interface CheckResult {
  readonly ok: boolean;
  readonly diagnostics: readonly string[];
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
}

export interface SearchHit {
  readonly object: ObjectId;
  readonly record: NoteRecord;
  readonly paths: readonly string[];
}

export interface HistoryEntry {
  readonly commit: CommitId;
  readonly blob: BlobId;
  readonly records: readonly NoteRecord[];
}

interface DiffTransition {
  readonly from: BlobId;
  readonly to?: BlobId;
  readonly oldPath?: string;
  readonly newPath?: string;
}

function isFullObjectId(value: string): boolean {
  return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value);
}

function zeroObject(value: string): boolean {
  return /^0+$/.test(value);
}

function allSources(record: NoteRecord): readonly Source[] {
  if (record.type === "reverie") {
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

export class Reveries {
  private constructor(readonly repository: GitRepository) {}

  static async open(cwd: string): Promise<Reveries> {
    return new Reveries(await GitRepository.open(cwd));
  }

  async recordNew(input: RecordNewInput): Promise<RecordResult> {
    const object = await this.repository.resolvePath(input);
    const semantic = `${semanticPayload(input.semantic)}\n`;
    const oid = await this.repository.hashObject(semantic);
    const record = createReverie(input.semantic, input.metadata, () => oid);
    await this.appendRecord(object, record);
    return {
      object,
      record,
      paths: input.revision === "index"
        ? await this.repository.indexPathsForBlob(object)
        : await this.repository.pathsForBlob(object, input.revision),
    };
  }

  async recordContinue(input: {
    readonly fromBlob: BlobId;
    readonly toPath: string;
    readonly toRevision: "HEAD" | "index" | string;
    readonly id: ReverieId;
  }): Promise<RecordResult> {
    const object = await this.repository.resolvePath({ path: input.toPath, revision: input.toRevision });
    return this.recordContinueToBlob({ fromBlob: input.fromBlob, toBlob: object, id: input.id, path: input.toPath });
  }

  async recordContinueToBlob(input: {
    readonly fromBlob: BlobId;
    readonly toBlob: BlobId;
    readonly id: ReverieId;
    readonly path?: string;
  }): Promise<RecordResult> {
    const fromBlob = input.fromBlob;
    const predecessor = await this.strictRead(fromBlob);
    const record = predecessor.records.find(
      (candidate): candidate is ReverieRecord => candidate.type === "reverie" && candidate.id === input.id,
    );
    if (record === undefined) {
      throw new Error(`Reverie ${input.id} is not attached to predecessor blob ${fromBlob}`);
    }
    const object = input.toBlob;
    const type = (await this.repository.run(["cat-file", "-t", object])).stdout.trim();
    if (type !== "blob") throw new Error(`${object} is not a blob`);
    if (!(await this.repository.blobIsDurable(object))) {
      throw new Error(`Successor blob ${object} is neither staged nor reachable from a commit`);
    }
    await this.appendRecord(object, record);
    return {
      object,
      record,
      paths: input.path === undefined ? await this.repository.pathsForBlob(object) : [input.path],
    };
  }

  async recordSupersede(input: RecordNewInput & { readonly old: ReverieId }): Promise<RecordResult> {
    const semantic: ReverieInput = {
      ...input.semantic,
      supersedes: [...new Set([...input.semantic.supersedes, input.old])],
    };
    return this.recordNew({ ...input, semantic });
  }

  async show(input: ShowInput): Promise<ShowResult> {
    const target = await this.resolveTarget(input.target, input.revision ?? "HEAD");
    const note = await this.repository.readNote(target.object);
    if (note === null) {
      return { ...target, records: [], active: [], historical: [], diagnostics: [], paths: target.paths };
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
    };
  }

  async summarize(input: {
    readonly commit: string;
    readonly summary: SessionSummary;
    readonly replace?: boolean;
  }): Promise<void> {
    const commit = await this.repository.resolveCommit(input.commit);
    validateNote([input.summary], { verifyIds: false });
    await this.repository.withNotesWrite(async (notes) => {
      if (input.replace !== true) {
        await notes.append(commit, canonicalRecord(input.summary));
        return;
      }
      const existing = await notes.read(commit);
      const records = existing === null ? [] : parseNote(existing, "strict", { verifyIds: false }).records;
      const retained = records.filter((record) => record.type !== "session-summary");
      await notes.replace(commit, [input.summary, ...retained].map(canonicalRecord).join(""));
    }, (ref) => this.validateNotesRef(ref));
  }

  async attachInitialization(input: { readonly commit: string; readonly record: ReveriesInit }): Promise<void> {
    const commit = await this.repository.resolveCommit(input.commit);
    await this.repository.withNotesWrite(async (notes) => {
      await notes.append(commit, canonicalRecord(input.record));
    }, (ref) => this.validateNotesRef(ref));
  }

  async checkStaged(explicitSuccessors: ReadonlyMap<string, string> = new Map()): Promise<CheckResult> {
    const transitions = [...await this.stagedTransitions()];
    for (const [oldPath, newPath] of explicitSuccessors) {
      const from = await this.repository.resolvePath({ path: oldPath, revision: "HEAD" });
      const to = await this.repository.resolvePath({ path: newPath, revision: "index" });
      const existing = transitions.findIndex((transition) => transition.oldPath === oldPath);
      const mapped: DiffTransition = { from, to, oldPath, newPath };
      if (existing < 0) transitions.push(mapped);
      else transitions.splice(existing, 1, mapped);
    }
    return this.checkTransitions(transitions, emptySummary());
  }

  async checkCommit(revision: string): Promise<CheckResult> {
    const diagnostics: string[] = [];
    const commit = await this.repository.resolveCommit(revision);
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
    let summary: SessionSummary | null = null;
    try {
      const note = await this.strictRead(commit);
      summary = note.records.find((record): record is SessionSummary => record.type === "session-summary") ?? null;
    } catch (error: unknown) {
      diagnostics.push(error instanceof Error ? error.message : String(error));
    }
    if (summary === null) {
      diagnostics.push(`Commit ${commit} requires exactly one valid session summary`);
      return { ok: false, diagnostics };
    }
    const parentsResult = await this.repository.run(["show", "-s", "--format=%P", commit]);
    const parents = parentsResult.stdout.trim().split(" ").filter((parent) => parent.length > 0);
    for (const parent of parents) {
      const transitions = await this.commitTransitions(parent, commit);
      const result = await this.checkTransitions(transitions, summary);
      diagnostics.push(...result.diagnostics.map((diagnostic) => `${parent}: ${diagnostic}`));
    }
    return { ok: diagnostics.length === 0, diagnostics };
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
    const initialization = await this.findInitialization();
    if (initialization === null) {
      return { ok: false, diagnostics: ["Reveries initialization boundary is missing"] };
    }
    const diagnostics: string[] = [];
    const notesUpdate = updates.find((update) => update.remoteRef === NOTES_REF);
    const branchUpdates = updates.filter((update) => update.localRef.startsWith("refs/heads/") && update.localObject !== null);
    if (branchUpdates.length > 0 && notesUpdate === undefined) {
      diagnostics.push("The push publishes a branch without refs/notes/reveries");
    }
    if (notesUpdate !== undefined) {
      const localNotes = await this.repository.notesTip();
      if (notesUpdate.localObject !== localNotes) {
        diagnostics.push("The pushed notes object is not the current local Reveries notes tip");
      }
      diagnostics.push(...(await this.checkRemoteNotesIncorporated(remote, notesUpdate.remoteObject)).diagnostics);
    }
    for (const update of branchUpdates) {
      diagnostics.push(...await this.checkOutgoingRange(
        initialization.commit,
        commitId(update.localObject!),
        update.remoteObject,
        update.remoteRef,
      ));
    }
    try {
      await this.validateNotesRef(NOTES_REF);
    } catch (error: unknown) {
      diagnostics.push(error instanceof Error ? error.message : String(error));
    }
    return { ok: diagnostics.length === 0, diagnostics };
  }

  async search(input: SearchInput): Promise<readonly SearchHit[]> {
    const revision = input.revision ?? "HEAD";
    const candidates = input.all === true
      ? await this.repository.listNotes()
      : await this.currentNoteTargets(revision);
    const hits: SearchHit[] = [];
    for (const candidate of candidates) {
      const note = await this.repository.readNote(candidate.object);
      if (note === null) continue;
      const parsed = parseNote(note, "tolerant", { verifyIds: false });
      for (const record of parsed.records) {
        if (input.query !== undefined && !searchText(record).includes(input.query.toLocaleLowerCase())) continue;
        if (input.source !== undefined && !allSources(record).some((source) => source.ref === input.source)) continue;
        if (input.author !== undefined && recordAuthor(record) !== input.author) continue;
        hits.push({
          object: candidate.object,
          record,
          paths: await this.pathsForObject(candidate.object, revision),
        });
      }
    }
    return hits;
  }

  async history(path: string): Promise<readonly HistoryEntry[]> {
    const log = await this.repository.run(["log", "--format=%H", "--", path]);
    const history: HistoryEntry[] = [];
    const seen = new Set<string>();
    for (const value of log.stdout.trim().split("\n").filter((line) => line.length > 0)) {
      const commit = commitId(value);
      try {
        const blob = await this.repository.resolvePath({ path, revision: commit });
        const key = `${commit}:${blob}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const note = await this.repository.readNote(blob);
        history.push({
          commit,
          blob,
          records: note === null ? [] : parseNote(note, "tolerant", { verifyIds: false }).records,
        });
      } catch {
        continue;
      }
    }
    return history;
  }

  async syncPull(remote: string): Promise<CheckResult> {
    await this.repository.fetchNotes(remote);
    await this.repository.mergeFetchedNotes(remote);
    try {
      await this.validateNotesRef("refs/notes/reveries");
      return { ok: true, diagnostics: [] };
    } catch (error: unknown) {
      return { ok: false, diagnostics: [error instanceof Error ? error.message : String(error)] };
    }
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
    const check = await this.checkOutgoingUpdates(remote, [{
      localRef: branchRef,
      localObject: await this.repository.resolveCommit("HEAD"),
      remoteRef: branchRef,
      remoteObject: await this.repository.remoteObject(remote, branchRef),
    }, {
      localRef: NOTES_REF,
      localObject: await this.repository.notesTip(),
      remoteRef: NOTES_REF,
      remoteObject: await this.repository.remoteObject(remote, NOTES_REF),
    }]);
    if (!check.ok) return check;
    await this.repository.pushAtomically(remote);
    return check;
  }

  async doctor(): Promise<CheckResult> {
    const diagnostics: string[] = [];
    let agents = "";
    try {
      agents = await readFile(join(this.repository.root, "AGENTS.md"), "utf8");
    } catch {
      diagnostics.push("AGENTS.md is unavailable");
    }
    if (!agents.includes("<!-- reveries:begin -->")) diagnostics.push("AGENTS.md Reveries marker is missing");
    const strategy = await this.repository.run(
      ["config", "--get", "notes.reveries.mergeStrategy"],
      { allowExitCodes: [0, 1] },
    );
    if (strategy.stdout.trim() !== "cat_sort_uniq") diagnostics.push("notes.reveries.mergeStrategy is not cat_sort_uniq");
    const initialization = await this.findInitialization();
    if (initialization === null) diagnostics.push("Reveries initialization boundary is missing");
    else {
      for (const remote of initialization.record.publishing_remotes) {
        const fetch = await this.repository.run(
          ["config", "--get-all", `remote.${remote}.fetch`],
          { allowExitCodes: [0, 1] },
        );
        const push = await this.repository.run(
          ["config", "--get-all", `remote.${remote}.push`],
          { allowExitCodes: [0, 1] },
        );
        if (!fetch.stdout.includes(`refs/notes/remotes/${remote}/reveries`)) {
          diagnostics.push(`Publishing remote ${remote} lacks the Reveries fetch refspec`);
        }
        if (!push.stdout.includes("refs/notes/reveries:refs/notes/reveries")) {
          diagnostics.push(`Publishing remote ${remote} lacks the Reveries push refspec`);
        }
        const remoteTip = await this.repository.notesTip(`refs/notes/remotes/${remote}/reveries`);
        const localTip = await this.repository.notesTip();
        if (remoteTip !== null && localTip !== null) {
          const incorporated = await this.repository.run(
            ["merge-base", "--is-ancestor", remoteTip, localTip],
            { allowExitCodes: [0, 1] },
          );
          if (incorporated.exitCode !== 0) diagnostics.push(`Remote ${remote} notes have not been incorporated`);
        }
      }
    }
    const commonDirectory = await this.repository.commonDirectory();
    for (const name of ["pre-push", "post-commit"]) {
      try {
        const hook = await readFile(join(commonDirectory, "hooks", name), "utf8");
        if (!hook.includes("reveries:begin")) diagnostics.push(`${name} enforcement is partial`);
      } catch {
        diagnostics.push(`${name} hook is missing`);
      }
    }
    try {
      await access(join(commonDirectory, "NOTES_MERGE_PARTIAL"));
      diagnostics.push("An unresolved Git notes merge is in progress");
    } catch {
      // No unresolved notes merge marker exists.
    }
    try {
      await this.validateNotesRef("refs/notes/reveries");
    } catch (error: unknown) {
      diagnostics.push(error instanceof Error ? error.message : String(error));
    }
    return { ok: diagnostics.length === 0, diagnostics };
  }

  private async appendRecord(object: ObjectId, record: ReverieRecord): Promise<void> {
    await this.repository.withNotesWrite(async (notes) => {
      await notes.append(object, canonicalRecord(record));
    }, (ref) => this.validateNotesRef(ref));
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
  }> {
    const object = isFullObjectId(target)
      ? objectId(target)
      : await this.repository.resolvePath({ path: target, revision });
    const objectType = (await this.repository.run(["cat-file", "-t", object])).stdout.trim();
    const paths = objectType !== "blob"
      ? []
      : revision === "index"
        ? await this.repository.indexPathsForBlob(blobId(object))
        : await this.repository.pathsForBlob(blobId(object), revision);
    return { object, objectType, paths };
  }

  private async pathsForObject(object: ObjectId, revision: string): Promise<readonly string[]> {
    const type = (await this.repository.run(["cat-file", "-t", object])).stdout.trim();
    return type === "blob" ? this.repository.pathsForBlob(blobId(object), revision) : [];
  }

  private async strictRead(object: ObjectId, ref = "refs/notes/reveries"): Promise<{
    readonly records: readonly NoteRecord[];
    readonly projection: ActiveProjection;
  }> {
    const note = await this.repository.readNoteFromRef(ref, object);
    if (note === null) {
      return { records: [], projection: projectActiveReveries([]) };
    }
    const parsed = parseNote(note, "strict", { verifyIds: false });
    const records = validateNote(parsed, { verifyIds: false });
    for (const record of records) {
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

  private async validateNotesRef(ref: string): Promise<void> {
    const entries = await this.repository.listNotes(ref);
    for (const entry of entries) {
      const strict = await this.strictRead(entry.object, ref);
      const objectType = (await this.repository.run(["cat-file", "-t", entry.object])).stdout.trim();
      if (objectType === "blob" && strict.records.some((record) => record.type !== "reverie")) {
        throw new Error(`Blob ${entry.object} has a non-reverie protocol record`);
      }
      if (objectType === "commit" && strict.records.some((record) => record.type === "reverie")) {
        throw new Error(`Commit ${entry.object} has a file reverie record`);
      }
    }
  }

  private async validateSources(records: readonly NoteRecord[], ref: string): Promise<void> {
    for (const record of records) {
      for (const source of allSources(record)) {
        if (source.kind === "commit" || source.kind === "blob") {
          const object = objectId(source.ref);
          if (!(await this.repository.objectExists(source.kind, object))) {
            throw new Error(`Broken local ${source.kind} source: ${source.ref}`);
          }
        } else if (source.kind === "path") {
          if (source.at === undefined) throw new Error("A path source requires an at commit");
          await this.repository.resolvePath({ path: source.ref, revision: source.at });
        } else if (source.kind === "note") {
          const found = await this.findReverie(source.ref, ref);
          if (!found) throw new Error(`Referenced reverie does not exist: ${source.ref}`);
        } else if (source.kind === "git-email") {
          if (!/^[^\s@]+@[^\s@]+$/.test(source.ref)) throw new Error(`Invalid Git email source: ${source.ref}`);
        } else if (!/^(?:github|gitlab|linear|jira|generic):\S+$/.test(source.ref)) {
          throw new Error(`Invalid issue source: ${source.ref}`);
        }
      }
    }
  }

  private async findReverie(id: string, ref: string): Promise<boolean> {
    for (const entry of await this.repository.listNotes(ref)) {
      const note = await this.repository.readNoteFromRef(ref, entry.object);
      if (note === null) continue;
      const parsed = parseNote(note, "tolerant", { verifyIds: false });
      if (parsed.records.some((record) => record.type === "reverie" && record.id === id)) return true;
    }
    return false;
  }

  private async findInitialization(): Promise<{ readonly commit: CommitId; readonly record: ReveriesInit } | null> {
    let found: { readonly commit: CommitId; readonly record: ReveriesInit } | null = null;
    for (const entry of await this.repository.listNotes()) {
      const note = await this.repository.readNote(entry.object);
      if (note === null) continue;
      const parsed = parseNote(note, "tolerant", { verifyIds: false });
      for (const record of parsed.records) {
        if (record.type !== "reveries-init") continue;
        if (found !== null) throw new Error("More than one Reveries initialization boundary exists");
        if (!(await this.repository.objectExists("commit", entry.object))) {
          throw new Error("The Reveries initialization record is not attached to a commit");
        }
        found = { commit: commitId(entry.object), record };
      }
    }
    return found;
  }

  private async currentNoteTargets(revision: string): Promise<readonly NoteListEntry[]> {
    const tree = await this.repository.listTree(revision);
    const notes = new Map<string, NoteListEntry>();
    const available = new Map((await this.repository.listNotes()).map((entry) => [entry.object, entry]));
    for (const entry of tree) {
      const note = available.get(entry.object);
      if (note !== undefined) notes.set(note.object, note);
    }
    const commit = await this.repository.resolveCommit(revision);
    const commitNote = available.get(commit);
    if (commitNote !== undefined) notes.set(commitNote.object, commitNote);
    return [...notes.values()];
  }

  private async stagedTransitions(): Promise<readonly DiffTransition[]> {
    const result = await this.repository.run([
      "diff", "--cached", "--raw", "-z", "--abbrev=64", "-M", "HEAD",
    ]);
    const successorBlobs = new Set((await this.repository.listIndex()).map((entry) => entry.object));
    return this.parseTransitions(result.stdout).filter(
      (transition) => transition.to !== undefined || !successorBlobs.has(transition.from),
    );
  }

  private async commitTransitions(parent: string, commit: string): Promise<readonly DiffTransition[]> {
    const result = await this.repository.run([
      "diff-tree", "--raw", "-z", "--abbrev=64", "-r", "-M", "--no-commit-id", parent, commit,
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

  private async projectionFor(blob: BlobId): Promise<ActiveProjection> {
    return (await this.strictRead(blob)).projection;
  }

  private async checkTransitions(
    transitions: readonly DiffTransition[],
    summary: SessionSummary,
  ): Promise<CheckResult> {
    const predecessors = new Map<BlobId, ActiveProjection>();
    const successors = new Map<BlobId, ActiveProjection>();
    for (const transition of transitions) {
      if (await this.repository.readNote(transition.from) !== null) {
        predecessors.set(transition.from, await this.projectionFor(transition.from));
      }
      if (transition.to !== undefined) {
        successors.set(transition.to, await this.projectionFor(transition.to));
      }
    }
    const report = analyzeContinuity({ transitions, predecessors, successors, summary });
    const diagnostics = [
      ...report.conflicts,
      ...report.obligations.map(
        (obligation) => `${obligation.id} from ${obligation.from_blob}: ${obligation.reason}`,
      ),
    ];
    return { ok: report.ok, diagnostics };
  }
}
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
