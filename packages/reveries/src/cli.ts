#!/usr/bin/env node

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  commitAdoption,
  initializeRepository,
  removeIntegration,
  repairLocalIntegration,
  type HelperInvocation,
  type SkillSetup,
  type SupportedHost,
} from "./install.ts";
import { INTERNAL_ATOMIC_PUSH_ENV, NOTES_REF } from "./git.ts";
import { adaptHostEvent, handleHookEvent } from "./hooks.ts";
import { Reveries, type PushUpdate } from "./operations.ts";
import { checkReceive, type ReceiveCheckInput, type ReceiveEvidence, type ReceiveRefUpdate } from "./receive.ts";
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
  type ReverieRecord,
  type ReveriesInit,
  type Retirement,
  type SessionSummary,
  type Source,
  type SourceKind,
  type SourceRelation,
} from "./protocol.ts";

export type ExitCode = 0 | 1 | 2 | 3;

const execFileAsync = promisify(execFile);

export interface CliIo {
  readonly cwd: string;
  readonly stdin: () => Promise<string>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly helper?: HelperInvocation;
  readonly environment?: Readonly<Record<string, string | undefined>>;
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

class EditorCancelledError extends Error {}

const RELATIONS = new Set<SourceRelation>([
  "caused-by", "constrained-by", "requested-by", "derived-from", "implements", "corroborated-by",
]);
const KINDS = new Set<SourceKind>(["commit", "blob", "path", "note", "git-email", "issue"]);
const HOSTS = new Set<SupportedHost>(["pi", "claude", "opencode", "codex", "gemini"]);
const VERSION = "1.0.2";
const HELP = `reveries <command>

Commands:
  help       Show general or command-specific help
  init       Prepare project instructions, Git configuration, and hooks
  adopt      Verify the prepared files and create the adoption commit
  doctor     Diagnose the local installation and notes state (--fix repairs local state)
  show       Show notes for a path, blob, or commit
  record     Create, continue, or supersede a blob reverie
  summarize  Attach or replace a commit summary or initialization record
  check      Check staged, committed, or outgoing continuity and coverage
  search     Search current or historical engineering evidence
  history    Trace a path or reverie through history
  sync       Inspect or pull a publishing remote's notes
  push       Atomically push HEAD and refs/notes/reveries
  hook       Handle one host-neutral adapter event from standard input
  receive-check Validate proposed refs and evidence without a worktree
  remove     Remove owned integration without deleting evidence

Init requires an explicit choice for hosts, publishing, directive email, and
--skill-setup reminder|pull|vendored|symlink|submodule. Pull and submodule
require --skill-repository.
Vendored and symlink setups require --skill-source.

Use --json on inspection and check commands for stable machine output.
`;

const COMMAND_HELP: Readonly<Record<string, string>> = {
  help: `Usage: reveries help [<command>]

Show general help or usage for one command.
Examples:
  reveries help
  reveries help record
`,
  init: `Usage: reveries init --hosts <list>|--no-hosts --remote <list>|--no-publish --directive-email <email>|--no-directive-email --skill-setup <kind> [options]

Prepare the repository's instructions, Git configuration, and hooks.
Options: --skill-repository <url>, --skill-source <path>, --json
Examples:
  reveries init --hosts codex --remote origin --directive-email me@example.com --skill-setup reminder
  reveries init --no-hosts --no-publish --no-directive-email --skill-setup reminder
`,
  adopt: `Usage: reveries adopt --plan <path> --message <message> [--json]

Verify the prepared adoption plan and create its adoption commit.
Examples:
  reveries adopt --plan .reveries/adoption.json --message "Adopt Reveries"
`,
  doctor: `Usage: reveries doctor [--fix] [--json]

Diagnose repository setup, enforcement, and notes state. --fix first repairs local
Git configuration, managed notes refspecs, the helper runner, and Reveries-owned
hook blocks from the committed initialization record, then reports the result.
--fix never changes tracked files, notes, or the adoption plan.
Examples:
  reveries doctor
  reveries doctor --fix
  reveries doctor --json
`,
  show: `Usage: reveries show <path|blob|commit> [--staged] [--json]

Show active and historical evidence for a Git object.
Examples:
  reveries show src/state.ts
  reveries show src/state.ts --staged
`,
  record: `Usage: reveries record <new|supersede> <path> [--from <file|->] [causal options]
       reveries record continue --from-blob <blob> --to-blob <blob> --id <reverie-id>

Create or supersede a reverie. Missing metadata defaults to Git's user.email,
the current UTC time, and --session, REVERIES_SESSION, or null.
Options: --driving-event <text>, --decision <text>, --impact <text>,
         --recurrence-control <text>|--no-recurrence-control, --alternative <text>,
         --source <relation:kind:ref[@at]>, --session <name>, --edit,
         --committed, --staged, --old <reverie-id>, --json
Examples:
  reveries record new src/state.ts --driving-event "A transition failed" --decision "Guard it" --impact "All writers are checked"
  reveries record new src/state.ts --from draft.json --edit
  cat draft.json | reveries record new src/state.ts --from -
`,
  summarize: `Usage: reveries summarize <commit> [--from <file|->] [causal options] [--replace]
       reveries summarize <commit> --from <reveries-init.json> --init

Attach a session summary. Missing metadata defaults to Git's user.email,
the current UTC time, and --session, REVERIES_SESSION, or null.
Options: --driving-event <text>, --decision <text>, --impact <text>,
         --recurrence-control <text>|--no-recurrence-control, --alternative <text>,
         --source <relation:kind:ref[@at]>, --reverie <id>, --retire <rv:id:blob:reason>,
         --session <name>, --edit, --because <reason>, --replace, --init, --json
Examples:
  reveries summarize HEAD --from summary.json --edit
  cat summary.json | reveries summarize HEAD --from -
`,
  check: `Usage: reveries check [<commit>|--staged|--outgoing <remote>] [--successor old/path=new/path] [--json]

Check continuity and summary coverage.
Examples:
  reveries check --staged
  reveries check HEAD
  reveries check --outgoing origin
`,
  search: `Usage: reveries search [<query>] [--source <ref>] [--author <email>] [--at <revision>] [--all] [--json]

Search current or historical engineering evidence.
Examples:
  reveries search "transition authority"
  reveries search --source github:owner/repository#417
`,
  history: `Usage: reveries history <path|reverie-id> [--json]

Trace evidence attached to a path or reverie through history.
Examples:
  reveries history src/state.ts
  reveries history rv:<full-id>
`,
  sync: `Usage: reveries sync [<remote>] (--status|--pull) [--json]

Inspect or fetch a publishing remote's notes. Without a remote, use the
branch upstream or the sole configured publishing remote.
Examples:
  reveries sync --status
  reveries sync --pull origin
`,
  push: `Usage: reveries push [<remote>] [--json]

Atomically publish HEAD and refs/notes/reveries. Without a remote, use the
branch upstream or the sole configured publishing remote.
Examples:
  reveries push
  reveries push origin
`,
  hook: `Usage: reveries hook <event> < event.json

Handle one host-neutral adapter event from standard input.
Examples:
  reveries hook session-start < event.json
`,
  "receive-check": `Usage: reveries receive-check [--evidence <object>] [--base-tree <tree>] < proposal.json

Validate proposed refs and evidence without a worktree.
`,
  remove: `Usage: reveries remove [--remote <name>]... [--json]

Remove owned integration without deleting historical evidence.
`,
};

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

function parseReceiveObject(value: unknown, label: string): ReturnType<typeof objectId> | null {
  const raw = expectString(value, label);
  if (/^0+$/.test(raw)) return null;
  try {
    return objectId(raw);
  } catch (error: unknown) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

function parseReceiveUpdate(value: unknown, index: number): ReceiveRefUpdate {
  const update = expectObject(value, `receive update ${index + 1}`);
  return {
    ref: expectString(update.ref, `receive update ${index + 1}.ref`),
    oldObject: parseReceiveObject(update.old ?? update.oldObject, `receive update ${index + 1}.old`),
    newObject: parseReceiveObject(update.new ?? update.newObject, `receive update ${index + 1}.new`),
  };
}

function parseReceiveEvidence(value: unknown, index: number): ReceiveEvidence {
  if (typeof value === "string") {
    try {
      return { object: objectId(value) };
    } catch (error: unknown) {
      throw new UsageError(error instanceof Error ? error.message : String(error));
    }
  }
  const evidence = expectObject(value, `evidence ${index + 1}`);
  const object = parseReceiveObject(evidence.object, `evidence ${index + 1}.object`);
  if (object === null) throw new UsageError(`evidence ${index + 1}.object cannot be zero`);
  const baseTree = evidence.base_tree === undefined
    ? undefined
    : parseReceiveObject(evidence.base_tree, `evidence ${index + 1}.base_tree`);
  return { object, ...(baseTree === undefined || baseTree === null ? {} : { baseTree }) };
}

async function parseReceiveInput(input: string): Promise<ReceiveCheckInput> {
  const trimmed = input.trim();
  if (trimmed.startsWith("{")) {
    let value: unknown;
    try {
      value = JSON.parse(trimmed) as unknown;
    } catch (error: unknown) {
      throw new UsageError(`receive-check input is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    const proposal = expectObject(value, "receive proposal");
    if (!Array.isArray(proposal.updates)) throw new UsageError("receive proposal updates must be an array");
    const evidence = proposal.evidence === undefined
      ? []
      : !Array.isArray(proposal.evidence)
        ? (() => { throw new UsageError("receive proposal evidence must be an array"); })()
        : proposal.evidence.map(parseReceiveEvidence);
    const baseTree = proposal.base_tree === undefined
      ? undefined
      : parseReceiveObject(proposal.base_tree, "receive proposal.base_tree");
    return {
      updates: proposal.updates.map(parseReceiveUpdate),
      evidence,
      ...(baseTree === undefined || baseTree === null ? {} : { baseTree }),
    };
  }
  const updates: ReceiveRefUpdate[] = [];
  for (const [index, line] of trimmed.split("\n").entries()) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 3 || fields.some((field) => field.length === 0 || field.includes("\0"))) {
      throw new UsageError(`receive-check received a malformed ref update on line ${index + 1}`);
    }
    const [oldValue, newValue, ref] = fields;
    if (oldValue === undefined || newValue === undefined || ref === undefined) {
      throw new UsageError(`receive-check received a malformed ref update on line ${index + 1}`);
    }
    updates.push({
      ref,
      oldObject: parseReceiveObject(oldValue, `receive update ${index + 1}.old`),
      newObject: parseReceiveObject(newValue, `receive update ${index + 1}.new`),
    });
  }
  return { updates, evidence: [] };
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

function parseSourceValue(value: unknown): Source {
  try {
    return parseSource(value);
  } catch (error: unknown) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

function parseReverieId(value: string): ReturnType<typeof reverieId> {
  try {
    return reverieId(value);
  } catch (error: unknown) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

async function readDraft(from: string | undefined, io: CliIo): Promise<unknown> {
  if (from === undefined) return {};
  let input: string;
  try {
    input = from === "-" ? await io.stdin() : await readFile(resolve(io.cwd, from), "utf8");
  } catch (error: unknown) {
    throw new UsageError(`cannot read JSON from ${from}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(input) as unknown;
  } catch (error: unknown) {
    throw new UsageError(`cannot read JSON from ${from}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function flagSources(parsed: ParsedArguments): Source[] {
  return (parsed.values.get("--source") ?? []).map((value) => {
    const first = value.indexOf(":");
    const second = first < 0 ? -1 : value.indexOf(":", first + 1);
    if (first <= 0 || second <= first + 1 || second === value.length - 1) {
      throw new UsageError("--source must use relation:kind:ref[@at]");
    }
    const relation = value.slice(0, first);
    const kind = value.slice(first + 1, second);
    let ref = value.slice(second + 1);
    let at: string | undefined;
    const separator = ref.lastIndexOf("@");
    if (separator >= 0) {
      const candidate = ref.slice(separator + 1);
      if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(candidate)) {
        ref = ref.slice(0, separator);
        at = candidate;
      }
    }
    return parseSourceValue({ relation, kind, ref, ...(at === undefined ? {} : { at }) });
  });
}

function flagRetirements(parsed: ParsedArguments): Retirement[] {
  return (parsed.values.get("--retire") ?? []).map((value) => {
    const match = /^(rv:[^:]+):([^:]+):(.*)$/s.exec(value);
    if (match === null) throw new UsageError("--retire must use rv:<id>:<blob>:<reason>");
    const [, reverie, blob, reason] = match;
    if (reverie === undefined || blob === undefined || reason === undefined) {
      throw new UsageError("--retire must use rv:<id>:<blob>:<reason>");
    }
    try {
      return { reverie: reverieId(reverie), from_blob: blobId(blob), reason };
    } catch (error: unknown) {
      throw new UsageError(error instanceof Error ? error.message : String(error));
    }
  });
}

function overlayRecurrence(
  value: unknown,
  parsed: ParsedArguments,
): string | null {
  const noRecurrence = parsed.flags.has("--no-recurrence-control");
  const recurrence = one(parsed, "--recurrence-control");
  if (noRecurrence && recurrence !== undefined) {
    throw new UsageError("choose only one of --recurrence-control or --no-recurrence-control");
  }
  if (noRecurrence) return null;
  const selected = recurrence ?? value;
  return selected === undefined || selected === null
    ? null
    : expectString(selected, "recurrence_control");
}

function overlayAlternatives(value: unknown, parsed: ParsedArguments): string[] {
  const existing = value === undefined ? [] : expectStringArray(value, "alternatives");
  return [...existing, ...(parsed.values.get("--alternative") ?? [])];
}

function overlaySources(value: unknown, parsed: ParsedArguments): Source[] {
  const existing = value === undefined
    ? []
    : !Array.isArray(value)
      ? (() => { throw new UsageError("sources must be an array"); })()
      : value.map(parseSourceValue);
  return [...existing, ...flagSources(parsed)];
}

async function parseMetadata(
  value: Record<string, unknown>,
  reveries: Reveries,
  io: CliIo,
  parsed: ParsedArguments,
): Promise<ReverieMetadata> {
  let authorEmail = value.author_email;
  if (authorEmail === undefined) {
    const configured = await reveries.repository.run(["config", "--get", "user.email"], { allowExitCodes: [0, 1] });
    authorEmail = configured.exitCode === 0 ? configured.stdout.trim() : undefined;
  }
  if (authorEmail === undefined || authorEmail === "") {
    throw new UsageError("author_email is missing; configure git user.email or supply it in the draft");
  }
  const environment = io.environment ?? process.env;
  const sessionFlag = one(parsed, "--session");
  const sessionValue = sessionFlag ?? (value.session === undefined ? environment.REVERIES_SESSION ?? null : value.session);
  if (sessionValue !== null && typeof sessionValue !== "string") {
    throw new UsageError("session must be a string or null");
  }
  return {
    author_email: expectString(authorEmail, "author_email"),
    session: sessionValue,
    created_at: value.created_at === undefined
      ? new Date().toISOString()
      : expectString(value.created_at, "created_at"),
  };
}

async function parseReverieDraft(
  raw: unknown,
  reveries: Reveries,
  io: CliIo,
  parsed: ParsedArguments,
): Promise<{
  readonly semantic: ReverieInput;
  readonly metadata: ReverieMetadata;
}> {
  const value = expectObject(raw, "reverie draft");
  if (value.type !== undefined && value.type !== "reverie") throw new UsageError("reverie draft type must be reverie");
  const drivingEvent = one(parsed, "--driving-event") ?? value.driving_event;
  const decision = one(parsed, "--decision") ?? value.decision;
  const impact = one(parsed, "--impact") ?? value.impact;
  const supersedes = value.supersedes === undefined ? [] : expectStringArray(value.supersedes, "supersedes");
  const semantic: ReverieInput = {
    v: value.v === undefined || value.v === 1 ? 1 : (() => { throw new UsageError("v must be 1"); })(),
    driving_event: expectString(drivingEvent, "driving_event"),
    decision: expectString(decision, "decision"),
    impact: expectString(impact, "impact"),
    recurrence_control: overlayRecurrence(value.recurrence_control, parsed),
    alternatives: overlayAlternatives(value.alternatives, parsed),
    sources: overlaySources(value.sources, parsed),
    supersedes: supersedes.map(parseReverieId),
  };
  const metadata = await parseMetadata(value, reveries, io, parsed);
  const candidate: ReverieRecord = {
    ...semantic,
    ...metadata,
    type: "reverie",
    id: parseReverieId(`rv:${"0".repeat(40)}`),
  };
  try {
    validateNote([candidate], { verifyIds: false });
  } catch (error: unknown) {
    throw new UsageError(errorText(error));
  }
  return { semantic, metadata };
}

async function parseSummaryDraft(
  raw: unknown,
  reveries: Reveries,
  io: CliIo,
  parsed: ParsedArguments,
): Promise<SessionSummary> {
  const value = expectObject(raw, "session-summary draft");
  if (value.type !== undefined && value.type !== "session-summary") {
    throw new UsageError("session-summary draft type must be session-summary");
  }
  const rawEntries = value.entries === undefined ? [] : value.entries;
  if (!Array.isArray(rawEntries)) throw new UsageError("entries must be an array");
  const noEntryFlags: ParsedArguments = { positionals: [], values: new Map(), flags: new Set() };
  const summaryOptions = parsed.values.has("--driving-event")
    || parsed.values.has("--decision")
    || parsed.values.has("--impact")
    || parsed.values.has("--recurrence-control")
    || parsed.flags.has("--no-recurrence-control")
    || parsed.values.has("--alternative")
    || parsed.values.has("--source")
    || parsed.values.has("--reverie")
    || parsed.values.has("--retire")
    || ["driving_event", "decision", "impact", "recurrence_control", "alternatives", "sources", "reveries", "retirements"]
      .some((key) => value[key] !== undefined);
  const entries = rawEntries.map((entry, index) => {
    const rawEntry = expectObject(entry, `entries[${index}]`);
    const source = index === 0 ? { ...value, ...rawEntry } : rawEntry;
    const entryFlags = index === 0 ? parsed : noEntryFlags;
    const drivingEvent = one(entryFlags, "--driving-event") ?? source.driving_event;
    const decision = one(entryFlags, "--decision") ?? source.decision;
    const impact = one(entryFlags, "--impact") ?? source.impact;
    const existingReveries = source.reveries === undefined ? [] : expectStringArray(source.reveries, "reveries");
    const existingRetirements = source.retirements === undefined
      ? []
      : !Array.isArray(source.retirements)
        ? (() => { throw new UsageError("retirements must be an array"); })()
        : source.retirements;
    const flaggedReveries = (entryFlags.values.get("--reverie") ?? []).map(parseReverieId);
    return {
      driving_event: expectString(drivingEvent, `entries[${index}].driving_event`),
      decision: expectString(decision, `entries[${index}].decision`),
      impact: expectString(impact, `entries[${index}].impact`),
      recurrence_control: overlayRecurrence(source.recurrence_control, entryFlags),
      alternatives: overlayAlternatives(source.alternatives, entryFlags),
      sources: overlaySources(source.sources, entryFlags),
      reveries: [...existingReveries.map(parseReverieId), ...flaggedReveries],
      retirements: [...existingRetirements, ...flagRetirements(entryFlags)],
    };
  });
  if (entries.length === 0 && summaryOptions) {
    const source = value;
    const initial = {
      driving_event: one(parsed, "--driving-event") ?? source.driving_event,
      decision: one(parsed, "--decision") ?? source.decision,
      impact: one(parsed, "--impact") ?? source.impact,
      recurrence_control: overlayRecurrence(source.recurrence_control, parsed),
      alternatives: overlayAlternatives(source.alternatives, parsed),
      sources: overlaySources(source.sources, parsed),
      reveries: (parsed.values.get("--reverie") ?? []).map(parseReverieId),
      retirements: flagRetirements(parsed),
    };
    entries.push({
      driving_event: expectString(initial.driving_event, "driving_event"),
      decision: expectString(initial.decision, "decision"),
      impact: expectString(initial.impact, "impact"),
      recurrence_control: initial.recurrence_control,
      alternatives: initial.alternatives,
      sources: initial.sources,
      reveries: initial.reveries,
      retirements: initial.retirements,
    });
  }
  const metadata = await parseMetadata(value, reveries, io, parsed);
  const summary: SessionSummary = {
    v: value.v === undefined || value.v === 1 ? 1 : (() => { throw new UsageError("v must be 1"); })(),
    type: "session-summary",
    ...metadata,
    entries,
    ...(value.correction_reason === undefined ? {} : { correction_reason: expectString(value.correction_reason, "correction_reason") }),
  };
  try {
    validateNote([summary], { verifyIds: false });
  } catch (error: unknown) {
    throw new UsageError(errorText(error));
  }
  return summary;
}

type PreparedDraft = {
  readonly kind: "unchanged";
  readonly value: unknown;
  readonly cleanup: () => Promise<void>;
} | {
  readonly kind: "edited";
  readonly value: unknown;
  readonly cleanup: () => Promise<void>;
  readonly retainedPath: string;
};

function editorArguments(command: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let started = false;
  for (const character of command) {
    if (escaped) {
      current += character;
      escaped = false;
      started = true;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote !== null) {
      if (character === quote) quote = null;
      else current += character;
      started = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) args.push(current);
      current = "";
      started = false;
      continue;
    }
    current += character;
    started = true;
  }
  if (escaped || quote !== null) throw new UsageError("editor command has an unterminated quote or escape");
  if (started) args.push(current);
  if (args.length === 0 || args[0] === "") throw new UsageError("set VISUAL or EDITOR to edit this draft");
  return args;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function prepareDraft(raw: unknown, edit: boolean, io: CliIo): Promise<PreparedDraft> {
  if (!edit) return { kind: "unchanged", value: raw, cleanup: async () => {} };
  const environment = io.environment ?? process.env;
  const editor = environment.VISUAL?.trim() || environment.EDITOR?.trim();
  if (editor === undefined || editor.length === 0) throw new UsageError("set VISUAL or EDITOR to edit this draft");
  const command = editorArguments(editor);
  const directory = await mkdtemp(join(tmpdir(), "reveries-draft-"));
  const path = join(directory, "draft.json");
  const cleanup = async () => rm(directory, { recursive: true, force: true });
  await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  try {
    await execFileAsync(command[0]!, [...command.slice(1), path], {
      cwd: io.cwd,
      env: { ...process.env, ...(io.environment ?? {}) },
    });
  } catch (error: unknown) {
    throw new UsageError(`Draft retained at ${path}: editor failed: ${errorText(error)}`);
  }
  const edited = await readFile(path, "utf8");
  if (edited.trim().length === 0) {
    await cleanup();
    throw new EditorCancelledError("Draft editing cancelled because the editor left the draft empty");
  }
  try {
    return { kind: "edited", value: JSON.parse(edited) as unknown, cleanup, retainedPath: path };
  } catch (error: unknown) {
    throw new UsageError(`Draft retained at ${path}: ${errorText(error)}`);
  }
}

async function usePreparedDraft<T>(draft: PreparedDraft, action: (value: unknown) => Promise<T>): Promise<T> {
  try {
    const result = await action(draft.value);
    await draft.cleanup();
    return result;
  } catch (error: unknown) {
    if (draft.kind === "unchanged") throw error;
    throw new UsageError(`Draft retained at ${draft.retainedPath}: ${errorText(error)}`);
  }
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
  try {
    if (type === "session-summary") validateNote([candidate], { verifyIds: false });
    else {
      const parsed = parseNote(canonicalRecord(candidate), "tolerant", { verifyIds: false });
      if (parsed.diagnostics.length > 0) throw new UsageError(parsed.diagnostics.map((item) => item.message).join("; "));
    }
  } catch (error: unknown) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(errorText(error));
  }
  return candidate as SessionSummary | ReveriesInit;
}

type HumanContext = {
  readonly remote?: string;
  readonly target?: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringField(value: Record<string, unknown>, field: string, fallback = "unknown"): string {
  const item = value[field];
  return typeof item === "string" ? item : fallback;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function formatRecord(record: unknown, indent = "  "): string[] {
  const value = asRecord(record);
  if (value === null) return [`${indent}${String(record)}`];
  if (value.type === "reverie") {
    return [
      `${indent}${stringField(value, "id")}: ${stringField(value, "decision")}`,
      `${indent}  Event: ${stringField(value, "driving_event")}`,
      `${indent}  Impact: ${stringField(value, "impact")}`,
    ];
  }
  if (value.type === "session-summary") {
    const entries = Array.isArray(value.entries) ? value.entries : [];
    return [
      `${indent}Session summary by ${stringField(value, "author_email")}`,
      ...entries.flatMap((entry, index) => {
        const item = asRecord(entry);
        if (item === null) return [];
        return [
          `${indent}  ${index + 1}. ${stringField(item, "decision")}`,
          `${indent}     Event: ${stringField(item, "driving_event")}`,
          `${indent}     Impact: ${stringField(item, "impact")}`,
        ];
      }),
    ];
  }
  if (value.type === "reveries-init") {
    return [`${indent}Initialization record for ${stringList(value.publishing_remotes).join(", ") || "local-only use"}`];
  }
  return [`${indent}${JSON.stringify(value)}`];
}

function humanOutput(
  command: string,
  result: unknown,
  context: HumanContext,
): string {
  const value = asRecord(result);
  if (command === "check" || command === "receive-check") {
    return `${value?.ok === true ? "Continuity check passed." : "Continuity check failed."}\n`;
  }
  if (command === "doctor") {
    const protection = asRecord(value?.protection);
    const lines = [`Reveries doctor: ${stringField(value ?? {}, "state")}.`];
    if (protection !== null) {
      lines.push(
        `Protection: helper ${stringField(protection, "helper")}, local ${stringField(protection, "local")}, receive-side ${stringField(protection, "receiveSide")}.`,
      );
    }
    const repair = asRecord(value?.repair);
    if (repair !== null) {
      lines.push(`Repair: ${stringField(repair, "state")}.`);
      for (const snippet of stringList(repair.hookSnippets)) {
        lines.push(`Add this to the ${/(\S+)\s+"\$@"$/.exec(snippet)?.[1] ?? "matching"} hook: ${snippet}`);
      }
    }
    for (const notice of stringList(value?.notices)) lines.push(`Notice: ${notice}`);
    return `${lines.join("\n")}\n`;
  }
  if (command === "show") {
    const target = context.target ?? stringField(value ?? {}, "object");
    const records = Array.isArray(value?.records) ? value.records : [];
    const active = Array.isArray(value?.active) ? value.active : [];
    const historical = Array.isArray(value?.historical) ? value.historical : [];
    if (records.length === 0) return `No Reveries evidence is attached to ${target}.\n`;
    return [
      `Evidence for ${target}:`,
      ...(active.length === 0 ? [] : ["Active decisions:", ...active.flatMap((record) => formatRecord(record))]),
      ...(historical.length === 0 ? [] : ["Historical decisions:", ...historical.flatMap((record) => formatRecord(record))]),
      ...(active.length + historical.length > 0 ? [] : records.flatMap((record) => formatRecord(record))),
      "",
    ].join("\n");
  }
  if (command === "push") {
    return value?.ok === true
      ? `Published HEAD and ${NOTES_REF} to ${context.remote ?? "the remote"} atomically.\n`
      : `Push to ${context.remote ?? "the remote"} was not performed.\n`;
  }
  if (command === "sync") {
    const state = stringField(value ?? {}, "state");
    if (state === "equal" || state === "diverged" || state === "unknown") {
      return `Notes status for ${context.remote ?? "the remote"}: ${state} (local ${String(value?.local ?? "none")}, remote ${String(value?.remote ?? "none")}).\n`;
    }
    return state === "remote-notes-absent"
      ? `No Reveries notes are published on ${context.remote ?? "the remote"}.\n`
      : `Fetched Reveries notes from ${context.remote ?? "the remote"}.\n`;
  }
  if (command === "search") {
    const hits = Array.isArray(result) ? result : [];
    if (hits.length === 0) return "No matching Reveries evidence found.\n";
    return [
      `Found ${hits.length} matching ${hits.length === 1 ? "record" : "records"}:`,
      ...hits.flatMap((hit) => {
        const item = asRecord(hit);
        if (item === null) return [];
        const paths = stringList(item.paths);
        return [
          `- ${paths.length === 0 ? String(item.object) : paths.join(", ")} (${String(item.object)})`,
          ...formatRecord(item.record, "  "),
        ];
      }),
      "",
    ].join("\n");
  }
  if (command === "history") {
    const entries = Array.isArray(result) ? result : [];
    if (entries.length === 0) return `No history found for ${context.target ?? "the requested target"}.\n`;
    return [
      `History for ${context.target ?? "the requested target"}:`,
      ...entries.flatMap((entry) => {
        const item = asRecord(entry);
        if (item === null) return [];
        const records = Array.isArray(item.records)
          ? item.records
          : item.record === undefined
            ? []
            : [item.record];
        const object = item.commit ?? item.object ?? "unknown object";
        const blob = item.blob === undefined ? "" : ` (${String(item.blob)})`;
        const paths = stringList(item.paths);
        return [
          `- ${paths.length === 0 ? String(object) : `${paths.join(", ")} at ${String(object)}`}${blob}`,
          ...(records.length === 0 ? ["  No records attached."] : records.flatMap((record) => formatRecord(record, "  "))),
        ];
      }),
      "",
    ].join("\n");
  }
  if (command.startsWith("record ")) {
    const record = asRecord(value?.record);
    const id = record === null ? "the reverie" : stringField(record, "id", "the reverie");
    const paths = stringList(value?.paths);
    return `Recorded reverie ${id}${paths.length === 0 ? "" : ` for ${paths.join(", ")}`}.\n`;
  }
  if (command === "summarize") {
    return `Summarized commit ${stringField(value ?? {}, "commit", context.target ?? "unknown")}.\n`;
  }
  if (command === "init") {
    return `Reveries setup ${stringField(value ?? {}, "state", "completed")}.\n`;
  }
  if (command === "adopt") {
    return `Adopted commit ${stringField(value ?? {}, "commit")}.\n`;
  }
  if (command === "remove") {
    return value?.removed === true ? "Removed Reveries integration. Evidence was preserved.\n" : "No Reveries integration was removed.\n";
  }
  if (typeof result === "string") return `${result}\n`;
  if (result === undefined) return "";
  return `${JSON.stringify(result, null, 2)}\n`;
}

function emit(
  io: CliIo,
  json: boolean,
  command: string,
  result: unknown,
  diagnostics: readonly string[] = [],
  context: HumanContext = {},
): void {
  if (json) {
    io.stdout(`${JSON.stringify({ ok: diagnostics.length === 0, command, result, diagnostics })}\n`);
    return;
  }
  const output = humanOutput(command, result, context);
  if (output.length > 0) io.stdout(output);
  for (const diagnostic of diagnostics) io.stderr(`${diagnostic}\n`);
}

function splitList(values: readonly string[]): string[] {
  return [...new Set(values.flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean))];
}

async function defaultRemote(reveries: Reveries): Promise<string> {
  const branchResult = await reveries.repository.run(
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    { allowExitCodes: [0, 1] },
  );
  if (branchResult.exitCode === 0) {
    const branch = branchResult.stdout.trim();
    const upstream = await reveries.repository.run(
      ["config", "--get", `branch.${branch}.remote`],
      { allowExitCodes: [0, 1] },
    );
    const remote = upstream.stdout.trim();
    if (upstream.exitCode === 0 && remote.length > 0 && remote !== ".") return remote;
  }

  const configured = await reveries.repository.run(
    ["config", "--get-all", "reveries.publishingRemote"],
    { allowExitCodes: [0, 1] },
  );
  const publishers = [...new Set(configured.stdout.split("\n").map((remote) => remote.trim()).filter(Boolean))];
  if (publishers.length === 1) return publishers[0]!;
  if (publishers.length === 0) {
    throw new UsageError(
      "No default remote is available; set an upstream or configure one publishing remote, or pass a remote explicitly",
    );
  }
  throw new UsageError(
    `Default publishing remote is ambiguous (${publishers.join(", ")}); set an upstream or pass a remote explicitly`,
  );
}

async function remoteArgument(parsed: ParsedArguments, reveries: Reveries): Promise<string> {
  if (parsed.positionals.length > 1) throw new UsageError("only one remote may be specified");
  return parsed.positionals[0] ?? defaultRemote(reveries);
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
  if (kind === "submodule") {
    if (repository === undefined) throw new UsageError("--skill-setup submodule requires --skill-repository");
    if (sourceRoot !== undefined) throw new UsageError("--skill-source does not apply to submodule setup");
    return { kind, repository };
  }
  if (kind === "vendored" || kind === "symlink") {
    if (sourceRoot === undefined) throw new UsageError(`--skill-setup ${kind} requires --skill-source`);
    if (repository !== undefined) throw new UsageError("--skill-repository applies only to pull or submodule setup");
    return { kind, sourceRoot };
  }
  throw new UsageError("--skill-setup must be reminder, pull, vendored, symlink, or submodule");
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
    const reveries = command === "init" || command === "adopt" || command === "remove" || command === "hook" || command === "receive-check" || command === "help" || command === "--help" || command === "--version"
      ? null
      : await Reveries.open(io.cwd);
    if (command === "--version") {
      io.stdout(`reveries ${VERSION}\n`);
      return 0;
    }
    if (command === "help") {
      const topic = argv[1];
      if (topic === undefined) io.stdout(HELP);
      else {
        const help = COMMAND_HELP[topic];
        if (help === undefined) throw new UsageError(`no help is available for ${topic}`);
        io.stdout(help);
      }
      return 0;
    }
    if (command === "--help") {
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
    if (command === "receive-check") {
      const parsed = parseArguments(
        argv.slice(1),
        ["--evidence", "--base-tree", "--notes-tip"],
        ["--json"],
      );
      const input = await parseReceiveInput(await io.stdin());
      const evidence = [
        ...(input.evidence ?? []),
        ...(parsed.values.get("--evidence") ?? []).map((value, index) => parseReceiveEvidence(value, index)),
      ];
      const baseTreeValue = one(parsed, "--base-tree");
      const baseTree = baseTreeValue === undefined
        ? input.baseTree
        : parseReceiveObject(baseTreeValue, "--base-tree");
      const notesTipValue = one(parsed, "--notes-tip");
      const updates = [...input.updates];
      if (notesTipValue !== undefined) {
        const notesTip = parseReceiveObject(notesTipValue, "--notes-tip");
        if (notesTip === null) throw new UsageError("--notes-tip cannot be zero");
        const existing = updates.findIndex((update) => update.ref === NOTES_REF);
        const notesUpdate = { ref: NOTES_REF, oldObject: null, newObject: notesTip };
        if (existing < 0) updates.push(notesUpdate);
        else updates.splice(existing, 1, notesUpdate);
      }
      const receive = await checkReceive(io.cwd, {
        updates,
        evidence,
        ...(baseTree === undefined || baseTree === null ? {} : { baseTree }),
      });
      emit(io, json, command, receive, receive.diagnostics);
      return receive.ok ? 0 : 1;
    }
    if (reveries === null) throw new Error("Reveries service was not opened");
    if (command === "show") {
      const parsed = parseArguments(argv.slice(1), [], ["--staged", "--json"]);
      const target = requirePositional(parsed, 0, "path or object");
      const result = await reveries.show({
        target,
        revision: parsed.flags.has("--staged") ? "index" : "HEAD",
      });
      emit(io, json, command, result, result.diagnostics, { target });
      return result.diagnostics.length === 0 ? 0 : 1;
    }
    if (command === "record") {
      const action = argv[1];
      if (action === "new" || action === "supersede") {
        const parsed = parseArguments(
          argv.slice(2),
          ["--from", "--old", "--session", "--driving-event", "--decision", "--impact", "--recurrence-control", "--alternative", "--source"],
          ["--staged", "--committed", "--json", "--no-recurrence-control", "--edit"],
        );
        const path = requirePositional(parsed, 0, "path");
        const from = one(parsed, "--from");
        const draftSource = await prepareDraft(await readDraft(from, io), parsed.flags.has("--edit"), io);
        const revision = parsed.flags.has("--committed") ? "HEAD" : "index";
        const result = await usePreparedDraft(draftSource, async (raw) => {
          const draft = await parseReverieDraft(raw, reveries, io, parsed);
          return action === "new"
            ? reveries.recordNew({ path, revision, ...draft })
            : reveries.recordSupersede({
                path,
                revision,
                ...draft,
                old: parseReverieId(one(parsed, "--old", true) ?? ""),
              });
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
      const parsed = parseArguments(
        argv.slice(1),
        ["--from", "--because", "--session", "--driving-event", "--decision", "--impact", "--recurrence-control", "--alternative", "--source", "--reverie", "--retire"],
        ["--replace", "--init", "--json", "--no-recurrence-control", "--edit"],
      );
      const commit = requirePositional(parsed, 0, "commit");
      const from = one(parsed, "--from");
      if (parsed.flags.has("--init")) {
        if (parsed.flags.has("--edit")) throw new UsageError("--edit does not apply with --init");
        if (from === undefined) throw new UsageError("--init requires --from reveries-init.json");
        if (parsed.values.has("--session") || parsed.values.has("--driving-event") || parsed.values.has("--decision")
          || parsed.values.has("--impact") || parsed.values.has("--recurrence-control") || parsed.flags.has("--no-recurrence-control")
          || parsed.values.has("--alternative") || parsed.values.has("--source") || parsed.values.has("--reverie")
          || parsed.values.has("--retire")) {
          throw new UsageError("causal summary options do not apply with --init");
        }
      }
      const draftSource = await prepareDraft(await readDraft(from, io), parsed.flags.has("--edit"), io);
      if (parsed.flags.has("--init")) {
        await usePreparedDraft(draftSource, async (raw) => {
          const init = parseProtocolRecordValue(raw, "reveries-init", from ?? "reveries-init draft");
          await reveries.attachInitialization({ commit, record: init });
        });
      } else {
        const because = one(parsed, "--because");
        await usePreparedDraft(draftSource, async (raw) => {
          const summary = await parseSummaryDraft(raw, reveries, io, parsed);
          await reveries.summarize({
            commit,
            summary: because === undefined ? summary : { ...summary, correction_reason: because },
            replace: parsed.flags.has("--replace"),
          });
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
      emit(io, json, command, result, [], { target });
      return 0;
    }
    if (command === "sync") {
      const parsed = parseArguments(argv.slice(1), [], ["--pull", "--status", "--json"]);
      if (parsed.flags.has("--pull") === parsed.flags.has("--status")) {
        throw new UsageError("choose exactly one of --pull or --status");
      }
      const remote = await remoteArgument(parsed, reveries);
      if (parsed.flags.has("--pull")) {
        const result = await reveries.syncPull(remote);
        emit(io, json, command, result, result.diagnostics, { remote });
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
        emit(io, json, command, result, [], { remote });
        return 0;
      }
    }
    if (command === "push") {
      const parsed = parseArguments(argv.slice(1), [], ["--json"]);
      const remote = await remoteArgument(parsed, reveries);
      const result = await reveries.push(remote);
      emit(io, json, command, result, result.diagnostics, { remote });
      return result.ok ? 0 : 1;
    }
    if (command === "doctor") {
      const parsed = parseArguments(argv.slice(1), [], ["--json", "--fix"]);
      const repair = parsed.flags.has("--fix")
        ? await repairLocalIntegration(io.cwd, io.helper === undefined ? {} : { helper: io.helper })
        : null;
      const result = await reveries.doctor();
      const diagnostics = [...result.diagnostics, ...(repair?.diagnostics ?? [])];
      emit(io, json, command, repair === null ? result : { ...result, repair }, diagnostics);
      return result.ok && repair?.state !== "unavailable" ? 0 : 1;
    }
    if (command === "pre-push") {
      const remote = argv[1];
      if (remote === undefined) throw new UsageError("pre-push requires the remote name from Git");
      const updates = parsePushUpdates(await io.stdin());
      const publishesBranch = updates.some(
        (update) => update.localRef.startsWith("refs/heads/") && update.localObject !== null,
      );
      if (publishesBranch && (io.environment ?? process.env)[INTERNAL_ATOMIC_PUSH_ENV] !== "1") {
        const diagnostics = [
          "Raw branch publication is disabled; use reveries push for atomic publication or --no-verify for an explicit bypass",
        ];
        emit(io, false, command, undefined, diagnostics);
        return 1;
      }
      const result = await reveries.checkOutgoingUpdates(remote, updates);
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
    if (error instanceof EditorCancelledError) {
      io.stderr(`${message}\n`);
      return 1;
    }
    if (error instanceof UsageError) {
      const hint = command === "help" ? "reveries --help" : `reveries help ${command ?? "<command>"}`;
      io.stderr(`${message}\nTry '${hint}' for usage.\n`);
      return 3;
    }
    if (json) io.stdout(`${JSON.stringify({ ok: false, command: command ?? null, diagnostics: [message] })}\n`);
    else io.stderr(`${message}\n`);
    return 2;
  }
}
