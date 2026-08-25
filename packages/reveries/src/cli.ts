#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  commitAdoption,
  initializeRepository,
  removeIntegration,
  type HelperInvocation,
  type SkillSetup,
  type SupportedHost,
} from "./install.ts";
import { adaptHostEvent, handleHookEvent } from "./hooks.ts";
import { Reveries, type PushUpdate } from "./operations.ts";
import {
  blobId,
  commitId,
  canonicalRecord,
  objectId,
  parseNote,
  reverieId,
  validateNote,
  type NoteRecord,
  type ReverieInput,
  type ReverieMetadata,
  type ReveriesInit,
  type SessionSummary,
  type Source,
  type SourceKind,
  type SourceRelation,
} from "./protocol.ts";

export type ExitCode = 0 | 1 | 2 | 3;

export interface CliIo {
  readonly cwd: string;
  readonly stdin: () => Promise<string>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly helper?: HelperInvocation;
}

interface ParsedArguments {
  readonly positionals: readonly string[];
  readonly values: ReadonlyMap<string, readonly string[]>;
  readonly flags: ReadonlySet<string>;
}

class UsageError extends Error {
  constructor(message: string) {
    super(`Usage error: ${message}`);
    this.name = "UsageError";
  }
}

const RELATIONS = new Set<SourceRelation>([
  "caused-by", "constrained-by", "requested-by", "derived-from", "implements", "corroborated-by",
]);
const KINDS = new Set<SourceKind>(["commit", "blob", "path", "note", "git-email", "issue"]);
const HOSTS = new Set<SupportedHost>(["pi", "claude", "opencode", "codex", "gemini"]);
const VERSION = "1.0.2";
const HELP = `reveries <command>

Commands:
  init       Prepare project instructions, Git configuration, and hooks
  adopt      Verify the prepared files and create the adoption commit
  doctor     Diagnose the local installation and notes state
  show       Show notes for a path, blob, or commit
  record     Create, continue, or supersede a blob reverie
  summarize  Attach or replace a commit summary or initialization record
  check      Check staged, committed, or outgoing continuity and coverage
  search     Search current or historical engineering evidence
  history    Trace a path or reverie through history
  sync       Inspect or pull a publishing remote's notes
  push       Atomically push HEAD and refs/notes/reveries
  hook       Handle one host-neutral adapter event from standard input
  remove     Remove owned integration without deleting evidence

Init requires an explicit choice for hosts, publishing, directive email, and
--skill-setup reminder|pull|vendored|symlink. Pull requires --skill-repository.
Vendored and symlink setups require --skill-source.

Use --json on inspection and check commands for stable machine output.
`;

function defaultIo(): CliIo {
  const script = process.argv[1];
  return {
    cwd: process.cwd(),
    stdin: async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return Buffer.concat(chunks).toString("utf8");
    },
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    ...(script === undefined ? {} : {
      helper: { command: process.execPath, args: [resolve(script)], verification: "self" as const },
    }),
  };
}

function parseArguments(
  args: readonly string[],
  valueNames: readonly string[],
  flagNames: readonly string[],
): ParsedArguments {
  const acceptedValues = new Set(valueNames);
  const acceptedFlags = new Set(flagNames);
  const positionals: string[] = [];
  const values = new Map<string, string[]>();
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === undefined) continue;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    if (acceptedFlags.has(token)) {
      flags.add(token);
      continue;
    }
    if (!acceptedValues.has(token)) throw new UsageError(`unknown option ${token}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`${token} requires a value`);
    const existing = values.get(token) ?? [];
    existing.push(value);
    values.set(token, existing);
    index += 1;
  }
  return { positionals, values, flags };
}

function parsePushUpdates(input: string): PushUpdate[] {
  return input.split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const fields = line.split(" ");
      if (fields.length !== 4 || fields.some((field) => field.length === 0 || field.includes("\0"))) {
        throw new UsageError("pre-push received a malformed ref update");
      }
      const [localRef, localValue, remoteRef, remoteValue] = fields;
      if (localRef === undefined || localValue === undefined || remoteRef === undefined || remoteValue === undefined) {
        throw new UsageError("pre-push received a malformed ref update");
      }
      return {
        localRef,
        localObject: /^0+$/.test(localValue) ? null : objectId(localValue),
        remoteRef,
        remoteObject: /^0+$/.test(remoteValue) ? null : objectId(remoteValue),
      };
    });
}

function one(parsed: ParsedArguments, name: string, required = false): string | undefined {
  const values = parsed.values.get(name) ?? [];
  if (values.length > 1) throw new UsageError(`${name} may appear only once`);
  const value = values[0];
  if (required && value === undefined) throw new UsageError(`${name} is required`);
  return value;
}

function requirePositional(parsed: ParsedArguments, index: number, label: string): string {
  const value = parsed.positionals[index];
  if (value === undefined) throw new UsageError(`${label} is required`);
  return value;
}

function expectObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new UsageError(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new UsageError(`${label} must be a string`);
  return value;
}

function expectStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new UsageError(`${label} must be an array of strings`);
  }
  return value;
}

function parseSource(value: unknown): Source {
  const source = expectObject(value, "source");
  const relation = expectString(source.relation, "source.relation");
  const kind = expectString(source.kind, "source.kind");
  if (!RELATIONS.has(relation as SourceRelation)) throw new UsageError(`unknown source relation ${relation}`);
  if (!KINDS.has(kind as SourceKind)) throw new UsageError(`unknown source kind ${kind}`);
  return {
    relation: relation as SourceRelation,
    kind: kind as SourceKind,
    ref: expectString(source.ref, "source.ref"),
    ...(source.at === undefined ? {} : { at: commitId(expectString(source.at, "source.at")) }),
  };
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error: unknown) {
    throw new UsageError(`cannot read JSON from ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function parseReverieDraft(path: string): Promise<{
  readonly semantic: ReverieInput;
  readonly metadata: ReverieMetadata;
}> {
  const value = expectObject(await readJson(path), "reverie draft");
  const sources = value.sources;
  if (!Array.isArray(sources)) throw new UsageError("sources must be an array");
  const session = value.session;
  if (session !== null && typeof session !== "string") throw new UsageError("session must be a string or null");
  return {
    semantic: {
      v: value.v === 1 ? 1 : (() => { throw new UsageError("v must be 1"); })(),
      driving_event: expectString(value.driving_event, "driving_event"),
      decision: expectString(value.decision, "decision"),
      impact: expectString(value.impact, "impact"),
      recurrence_control: value.recurrence_control === null
        ? null
        : expectString(value.recurrence_control, "recurrence_control"),
      alternatives: expectStringArray(value.alternatives, "alternatives"),
      sources: sources.map(parseSource),
      supersedes: expectStringArray(value.supersedes, "supersedes").map(reverieId),
    },
    metadata: {
      author_email: expectString(value.author_email, "author_email"),
      session,
      created_at: expectString(value.created_at, "created_at"),
    },
  };
}

async function parseProtocolRecord(path: string, type: "session-summary"): Promise<SessionSummary>;
async function parseProtocolRecord(path: string, type: "reveries-init"): Promise<ReveriesInit>;
async function parseProtocolRecord(path: string, type: "session-summary" | "reveries-init"): Promise<SessionSummary | ReveriesInit> {
  const value = await readJson(path);
  return type === "session-summary"
    ? parseProtocolRecordValue(value, "session-summary", path)
    : parseProtocolRecordValue(value, "reveries-init", path);
}

function parseProtocolRecordValue(value: unknown, type: "session-summary", label: string): SessionSummary;
function parseProtocolRecordValue(value: unknown, type: "reveries-init", label: string): ReveriesInit;
function parseProtocolRecordValue(
  raw: unknown,
  type: "session-summary" | "reveries-init",
  label: string,
): SessionSummary | ReveriesInit {
  const value = expectObject(raw, type);
  if (value.type !== type) throw new UsageError(`${label} must contain a ${type} record`);
  const candidate = value as NoteRecord;
  if (type === "session-summary") validateNote([candidate], { verifyIds: false });
  else {
    const parsed = parseNote(canonicalRecord(candidate), "tolerant", { verifyIds: false });
    if (parsed.diagnostics.length > 0) throw new UsageError(parsed.diagnostics.map((item) => item.message).join("; "));
  }
  return candidate as SessionSummary | ReveriesInit;
}

function emit(
  io: CliIo,
  json: boolean,
  command: string,
  result: unknown,
  diagnostics: readonly string[] = [],
): void {
  if (json) {
    io.stdout(`${JSON.stringify({ ok: diagnostics.length === 0, command, result, diagnostics })}\n`);
    return;
  }
  if (result !== undefined) io.stdout(`${typeof result === "string" ? result : JSON.stringify(result, null, 2)}\n`);
  for (const diagnostic of diagnostics) io.stderr(`${diagnostic}\n`);
}

function splitList(values: readonly string[]): string[] {
  return [...new Set(values.flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean))];
}

function parseSkillSetup(parsed: ParsedArguments): SkillSetup {
  const kind = one(parsed, "--skill-setup", true);
  const repository = one(parsed, "--skill-repository");
  const sourceRoot = one(parsed, "--skill-source");
  if (kind === "reminder") {
    if (repository !== undefined || sourceRoot !== undefined) {
      throw new UsageError("--skill-repository and --skill-source do not apply to reminder setup");
    }
    return { kind };
  }
  if (kind === "pull") {
    if (repository === undefined) throw new UsageError("--skill-setup pull requires --skill-repository");
    if (sourceRoot !== undefined) throw new UsageError("--skill-source does not apply to pull setup");
    return { kind, repository };
  }
  if (kind === "vendored" || kind === "symlink") {
    if (sourceRoot === undefined) throw new UsageError(`--skill-setup ${kind} requires --skill-source`);
    if (repository !== undefined) throw new UsageError("--skill-repository applies only to pull setup");
    return { kind, sourceRoot };
  }
  throw new UsageError("--skill-setup must be reminder, pull, vendored, or symlink");
}

function explicitList(
  parsed: ParsedArguments,
  value: "--hosts" | "--remote",
  emptyFlag: "--no-hosts" | "--no-publish",
): string[] {
  const hasValues = parsed.values.has(value);
  const hasEmpty = parsed.flags.has(emptyFlag);
  if (hasValues === hasEmpty) throw new UsageError(`choose exactly one of ${value} or ${emptyFlag}`);
  return hasEmpty ? [] : splitList(parsed.values.get(value) ?? []);
}

export async function runCli(argv: readonly string[], io: CliIo = defaultIo()): Promise<ExitCode> {
  const json = argv.includes("--json");
  const command = argv[0];
  try {
    if (command === undefined) throw new UsageError("a command is required");
    const reveries = command === "init" || command === "adopt" || command === "remove" || command === "hook" || command === "help" || command === "--help" || command === "--version"
      ? null
      : await Reveries.open(io.cwd);
    if (command === "--version") {
      io.stdout(`reveries ${VERSION}\n`);
      return 0;
    }
    if (command === "help" || command === "--help") {
      io.stdout(HELP);
      return 0;
    }
    if (command === "init") {
      const parsed = parseArguments(
        argv.slice(1),
        ["--hosts", "--remote", "--directive-email", "--skill-setup", "--skill-repository", "--skill-source"],
        ["--json", "--no-hosts", "--no-publish", "--no-directive-email"],
      );
      const hosts = explicitList(parsed, "--hosts", "--no-hosts");
      if (!hosts.every((host) => HOSTS.has(host as SupportedHost))) throw new UsageError("--hosts contains an unsupported host");
      const publishingRemotes = explicitList(parsed, "--remote", "--no-publish");
      const email = one(parsed, "--directive-email");
      const noEmail = parsed.flags.has("--no-directive-email");
      if ((email !== undefined) === noEmail) {
        throw new UsageError("choose exactly one of --directive-email or --no-directive-email");
      }
      const result = await initializeRepository(io.cwd, {
        hosts: hosts as SupportedHost[],
        publishingRemotes,
        directiveEmail: noEmail ? null : email ?? null,
        skillSetup: parseSkillSetup(parsed),
        ...(io.helper === undefined ? {} : { helper: io.helper }),
      });
      emit(io, json, command, result);
      return 0;
    }
    if (command === "adopt") {
      const parsed = parseArguments(argv.slice(1), ["--plan", "--message"], ["--json"]);
      const plan = resolve(io.cwd, one(parsed, "--plan", true) ?? "");
      const committed = await commitAdoption(
        io.cwd,
        plan,
        one(parsed, "--message", true) ?? "",
      );
      const adoption = await Reveries.open(io.cwd);
      await adoption.attachAdoption({
        commit: committed.commit,
        summary: parseProtocolRecordValue(JSON.parse(committed.sessionSummary), "session-summary", "adoption summary"),
        initialization: parseProtocolRecordValue(JSON.parse(committed.initialization), "reveries-init", "adoption initialization"),
      });
      await adoption.repository.run(["config", "--unset-all", "reveries.adoptionPlan"], { allowExitCodes: [0, 1, 5] });
      await adoption.repository.run(["config", "--unset-all", "reveries.adoptionPlanHash"], { allowExitCodes: [0, 1, 5] });
      emit(io, json, command, { commit: committed.commit });
      return 0;
    }
    if (command === "remove") {
      const parsed = parseArguments(argv.slice(1), ["--remote"], ["--json"]);
      const result = await removeIntegration(io.cwd, { publishingRemotes: splitList(parsed.values.get("--remote") ?? []) });
      emit(io, json, command, result, result.preservedSkillPaths.map(
        (path) => `Owned Skill path was preserved for manual review: ${path}`,
      ));
      return result.removed ? 0 : 1;
    }
    if (command === "hook") {
      const eventName = argv[1];
      if (eventName === undefined) throw new UsageError("hook requires an event name");
      const raw = expectObject(JSON.parse(await io.stdin()) as unknown, "hook input");
      const host = expectString(raw.host, "hook host");
      const event = adaptHostEvent(host, { ...raw, event: eventName });
      const result = await handleHookEvent(event, { cwd: io.cwd });
      io.stdout(`${JSON.stringify(result)}\n`);
      return 0;
    }
    if (reveries === null) throw new Error("Reveries service was not opened");
    if (command === "show") {
      const parsed = parseArguments(argv.slice(1), [], ["--staged", "--json"]);
      const result = await reveries.show({
        target: requirePositional(parsed, 0, "path or object"),
        revision: parsed.flags.has("--staged") ? "index" : "HEAD",
      });
      emit(io, json, command, result, result.diagnostics);
      return result.diagnostics.length === 0 ? 0 : 1;
    }
    if (command === "record") {
      const action = argv[1];
      if (action === "new" || action === "supersede") {
        const parsed = parseArguments(argv.slice(2), ["--from", "--old"], ["--staged", "--committed", "--json"]);
        const path = requirePositional(parsed, 0, "path");
        const from = one(parsed, "--from", true) ?? "";
        const draft = await parseReverieDraft(from);
        const revision = parsed.flags.has("--committed") ? "HEAD" : "index";
        const result = action === "new"
          ? await reveries.recordNew({ path, revision, ...draft })
          : await reveries.recordSupersede({
              path,
              revision,
              ...draft,
              old: reverieId(one(parsed, "--old", true) ?? ""),
            });
        emit(io, json, `${command} ${action}`, result);
        return 0;
      }
      if (action === "continue") {
        const parsed = parseArguments(argv.slice(2), ["--from-blob", "--to-blob", "--id"], ["--json"]);
        const result = await reveries.recordContinueToBlob({
          fromBlob: blobId(one(parsed, "--from-blob", true) ?? ""),
          toBlob: blobId(one(parsed, "--to-blob", true) ?? ""),
          id: reverieId(one(parsed, "--id", true) ?? ""),
        });
        emit(io, json, `${command} ${action}`, result);
        return 0;
      }
      throw new UsageError("record action must be new, continue, or supersede");
    }
    if (command === "summarize") {
      const parsed = parseArguments(argv.slice(1), ["--from", "--because"], ["--replace", "--init", "--json"]);
      const commit = requirePositional(parsed, 0, "commit");
      const from = one(parsed, "--from", true) ?? "";
      if (parsed.flags.has("--init")) {
        await reveries.attachInitialization({ commit, record: await parseProtocolRecord(from, "reveries-init") });
      } else {
        const summary = await parseProtocolRecord(from, "session-summary");
        const because = one(parsed, "--because");
        await reveries.summarize({
          commit,
          summary: because === undefined ? summary : { ...summary, correction_reason: because },
          replace: parsed.flags.has("--replace"),
        });
      }
      emit(io, json, command, { commit });
      return 0;
    }
    if (command === "check") {
      const parsed = parseArguments(argv.slice(1), ["--outgoing", "--successor"], ["--staged", "--json"]);
      const outgoing = one(parsed, "--outgoing");
      const successors = new Map<string, string>();
      for (const mapping of parsed.values.get("--successor") ?? []) {
        const separator = mapping.indexOf("=");
        if (separator <= 0 || separator === mapping.length - 1) {
          throw new UsageError("--successor must use old/path=new/path");
        }
        successors.set(mapping.slice(0, separator), mapping.slice(separator + 1));
      }
      const result = parsed.flags.has("--staged")
        ? await reveries.checkStaged(successors)
        : outgoing === undefined
          ? await reveries.checkCommit(parsed.positionals[0] ?? "HEAD")
          : await reveries.checkOutgoing(outgoing);
      emit(io, json, command, result, result.diagnostics);
      return result.ok ? 0 : 1;
    }
    if (command === "search") {
      const parsed = parseArguments(argv.slice(1), ["--source", "--author", "--at"], ["--all", "--json"]);
      const source = one(parsed, "--source");
      const author = one(parsed, "--author");
      const revision = one(parsed, "--at");
      const result = await reveries.search({
        ...(parsed.positionals.length === 0 ? {} : { query: parsed.positionals.join(" ") }),
        ...(source === undefined ? {} : { source }),
        ...(author === undefined ? {} : { author }),
        ...(revision === undefined ? {} : { revision }),
        all: parsed.flags.has("--all"),
      });
      emit(io, json, command, result);
      return 0;
    }
    if (command === "history") {
      const parsed = parseArguments(argv.slice(1), [], ["--json"]);
      const target = requirePositional(parsed, 0, "path or reverie ID");
      const result = target.startsWith("rv:")
        ? (await reveries.search({ query: target, all: true })).filter(
            (hit) => hit.record.type === "reverie" && hit.record.id === target,
          )
        : await reveries.history(target);
      emit(io, json, command, result);
      return 0;
    }
    if (command === "sync") {
      const parsed = parseArguments(argv.slice(1), [], ["--pull", "--status", "--json"]);
      const remote = requirePositional(parsed, 0, "remote");
      if (parsed.flags.has("--pull")) {
        const result = await reveries.syncPull(remote);
        emit(io, json, command, result, result.diagnostics);
        return result.ok ? 0 : 1;
      }
      if (parsed.flags.has("--status")) {
        const local = await reveries.repository.notesTip();
        const tracked = await reveries.repository.notesTip(`refs/notes/remotes/${remote}/reveries`);
        const result = {
          local,
          remote: tracked,
          state: local === null || tracked === null ? "unknown" : local === tracked ? "equal" : "diverged",
        };
        emit(io, json, command, result);
        return 0;
      }
      throw new UsageError("sync requires --pull or --status");
    }
    if (command === "push") {
      const parsed = parseArguments(argv.slice(1), [], ["--json"]);
      const result = await reveries.push(requirePositional(parsed, 0, "remote"));
      emit(io, json, command, result, result.diagnostics);
      return result.ok ? 0 : 1;
    }
    if (command === "doctor") {
      const parsed = parseArguments(argv.slice(1), [], ["--json"]);
      const result = await reveries.doctor();
      emit(io, json, command, result, result.diagnostics);
      return result.ok ? 0 : 1;
    }
    if (command === "pre-push") {
      const remote = argv[1];
      if (remote === undefined) throw new UsageError("pre-push requires the remote name from Git");
      const result = await reveries.checkOutgoingUpdates(remote, parsePushUpdates(await io.stdin()));
      emit(io, false, command, undefined, result.diagnostics);
      return result.ok ? 0 : 1;
    }
    if (command === "post-commit") {
      const result = await reveries.postCommitCheck();
      emit(io, false, command, undefined, result.diagnostics);
      return 0;
    }
    throw new UsageError(`unknown command ${command}`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof UsageError) {
      io.stderr(`${message}\n`);
      return 3;
    }
    if (json) io.stdout(`${JSON.stringify({ ok: false, command: command ?? null, diagnostics: [message] })}\n`);
    else io.stderr(`${message}\n`);
    return 2;
  }
}
