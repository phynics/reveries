# Search current rationale

## Default scope

`reveries search QUERY` begins with the selected revision’s current tree (default `HEAD`). It
searches valid reveries attached to reachable blobs, the selected commit’s session summary, and
sources in those records. This answers “Why does the repository look like this?”

Useful forms:

```bash
reveries show src/state.rs
reveries show src/state.rs --staged
reveries search 'transition authority'
reveries search --source github:owner/repository#417
reveries search --author engineer@example.com
reveries search --at HEAD
```

When a matched blob occurs under several paths, show them as navigation aids and say that the
reverie applies to content, not location. Report active, superseded, retired, malformed, and
conflicting state distinctly.

## Evidence discipline

Quote or summarize the causal fields needed to answer the question. Do not transform an issue,
email, path, or note source into proof. Say when the conclusion is an inference from the attached
record. Search does not fetch remote notes or contact source systems.
