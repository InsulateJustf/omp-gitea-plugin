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

## Failure and output limits

The extension accepts a result only when `gh tea issue view` exits successfully and returns one complete JSON object with every requested field. A failed later comment page therefore fails the whole CLI call; the extension does not render an issue or partial comment list. Nonzero exits retain the exit code and stderr. Contract errors and nonzero exits identify the required `gh`/`gh-tea` dependency and the v0.6.0+ JSON contract; authentication, unknown aliases, missing issues, and repository/instance ambiguity remain gh-tea diagnostics.

When comments are requested, the CLI must return the complete server-ordered comments array. The extension does not truncate comments itself. In OMP 18.8.7 RPC sessions using installed gh-tea v0.6.0 against an isolated local Gitea HTTP fixture, the actual loaded tool resolved the same issue number 7 to distinct Alpha and Beta repositories from two separate session `cwd`s. A separate read returned 101 comments (119,734 CLI stdout bytes) from three pages. With page 2 deliberately failing, the CLI exited 1 with empty stdout and the actual loaded `read` tool returned an error containing the exit code and stderr, not the issue body or page-1 comments. A separate RPC read against the fixture with 101 large comments produced 125,693 bytes; OMP's default 40,960-byte result limit marked it truncated and the extension returned an explicit error. A real OMP abort sent while page 1 was blocked produced a cancellation error and closed the fixture's HTTP response socket. A separate session with a deliberately lowered 1-byte spill threshold observed the same fail-closed path. These observations do not establish an unlimited output guarantee: the host may constrain results at its configured limit, and very large RPC frames have separate transport limits.
