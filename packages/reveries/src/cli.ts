#!/usr/bin/env node

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createPublicKey } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  commitAdoption,
  createPrivateKeyFile,
  initializeRepository,
  readLocalTrustStore,
  removeIntegration,
  repairLocalIntegration,
  resolvePrivateKeyPath,
  trustStoreEntry,
  upsertTrustKey,
  writeLocalTrustStore,
  type HelperInvocation,
  type SkillSetup,
  type SupportedHost,
} from "./install.ts";
import {
  INTERNAL_ATOMIC_PUSH_ENV,
  LEDGER_REF,
  NOTES_REF,
  createLocalEd25519Signer,
  createLocalEd25519Verifier,
  ed25519KeyId,
  generateEd25519KeyPair,
  type TrustStoreFile,
  type TrustStoreKey,
} from "./git.ts";
import { adaptHostEvent, handleHookEvent } from "./hooks.ts";
import { Reveries, type PushUpdate, type SigningOptions } from "./operations.ts";
import { checkReceive, type ReceiveCheckInput, type ReceiveEvidence, type ReceiveRefUpdate } from "./receive.ts";
import {
  REMOTE_ROLES,
  SIGNATURE_ROLES,
  canonicalRecord,
  blobId,
  commitId,
  factTargetId,
  objectId,
  parseNote,
  readLedgerManifest,
  recordFactId,
  remoteRole,
  rolePromotion,
  reverieId,
  validateNote,
  type FactTargetId,
  type LedgerManifest,
  type NoteRecord,
  type ObjectId,
  type ReverieInput,
  type ReverieMetadata,
  type ReverieRecord,
  type ReveriesInit,
  type RemoteRole,
  type Retirement,
  type SessionSummary,
  type SignatureRole,
  type SignatureRecord,
  type Source,
  type SourceKind,
  type SourceRelation,
  type TrustState,
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
  ledger     Inspect, advance, or materialize the protected ledger envelope
  role       Show, set, or clear the role a publishing remote plays
  policy     Show, set, or clear the signature roles this repository requires
  sign       Attest one record with the configured signing key
  verify     Report what is established about signatures and the checkpoint
  trust      Inspect and manage the local trust store
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
  ledger: `Usage: reveries ledger <status|build|materialize> [<revision>] [--json]

Inspect, advance, or materialize the protected ledger envelope on
refs/heads/reveries-ledger. The envelope carries the exact notes commit as a
typed parent, so a clone can recover its evidence from an ordinary branch fetch.

  status       Report how the envelope relates to the local notes ref.
  build        Advance the envelope over the current notes tip. Only ever
               appends: a line the previous envelope carried cannot be dropped.
  materialize  Recreate refs/notes/reveries from a verified envelope. Refuses
               when the local notes ref carries records the envelope does not.

materialize never overwrites local notes it cannot prove the envelope already
contains. Pass <revision> to name a remote envelope, such as
refs/remotes/origin/reveries-ledger in a fresh clone.

  build advances the envelope over the current notes tip and stamps it with the
       primary remote resolved from reveries.remoteRole.*. Options:
       --authority <remote>, --no-authority to stamp none, --sign, --no-sign to
       skip the manifest attestation, --signing-role <role>.
       build is an append: each call is a new checkpoint whose manifest names the
       previous one, so a repeated build is never a no-op.

A sync materializes a remote's envelope only when that remote's notes were
promoted. When the notes are quarantined or the remote is refused, the envelope is
left alone: it carries the same evidence, so materializing it would hand the
promotion decision to whichever route ran second.
Examples:
  reveries ledger status
  reveries ledger build
  reveries ledger build --no-sign --no-authority
  reveries ledger materialize refs/remotes/origin/reveries-ledger
`,
  role: `Usage: reveries role <show|set|clear> [<remote> [<role>]] [--json]

Show, set, or clear the role a remote plays in authoritative publication.
Roles are primary, mirror, archive, and import-only. They are declared as
reveries.remoteRole.<remote> and resolved into at most one primary. A remote with
no declared role keeps the pre-role behaviour, and a repository that never
declares one is unaffected.
Examples:
  reveries role show
  reveries role set origin primary
  reveries role set backup mirror
  reveries role clear backup
`,
  policy: `Usage: reveries policy <show|set|clear> [<role[,role]>] [--json]

Show, set, or clear the signature roles this repository requires, stored as
reveries.signingRoles. A signature is trusted when the trust store binds its key
to its signer, and policy-satisfying when the signed role is also one this
repository requires. An empty list means trusted is the strongest state
reachable here.
Examples:
  reveries policy show
  reveries policy set author,reviewer
  reveries policy clear
`,
  sign: `Usage: reveries sign <rv:|tr:|cr:|rs:|rd: id> [--role <role>] [--key <path>] [--json]

Attest one record with the configured signing key and append the signature to the
annotated subject's note. The target must already be in the current notes, so a
signature always covers bytes this repository actually holds.

The signer identity is never typed: the key's own fingerprint is looked up in the
trust store, and a key with no entry is refused. Precedence for the key is --key,
then REVERIES_SIGNING_KEY, then reveries.signingKey. A repository with no key
configured is unsigned, which is an ordinary state.

The signature covers the protocol domain, role, target, subject, signer,
algorithm, and the target's content hash. The signature record's own author_email,
session, and created_at are outside that payload and are not attested.
Examples:
  reveries sign rv:<id>
  reveries sign rv:<id> --role reviewer
  reveries sign rv:<id> --key ~/.config/reveries/signing.pem
`,
  verify: `Usage: reveries verify [<target-id>] [--ledger] [--require-policy] [--json]

Report what is established about this repository's signatures.

Trust is reported at face value. unknown means the key is not in the trust store,
valid means the bytes verify without an identity binding, trusted means the store
binds the key to the signer, and policy-satisfying additionally means the role is
required. Only invalid and revoked are failures.

--require-policy asks a different question: whether this repository's own policy
is satisfied. It fails for every state below policy-satisfying, including a
repository with no signatures at all.

--ledger verifies the checkpoint envelope and reports its manifest attestation.
A structurally invalid envelope always fails, whatever the policy says.
Examples:
  reveries verify
  reveries verify rv:<id> --json
  reveries verify --require-policy
  reveries verify --ledger
`,
  trust: `Usage: reveries trust <init|list|add|remove|revoke|restore> [options] [--json]

Inspect and manage the local trust store, which binds a public key to the identity
it is authorized to speak for. It lives in the Git common directory by default, so
no clone receives it, and reveries.trustStore overrides the path.

  init     Generate an ed25519 key pair. The private key is written only to the
           --key-file you name, with mode 0600 and never overwriting an existing
           file, and a path inside the repository or its Git directory is refused.
           Only the public key is registered.
  list     Show the store path and every entry with its revocation state.
  add      Register an existing public key from a PEM public key file
           (-----BEGIN PUBLIC KEY-----). An OpenSSH public key
           (ssh-ed25519 AAAA...) and a private key are refused.
  remove   Drop an entry. Existing signatures stay in the notes and report unknown.
  revoke   Mark a key revoked. Its signatures stay visible and report revoked.
  restore  Un-revoke a key.

A signer identity must be email shaped, because a ledger manifest signature records
it as the author email. Revoking never removes evidence.
Examples:
  reveries trust list
  reveries trust init --signer me@example.com --key-file ~/.config/reveries/signing.pem
  reveries trust add --signer me@example.com --from-file reveries.pub.pem
  reveries trust revoke --key SHA256:...
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
    const prDescription = proposal.pr_description === undefined
      ? undefined
      : expectString(proposal.pr_description, "receive proposal.pr_description");
    const allowPrDescriptionSummary = proposal.allow_pr_description_summary === undefined
      ? undefined
      : typeof proposal.allow_pr_description_summary === "boolean"
        ? proposal.allow_pr_description_summary
        : (() => { throw new UsageError("receive proposal.allow_pr_description_summary must be a boolean"); })();
    return {
      updates: proposal.updates.map(parseReceiveUpdate),
      evidence,
      ...(baseTree === undefined || baseTree === null ? {} : { baseTree }),
      ...(prDescription === undefined ? {} : { prDescription }),
      ...(allowPrDescriptionSummary === undefined ? {} : { allowPrDescriptionSummary }),
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

/**
 * Doctor notices that already have a dedicated line.
 *
 * These are blocks an operator reads as their own question, so a generic
 * `Notice:` copy of the same sentence is noise that trains the reader to skip the
 * block. The prefixes are the exact strings core emits.
 */
const DEDICATED_DOCTOR_PREFIXES: readonly string[] = [
  "Ledger:",
  "Signatures:",
  "Authority:",
  "Mirror ",
  "Retention:",
];

/**
 * One human-readable line for a ledger block, whether it came from `doctor`,
 * `sync`, or `ledger status`.
 *
 * The state is spelled out rather than reduced to a notice, because the four
 * states mean different things: `absent` is a repository that never adopted the
 * envelope, `stale` is a healthy repository that has not rebuilt it over its
 * newest notes, and only `invalid` is damage.
 */
function describeLedger(block: unknown): string | null {
  const ledger = asRecord(block);
  if (ledger === null) return null;
  const state = stringField(ledger, "state", "absent");
  const tip = ledger.tip === null || ledger.tip === undefined ? "none" : String(ledger.tip);
  const subjects = ledger.annotatedSubjects === undefined
    ? "0"
    : String(ledger.annotatedSubjects);
  const relation = state === "valid"
    ? "the local notes ref matches it"
    : state === "stale"
      ? "the local notes ref is ahead of it"
      : state === "invalid"
        ? "the envelope failed verification"
        : "no checkpoint exists";
  return `Ledger: ${state}; tip ${tip}; ${subjects} annotated subject(s) transported; ${relation}.`;
}

function humanOutput(
  command: string,
  result: unknown,
  context: HumanContext,
): string {
  const value = asRecord(result);
  if (command === "ledger status") {
    return `${describeLedger(value) ?? "No Reveries ledger envelope is available."}\n`;
  }
  if (command === "ledger build" || command === "ledger materialize") {
    const state = stringField(value ?? {}, "state");
    const tip = value?.checkpoint === null || value?.checkpoint === undefined
      ? "none"
      : String(value.checkpoint);
    const sentences: Record<string, string> = {
      created: `Ledger checkpoint advanced to ${tip}.`,
      unchanged: `The ledger envelope already describes the current notes tip (${tip}).`,
      "up-to-date": `The notes ref already matches the envelope ${tip}.`,
      materialized: `Materialized ${NOTES_REF} from the ledger envelope ${tip}.`,
      absent: "No Reveries ledger envelope is available.",
      "local-ahead": "The local notes ref was left unchanged; it carries records the envelope does not.",
      refused: `The ledger envelope was refused; the notes ref was left unchanged (${tip}).`,
    };
    const base = sentences[state] ?? `Ledger ${state} (${tip}).`;
    if (command !== "ledger build") return `${base}\n`;
    // A build is an append, never an idempotent no-op: the manifest names the
    // previous ledger, so each build is a new checkpoint over a new
    // `previous_ledger`. Saying so is the difference between an operator who
    // trusts the envelope and one who assumes a second build changed nothing.
    //
    // The authority rendered here is the one the checkpoint actually carries. When
    // an explicit `--authority` named something other than the resolved primary,
    // both are shown, because a reader who sees only the stamp would not know a
    // divergence had been requested.
    const authority = value?.authority === null || value?.authority === undefined
      ? "none"
      : String(value.authority);
    const resolved = value?.authorityResolved === null || value?.authorityResolved === undefined
      ? null
      : String(value.authorityResolved);
    const divergence = resolved !== null && resolved !== authority ? ` (resolved primary is ${resolved})` : "";
    const attestation = value?.signed === true
      ? `signed over the manifest (${stringField(value ?? {}, "reason")})`
      : `unsigned (${stringField(value ?? {}, "reason")})`;
    return `${base} Authority: ${authority}${divergence}; manifest ${attestation}.\n`;
  }
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
    const ledgerLine = describeLedger(value?.ledger);
    if (ledgerLine !== null) lines.push(ledgerLine);
    // Signature, authority, mirror, and trust each get their own line rather than
    // a generic `Notice:`, because an operator reads them as four separate
    // questions. The matching notices are filtered out below so no fact is
    // printed twice.
    const signatures = asRecord(value?.signatures);
    if (signatures !== null) {
      const counts = asRecord(signatures.counts) ?? {};
      const tally = TRUST_STATES.map((state) => `${String(counts[state] ?? 0)} ${state}`).join(", ");
      lines.push(
        `Signatures: ${stringField(signatures, "state")}; checkpoint ${stringField(signatures, "checkpoint", "none")}; `
        + `manifest ${signatures.checkpointSigned === true ? "signed" : "unsigned"}; ${tally}.`,
      );
    }
    const authority = asRecord(value?.authority);
    if (authority !== null) {
      const roles = authority.roles !== null && typeof authority.roles === "object" ? authority.roles as Record<string, unknown> : {};
      const count = (role: string): number => Object.values(roles).filter((entry) => entry === role).length;
      lines.push(
        `Authority: ${stringField(authority, "state")}; primary ${stringField(authority, "primary", "none")}; `
        + `${count("mirror")} mirror(s), ${count("archive")} archive(s), ${count("import-only")} import-only.`,
      );
    }
    for (const mirror of Array.isArray(value?.mirrors) ? value.mirrors : []) {
      const entry = asRecord(mirror);
      if (entry === null) continue;
      lines.push(
        `Mirror ${stringField(entry, "remote")}: ${stringField(entry, "state")}; `
        + `checkpoint ${stringField(entry, "checkpoint", "none")}; `
        + `signature ${entry.signature === null || entry.signature === undefined ? "none" : String(entry.signature)}.`,
      );
    }
    const trust = asRecord(value?.trust);
    if (trust !== null) {
      lines.push(
        `Trust store: ${stringField(trust, "path")}; ${String(trust.keys ?? 0)} key(s); `
        + `${String(trust.revoked ?? 0)} revoked; signing key ${trust.keyLoaded === true ? "loaded" : "absent"}.`,
      );
    }
    const repair = asRecord(value?.repair);
    if (repair !== null) {
      lines.push(`Repair: ${stringField(repair, "state")}.`);
      for (const snippet of stringList(repair.hookSnippets)) {
        lines.push(`Add this to the ${/(\S+)\s+"\$@"$/.exec(snippet)?.[1] ?? "matching"} hook: ${snippet}`);
      }
    }
    for (const notice of stringList(value?.notices)) {
      // The blocks above already have their own lines. Repeating them inside a
      // generic notice would print "Notice: Ledger:" and read as two different
      // things, and it would train an operator to skip the block that matters.
      if (DEDICATED_DOCTOR_PREFIXES.some((prefix) => notice.startsWith(prefix))) continue;
      lines.push(`Notice: ${notice}`);
    }
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
    const ledger = asRecord(value?.ledger);
    const ledgerLine = ledger === null
      ? null
      : ledger.state === "skipped"
        ? `Ledger: not materialized (${stringField(ledger, "reason", "the promotion decision withheld it")}).`
        : `Ledger: ${stringField(ledger, "state")}${
          ledger.notesCommit === null || ledger.notesCommit === undefined
            ? "."
            : `; notes tip ${String(ledger.notesTip ?? "none")}.`
        }`;
    if (state === "equal" || state === "diverged" || state === "unknown") {
      return [
        `Notes status for ${context.remote ?? "the remote"}: ${state} (local ${String(value?.local ?? "none")}, remote ${String(value?.remote ?? "none")}).`,
        ...(ledgerLine === null ? [] : [ledgerLine]),
        "",
      ].join("\n");
    }
    // A held candidate is the outcome, not an aside: the operator has to be able
    // to see that the evidence was validated, where it was parked, and that
    // canonical state did not move.
    const quarantineRef = value?.quarantineRef;
    const held = typeof quarantineRef === "string" && quarantineRef.length > 0;
    return [
      held
        ? `Fetched Reveries notes from ${context.remote ?? "the remote"}; the validated union is quarantined at ${quarantineRef} and ${NOTES_REF} is unchanged.`
        : state === "remote-notes-absent"
          ? `No Reveries notes are published on ${context.remote ?? "the remote"}.`
          : `Fetched Reveries notes from ${context.remote ?? "the remote"}.`,
      ...(ledgerLine === null ? [] : [ledgerLine]),
      "",
    ].join("\n");
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
    const cleared = stringList(value?.removedTrustConfig);
    const store = asRecord(value?.trustStore);
    const lines = [value?.removed === true
      ? "Removed Reveries integration. Evidence was preserved."
      : "No Reveries integration was removed."];
    // Removal clears configuration and never deletes trust material, so the one
    // thing worth stating about the trust store is that it was left alone and
    // where it is. A reader who assumed otherwise would have to go looking for a
    // file that was never touched.
    if (cleared.length > 0) lines.push(`Cleared local configuration: ${cleared.join(", ")}.`);
    if (store !== null) lines.push(stringField(store, "reason"));
    return `${lines.join("\n")}\n`;
  }
  if (typeof result === "string") return `${result}\n`;
  if (result === undefined) return "";
  return `${JSON.stringify(result, null, 2)}\n`;
}

/**
 * Emit one command result.
 *
 * `diagnostics` and `notices` are separate channels because they mean different
 * things to a caller: a diagnostic is a failure or a refused operation, while a
 * notice is something that happened and is worth knowing. Deriving `ok` from
 * diagnostics alone is what lets a validated-but-held result report `ok: false`
 * with a success exit code, which is self-contradictory. The JSON envelope gains
 * an additive `notices` array; `ok`, `command`, `result`, and `diagnostics` keep
 * their meaning and position.
 */
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

/**
 * Whether the local notes ref may be replaced by a verified envelope.
 *
 * `materializeNotesFromLedger` moves the ref with `update-ref`, so it REPLACES
 * rather than unions. Anything the envelope does not already contain would be
 * lost, so the only safe moves are an absent notes ref and a fast-forward from a
 * local tip that is a strict ancestor of the envelope's notes commit. Every
 * other case is `local-ahead` and must be refused.
 */
type LedgerGate =
  | { readonly kind: "proceed"; readonly expectedNotes: ObjectId | null }
  | { readonly kind: "up-to-date"; readonly notesTip: ObjectId }
  | { readonly kind: "local-ahead"; readonly notesTip: ObjectId; readonly notesCommit: ObjectId };

async function ledgerGate(reveries: Reveries, notesCommit: ObjectId): Promise<LedgerGate> {
  const notesTip = await reveries.repository.notesTip();
  // No local notes ref at all is the fresh-clone case the envelope exists for.
  if (notesTip === null) return { kind: "proceed", expectedNotes: null };
  if (notesTip === notesCommit) return { kind: "up-to-date", notesTip };
  // Ancestry runs envelope -> local in the ordinary case, because a checkpoint
  // is built from the notes tip as it stood and notes only grow. The local tip
  // is therefore normally ahead, which is stale-but-healthy, not a fast-forward.
  const ancestor = await reveries.repository.run(
    ["merge-base", "--is-ancestor", notesTip, notesCommit],
    { allowExitCodes: [0, 1] },
  );
  return ancestor.exitCode === 0
    ? { kind: "proceed", expectedNotes: notesTip }
    : { kind: "local-ahead", notesTip, notesCommit };
}

/** A ledger step as reported to humans and to `--json`. */
interface LedgerReport {
  readonly ok: boolean;
  readonly state:
    | "absent"
    | "status"
    | "valid"
    | "stale"
    | "invalid"
    | "created"
    | "unchanged"
    | "refused"
    | "materialized"
    | "up-to-date"
    | "local-ahead"
    | "skipped";
  readonly checkpoint: ObjectId | null;
  readonly notesTip: ObjectId | null;
  readonly notesCommit: ObjectId | null;
  /**
   * Why the envelope route did not run at all. Only ever set for `skipped`, and
   * only ever a reason a reader can act on.
   */
  readonly reason?: string;
  /** Failures only. An `absent`, `local-ahead`, or `skipped` envelope is not a failure. */
  readonly diagnostics: readonly string[];
}

const LEDGER_ABSENT_REPORT: LedgerReport = {
  ok: true,
  state: "absent",
  checkpoint: null,
  notesTip: null,
  notesCommit: null,
  diagnostics: [],
};

/**
 * Verify an envelope, then move the notes ref onto it when that is safe.
 *
 * The gate runs first and refuses rather than replacing, so a local notes tip
 * carrying records the envelope lacks is never destroyed. Callers choose the
 * severity of a refusal, because the same refusal is routine on a sync and a
 * failure on an explicit request.
 */
/**
 * The remote an explicitly named envelope revision came from.
 *
 * `refs/remotes/<remote>/reveries-ledger` is the shape an operator names by hand,
 * and the remote in it is exactly whose evidence the envelope transports.
 */
function remoteOfRevision(revision: string | undefined): string | null {
  if (revision === undefined) return null;
  const match = /^refs\/remotes\/([^/]+)\//.exec(revision);
  return match?.[1] ?? null;
}

/**
 * Whether this remote's evidence may become canonical state through an envelope.
 *
 * The notes route and the envelope route carry the *same* evidence, so a role that
 * withholds promotion on one has to withhold it on the other. Without this, an
 * explicit `reveries ledger materialize refs/remotes/<mirror>/reveries-ledger`
 * would route straight around the quarantine decision the sync already made — the
 * gate exists precisely so that withholding is a property of the evidence rather
 * than of whichever command the operator happened to run.
 *
 * A remote with no declared role keeps its pre-role behaviour: it promotes.
 * A contradictory configuration is not an undeclared remote, and nothing promotes
 * while the repository cannot say which remote is authoritative.
 */
async function envelopePromotionGate(
  reveries: Reveries,
  revision: string | undefined,
): Promise<{ readonly allowed: boolean; readonly diagnostic: string | null }> {
  const authority = await reveries.authorityStatus();
  if (authority.state === "invalid") {
    return {
      allowed: false,
      diagnostic: `Authority configuration is invalid, so no envelope may become canonical state: ${authority.diagnostics.join("; ")}`,
    };
  }
  const remote = remoteOfRevision(revision);
  if (remote === null) return { allowed: true, diagnostic: null };
  const role = authority.roles.get(remote) ?? null;
  if (role === null) return { allowed: true, diagnostic: null };
  if (rolePromotion(role) === "promote") return { allowed: true, diagnostic: null };
  return {
    allowed: false,
    diagnostic: `${remote} is an ${role} remote, so its evidence is quarantined rather than promoted, and the ledger envelope transports the same notes; materialize was refused`,
  };
}

async function materializeLedger(
  reveries: Reveries,
  revision: string | undefined,
): Promise<LedgerReport> {
  const promotion = await envelopePromotionGate(reveries, revision);
  if (!promotion.allowed) {
    const reason = promotion.diagnostic ?? "The envelope was refused";
    return {
      ...LEDGER_ABSENT_REPORT,
      ok: false,
      state: "refused",
      reason,
      diagnostics: [reason],
    };
  }
  const notesTip = await reveries.repository.notesTip();
  const stored = await (async () => {
    const checkpoint = revision === undefined
      ? await reveries.repository.ledgerTip()
      : await reveries.repository.resolveCommit(revision);
    if (checkpoint === null) return null;
    return { checkpoint, manifest: await reveries.repository.readLedgerManifestAt(checkpoint) };
  })();
  if (stored === null) {
    return { ...LEDGER_ABSENT_REPORT, ok: false, diagnostics: [`No Reveries ledger envelope is available${revision === undefined ? "" : ` at ${revision}`}`] };
  }
  const verification = await reveries.verifyLedgerEnvelope(stored.checkpoint);
  if (!verification.ok) {
    return {
      ok: false,
      state: "refused",
      checkpoint: stored.checkpoint,
      notesTip,
      notesCommit: null,
      diagnostics: verification.diagnostics,
    };
  }
  const notesCommit = (await reveries.repository.readLedgerManifestAt(stored.checkpoint)) === null
    ? null
    : readEnvelopeNotesCommit(await reveries.repository.readLedgerManifestAt(stored.checkpoint) as string);
  if (notesCommit === null) {
    return {
      ok: false,
      state: "refused",
      checkpoint: stored.checkpoint,
      notesTip,
      notesCommit: null,
      diagnostics: ["The verified ledger envelope transports no notes commit"],
    };
  }
  const gate = await ledgerGate(reveries, notesCommit);
  if (gate.kind === "local-ahead") {
    return {
      ok: false,
      state: "local-ahead",
      checkpoint: stored.checkpoint,
      notesTip: gate.notesTip,
      notesCommit,
      diagnostics: [
        `The local ${NOTES_REF} carries notes the ledger envelope does not contain, so it was left unchanged`,
      ],
    };
  }
  if (gate.kind === "up-to-date") {
    return {
      ok: true,
      state: "up-to-date",
      checkpoint: stored.checkpoint,
      notesTip: gate.notesTip,
      notesCommit,
      diagnostics: [],
    };
  }
  const result = await reveries.materializeNotesFromLedger({
    expectedNotes: gate.expectedNotes,
    ...(revision === undefined ? {} : { revision }),
  });
  return {
    ok: result.ok,
    state: result.state,
    checkpoint: stored.checkpoint,
    notesTip: result.notesTip,
    notesCommit,
    diagnostics: result.diagnostics,
  };
}

/** The notes commit a verified envelope transports, or null if it names none. */
function readEnvelopeNotesCommit(stored: string): ObjectId | null {
  try {
    return readLedgerManifest(stored)?.notes_commit ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether a publishing remote carries a ledger envelope.
 *
 * The envelope is optional by design, so its absence is `absent` and never a
 * failure. The probe runs before any fetch so a remote without one costs a
 * single round trip.
 */
async function remoteHasLedger(reveries: Reveries, remote: string): Promise<boolean> {
  const probe = await reveries.repository.run(
    ["ls-remote", "--refs", remote, LEDGER_REF],
    { allowExitCodes: [0, 1, 128] },
  );
  if (probe.exitCode !== 0) return false;
  return probe.stdout.split("\n").some((line) => line.endsWith(`\t${LEDGER_REF}`));
}

/** Fetch an envelope into its remote-tracking mirror. */
async function fetchLedger(reveries: Reveries, remote: string): Promise<{ readonly ok: boolean; readonly diagnostics: readonly string[] }> {
  try {
    await reveries.repository.run([
      "fetch",
      remote,
      `+${LEDGER_REF}:refs/remotes/${remote}/reveries-ledger`,
    ]);
    return { ok: true, diagnostics: [] };
  } catch (error: unknown) {
    return { ok: false, diagnostics: [`Could not fetch the Reveries ledger from ${remote}: ${errorText(error)}`] };
  }
}

/**
 * Bring a remote's ledger envelope across and materialize from it.
 *
 * `syncPull` fetches exactly one refspec, an explicit `refs/notes/reveries` one,
 * so a configured `remote.<r>.fetch` refspec never brings the envelope along.
 * That is why this runs its own fetch rather than relying on the refspec that
 * setup manages.
 */
async function syncLedger(reveries: Reveries, remote: string): Promise<LedgerReport> {
  if (!await remoteHasLedger(reveries, remote)) return LEDGER_ABSENT_REPORT;
  const fetched = await fetchLedger(reveries, remote);
  if (!fetched.ok) {
    return { ...LEDGER_ABSENT_REPORT, ok: false, state: "refused", diagnostics: fetched.diagnostics };
  }
  const report = await materializeLedger(reveries, `refs/remotes/${remote}/reveries-ledger`);
  if (report.state === "local-ahead") {
    // Approved severity split: the notes already arrived through the notes ref,
    // so nothing is lost and nothing is wrong. The repository is merely ahead of
    // its last checkpoint, which `ledgerStatus` already calls `stale`.
    return { ...report, ok: true, diagnostics: [] };
  }
  return report;
}

/**
 * The envelope route deliberately not taken during a sync.
 *
 * This is not a failure and not an absence: the remote's evidence is being held by
 * the notes route, and materializing the same evidence through a second transport
 * would hand the promotion decision to whichever route happened to run second.
 */
function skippedLedger(reason: string): LedgerReport {
  return {
    ok: true,
    state: "skipped",
    checkpoint: null,
    notesTip: null,
    notesCommit: null,
    reason,
    diagnostics: [],
  };
}

/**
 * A build reports more than a status: which remote the checkpoint is published on
 * behalf of, and whether it carries an attestation. Those two facts are the whole
 * point of the envelope, and a reader who cannot see them has to go looking.
 */
interface LedgerBuildReport extends LedgerReport {
  readonly authority: string | null;
  /** The primary the configuration resolves to, even when the stamp differs. */
  readonly authorityResolved: string | null;
  readonly authorityState: string;
  readonly signed: boolean;
  /** Why the attestation is present or absent, in one clause. */
  readonly reason: string;
}

/**
 * The authority the built checkpoint actually carries.
 *
 * Reading it back from the manifest rather than recomputing the argument is what
 * keeps the report honest: the bytes are the authority, and a value derived from
 * the flags could disagree with them.
 */
async function readStampedAuthority(reveries: Reveries, checkpoint: ObjectId): Promise<string | null> {
  try {
    const stored = await reveries.repository.readLedgerManifestAt(checkpoint);
    return stored === null ? null : readLedgerManifest(stored)?.authority ?? null;
  } catch {
    // An unreadable manifest is already reported by the checkpoint's own
    // verification; the report falls back to what was asked for rather than
    // inventing a value.
    return null;
  }
}

function buildReason(
  built: { readonly ok: boolean },
  authority: string | null,
  signChoice: boolean | undefined,
  keyLoaded: boolean,
): string {
  if (!built.ok) return "the checkpoint was refused";
  if (signChoice === false) return "signing was declined with --no-sign";
  if (!keyLoaded) return "no signing key is configured, so the manifest is unsigned";
  return "the configured key signed the manifest";
}

/**
 * Read an override that has three states: absent, explicitly set, and explicitly
 * declined.
 *
 * The distinction matters because an omitted value defers to a default while an
 * explicit `null` or `false` overrides it. Collapsing the two would make
 * `--no-authority` indistinguishable from saying nothing, which is the whole
 * reason the flag exists. Declaring both is a usage error, because the two
 * answers contradict each other.
 */
type OptionalChoice =
  | { readonly kind: "absent" }
  | { readonly kind: "value"; readonly value: string }
  | { readonly kind: "declined" };

function explicitOptional(parsed: ParsedArguments, valueName: string, flagName: string): OptionalChoice {
  const hasValue = parsed.values.has(valueName);
  const hasFlag = parsed.flags.has(flagName);
  if (hasValue && hasFlag) throw new UsageError(`choose only one of ${valueName} or ${flagName}`);
  if (hasValue) return { kind: "value", value: parsed.values.get(valueName)?.[0] ?? "" };
  if (hasFlag) return { kind: "declined" };
  return { kind: "absent" };
}

/** A tri-state string override: a name, an explicit `null`, or deferral. */
function optionalString(parsed: ParsedArguments, valueName: string, flagName: string): string | null | undefined {
  const choice = explicitOptional(parsed, valueName, flagName);
  if (choice.kind === "absent") return undefined;
  if (choice.kind === "declined") return null;
  return choice.value.length === 0 ? null : choice.value;
}

/** A tri-state boolean override: true, false, or deferral. */
function optionalBoolean(parsed: ParsedArguments, valueName: string, flagName: string): boolean | undefined {
  const choice = explicitOptional(parsed, valueName, flagName);
  if (choice.kind === "absent") return undefined;
  return choice.kind === "value";
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

// Signing, trust, and authority surfaces (RVR-009, RVR-017)
// -------------------------------------------------------------------------------

/**
 * Everything a command needs to know about local signing state.
 *
 * The trust store is loaded for every repository command, so a signature's trust
 * state is a real answer rather than `unknown` everywhere. A private key is
 * optional and its absence is ordinary: a repository that never signs has nothing
 * to sign with, and a failure to load the key is reported only by the commands
 * that were going to use it, so a stale `reveries.signingKey` cannot stop an
 * operator reading, verifying, or recording evidence.
 */
interface OpenedRepository {
  readonly reveries: Reveries;
  readonly trust: Awaited<ReturnType<typeof readLocalTrustStore>>;
  /** The loaded key's identity, or null when no key is configured or usable. */
  readonly signingKey: { readonly keyId: string; readonly signer: string; readonly path: string } | null;
  /** Why a configured key could not be used, for the commands that need one. */
  readonly signingKeyError: string | null;
  /** The store is readable but the loaded key has no entry, so signing is refused. */
  readonly signingKeyUnauthorized: string | null;
}

/**
 * The `key_id` of a PKCS#8 private key, derived from its public half.
 *
 * Identity is derived, never typed. A signature claims a signer, and the trust
 * store is what binds a key to a signer; letting the caller pass an identity
 * alongside the key would let any key speak for any signer, which is exactly the
 * gap the `valid`-versus-`trusted` states exist to close.
 */
function privateKeyId(pem: string): string {
  const publicPem = createPublicKey(pem).export({ type: "spki", format: "pem" }).toString();
  return ed25519KeyId(publicPem);
}

/**
 * The accepted public-key formats, and why the boundary is explicit.
 *
 * A trust store holds public material only. Two things can go wrong at this
 * boundary, and both are silent without a check: a PKCS#8 *private* key parses
 * just as successfully as a public one and would be written into a file the
 * project documents as containing nothing secret, and an OpenSSH `ssh-ed25519`
 * line is a legitimate key in a format the verifier cannot consume, which would
 * produce a store entry that registers a key it can never verify.
 *
 * Everything is normalised to SPKI PEM, because that is the single form
 * `createLocalEd25519Verifier` accepts and the form the derived `key_id` is
 * computed over. Deriving the identity from the *normalised* bytes keeps the
 * stored identity and the stored key describing the same key.
 */
function normalizePublicKey(raw: string, source: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") throw new UsageError(`${source} is empty`);
  const describe = "expected a PEM public key (-----BEGIN PUBLIC KEY-----); "
    + "an OpenSSH public key (ssh-ed25519 AAAA...) and a PKCS#8 private key are not accepted";
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(trimmed)) {
    // Refusing by content rather than by parse failure: a private key parses, so
    // this is the only check that catches it.
    throw new UsageError(
      `${source} contains a private key. A trust store holds public key material only, `
      + `and a private key here would be readable by everyone who can read the store. ${describe}.`,
    );
  }
  if (trimmed.startsWith("ssh-") || trimmed.startsWith("ecdsa-") || trimmed.startsWith("sk-")) {
    throw new UsageError(`${source} is an OpenSSH public key. ${describe}.`);
  }
  let key: ReturnType<typeof createPublicKey>;
  try {
    key = createPublicKey(trimmed);
  } catch {
    throw new UsageError(`${source} is not a readable public key. ${describe}.`);
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new UsageError(
      `${source} is a ${String(key.asymmetricKeyType)} key; Reveries signs with ed25519, so only an ed25519 public key can be trusted.`,
    );
  }
  // `createPublicKey` accepts a PKCS#8 private key and derives the public half,
  // so the *output* is always a public key even when the input was not. The
  // private-key case is rejected above for exactly this reason.
  return key.export({ type: "spki", format: "pem" }).toString();
}

async function configuredSigningKeyPath(reveries: Reveries, io: CliIo, flag: string | undefined): Promise<string | null> {
  if (flag !== undefined) return flag;
  const environment = io.environment ?? process.env;
  const fromEnvironment = environment.REVERIES_SIGNING_KEY;
  if (fromEnvironment !== undefined && fromEnvironment.trim().length > 0) return fromEnvironment.trim();
  const configured = await reveries.repository.run(["config", "--get", "reveries.signingKey"], {
    allowExitCodes: [0, 1],
  });
  const value = configured.stdout.trim();
  return value === "" ? null : value;
}

async function openWithTrust(cwd: string, io: CliIo, keyFlag?: string): Promise<OpenedRepository> {
  const base = await Reveries.open(cwd);
  const trust = await readLocalTrustStore(base.repository);
  let signer: SigningOptions["signer"];
  let signingKey: OpenedRepository["signingKey"] = null;
  let signingKeyError: string | null = null;
  let signingKeyUnauthorized: string | null = null;
  const keyPath = await configuredSigningKeyPath(base, io, keyFlag);
  if (keyPath !== null) {
    let pem: string;
    try {
      pem = await readFile(resolve(io.cwd, keyPath), "utf8");
    } catch (error: unknown) {
      signingKeyError = `Signing key ${keyPath} is unreadable: ${errorText(error)}`;
      pem = "";
    }
    if (pem !== "") {
      let keyId: string;
      try {
        keyId = privateKeyId(pem);
      } catch (error: unknown) {
        signingKeyError = `Signing key ${keyPath} is not a readable private key: ${errorText(error)}`;
        keyId = "";
      }
      if (keyId !== "") {
        const entry = trustStoreEntry(trust.file, keyId);
        if (entry === undefined) {
          signingKeyUnauthorized = `The signing key ${keyId} has no entry in ${trust.path}; add it with reveries trust add before signing`;
        } else if (entry.revoked) {
          signingKeyUnauthorized = `The signing key ${keyId} is revoked in ${trust.path}; restore it with reveries trust restore before signing`;
        } else {
          signingKey = { keyId, signer: entry.signer, path: keyPath };
          signer = createLocalEd25519Signer({ signer: entry.signer, keyId, privateKey: pem });
        }
      }
    }
  }
  const reveries = await Reveries.open(cwd, {
    verifier: createLocalEd25519Verifier(trust.verifierKeys),
    trust: trust.store,
    ...(signer === undefined ? {} : { signer }),
  });
  return { reveries, trust, signingKey, signingKeyError, signingKeyUnauthorized };
}

const TRUST_ACTIONS = new Set(["init", "list", "add", "remove", "revoke", "restore"]);

/** One trust-store row, in the shape both the human and JSON output render. */
interface TrustRow {
  readonly key_id: string;
  readonly signer: string;
  readonly state: "trusted" | "revoked";
}

function trustRows(file: TrustStoreFile): readonly TrustRow[] {
  return [...file.keys]
    .sort((a, b) => (a.key_id < b.key_id ? -1 : a.key_id > b.key_id ? 1 : 0))
    .map((entry) => ({ key_id: entry.key_id, signer: entry.signer, state: entry.revoked ? "revoked" : "trusted" }));
}

/**
 * `reveries trust` — the local trust store.
 *
 * The store holds public keys and the identity each is authorized to speak for.
 * Private key material is never written here, never printed, and never included
 * in a diagnostic: generation happens only when an operator explicitly asks for it,
 * and even then the key lands in a file they named, outside the repository.
 */
async function runTrustCommand(
  action: string | undefined,
  parsed: ParsedArguments,
  json: boolean,
  io: CliIo,
  opened: OpenedRepository,
): Promise<ExitCode> {
  if (action === undefined) throw new UsageError("trust requires an action");
  if (!TRUST_ACTIONS.has(action)) {
    throw new UsageError(`trust action must be one of ${[...TRUST_ACTIONS].join(", ")}`);
  }
  const label = `trust ${action}`;
  const { trust } = opened;
  const repository = opened.reveries.repository;

  if (action === "list") {
    const rows = trustRows(trust.file);
    const result = { path: trust.path, present: trust.present, keys: rows };
    if (json) {
      emit(io, true, label, result);
      return 0;
    }
    io.stdout(`Trust store: ${trust.path}; ${rows.length} key(s)${trust.present ? "" : " (not created yet)"}.\n`);
    for (const row of rows) io.stdout(`  ${row.state} ${row.key_id} for ${row.signer}\n`);
    return 0;
  }

  const signer = one(parsed, "--signer");
  if (signer !== undefined && signer.trim() === "") throw new UsageError("--signer must be a nonempty identity");
  // A manifest signature reuses the signer identity as `author_email`, and the
  // protocol validates that field as an email address. Requiring an email-shaped
  // identity here is what keeps a signed checkpoint constructible at all; the
  // coupling is documented rather than hidden.
  if (signer !== undefined && !/^[^\s@]+@[^\s@]+$/.test(signer)) {
    throw new UsageError(
      `--signer must be an email-shaped identity because a ledger manifest signature records it as the author email; found ${signer}`,
    );
  }

  if (action === "init") {
    const keyFile = one(parsed, "--key-file", true) ?? "";
    if (signer === undefined) throw new UsageError("trust init requires --signer");
    const destination = await refuseAsUsage(() => resolvePrivateKeyPath(repository, keyFile));
    const pair = generateEd25519KeyPair();
    // Exclusive create with 0600, so an existing key is never replaced and the
    // private key is never briefly world-readable.
    await refuseAsUsage(() => createPrivateKeyFile(destination.resolved, pair.privateKey));
    const entry: TrustStoreKey = {
      key_id: pair.keyId,
      signer,
      revoked: false,
      public_key: pair.publicKey,
    };
    // The key exists before the store does, so a store failure would otherwise
    // leave a key behind whose only symptom on the next attempt is EEXIST. Rolling
    // back the file this run created restores the state the command started from,
    // and makes the retry work. `createPrivateKeyFile` refused to overwrite, so
    // success here is proof this run created the file and owns the rollback.
    let path: string;
    try {
      path = await writeLocalTrustStore(repository, upsertTrustKey(trust.file, entry));
    } catch (error: unknown) {
      await rm(destination.resolved, { force: true });
      throw new Error(
        `The private key at ${destination.path} was removed because registering it failed, so nothing was half-created; `
        + `fix the problem and run the command again. Cause: ${errorText(error)}`,
      );
    }
    const result = { path, key_id: pair.keyId, signer, privateKeyPath: destination.path, privateKeyMode: "0600" };
    if (json) {
      emit(io, true, label, result);
      return 0;
    }
    // The location, never the contents.
    io.stdout(
      `Created key ${pair.keyId} for ${signer}; private key written to ${destination.path} (mode 0600) `
      + `and the public key added to ${path}.\n`,
    );
    return 0;
  }

  if (action === "add") {
    const fromFile = one(parsed, "--from-file", true) ?? "";
    if (signer === undefined) throw new UsageError("trust add requires --signer");
    let raw: string;
    try {
      raw = await readFile(resolve(io.cwd, fromFile), "utf8");
    } catch (error: unknown) {
      throw new UsageError(`cannot read a public key from ${fromFile}: ${errorText(error)}`);
    }
    // The format is checked and normalised before anything is stored, so a
    // refusal cannot leave a half-written trust store behind. Normalising to SPKI
    // PEM is what makes the stored bytes and the derived identity agree with what
    // the verifier will actually be handed later.
    const publicKey = normalizePublicKey(raw, fromFile);
    const derived = ed25519KeyId(publicKey);
    const existing = trustStoreEntry(trust.file, derived);
    if (existing !== undefined && existing.signer !== signer) {
      throw new UsageError(
        `The trust store already binds ${derived} to ${existing.signer}; remove that entry before binding it to ${signer}`,
      );
    }
    const entry: TrustStoreKey = { key_id: derived, signer, revoked: false, public_key: publicKey };
    const path = await writeLocalTrustStore(repository, upsertTrustKey(trust.file, entry));
    if (json) {
      emit(io, true, label, { path, key_id: derived, signer, added: existing === undefined });
      return 0;
    }
    io.stdout(`${existing === undefined ? "Added" : "Updated"} ${derived} for ${signer} in ${path}.\n`);
    return 0;
  }

  // `--key` names the entry every remaining action edits. `add` is the one action
  // that does not take it: it derives the key identity from the public key it is
  // given, so asking for one there would be asking for the answer.
  const keyId = one(parsed, "--key", true) ?? "";
  const existing = trustStoreEntry(trust.file, keyId);
  if (existing === undefined) {
    throw new UsageError(`The trust store ${trust.path} has no entry for ${keyId}`);
  }
  if (action === "remove") {
    const path = await writeLocalTrustStore(repository, {
      keys: trust.file.keys.filter((entry) => entry.key_id !== keyId),
    });
    if (json) {
      emit(io, true, label, { path, key_id: keyId, signer: existing.signer, removed: true });
      return 0;
    }
    io.stdout(
      `Removed ${keyId} for ${existing.signer} from ${path}. Signatures by that key now report unknown; `
      + "the signature records themselves are untouched.\n",
    );
    return 0;
  }
  const revoked = action === "revoke";
  if (existing.revoked === revoked) {
    if (json) {
      emit(io, true, label, { path: trust.path, key_id: keyId, signer: existing.signer, revoked });
      return 0;
    }
    io.stdout(`${keyId} is already ${revoked ? "revoked" : "restored"} in ${trust.path}.\n`);
    return 0;
  }
  const path = await writeLocalTrustStore(repository, upsertTrustKey(trust.file, { ...existing, revoked }));
  if (json) {
    emit(io, true, label, { path, key_id: keyId, signer: existing.signer, revoked });
    return 0;
  }
  io.stdout(
    revoked
      ? `Revoked ${keyId} for ${existing.signer} in ${path}. Signatures by that key stay in the notes and now report revoked.\n`
      : `Restored ${keyId} for ${existing.signer} in ${path}.\n`,
  );
  return 0;
}

const ROLE_ACTIONS = new Set(["show", "set", "clear"]);

/**
 * `reveries role` — the role a remote plays in authoritative publication.
 *
 * Writing the key is the easy half. The command reports the *resolved* result
 * afterwards, because a role only means something next to the other roles: an
 * operator who sets a mirror needs to see whether that left a primary, and an
 * operator who sets a second primary needs to see the refusal rather than discover
 * it through a damaged `doctor` later.
 */
async function runRoleCommand(
  action: string | undefined,
  parsed: ParsedArguments,
  json: boolean,
  io: CliIo,
  opened: OpenedRepository,
): Promise<ExitCode> {
  if (action === undefined) throw new UsageError("role requires an action");
  if (!ROLE_ACTIONS.has(action)) throw new UsageError(`role action must be one of ${[...ROLE_ACTIONS].join(", ")}`);
  const label = `role ${action}`;
  const { reveries } = opened;
  const repository = reveries.repository;

  const report = async (changed: string | null): Promise<ExitCode> => {
    const status = await reveries.authorityStatus();
    const result = {
      changed,
      state: status.state,
      primary: status.primary,
      notice: status.notice,
      roles: Object.fromEntries([...status.roles].sort(([a], [b]) => (a < b ? -1 : 1))),
      diagnostics: status.diagnostics,
    };
    if (json) {
      emit(io, true, label, result, status.diagnostics);
      return status.diagnostics.length === 0 ? 0 : 1;
    }
    if (changed !== null) io.stdout(`${changed}\n`);
    io.stdout(`Authority: ${status.state}; primary ${status.primary ?? "none"}. ${status.notice}\n`);
    for (const [remote, role] of [...status.roles].sort(([a], [b]) => (a < b ? -1 : 1))) {
      io.stdout(`  ${remote}: ${role}\n`);
    }
    for (const diagnostic of status.diagnostics) io.stderr(`${diagnostic}\n`);
    return status.diagnostics.length === 0 ? 0 : 1;
  };

  if (action === "show") return report(null);

  const remote = requirePositional(parsed, 0, "remote name");
  validateRemoteName(remote);
  const key = `reveries.remoteRole.${remote}`;
  if (action === "clear") {
    await repository.run(["config", "--unset-all", key], { allowExitCodes: [0, 1, 5] });
    return report(`Cleared the role for ${remote}.`);
  }
  const role = await refuseAsUsage(async () => remoteRole(requirePositional(parsed, 1, "remote role")));
  const known = (await repository.run(["remote"])).stdout.trimEnd().split("\n").filter((remote) => remote.length > 0);
  if (!known.includes(remote)) {
    throw new UsageError(`Remote ${remote} does not exist in this repository; add it before declaring a role`);
  }
  // Refuse a second primary here rather than writing a configuration that makes
  // authority permanently `invalid`.
  const current = (await repository.run(["config", "--get-regexp", "^reveries\\.remoteRole\\."], {
    allowExitCodes: [0, 1],
  })).stdout;
  if (role === "primary") {
    const primaries = current
      .split("\n")
      .map((line) => line.split(" "))
      .filter(([name, value]) => name !== undefined && value === "primary" && name !== key)
      .map(([name]) => name?.slice("reveries.remoteRole.".length) ?? "")
      .filter((name) => name.length > 0);
    if (primaries.length > 0) {
      throw new UsageError(
        `Authority must name exactly one primary; reveries.remoteRole already declares ${primaries.join(", ")}. `
        + `Clear ${primaries.map((name) => `${key.slice(0, key.indexOf("."))}.${name}`).join(" or ")} first.`,
      );
    }
  }
  await repository.run(["config", key, role]);
  return report(`Set ${remote} to ${role}.`);
}

/**
 * `reveries policy` — which signature roles this repository requires.
 *
 * The requirement is what separates `trusted` from `policy-satisfying`, and it is
 * the one piece of signing policy that travels nowhere: it is a local decision
 * about what this repository insists on, so it is configuration rather than
 * evidence.
 */
async function runPolicyCommand(
  action: string | undefined,
  parsed: ParsedArguments,
  json: boolean,
  io: CliIo,
  opened: OpenedRepository,
): Promise<ExitCode> {
  if (action === undefined) throw new UsageError("policy requires an action");
  if (!ROLE_ACTIONS.has(action)) throw new UsageError(`policy action must be one of ${[...ROLE_ACTIONS].join(", ")}`);
  const label = `policy ${action}`;
  const repository = opened.reveries.repository;
  const key = "reveries.signingRoles";

  const report = async (changed: string | null): Promise<ExitCode> => {
    const required = await opened.reveries.signingPolicy();
    const result = { changed, requiredRoles: required.requiredRoles, source: (await repository.run(
      ["config", "--get", key],
      { allowExitCodes: [0, 1] },
    )).stdout.trim() };
    if (json) {
      emit(io, true, label, result);
      return 0;
    }
    if (changed !== null) io.stdout(`${changed}\n`);
    io.stdout(
      required.requiredRoles.length === 0
        ? "Signing policy requires no role, so trusted is the strongest state a signature can reach here.\n"
        : `Signing policy requires ${required.requiredRoles.join(", ")}.\n`,
    );
    return 0;
  };

  if (action === "show") return report(null);
  if (action === "clear") {
    await repository.run(["config", "--unset-all", key], { allowExitCodes: [0, 1, 5] });
    return report("Cleared the required signing roles.");
  }
  const raw = parsed.positionals.join(",");
  if (raw.trim() === "") throw new UsageError("policy set requires a comma-separated role list");
  const names = splitList([raw]);
  for (const name of names) {
    if (!(SIGNATURE_ROLES as readonly string[]).includes(name)) {
      throw new UsageError(`reveries.signingRoles must name roles from ${SIGNATURE_ROLES.join(", ")}; found ${name}`);
    }
  }
  await repository.run(["config", key, names.join(",")]);
  return report(`Set the required signing roles to ${names.join(", ")}.`);
}

/**
 * Report an install-layer refusal as a usage error.
 *
 * The path checks and the exclusive create fail because of what the operator
 * asked for, not because the repository could not be evaluated, so they are exit
 * 3 with the standard hint. The message is preserved verbatim because it names the
 * exact path that was refused, which is what makes the refusal actionable.
 */
async function refuseAsUsage<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error: unknown) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(errorText(error));
  }
}

function validateRemoteName(remote: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remote)) {
    throw new UsageError(`Remote name ${remote} is not a usable Git remote name`);
  }
}

function signatureRoleValue(value: string): SignatureRole {
  if (!(SIGNATURE_ROLES as readonly string[]).includes(value)) {
    throw new UsageError(`--role must name a role from ${SIGNATURE_ROLES.join(", ")}; found ${value}`);
  }
  return value as SignatureRole;
}

/** Signature records parsed out of a raw note or envelope body. */
function signatureRecords(body: string): readonly SignatureRecord[] {
  const records: SignatureRecord[] = [];
  for (const line of body.split("\n")) {
    if (line.trim().length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      // A malformed line belongs to the note validator, not to a signature pass.
      continue;
    }
    if (value !== null && typeof value === "object" && (value as { type?: unknown }).type === "signature") {
      records.push(value as SignatureRecord);
    }
  }
  return records;
}

const TRUST_STATES: readonly TrustState[] = [
  "unknown",
  "valid",
  "trusted",
  "policy-satisfying",
  "invalid",
  "revoked",
];

/**
 * `reveries sign` — attest one record with the configured key.
 *
 * A signature is only meaningful over bytes the repository actually holds, so the
 * target must be present in the current notes: signing a record that is not there
 * would produce an attestation no reader could resolve to anything. The signer
 * identity is never typed here either; it comes from the trust store entry for the
 * loaded key.
 *
 * What this reports is deliberately narrow. The signature binds the eight payload
 * fields, one of which is a hash of the target's exact canonical bytes — so the
 * target's own content, including its author metadata, is attested. The signature
 * record's `author_email`, `session`, and `created_at` are outside that payload and
 * outside the record ID, so they are not reported here as though they were signed.
 */
async function runSignCommand(
  parsed: ParsedArguments,
  json: boolean,
  io: CliIo,
  opened: OpenedRepository,
): Promise<ExitCode> {
  const target = requirePositional(parsed, 0, "a record id to sign");
  let targetId: FactTargetId;
  try {
    targetId = factTargetId(target);
  } catch (error: unknown) {
    throw new UsageError(errorText(error));
  }
  const role = signatureRoleValue(one(parsed, "--role") ?? "author");
  const { reveries } = opened;

  // Resolve the target from the repository's own evidence before deciding anything
  // about keys, so a bad target is reported as a bad target.
  const snapshot = await reveries.loadEvidenceSnapshot({});
  let found: { readonly record: NoteRecord; readonly subject: ObjectId } | null = null;
  for (const entry of snapshot.entries) {
    for (const record of entry.records) {
      if (recordFactId(record) === targetId) {
        found = { record, subject: entry.object };
        break;
      }
    }
    if (found !== null) break;
  }
  if (found === null) {
    throw new UsageError(`No record with id ${targetId} is attached to the current notes`);
  }

  if (opened.signingKeyError !== null) throw new UsageError(opened.signingKeyError);
  if (opened.signingKey === null) {
    if (opened.signingKeyUnauthorized !== null) {
      const result = { state: "unavailable", target: targetId, reason: opened.signingKeyUnauthorized };
      if (json) {
        emit(io, true, "sign", result, [opened.signingKeyUnauthorized]);
        return 1;
      }
      io.stdout(`Cannot sign ${targetId}: ${opened.signingKeyUnauthorized}\n`);
      return 1;
    }
    // Nothing configured is an ordinary state, not a failure: a repository that
    // never signs is a normal repository.
    const result = { state: "unavailable", target: targetId, reason: "no signing key is configured" };
    if (json) {
      emit(io, true, "sign", result);
      return 0;
    }
    io.stdout(
      `No signing key is configured, so ${targetId} is unsigned. `
      + "Create one with 'reveries trust init --signer <you@example.com> --key-file <path outside the repository>', "
      + "or point --key, REVERIES_SIGNING_KEY, or reveries.signingKey at an existing key.\n",
    );
    return 0;
  }

  const draft = await readDraft(one(parsed, "--from"), io);
  const metadata = await parseMetadata(asRecord(draft) ?? {}, reveries, io, parsed);
  const signed = await reveries.signRecord({
    target: found.record,
    subject: found.subject,
    role,
    metadata,
  });
  if (!signed.ok || signed.record === null) {
    emit(io, json, "sign", signed, signed.diagnostics);
    return 1;
  }
  const report = await reveries.verifySignatureRecord(signed.record, await reveries.signingPolicy());
  const result = {
    state: signed.state as "signed",
    record: signed.record,
    subject: found.subject,
    trust: { state: report.state, key_id: report.key_id, signer: report.signer, role: report.role },
  };
  if (json) {
    emit(io, true, "sign", result);
    return 0;
  }
  io.stdout(
    `Signed ${targetId} on ${found.subject} as ${role} by ${report.signer}; signature ${report.id} (${report.state}). `
    + `It attests the exact canonical bytes of ${targetId}.\n`,
  );
  const ledger = await reveries.ledgerStatus();
  if (ledger.state !== "absent") {
    io.stdout(
      `The ledger envelope ${ledger.tip ?? "(absent)"} is now ${ledger.state === "stale" ? "stale" : ledger.state}; `
      + "run 'reveries ledger build' to advance it over this signature.\n",
    );
  }
  return 0;
}

/**
 * `reveries verify` — report what is actually established about this evidence.
 *
 * Trust is a refinement, and this command reports each state at face value: a
 * signature whose key is not in the store is `unknown`, one whose bytes verify
 * without an identity binding is `valid`, and one this store binds is `trusted`.
 * None of those is a failure, because none of them is a claim of forgery. Only
 * `invalid` and `revoked` are.
 *
 * `--require-policy` is a different question. It asks whether this repository's
 * own policy is satisfied, and the answer is yes only for `policy-satisfying`, so
 * every other state fails it — including the ones that are perfectly fine
 * unremarkable evidence on their own. That is the point of the flag: it is how an
 * operator distinguishes "this repository has signatures" from "this repository
 * has the signatures it insists on".
 */
async function runVerifyCommand(
  parsed: ParsedArguments,
  json: boolean,
  io: CliIo,
  opened: OpenedRepository,
): Promise<ExitCode> {
  const { reveries } = opened;
  const target = parsed.positionals[0];
  const ledgerOnly = parsed.flags.has("--ledger");
  const requirePolicy = parsed.flags.has("--require-policy");
  const diagnostics: string[] = [];
  const status = await reveries.signatureStatus();

  if (ledgerOnly) {
    if (target !== undefined) throw new UsageError("verify --ledger takes no record id");
    const checkpoint = await reveries.repository.ledgerTip();
    if (checkpoint === null) {
      if (json) {
        emit(io, true, "verify --ledger", { state: "absent", envelope: { ok: true, diagnostics: [] } });
        return requirePolicy ? 1 : 0;
      }
      io.stdout("Ledger: absent; no checkpoint exists to verify.\n");
      return requirePolicy ? 1 : 0;
    }
    const envelope = await reveries.verifyLedgerEnvelope(checkpoint);
    const stored = await reveries.repository.readLedgerManifestAt(checkpoint);
    const manifest = stored === null ? null : readLedgerManifest(stored);
    const policy = await reveries.signingPolicy();
    const records = stored === null ? [] : signatureRecords(await reveries.repository.readLedgerSignaturesAt(checkpoint) ?? "");
    const newest = records.length === 0 ? undefined : records[records.length - 1];
    const signature = newest === undefined || manifest === null
      ? null
      : reveries.verifySignatureRecord(newest, policy);
    const result = {
      state: envelope.ok ? (signature === null ? "unsigned" : "signed") : "invalid",
      checkpoint,
      envelope: { ok: envelope.ok, diagnostics: envelope.diagnostics },
      signature: signature === null
        ? null
        : {
            id: signature.id,
            signer: signature.signer,
            key_id: signature.key_id,
            role: signature.role,
            state: signature.state,
          },
      requiredRoles: policy.requiredRoles,
    };
    // A structural failure always fails, whatever the policy says: an envelope
    // that contradicts itself is damage, not an unmet preference.
    if (!envelope.ok) diagnostics.push(...envelope.diagnostics);
    if (envelope.ok && signature !== null && (signature.state === "invalid" || signature.state === "revoked")) {
      diagnostics.push(`Ledger manifest signature ${signature.id} is ${signature.state}`);
    }
    if (requirePolicy && envelope.ok && signature?.state !== "policy-satisfying") {
      diagnostics.push(
        policy.requiredRoles.length === 0
          ? `The ledger manifest signature is ${signature?.state ?? "absent"}, not policy-satisfying. reveries.signingRoles is unset, so nothing can be policy-satisfying; set one with 'reveries policy set <role>'.`
          : `The ledger manifest signature is ${signature?.state ?? "absent"}, not policy-satisfying; required roles: ${policy.requiredRoles.join(", ")}`,
      );
    }
    if (json) {
      emit(io, true, "verify --ledger", result, diagnostics);
      return diagnostics.length === 0 ? 0 : 1;
    }
    io.stdout(
      `Ledger ${checkpoint}: envelope ${envelope.ok ? "valid" : "invalid"}; manifest `
      + `${signature === null ? "unsigned" : `signed by ${signature.signer} as ${signature.role} (${signature.state})`}.\n`,
    );
    for (const diagnostic of diagnostics) io.stderr(`${diagnostic}\n`);
    return diagnostics.length === 0 ? 0 : 1;
  }

  let wanted: FactTargetId | null = null;
  if (target !== undefined) {
    try {
      wanted = factTargetId(target);
    } catch (error: unknown) {
      throw new UsageError(errorText(error));
    }
    const snapshot = await reveries.loadEvidenceSnapshot({});
    const known = snapshot.entries.some((entry) => entry.records.some((record) => recordFactId(record) === wanted));
    if (!known) throw new UsageError(`No record with id ${wanted} is attached to the current notes`);
  }

  const reports = await reveries.signatureReports();
  const rows = [...reports.entries()]
    .filter(([id]) => wanted === null || id === wanted)
    .flatMap(([, entries]) => entries)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const counts: Record<TrustState, number> = {
    unknown: 0,
    valid: 0,
    trusted: 0,
    "policy-satisfying": 0,
    invalid: 0,
    revoked: 0,
  };
  for (const row of rows) counts[row.state] += 1;
  // Unscoped, core already counted every signature in the snapshot plus the
  // checkpoint's own attestations. Scoped to one target, the rows above are the
  // whole answer and re-counting would double the checkpoint.
  const scope: Record<TrustState, number> = wanted === null ? { ...status.counts } : counts;
  for (const row of rows) {
    if (row.state === "invalid" || row.state === "revoked") {
      diagnostics.push(`Signature ${row.id} over ${row.target} by ${row.signer} is ${row.state}`);
    }
  }
  if (requirePolicy && scope["policy-satisfying"] === 0) {
    const observed = rows.length === 0 ? "no signatures" : `the strongest state present is ${strongestState(counts)}`;
    // `trusted` is not `policy-satisfying`, and an empty policy is not permission
    // to treat them as the same. Reporting "none configured" would read as though
    // the requirement were met; the honest statement is that nothing can satisfy a
    // policy nobody has set, and the fix is named.
    diagnostics.push(
      status.requiredRoles.length === 0
        ? `No signature reaches policy-satisfying (${observed}). reveries.signingRoles is unset, so no role is required and nothing can be policy-satisfying; set one with 'reveries policy set <role>'.`
        : `No signature reaches policy-satisfying (${observed}); required roles: ${status.requiredRoles.join(", ")}`,
    );
  }
  const result = {
    state: wanted !== null ? (rows.length === 0 ? "unsigned" : "signed") : status.state,
    target: wanted,
    counts: scope,
    signatures: rows.map((row) => ({
      id: row.id,
      target: row.target,
      subject: row.subject,
      signer: row.signer,
      key_id: row.key_id,
      role: row.role,
      state: row.state,
    })),
    requiredRoles: status.requiredRoles,
  };
  if (json) {
    emit(io, true, "verify", result, diagnostics);
    return diagnostics.length === 0 ? 0 : 1;
  }
  const tally = TRUST_STATES.map((state) => `${scope[state]} ${state}`).join(", ");
  io.stdout(`Signatures: ${result.state}; ${rows.length} shown; ${tally}.\n`);
  for (const row of result.signatures) {
    io.stdout(`  ${row.state} ${row.id} by ${row.signer} as ${row.role}, key ${row.key_id}, over ${row.target}\n`);
  }
  for (const diagnostic of diagnostics) io.stderr(`${diagnostic}\n`);
  return diagnostics.length === 0 ? 0 : 1;
}

/**
 * The strongest state actually present, in the order the states refine one another.
 *
 * The order is not the declaration order: `revoked` and `invalid` are weaker
 * claims than `unknown`, so a store that is present but unusable reports the
 * broken state rather than the empty one.
 */
function strongestState(counts: Readonly<Record<TrustState, number>>): TrustState {
  for (const state of ["policy-satisfying", "trusted", "valid", "unknown", "revoked", "invalid"] as const) {
    if (counts[state] > 0) return state;
  }
  return "unknown";
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
      // A deleted trust store is a notice rather than a diagnostic: the removal
      // succeeded, and the operator needs to know the file is gone, not that
      // something went wrong.
      // A preserved store is a notice, not a diagnostic: the removal succeeded,
      // the file is still there, and the operator needs to know that.
      const notices = [
        ...(result.removedTrustConfig.length === 0
          ? []
          : [`Cleared local signing and authority configuration: ${result.removedTrustConfig.join(", ")}`]),
        result.trustStore.reason,
      ];
      emit(io, json, command, result, result.preservedSkillPaths.map(
        (path) => `Owned Skill path was preserved for manual review: ${path}`,
      ), {}, notices);
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
        ...(input.prDescription === undefined ? {} : { prDescription: input.prDescription }),
        ...(input.allowPrDescriptionSummary === undefined
          ? {}
          : { allowPrDescriptionSummary: input.allowPrDescriptionSummary }),
      });
      emit(io, json, command, receive, receive.diagnostics);
      return receive.ok ? 0 : 1;
    }
    if (command === "trust" || command === "role" || command === "policy" || command === "sign" || command === "verify") {
      // These open the repository themselves because they need the local trust
      // store, and a signing command needs the key as well. Opening twice would
      // mean two sets of answers about who this repository trusts.
      //
      // Every branch awaits its handler rather than returning the promise, so a
      // usage error inside one of them still reaches the single catch below and
      // becomes exit 3 with the standard hint instead of an unhandled rejection.
      if (command === "sign") {
        const parsed = parseArguments(argv.slice(1), ["--role", "--key", "--from", "--session"], ["--json"]);
        return await runSignCommand(parsed, json, io, await openWithTrust(io.cwd, io, one(parsed, "--key")));
      }
      if (command === "verify") {
        const parsed = parseArguments(argv.slice(1), [], ["--json", "--ledger", "--require-policy"]);
        return await runVerifyCommand(parsed, json, io, await openWithTrust(io.cwd, io));
      }
      if (command === "trust") {
        const parsed = parseArguments(argv.slice(2), ["--signer", "--key-file", "--from-file", "--key"], ["--json"]);
        return await runTrustCommand(argv[1], parsed, json, io, await openWithTrust(io.cwd, io));
      }
      if (command === "role") {
        const parsed = parseArguments(argv.slice(2), [], ["--json"]);
        return await runRoleCommand(argv[1], parsed, json, io, await openWithTrust(io.cwd, io));
      }
      const parsed = parseArguments(argv.slice(2), [], ["--json"]);
      return await runPolicyCommand(argv[1], parsed, json, io, await openWithTrust(io.cwd, io));
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
        // Fail closed on a contradictory authority configuration before any fetch
        // or note write. A repository that declares two primaries cannot say which
        // remote is authoritative, so nothing it fetches may be promoted on the
        // strength of a role it has not actually resolved.
        const authority = await reveries.authorityStatus();
        if (authority.state === "invalid") {
          const diagnostics = authority.diagnostics.map(
            (entry) => `${entry}; nothing was fetched or promoted`,
          );
          emit(io, json, command, { state: "refused", remote, authority: authority.state }, diagnostics, { remote });
          return 1;
        }
        const result = await reveries.syncPull(remote);
        // The envelope is a second, independent route for the same evidence: a
        // remote that will not serve `refs/notes/reveries` can still deliver it
        // through an ordinary branch. Absent envelope and a refusal are both
        // normal here, so only a broken envelope or a lost compare-and-swap is a
        // failure of the sync itself.
        //
        // The route only runs when the notes route promoted. It transports the
        // *same* notes, so running it after a withheld or refused promotion would
        // let a non-primary remote reach canonical state through whichever
        // transport is checked second. `syncPull` owns the promotion decision and
        // has already made it; this only refuses to contradict it.
        const ledger = result.ok && (result.quarantineRef ?? null) === null
          ? await syncLedger(reveries, remote)
          : skippedLedger(
            result.ok
              ? `${remote} publishes evidence that is quarantined rather than promoted, and an envelope carries the same evidence, so its envelope was not materialized`
              : `${remote} was refused as a source of Reveries evidence, so its envelope was not materialized`,
          );
        // A validated union that is held rather than promoted is a success with
        // something to say, not a failure. Core already decided the severity in
        // `ok`, so its messages are routed by that decision instead of every
        // quarantine reason being promoted into a diagnostic.
        const diagnostics = result.ok
          ? [...ledger.diagnostics]
          : [...result.diagnostics, ...ledger.diagnostics];
        const notices = result.ok
          ? [...result.diagnostics, ...(ledger.state === "skipped" && ledger.reason !== undefined ? [ledger.reason] : [])]
          : result.quarantineRef === null || result.quarantineRef === undefined
            ? []
            : [`Notes from ${remote} were quarantined at ${result.quarantineRef} because the union failed validation`];
        emit(io, json, command, { ...result, ledger }, diagnostics, { remote }, notices);
        return result.ok && ledger.ok ? 0 : 1;
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
    if (command === "ledger") {
      const action = argv[1];
      if (action !== "status" && action !== "build" && action !== "materialize") {
        throw new UsageError("ledger action must be status, build, or materialize");
      }
      const parsed = parseArguments(
        argv.slice(2),
        ["--authority", "--signing-role"],
        ["--json", "--no-authority", "--sign", "--no-sign"],
      );
      const label = `ledger ${action}`;
      if (action === "status") {
        // Only an `invalid` envelope is damage. `absent` means this repository
        // never adopted the ledger and `stale` means it has not been rebuilt
        // over its newest notes; neither is a failure to report.
        const status = await reveries.ledgerStatus();
        const report: LedgerReport = {
          ok: status.state !== "invalid",
          state: status.state,
          checkpoint: status.tip,
          notesTip: status.notesTip,
          notesCommit: status.notesCommit,
          diagnostics: status.diagnostics,
        };
        emit(io, json, label, report, report.diagnostics);
        return report.ok ? 0 : 1;
      }
      if (action === "build") {
        // `build` is the only ledger action that writes, and it is the one that
        // signs: the manifest signature comes from the same local trust store the
        // rest of the signing surface reads, so the checkpoint a repository
        // publishes is attested with the identity that repository actually trusts.
        const trusted = await openWithTrust(io.cwd, io);
        if (trusted.signingKeyError !== null) throw new UsageError(trusted.signingKeyError);
        // `authority` is omitted unless the operator says otherwise, and core
        // resolves the omission from `reveries.remoteRole.*` through the same
        // `authorityStatus` the doctor reports. An explicit `null` is a different
        // statement from an omitted value and suppresses the resolution, which is
        // what makes `--no-authority` a real override rather than a synonym.
        // An invalid authority configuration is not a request to publish without
        // one: it means the repository cannot say which remote is authoritative.
        // The refusal happens before the checkpoint exists, so nothing is written
        // and no attestation is produced that an operator would have to undo.
        const authority = await trusted.reveries.authorityStatus();
        if (authority.state === "invalid") {
          const diagnostics = authority.diagnostics.map(
            (entry) => `${entry}; a checkpoint cannot be built until the authority configuration is valid`,
          );
          emit(io, json, label, {
            ...LEDGER_ABSENT_REPORT,
            ok: false,
            state: "refused" as const,
            reason: "The authority configuration is invalid",
            authority: null,
            authorityResolved: null,
            authorityState: authority.state,
            signed: false,
            diagnostics,
          } satisfies LedgerBuildReport, diagnostics);
          return 1;
        }
        const authorityChoice = optionalString(parsed, "--authority", "--no-authority");
        const signChoice = optionalBoolean(parsed, "--sign", "--no-sign");
        const signingRole = one(parsed, "--signing-role");
        // What the caller asked for, before the checkpoint exists. `--no-authority`
        // is a real value here, not an absence, so it is preserved as `null`.
        const chosenAuthority = authorityChoice === undefined ? authority.primary : authorityChoice;
        const built = await trusted.reveries.buildLedgerCheckpoint({
          ...(authorityChoice === undefined ? {} : { authority: authorityChoice }),
          ...(signChoice === undefined ? {} : { sign: signChoice }),
          ...(signingRole === undefined ? {} : { signingRole: signatureRoleValue(signingRole) }),
        });
        const signed = built.ok && signChoice !== false
          ? await trusted.reveries.signatureStatus()
          : null;
        // Report and render the authority that was actually stamped. An explicit
        // `--authority` is what the manifest carries, including the explicit `null`
        // `--no-authority` produces, so falling back to `authority.primary` here
        // would name a different remote from the one the checkpoint claims. The
        // chosen value is not merely echoed from the flag either: it is read back
        // from the built checkpoint, so the report cannot drift from the bytes.
        const stamped = built.ok && built.checkpoint === null
          ? chosenAuthority
          : built.ok
            ? await readStampedAuthority(trusted.reveries, built.checkpoint as ObjectId)
            : chosenAuthority;
        const report: LedgerBuildReport = {
          ok: built.ok,
          state: built.state,
          checkpoint: built.checkpoint,
          notesTip: built.notesTip,
          notesCommit: null,
          authority: stamped,
          authorityResolved: authority.primary,
          authorityState: authority.state,
          signed: signed?.checkpointSigned ?? false,
          reason: buildReason(built, stamped, signChoice, trusted.signingKey !== null),
          diagnostics: built.diagnostics,
        };
        emit(io, json, label, report, report.diagnostics);
        return report.ok ? 0 : 1;
      }
      const revision = parsed.positionals[0];
      const report = await materializeLedger(reveries, revision);
      // An explicit request that does not happen is a failure, so the exit code
      // and stderr both say so. The notes ref is still never overwritten.
      emit(io, json, label, report, report.diagnostics);
      return report.ok ? 0 : 1;
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
      // The trust block is computed here rather than in core, because where the
      // store lives and which key is loaded are facts about this clone's local
      // state, not about the evidence. Core reports the trust *states* it derived;
      // this reports what it derived them from, so a reader can tell "nothing is
      // trusted" from "nothing was loaded".
      const opened = await openWithTrust(io.cwd, io);
      const result = await opened.reveries.doctor();
      const trust = {
        path: opened.trust.path,
        present: opened.trust.present,
        keys: opened.trust.file.keys.length,
        revoked: opened.trust.file.keys.filter((entry) => entry.revoked).length,
        keyLoaded: opened.signingKey !== null,
        keyId: opened.signingKey?.keyId ?? null,
        signer: opened.signingKey?.signer ?? null,
      };
      const diagnostics = [...result.diagnostics, ...(repair?.diagnostics ?? [])];
      // `AuthorityStatus.roles` is a Map, and `JSON.stringify` renders a Map as
      // `{}`. Flattening it here is what keeps `--json` and the human line honest
      // about which remotes declared which role.
      const authority = {
        ...result.authority,
        roles: Object.fromEntries([...result.authority.roles].sort(([a], [b]) => (a < b ? -1 : 1))),
      };
      const reported = { ...result, authority, trust, ...(repair === null ? {} : { repair }) };
      emit(io, json, command, reported, diagnostics);
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
