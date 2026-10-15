# OMP Gitea issue read extension

This package wraps the native `read` tool in an OMP agent session. It supports `teaissue://N` for positive decimal issue numbers through `9223372036854775807`; leading zeroes are accepted and normalized. Each call invokes the installed `gh tea issue view` once from the current agent-session directory and returns the issue metadata, original body, and complete comment list as Markdown. Non-`teaissue:` paths are delegated unchanged to OMP's native `read`.

## Requirements

- OMP 18.8.7 (the verified support baseline).
- `gh` and `gh-tea` v0.6.0 installed and available on `PATH`.
- A valid gh-tea login and a Gitea repository remote in the session's current directory, or a gh-tea default instance/repository selection that resolves there.
- Install this package's runtime dependency before loading it:

  ```sh
  npm install --omit=dev
  ```

## Load in an agent session

From the repository/session directory, explicitly load the package directory:

```sh
omp --extension /absolute/path/to/omp-gitea-issue-read
```

Then ask the model to read an issue, for example: “Read `teaissue://11`.” The model must call the session's `read` tool. This extension does not change the standalone `omp read` command or register a host-wide URI scheme. The wrapper shadows the built-in `read`; do not load another extension that independently shadows `read` in the same session because wrapper composition is not guaranteed.

A Gitea issue is identified by `teaissue://<issue-number>` and resolved by gh-tea using the current session working directory. Issue numbers must be positive decimal int64 values. Invalid `teaissue:` URIs fail before `gh` starts. PRs are rejected based on the backend's `isPullRequest` field. A valid issue response requires the complete JSON field contract and the complete comments array; backend failure, invalid JSON, missing fields, invalid field types, cancellation, and timeout return tool errors rather than a partial issue. If OMP reports that the model-visible tool result was truncated, the wrapper replaces it with an explicit error rather than passing on incomplete issue data.
