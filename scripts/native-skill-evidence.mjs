import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evidencePath = join(workspace, "evidence", "pi-skills.json");
const skillNames = [
  "reveries-git-notes-init",
  "using-reveries",
  "reveries-git-notes-search",
];
const provider = "openai-codex";
const model = "gpt-5.4-mini";

const prompts = {
  init: "A user explicitly asks: \"Initialize Reveries in this Git repository.\" Use the installed Skill that applies, including reading its instructions before answering. Do not change files. Return exactly one compact JSON object with keys selected_skill, setup_modes, required_user_choices, and mutation_before_answers. setup_modes must name every supported way a new agent can obtain the everyday Reveries Skill. required_user_choices must name every choice that must be asked before setup. mutation_before_answers must be a boolean.",
  ordinary: "A user asks to review package.json in a repository that has no Reveries marker. Evaluate installed Reveries Skill routing only. Do not run tools or change files. Return exactly one compact JSON object with keys selected_skill and init_activated. Use null when no Reveries Skill applies.",
  use: "A Reveries-enabled repository has an annotated tracked file, and the user says: \"Edit that file and commit the change.\" Use the installed Skill that applies, reading it before answering. Do not change files. Return exactly one compact JSON object with keys selected_skill and reason.",
  search: "In this Reveries-enabled repository, explain why state.txt contains its current implementation. Use the installed Skill that applies and inspect the repository evidence. Do not change repository state. Return exactly one compact JSON object with keys selected_skill, mutates_repository, reverie_id, and decision.",
};

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await filesBelow(path));
    else if (entry.isFile()) paths.push(path);
  }
  return paths;
}

async function skillHash(name) {
  const directory = join(workspace, "skills", name);
  const hash = createHash("sha256");
  for (const path of await filesBelow(directory)) {
    hash.update(`${relative(directory, path)}\0`);
    hash.update(await readFile(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function currentSkillHashes() {
  return Object.fromEntries(await Promise.all(skillNames.map(async (name) => [name, await skillHash(name)])));
}

async function run(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? workspace,
      env: process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      const output = Buffer.concat(stdout).toString("utf8").trim();
      if (code === 0) resolvePromise(output);
      else rejectPromise(new Error(`${command} ${args.join(" ")} failed (${code}): ${Buffer.concat(stderr).toString("utf8").trim()}`));
    });
    child.stdin.end(options.input);
  });
}

async function git(directory, ...args) {
  return run("git", args, { cwd: directory });
}

function parseJsonOutput(output) {
  const lines = output.split("\n").map((line) => line.trim()).filter(Boolean);
  for (const line of lines.reverse()) {
    try {
      return JSON.parse(line);
    } catch {
      // Pi can emit non-JSON progress before its requested final object.
    }
  }
  throw new Error(`Pi did not return a JSON object: ${output}`);
}

async function runPi(prompt, cwd, tools = "read") {
  const output = await run("pi", [
    "--provider", provider,
    "--model", model,
    "--thinking", "low",
    "--approve",
    "--offline",
    "--no-session",
    "--tools", tools,
    "--print", prompt,
  ], { cwd });
  return parseJsonOutput(output);
}

async function repositorySnapshot(directory) {
  const worktreeHash = createHash("sha256");
  for (const path of await filesBelow(directory)) {
    if (path.startsWith(`${join(directory, ".git")}/`)) continue;
    worktreeHash.update(`${relative(directory, path)}\0`);
    worktreeHash.update(await readFile(path));
    worktreeHash.update("\0");
  }
  return {
    status: await git(directory, "status", "--porcelain=v1", "--untracked-files=all"),
    refs: await git(directory, "for-each-ref", "--format=%(refname) %(objectname)"),
    config: await git(directory, "config", "--local", "--list", "--show-origin"),
    worktree_sha256: worktreeHash.digest("hex"),
  };
}

async function createSearchFixture() {
  const directory = await mkdtemp(join(tmpdir(), "reveries-pi-search-"));
  await git(directory, "init", "-b", "main");
  await git(directory, "config", "user.name", "Reveries Conformance");
  await git(directory, "config", "user.email", "conformance@example.com");
  await writeFile(join(directory, "AGENTS.md"), `<!-- reveries:begin -->
## Reveries

This repository stores engineering decisions in Git notes at
\`refs/notes/reveries\`.

Before interpreting or changing tracked code, use \`using-reveries\`.
For rationale/history questions, use \`reveries-git-notes-search\`.
<!-- reveries:end -->
`, "utf8");
  await writeFile(join(directory, "state.txt"), "single guarded transition owner\n", "utf8");
  await git(directory, "add", "AGENTS.md", "state.txt");
  await git(directory, "commit", "-m", "fixture");
  const blob = await git(directory, "rev-parse", "HEAD:state.txt");
  const semantic = {
    v: 1,
    driving_event: "Two transition mechanisms could accept conflicting histories.",
    decision: "Use one guarded transition owner because validity must have a single authority.",
    impact: "Every transition writer must use the guarded boundary.",
    recurrence_control: "A concurrency test rejects stale predecessors.",
    alternatives: ["Reconcile independent histories after writes"],
    sources: [],
    supersedes: [],
  };
  const id = `rv:${await run("git", ["hash-object", "--stdin"], { cwd: directory, input: `${JSON.stringify(semantic)}\n` })}`;
  const record = {
    v: 1,
    type: "reverie",
    id,
    ...semantic,
    author_email: "conformance@example.com",
    session: "pi:conformance",
    created_at: "2026-08-25T00:00:00Z",
  };
  const noteFile = join(directory, "record.jsonl");
  await writeFile(noteFile, `${JSON.stringify(record)}\n`, "utf8");
  await git(directory, "notes", "--ref=refs/notes/reveries", "add", "--no-stripspace", "-F", noteFile, blob);
  await rm(noteFile);
  return { directory, id, decision: semantic.decision };
}

async function capture() {
  const fixture = await createSearchFixture();
  try {
    const before = await repositorySnapshot(fixture.directory);
    const search = await runPi(prompts.search, fixture.directory, "read,bash");
    const after = await repositorySnapshot(fixture.directory);
    const version = await run("pi", ["--version"]);
    const evidence = {
      schema_version: 1,
      captured_at: new Date().toISOString(),
      host: { name: "pi", version },
      model: { provider, model },
      skill_sha256: await currentSkillHashes(),
      cases: {
        init: { prompt: prompts.init, output: await runPi(prompts.init, workspace) },
        ordinary: { prompt: prompts.ordinary, output: await runPi(prompts.ordinary, workspace) },
        use: { prompt: prompts.use, output: await runPi(prompts.use, workspace) },
        search: { prompt: prompts.search, output: search },
      },
      search_audit: {
        expected_reverie_id: fixture.id,
        expected_decision: fixture.decision,
        before,
        after,
      },
    };
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function verify() {
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  assert(evidence.schema_version === 1, "unsupported native evidence schema");
  assert(evidence.host?.name === "pi" && typeof evidence.host.version === "string", "missing Pi host version");
  const hashes = await currentSkillHashes();
  assert(JSON.stringify(evidence.skill_sha256) === JSON.stringify(hashes), "native evidence is stale for the current Skill contents");

  const init = evidence.cases?.init?.output;
  assert(init?.selected_skill === "reveries-git-notes-init", "explicit initialization did not select the init Skill");
  assert(init.mutation_before_answers === false, "initialization would mutate before user choices");
  assert(JSON.stringify(init.setup_modes) === JSON.stringify(["Reminder only", "Pull when missing", "Vendored Skill"]), "initialization did not offer all Skill setup modes");
  assert(init.required_user_choices?.length === 4, "initialization did not ask all four required user choices");

  const ordinary = evidence.cases?.ordinary?.output;
  assert(ordinary?.selected_skill === null && ordinary.init_activated === false, "init Skill activated implicitly");
  assert(evidence.cases?.use?.output?.selected_skill === "using-reveries", "annotated edit did not select the use Skill");

  const search = evidence.cases?.search?.output;
  assert(search?.selected_skill === "reveries-git-notes-search", "rationale query did not select the search Skill");
  assert(search.mutates_repository === false, "search claimed it mutates the repository");
  assert(search.reverie_id === evidence.search_audit.expected_reverie_id, "search did not return the fixture reverie");
  assert(typeof search.decision === "string" && search.decision.includes("single authority"), "search did not explain the fixture decision");
  assert(JSON.stringify(evidence.search_audit.before) === JSON.stringify(evidence.search_audit.after), "Pi search changed repository state");
  process.stdout.write(`Pi ${evidence.host.version} Skill evidence passed.\n`);
}

if (process.argv.includes("--capture")) await capture();
else await verify();
