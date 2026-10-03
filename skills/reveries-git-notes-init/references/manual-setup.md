# Manual repository setup

Use this Git-only path when the Reveries helper is not available. The helper remains the preferred
setup path because it validates records and installs local hooks. Manual setup creates the same
tracked instruction blocks and adoption evidence; it does not provide the helper's strict checks or
atomic publication.

Before changing the repository, answer each question explicitly:

1. How should agents obtain the Skills: reminder only, pull from an approved repository, vendored
   copies, tracked project symlinks, or a pinned submodule?
2. Which hosts should use this setup? No host adapters is a valid answer.
3. Which remotes publish Reveries? Local-only is a valid answer. Do not select `origin` unless the
   user selects it.
4. Which Git email identifies material user directives? Leaving it unset is valid. This is separate
   from `git config user.email`, which is required as the author of the adoption records.

Confirm the repository root and review its existing files and configuration. Configure
`user.name` and `user.email` if they are missing. Do not overwrite unrelated prose, hooks, or Git
configuration. Stop if the repository has a conflicting Reveries marker, an unresolved notes
merge, or an unsafe generic push refspec that the user has not reviewed.

## Select Skill delivery

Choose exactly one mode. The blocks below are the helper-owned `AGENTS.md` block. Replace
`{{SKILL_REPOSITORY}}` in pull and submodule blocks with the approved HTTPS GitHub URL before
adding the block. Add the whole block between its markers to the root `AGENTS.md`, preserving all
other text. Do not add another copy if the markers already exist.

### Reminder only

Use this mode when each agent host already has the Skills.

<!-- manual-template:agents-reminder -->
```markdown
<!-- reveries:begin -->
## Reveries

This repository stores engineering decisions in Git notes at
`refs/notes/reveries`.

Before interpreting or changing tracked code, use `using-reveries`.
For rationale and history questions, use `reveries-git-notes-search`.

Automatic note delivery is best-effort. When needed, inspect a file directly:

    git notes --ref=refs/notes/reveries show \
      "$(git rev-parse 'HEAD:path/to/file')"

Before publishing:
- every changed annotated blob must continue, supersede, or retire its prior reveries;
- every post-initialization commit must have exactly one valid session summary;
- use `reveries push <remote>` for publication; generic `git push` is not atomic.
<!-- reveries:end -->
```

### Pull when a Skill is unavailable

Choose an approved HTTPS GitHub repository. The instruction tells a person how to install the
Skills; it does not run an installer during agent startup.

<!-- manual-template:agents-pull -->
```markdown
<!-- reveries:begin -->
## Reveries

This repository stores engineering decisions in Git notes at
`refs/notes/reveries`.

Before interpreting or changing tracked code, use `using-reveries`.
For rationale and history questions, use `reveries-git-notes-search`.

If `using-reveries` is unavailable, install it from
`{{SKILL_REPOSITORY}}` before continuing:

    npx skills add {{SKILL_REPOSITORY}} --skill using-reveries \
      --skill reveries-git-notes-search \
      --skill reveries-git-notes-init --yes

Restart the agent host after installation so that it discovers the Skill.

Automatic note delivery is best-effort. When needed, inspect a file directly:

    git notes --ref=refs/notes/reveries show \
      "$(git rev-parse 'HEAD:path/to/file')"

Before publishing:
- every changed annotated blob must continue, supersede, or retire its prior reveries;
- every post-initialization commit must have exactly one valid session summary;
- use `reveries push <remote>` for publication; generic `git push` is not atomic.
<!-- reveries:end -->
```

### Vendored Skills

Choose a repository-relative source directory that contains all three tracked Skill directories.
The following commands use `skills` as the selected source root. Copy each directory, then record
ownership. If you use a different source root, put that exact relative path in the ownership file.

```sh
mkdir -p .agents/skills
cp -R skills/using-reveries .agents/skills/using-reveries
cp -R skills/reveries-git-notes-search .agents/skills/reveries-git-notes-search
cp -R skills/reveries-git-notes-init .agents/skills/reveries-git-notes-init
printf '%s\n' '{"kind":"vendored","sourceRoot":"skills"}' > .agents/skills/.reveries-owned.json
```

Commit the vendored copies and ownership file with the adoption change. Later updates arrive as
reviewed repository changes; agent startup must not update them.

<!-- manual-template:agents-vendored -->
```markdown
<!-- reveries:begin -->
## Reveries

This repository stores engineering decisions in Git notes at
`refs/notes/reveries`.

Before interpreting or changing tracked code, use `using-reveries`.
For rationale and history questions, use `reveries-git-notes-search`.

This repository vendors the Reveries Skills under `.agents/skills`. If the
host did not load them, read `.agents/skills/using-reveries/SKILL.md` before
continuing.

Automatic note delivery is best-effort. When needed, inspect a file directly:

    git notes --ref=refs/notes/reveries show \
      "$(git rev-parse 'HEAD:path/to/file')"

Before publishing:
- every changed annotated blob must continue, supersede, or retire its prior reveries;
- every post-initialization commit must have exactly one valid session summary;
- use `reveries push <remote>` for publication; generic `git push` is not atomic.
<!-- reveries:end -->
```

### Linked project Skills

Choose this mode only when each file in all three source Skill directories is tracked. The paths
below link `.agents/skills` to a `skills` source root and match the helper's relative symlinks.

```sh
mkdir -p .agents/skills
ln -s ../../skills/using-reveries .agents/skills/using-reveries
ln -s ../../skills/reveries-git-notes-search .agents/skills/reveries-git-notes-search
ln -s ../../skills/reveries-git-notes-init .agents/skills/reveries-git-notes-init
printf '%s\n' '{"kind":"symlink","sourceRoot":"skills"}' > .agents/skills/.reveries-owned.json
```

Use a different relative symlink target and `sourceRoot` value if the tracked Skills live elsewhere.
Do not replace an existing nonmatching path.

<!-- manual-template:agents-symlink -->
```markdown
<!-- reveries:begin -->
## Reveries

This repository stores engineering decisions in Git notes at
`refs/notes/reveries`.

Before interpreting or changing tracked code, use `using-reveries`.
For rationale and history questions, use `reveries-git-notes-search`.

This repository exposes linked project Skills under `.agents/skills`. If the
host did not load them, read `.agents/skills/using-reveries/SKILL.md` before
continuing.

Automatic note delivery is best-effort. When needed, inspect a file directly:

    git notes --ref=refs/notes/reveries show \
      "$(git rev-parse 'HEAD:path/to/file')"

Before publishing:
- every changed annotated blob must continue, supersede, or retire its prior reveries;
- every post-initialization commit must have exactly one valid session summary;
- use `reveries push <remote>` for publication; generic `git push` is not atomic.
<!-- reveries:end -->
```

### Pinned Git submodule

Choose the approved repository URL. This pins the selected revision as a gitlink; do not advance it
automatically with `--remote`.

```sh
git submodule add --name reveries-skills \
  "{{SKILL_REPOSITORY}}" .agents/reveries
```

<!-- manual-template:agents-submodule -->
```markdown
<!-- reveries:begin -->
## Reveries

This repository stores engineering decisions in Git notes at
`refs/notes/reveries`.

Before interpreting or changing tracked code, use `using-reveries`.
For rationale and history questions, use `reveries-git-notes-search`.

This repository pins the Reveries Skills in the Git submodule
`.agents/reveries` from `{{SKILL_REPOSITORY}}`. If the submodule is absent or
uninitialized, restore its recorded commit before continuing:

    git submodule update --init --recursive -- .agents/reveries

If the host did not load the Skill, read
`.agents/reveries/skills/using-reveries/SKILL.md` before continuing.

Automatic note delivery is best-effort. When needed, inspect a file directly:

    git notes --ref=refs/notes/reveries show \
      "$(git rev-parse 'HEAD:path/to/file')"

Before publishing:
- every changed annotated blob must continue, supersede, or retire its prior reveries;
- every post-initialization commit must have exactly one valid session summary;
- use `reveries push <remote>` for publication; generic `git push` is not atomic.
<!-- reveries:end -->
```

## Select host instruction files

Keep the `AGENTS.md` block even when no host adapters are selected. The protocol host names are
`pi`, `claude`, `opencode`, `codex`, and `gemini`. Pi, OpenCode, and Codex use `AGENTS.md`. Add the
following owned block in `CLAUDE.md` only if Claude Code is selected:

<!-- manual-template:host-claude -->
```markdown
<!-- reveries:begin -->
@AGENTS.md
<!-- reveries:end -->
```

Add this owned block in `GEMINI.md` only if Gemini is selected:

<!-- manual-template:host-gemini -->
```markdown
<!-- reveries:begin -->
@./AGENTS.md
<!-- reveries:end -->
```

Preserve all text outside these marker blocks. Do not create either host file when its host is not
selected.

## Configure Git and prepare the adoption files

Set the protocol merge strategy:

```sh
git config notes.reveries.mergeStrategy cat_sort_uniq
```

For each explicitly selected publishing remote, add the wildcard refspec without removing the
remote's other fetch refspecs. Run this Bash block for each selected remote. It treats exit status
`1` as an absent key, propagates other Git errors, and is safe to repeat:

<!-- manual-template:remote-fetch -->
```bash
set -e

remote='the-selected-remote'
fetch_key="remote.${remote}.fetch"
fetch_refspec="+refs/notes/reveries*:refs/notes/remotes/${remote}/reveries*"
fetch_values=''
if fetch_values=$(git config --get-all "$fetch_key"); then
  :
else
  status=$?
  if [ "$status" -ne 1 ]; then
    exit "$status"
  fi
fi

fetch_found=false
while IFS= read -r configured_fetch; do
  if [ "$configured_fetch" = "$fetch_refspec" ]; then
    fetch_found=true
    break
  fi
done <<< "$fetch_values"

if [ "$fetch_found" = false ]; then
  git config --add "$fetch_key" "$fetch_refspec"
fi
```

Set the local publication choices to match the answers. Set `publishing_remotes` to the selected
remote names, or to an empty Bash array for local-only setup. This guarded block removes prior
values only when the key exists. It treats Git's exit status `1` as “not configured” and propagates
other read or write errors:

<!-- manual-template:publishing-remotes -->
```bash
set -e

unset_config_if_present() {
  key="$1"
  if git config --get-all "$key" >/dev/null; then
    git config --unset-all "$key" || return $?
  else
    status=$?
    if [ "$status" -ne 1 ]; then
      return "$status"
    fi
  fi
}

publishing_remotes=('the-selected-remote')
directive_email='the-selected-directive-email'
unset_config_if_present reveries.publishingRemote || exit $?
for remote in "${publishing_remotes[@]}"; do
  git config --add reveries.publishingRemote "$remote"
done

if [ "${#publishing_remotes[@]}" -eq 0 ]; then
  git config reveries.localOnly true
else
  git config reveries.localOnly false
fi

if [ -n "$directive_email" ]; then
  git config reveries.directiveEmail "$directive_email"
else
  unset_config_if_present reveries.directiveEmail || exit $?
fi
```

Set `directive_email` to the selected value. Use an empty string when the user left it unset. The
block removes an earlier value only when Git reports that the key exists, and propagates other Git
configuration errors.

Inspect every selected remote's `remote.<name>.push` values. Do not add generic push refspecs. Stop
and review any existing value; the helper's pre-push hook rejects generic branch publication.

Review exactly which paths belong in the adoption commit. Build a Bash array containing `AGENTS.md`,
the selected host files, and only the selected vendored/symlink/submodule paths. Do not stage the
whole `.agents/skills` directory because it may contain unrelated files. For example:

```bash
adoption_paths=(AGENTS.md)
# Add only the paths selected above. Examples:
# adoption_paths+=(CLAUDE.md GEMINI.md)
# adoption_paths+=(.agents/skills/.reveries-owned.json .agents/skills/using-reveries .agents/skills/reveries-git-notes-search .agents/skills/reveries-git-notes-init)
# adoption_paths+=(.agents/reveries .gitmodules)

git add -A -- "${adoption_paths[@]}"
git commit --only -m 'Adopt Reveries' -- "${adoption_paths[@]}"
```

The `--only` commit limits this adoption commit to the listed paths and leaves unrelated staged
changes out of it. If there is nothing to commit, stop and review the setup instead of creating an
empty commit.

## Attach the adoption records

Create one JSONL file with exactly two canonical records, in the order shown: one
`session-summary` and one `reveries-init`. Replace the sample author, timestamp, host, and remote
with the answers for this repository. Use the same author and UTC timestamp in both records. The
author is `git config user.email`; the optional directive email is separate. If a directive email
was selected, add this source to the summary entry's `sources` array:

```json
{"relation":"requested-by","kind":"git-email","ref":"directive@example.com"}
```

Keep one compact JSON object per line, protocol key order, and one final LF per record. Do not add
whitespace inside either JSON object. Example for a Codex host, the `origin` publishing remote, and
no directive email:

<!-- manual-template:adoption-records -->
```jsonl
{"v":1,"type":"session-summary","author_email":"you@example.com","session":null,"created_at":"2026-01-01T00:00:00Z","entries":[{"driving_event":"The repository needs durable engineering decisions beside the Git objects they explain.","decision":"Adopt Reveries v1 because blob notes preserve file decisions and commit notes preserve the causal account of each published change.","impact":"Published descendants require one session summary, and changes to annotated blobs require an explicit continuity disposition.","recurrence_control":"The pre-push checker validates summary coverage, decision continuity, and notes publication.","alternatives":["Keep engineering rationale only in commit messages and project documentation"],"sources":[],"reveries":[],"retirements":[]}]}
{"v":1,"type":"reveries-init","protocol":1,"notes_ref":"refs/notes/reveries","publishing_remotes":["origin"],"hosts":["codex"],"author_email":"you@example.com","created_at":"2026-01-01T00:00:00Z"}
```

Save both lines to one file, then attach that file to the adoption commit. Use one `git notes add`
operation; do not use `git notes append`, which can insert a non-canonical paragraph separator.

```sh
git notes --ref=refs/notes/reveries add -F /tmp/reveries-adoption.jsonl HEAD
```

The notes ref is not a tracked file. The `reveries-init` record establishes the protocol boundary
and records the selected historical hosts and publishing remotes. The summary explains the adoption
commit. Keep both records on that exact commit.

## Validate and publish

When the helper is available, run:

```sh
reveries doctor
reveries check HEAD
```

Before helper hooks are installed, `doctor` can report missing helper/hook enforcement. Those are
local enforcement diagnostics; they do not replace a passing strict `check HEAD`. After installing
the helper, run `reveries init` with the same explicit answers. It should leave the tracked blocks
and selected tracked Skill files unchanged, install the local hooks, and make `doctor` healthy.

Prefer `reveries push <remote>` when the helper is available; it requests an atomic code-plus-notes
push. With Git only, publish notes first and the branch second. These are separate, lower-grade
operations, not an atomic update. If the notes push fails, stop before pushing the branch. If the
branch push fails after notes succeed, leave the notes in place and reconcile remote state before
retrying. Do not bypass installed hooks. If a local hook rejects either push, stop and resolve its
diagnostic; do not use `--no-verify`.

```sh
branch=$(git branch --show-current)
git push 'the-selected-remote' refs/notes/reveries:refs/notes/reveries
git push 'the-selected-remote' "$branch:refs/heads/$branch"
```

Never force either ref. Local hooks are not a security boundary; configure receive-side enforcement
for a stronger publication boundary.
