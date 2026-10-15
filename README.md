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

In OMP 18.8.7 RPC sessions using installed gh-tea v0.6.0 against an isolated local Gitea HTTP fixture, the actual loaded `read` tool rendered all 101 comments from three server pages in order, including int64 IDs from `9223372036854775700` through `9223372036854775800`, every original comment body, and explicit `Missing` author/time/URL metadata on the final comment. This smaller result fit in the actual OMP tool result. A separate default-comments read with an empty source list rendered “No comments.” Successful reads each caused one `gh` invocation and fetched the source anew: two reads in one session cwd returned Alpha revisions 1 and 2; a different cwd returned Beta revision 1; and explicit `owner/repo` plus `use` returned Beta revision 2 from a directory without a git remote. The `comments=0` reads displayed “Comments were not requested” and made no comment-page requests. A separate fixture run returned 125,693 bytes and OMP marked its result truncated; the extension replaced it with an explicit incomplete-result error. The observed 40,960-byte `meta.maxBytes` is the inline head/tail budget, not OMP's default spill threshold; host spill occurs separately, and output limits remain configuration-dependent.

The same actual RPC surface showed that a failed second comment page exits the CLI with code 1 and empty stdout, and the loaded `read` returns an error with the exit code and stderr but no issue body or prior-page comments. A stalled comment request cancelled through the RPC abort closed the fixture response socket and returned an error. An isolated registered-read smoke with a deliberately rejecting `gh` executable returned the required `gh-tea v0.6.0+` compatibility hint for both default comments and `comments=0`, preserving the error code/stderr after exactly one execution and without retrying. Separate missing-`gh` and unavailable-`gh tea` command smokes identified the dependency from the attempted read and did not perform additional probes. That legacy-negative executable fixture is separate from the installed gh-tea v0.6.0 positive CLI/RPC fixtures.

Installed gh-tea v0.6.0 CLI runs against local HTTP fixtures observed default-instance selection with no git remote when `--repo` was explicit; an explicit repo alone retained host selection from the cwd's remote; and explicit repo plus `--use` worked outside a workspace. Unknown alias, missing authentication, nonexistent issue, and multiple matching remote instances each produced the CLI's diagnostic without fallback. The actual loaded extension's cwd smoke confirmed resolver selection for two repositories. OMP's 40,960-byte inline result budget, host spill threshold, and RPC frame limits are distinct constraints; no unlimited-output guarantee is established.
