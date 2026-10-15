# OMP Gitea issue read extension

This package wraps the native `read` tool in an OMP agent session. It supports both `teaissue://<issue-number>` and `teaissue://<owner>/<repo>/<issue-number>`. The short form resolves the repository using the current agent-session directory; the explicit form selects the repository without locking the Gitea instance. Add `use=<alias>` to select an existing gh-tea instance, and use both an explicit repository and `use` for stable cross-workspace selection. Each call invokes the installed `gh tea issue view` once and returns issue metadata, the original body, and (by default) the complete comment list as Markdown.

Issue numbers are positive decimal int64 values through `9223372036854775807`; leading zeroes are accepted and normalized. Both URI forms accept `use` and `comments` in either query order. `comments=0` fetches only the issue body and says that comments were not requested; the default and `comments=1` fetch the full comments list. A fetched empty list is reported as no comments. Invalid `teaissue:` URIs fail before `gh` starts. Non-`teaissue:` paths are delegated to OMP's native `read` unchanged.

## Requirements

- OMP 18.8.7 (the verified support baseline).
- `gh` and `gh-tea` v0.6.0 installed and available on `PATH`.
- A valid gh-tea login. Without explicit selectors, gh-tea resolves the instance and repository from the current session directory and its defaults; missing or ambiguous selection is reported by gh-tea rather than guessed.
- Install this package's runtime dependency before loading it:

  ```sh
  pnpm install --prod
  ```

## Load in an agent session

From the repository/session directory, explicitly load the package directory:

```sh
omp --extension /absolute/path/to/omp-gitea-issue-read
```

Then ask the model to read an issue, for example: “Read `teaissue://11`.” To select a different repository and instance from another working directory, use `teaissue://InsulateJustf/emby-pgsql/3?use=justf&comments=1`. To skip comments, use `teaissue://3?comments=0`. The model must call the session's `read` tool. This extension does not change the standalone `omp read` command or register a host-wide URI scheme. The wrapper shadows the built-in `read`; do not load another extension that independently shadows `read` in the same session because wrapper composition is not guaranteed.

PRs are rejected based on the backend's `isPullRequest` field. A valid issue response requires the complete JSON field contract (and complete comments array when requested); backend failure, invalid JSON, missing fields, invalid field types, cancellation, and timeout return tool errors rather than a partial issue. If OMP reports that the model-visible tool result was truncated, the wrapper replaces it with an explicit error rather than passing on incomplete issue data.
