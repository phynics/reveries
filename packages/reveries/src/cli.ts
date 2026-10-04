#!/usr/bin/env node

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { initializeRepository, type HelperInvocation } from "./install.ts";
import { INTERNAL_ATOMIC_PUSH_ENV, NOTES_REF } from "./git.ts";
import { SUGGESTION_NOTICE, suggestionCommand } from "./lineage.ts";
import { Reveries, type PushUpdate } from "./operations.ts";
import {
  LINEAGE_KINDS,
  blobId,
  commitId,
  objectId,
  parseNote,
  reverieId,
  validateNote,
  type LineageKind,
  type NoteRecord,
  type ObjectId,
  type ReverieInput,
  type ReverieMetadata,
  type ReverieRecord,
  type Source,
  type SourceKind,
  type SourceRelation,
  type SubjectId,
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
const KINDS = new Set<SourceKind>(["commit", "blob", "tree", "path", "note", "git-email", "issue", "confidential-pointer"]);
const VERSION = "1.0.2";
const HELP = `reveries <command>

Reveries is a Git evidence format. Decisions live in Git notes at
refs/notes/reveries; this CLI is a convenience over ordinary Git.

Commands:
  help       Show general or command-specific help
  init       Prepare the notes merge strategy and the instructions block
  doctor     Report the health of the notes ref and the retention ref
  show       Show notes for a path, blob, tree, or commit
  record     Create or supersede a reverie on a blob or a region of one
  link       Record explicit lineage, or suggest candidates
  search     Search current or historical engineering evidence
  history    Trace a path or reverie through history
  sync       Inspect or pull a publishing remote's notes
  push       Atomically push HEAD and refs/notes/reveries

Use --json on inspection commands for stable machine output.
`;

const COMMAND_HELP: Readonly<Record<string, string>> = {
  help: `Usage: reveries help [<command>]

Show general help or usage for one command.
Examples:
  reveries help
  reveries help record
`,
  init: `Usage: reveries init [--json]

Prepare this repository for Reveries evidence. Writes the owned instructions
block into AGENTS.md and sets notes.reveries.mergeStrategy to cat_sort_uniq so
two clones' notes refs combine by union.

It installs no hooks, configures no remote, and creates no trust store:
Reveries does not gate commits or pushes.
Examples:
  reveries init
`,
  doctor: `Usage: reveries doctor [--json]

Report the health of refs/notes/reveries and refs/reveries/retention. Exits
non-zero only for damage: a record that fails validation, or a retained object
that is no longer reachable.
Examples:
  reveries doctor
  reveries doctor --json
`,
  show: `Usage: reveries show <path|blob|tree|commit> [--staged] [--json]

Show active and historical evidence for a Git object. Directory paths and raw
tree object IDs resolve to the exact subtree; the decision shown applies to
every occurrence of that exact content.
Examples:
  reveries show src/state.ts
  reveries show src/state.ts --staged
  reveries show src/module
`,
  record: `Usage: reveries record <new|supersede> <path> [--start-line <n> --end-line <n>] [--from <file|->] [causal options]
       reveries record continue --from-blob <blob> --to-blob <blob> --id <reverie-id>

Create or supersede a reverie on a file blob, a directory tree, or an exact
region of a blob. The decision applies universally to every occurrence of the
exact recorded content; a region adds an exact_region fingerprint over the
selected lines, and the line numbers are navigation hints only.
Options: --driving-event <text>, --decision <text>, --impact <text>,
         --recurrence-control <text>|--no-recurrence-control, --alternative <text>,
         --source <relation:kind:ref[@at]>, --session <name>, --edit,
         --committed, --staged, --old <reverie-id>, --json
Examples:
  reveries record new src/state.ts --driving-event "A transition failed" --decision "Guard it" --impact "All writers are checked"
  reveries record new src/state.ts --start-line 10 --end-line 20 --driving-event "This loop is load-bearing" --decision "Keep it sequential" --impact "Parallelising it breaks ordering"
  reveries record new src/state.ts --from draft.json --edit
  cat draft.json | reveries record new src/state.ts --from -
`,
  link: `Usage: reveries link --kind <preserve|derive|split|merge|retire> --commit <commit> --from <path>... --to <path>... [--parent <commit>] [causal options]
       reveries link suggest [<commit>|--staged] [--json]

Record explicit lineage between subject occurrences. The immutable record is
written to the note of every --to endpoint when --to is non-empty, otherwise
to every --from endpoint, so the edge is discoverable from either end. Because
endpoints are object IDs, the edge survives a rebase.

lineage is never inferred: a similarity hint may suggest an edge, but only
recording it establishes one. An edge discharges no obligation; continuity is
known only when explicit lineage or a retirement exists.
Options: --driving-event <text>, --decision <text>, --impact <text>,
         --recurrence-control <text>|--no-recurrence-control, --alternative <text>,
         --source <relation:kind:ref[@at]>, --session <name>, --from-file <file|->, --staged, --json
Examples:
  reveries link suggest --staged
  reveries link --kind preserve --commit HEAD --from src/module --to lib/module --driving-event "Moved" --decision "Same intent" --impact "Paths change"
  reveries link --kind split --commit HEAD --parent HEAD~1 --from lib/util.js --to lib/a.js --to lib/b.js --driving-event "Split" --decision "Two concerns" --impact "Callers update"
`,
  lineage: `Usage: reveries link --kind <preserve|derive|split|merge|retire> --commit <commit> --from <path>... --to <path>... [causal options]
       reveries link suggest [<commit>|--staged] [--json]

lineage was renamed; use reveries link. The text below is the link help.
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
branch upstream or the sole configured publishing remote. A plain
git push refs/notes/reveries is equally valid; this command only adds the
single atomic ref transaction.
Examples:
  reveries push
  reveries push origin
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

function integerFlag(value: string, name: string): number {
  if (!/^[0-9]+$/.test(value)) throw new UsageError(`${name} must be a positive integer`);
  const parsed = Number.parseInt(value, 10);
  if (parsed < 1) throw new UsageError(`${name} must be a positive integer`);
  return parsed;
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

/** Parse one ID a hard redaction may name, using the protocol's own vocabulary. */
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

function parseLineageKind(value: string | undefined): LineageKind {
  if (value === undefined) throw new UsageError("link requires --kind");
  if (!LINEAGE_KINDS.includes(value as LineageKind)) {
    throw new UsageError(`--kind must be one of ${LINEAGE_KINDS.join(", ")}`);
  }
  return value as LineageKind;
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

type HumanContext = {
  readonly remote?: string;
  readonly target?: string;
};

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
    const region = asRecord(value.region);
    return [
      `${indent}${stringField(value, "id")}: ${stringField(value, "decision")}`,
      ...(region === null ? [] : [
        `${indent}  Region: ${String(stringField(region, "blob")).slice(0, 12)} lines ${String(region.start_line_hint)}-${String(region.end_line_hint)} (exact ${String(stringField(region, "exact_hash")).slice(0, 12)})`,
      ]),
      `${indent}  Event: ${stringField(value, "driving_event")}`,
      `${indent}  Impact: ${stringField(value, "impact")}`,
    ];
  }
  if (value.type === "occurrence") {
    const occurrence = asRecord(value.occurrence) ?? {};
    return [
      `${indent}${stringField(value, "id")} (occurrence at ${stringField(occurrence, "path")} @ ${stringField(occurrence, "commit").slice(0, 12)}): ${stringField(value, "decision")}`,
      `${indent}  Event: ${stringField(value, "driving_event")}`,
      `${indent}  Impact: ${stringField(value, "impact")}`,
    ];
  }
  if (value.type === "lineage") {
    const endpoints = (input: unknown): string => {
      const entries = Array.isArray(input) ? input : [];
      return entries
        .map((entry) => {
          const item = asRecord(entry) ?? {};
          return `${stringField(item, "path")}@${String(stringField(item, "subject", "")).slice(0, 12)}`;
        })
        .join(", ");
    };
    const to = endpoints(value.to);
    return [
      `${indent}${stringField(value, "id")}: ${stringField(value, "kind")} ${endpoints(value.from)}${to === "" ? " -> (no successor)" : ` -> ${to}`}`,
      `${indent}  Bound to parent ${String(stringField(value, "parent", "")).slice(0, 12)} -> commit ${String(stringField(value, "commit", "")).slice(0, 12)}`,
      `${indent}  Event: ${stringField(value, "driving_event")}`,
      `${indent}  Decision: ${stringField(value, "decision")}`,
      `${indent}  Impact: ${stringField(value, "impact")}`,
      `${indent}  This pairing discharges nothing: each decision on a predecessor still needs a continuation on every successor, a supersession, or a retirement.`,
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

/**
 * Doctor notices that already have a dedicated line.
 *
 * These are blocks an operator reads as their own question, so a generic
 * `Notice:` copy of the same sentence is noise that trains the reader to skip the
 * block. The prefixes are the exact strings core emits.
 */
function humanOutput(
  command: string,
  result: unknown,
  context: HumanContext,
): string {
  const value = asRecord(result);
  if (command === "doctor") {
    const lines = [`Reveries doctor: ${stringField(value ?? {}, "state")}.`];
    const retention = asRecord(value?.retention);
    if (retention !== null) {
      lines.push(
        `Retention: ${stringField(retention, "policy")}; ${stringField(retention, "state")}; `
        + `${Array.isArray(retention.retained) ? retention.retained.length : 0} of `
        + `${Array.isArray(retention.expected) ? retention.expected.length : 0} annotated subject(s) kept.`,
      );
    }
    return `${lines.join("\n")}\n`;
  }
  if (command === "show") {
    const object = stringField(value ?? {}, "object");
    const objectType = stringField(value ?? {}, "objectType", "object");
    const active = Array.isArray(value?.active) ? value.active : [];
    const historical = Array.isArray(value?.historical) ? value.historical : [];
    const notices = Array.isArray(value?.notices) ? value.notices.filter((item): item is string => typeof item === "string") : [];
    const lines = [`${context.target ?? object}: ${objectType} ${object}`];
    if (active.length === 0 && historical.length === 0) lines.push("  No evidence is attached.");
    if (active.length > 0) {
      lines.push(`  Active (${active.length}):`);
      for (const entry of active) lines.push(...formatRecord(entry, "    "));
    }
    if (historical.length > 0) {
      lines.push(`  Historical (${historical.length}):`);
      for (const entry of historical) lines.push(...formatRecord(entry, "    "));
    }
    for (const notice of notices) lines.push(`  Notice: ${notice}`);
    return `${lines.join("\n")}\n`;
  }
  if (command === "record new" || command === "record supersede" || command === "link") {
    const verb = command === "link" ? "Recorded lineage" : `Recorded reverie`;
    const lines = [`${verb} ${stringField(asRecord(value?.record) ?? {}, "id")}:`];
    lines.push(...formatRecord(value?.record, "  "));
    const paths = Array.isArray(value?.paths) ? value.paths.filter((item): item is string => typeof item === "string") : [];
    if (paths.length > 0) lines.push(`  Applies to every occurrence of the exact recorded content: ${paths.join(", ")}`);
    return `${lines.join("\n")}\n`;
  }
  if (command === "link suggest") {
    const suggestions = Array.isArray(value) ? value : [];
    if (suggestions.length === 0) return "No similarity candidates were found.\n";
    if (context.remote !== undefined) return `${SUGGESTION_NOTICE}\n`;
    return "Similarity candidates are not evidence. Recording an edge establishes one.\n"
      + `${suggestions.map((entry) => `  ${asRecord(entry)?.path ?? ""}`).join("\n")}\n`;
  }
  if (command === "search") {
    const hits = Array.isArray(result) ? result : [];
    if (hits.length === 0) return "No evidence matched.\n";
    const lines = [`Found ${hits.length} matching record(s):`];
    for (const hit of hits) {
      const entry = asRecord(hit) ?? {};
      const record = asRecord(entry.record) ?? {};
      const semantic = asRecord(record.semantic) ?? record;
      lines.push(`  ${stringField(entry, "object").slice(0, 12)} ${stringField(record, "type", "record")}: ${stringField(semantic, "decision", "")}`);
    }
    return `${lines.join("\n")}\n`;
  }
  if (command === "history") {
    const entries = Array.isArray(result) ? result : [];
    if (entries.length === 0) return "No history was found for that path.\n";
    const lines = [`History for ${context.target ?? "the target"} (${entries.length} entr${entries.length === 1 ? "y" : "ies"}):`];
    for (const entry of entries) {
      const item = asRecord(entry) ?? {};
      const records = Array.isArray(item.records) ? item.records : [];
      const descriptions = records.map((record) => {
        const container = asRecord(record) ?? {};
        const semantic = asRecord(container.semantic) ?? container;
        return stringField(semantic, "decision", "");
      }).filter(Boolean);
      lines.push(`  ${stringField(item, "commit").slice(0, 12)} ${stringField(item, "blob", "").slice(0, 12)}: ${descriptions.join("; ")}`);
    }
    return `${lines.join("\n")}\n`;
  }
  if (command === "sync") {
    return `${context.remote ?? "remote"}: ${stringField(value ?? {}, "state")}\n`;
  }
  if (command === "push") {
    return value?.ok === true
      ? `Published ${context.remote ?? "the remote"} branch and refs/notes/reveries atomically.\n`
      : "Publication failed.\n";
  }
  return "";
}

function emit(
  io: CliIo,
  json: boolean,
  command: string,
  result: unknown,
  diagnostics: readonly string[] = [],
  context: HumanContext = {},
  notices: readonly string[] = [],
): void {
  if (json) {
    // `notices` is added only when there is something to notice, so a command
    // with no notices keeps a byte-identical envelope. Machine consumers of the
    // existing four keys are unaffected, and the exact-envelope contract stays
    // testable for every command that has no notice to report.
    io.stdout(`${JSON.stringify({
      ok: diagnostics.length === 0,
      command,
      result,
      diagnostics,
      ...(notices.length === 0 ? {} : { notices }),
    })}\n`);
    return;
  }
  const output = humanOutput(command, result, context);
  if (output.length > 0) io.stdout(output);
  for (const notice of notices) io.stdout(`Notice: ${notice}\n`);
  for (const diagnostic of diagnostics) io.stderr(`${diagnostic}\n`);
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

export async function runCli(argv: readonly string[], io: CliIo = defaultIo()): Promise<ExitCode> {
  const json = argv.includes("--json");
  const command = argv[0];
  try {
    if (command === undefined) throw new UsageError("a command is required");
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
      // Reveries no longer decides which commits may be published. The command
      // survives so an existing hook does not break, and it only reports what
      // Git already knows: which refs are moving.
      emit(io, false, command, updates.map((update) => ({
        localRef: update.localRef,
        remoteRef: update.remoteRef,
        localObject: update.localObject,
      })));
      return 0;
    }
    if (command === "post-commit") {
      // A retired enforcement hook. It used to refuse a commit without a session
      // summary; a commit is now always allowed, so the command reports nothing
      // and exits zero rather than breaking an installed hook.
      emit(io, false, command, { ok: true, diagnostics: [] });
      return 0;
    }
    if (command === "init") {
      const parsed = parseArguments(argv.slice(1), [], ["--json"]);
      if (parsed.positionals.length > 0) throw new UsageError(`init takes no arguments`);
      const result = await initializeRepository(io.cwd, io.helper === undefined ? {} : { helper: io.helper });
      emit(io, json, command, result);
      return 0;
    }

    const reveries = await Reveries.open(io.cwd);

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
          ["--from", "--old", "--session", "--driving-event", "--decision", "--impact", "--recurrence-control", "--alternative", "--source", "--start-line", "--end-line"],
          ["--staged", "--committed", "--json", "--no-recurrence-control", "--edit"],
        );
        const path = requirePositional(parsed, 0, "path");
        const from = one(parsed, "--from");
        const startLine = one(parsed, "--start-line");
        const endLine = one(parsed, "--end-line");
        if ((startLine === undefined) !== (endLine === undefined)) {
          throw new UsageError("--start-line and --end-line must be provided together");
        }
        const region = startLine === undefined || endLine === undefined
          ? undefined
          : { start_line: integerFlag(startLine, "--start-line"), end_line: integerFlag(endLine, "--end-line") };
        const draftSource = await prepareDraft(await readDraft(from, io), parsed.flags.has("--edit"), io);
        const revision = parsed.flags.has("--committed") ? "HEAD" : "index";
        const result = await usePreparedDraft(draftSource, async (raw) => {
          const draft = await parseReverieDraft(raw, reveries, io, parsed);
          return action === "new"
            ? reveries.recordNew({ path, revision, ...draft, ...(region === undefined ? {} : { region }) })
            : reveries.recordSupersede({
                path,
                revision,
                ...draft,
                ...(region === undefined ? {} : { region }),
                old: parseReverieId(one(parsed, "--old", true) ?? ""),
              });
        });
        emit(io, json, `${command} ${action}`, result);
        return 0;
      }
      if (action === "continue") {
        const parsed = parseArguments(argv.slice(2), ["--from-blob", "--to-blob", "--id"], ["--json"]);
        const result = await reveries.recordContinueToBlob({
          fromBlob: objectId(one(parsed, "--from-blob", true) ?? ""),
          toBlob: objectId(one(parsed, "--to-blob", true) ?? ""),
          id: reverieId(one(parsed, "--id", true) ?? ""),
        });
        emit(io, json, `${command} ${action}`, result);
        return 0;
      }
      throw new UsageError("record action must be new, continue, or supersede");
    }
    if (command === "link" || command === "lineage") {
      const action = argv[1];
      if (action === "suggest") {
        const parsed = parseArguments(argv.slice(2), [], ["--staged", "--json"]);
        const result = await reveries.suggestLineage({
          staged: parsed.flags.has("--staged"),
          ...(parsed.positionals[0] === undefined ? {} : { revision: parsed.positionals[0] }),
        });
        emit(io, json, "link suggest", result, [], {});
        return 0;
      }
      if (command === "lineage" && action !== "suggest") {
        throw new UsageError("lineage record was replaced by link; run reveries link --help");
      }
      const parsed = parseArguments(
        argv.slice(1),
        ["--kind", "--commit", "--parent", "--from", "--to", "--from-file", "--session", "--driving-event", "--decision", "--impact", "--recurrence-control", "--alternative", "--source"],
        ["--json", "--no-recurrence-control", "--staged", "--edit"],
      );
      const kind = parseLineageKind(one(parsed, "--kind"));
      const commit = one(parsed, "--commit");
      const from = parsed.values.get("--from") ?? [];
      const to = parsed.values.get("--to") ?? [];
      if (from.length === 0) throw new UsageError("link requires at least one --from");
      const raw = await readDraft(one(parsed, "--from-file"), io);
      const draftSource = await prepareDraft(raw, parsed.flags.has("--edit"), io);
      const parent = one(parsed, "--parent")
        ?? (commit === undefined ? "HEAD" : `${commit}~1`);
      const result = await usePreparedDraft(draftSource, async (draftRaw) => {
        const value = expectObject(draftRaw, "lineage draft");
        if (value.type !== undefined && value.type !== "lineage") {
          throw new UsageError("lineage draft type must be lineage");
        }
        const semantic = {
          driving_event: expectString(one(parsed, "--driving-event") ?? value.driving_event, "driving_event"),
          decision: expectString(one(parsed, "--decision") ?? value.decision, "decision"),
          impact: expectString(one(parsed, "--impact") ?? value.impact, "impact"),
          recurrence_control: overlayRecurrence(value.recurrence_control, parsed),
          alternatives: overlayAlternatives(value.alternatives, parsed),
          sources: overlaySources(value.sources, parsed),
        };
        const metadata = await parseMetadata(value, reveries, io, parsed);
        return reveries.link({
          kind,
          commit: commit ?? "HEAD",
          parent,
          from,
          to,
          semantic,
          metadata,
        });
      });
      emit(io, json, command, result);
      return 0;
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
    if (command === "push") {
      const parsed = parseArguments(argv.slice(1), [], ["--json"]);
      const remote = await remoteArgument(parsed, reveries);
      const result = await reveries.push(remote);
      emit(io, json, command, result, result.diagnostics, { remote });
      return result.ok ? 0 : 1;
    }
    if (command === "doctor") {
      const parsed = parseArguments(argv.slice(1), [], ["--json"]);
      if (parsed.positionals.length > 0) throw new UsageError("doctor takes no arguments");
      const result = await reveries.doctor();
      emit(io, json, command, result, result.diagnostics);
      return result.ok ? 0 : 1;
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
