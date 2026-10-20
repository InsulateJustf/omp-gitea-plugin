# OMP Gitea read extension

An OMP extension that wraps the session's native `read` tool for `teaissue:` URIs and Gitea PR lists at `teapr://` URIs. Issue reads invoke `gh tea issue view`; PR lists invoke `gh tea pr list`. Other inputs go unchanged to OMP's native `read`.

## Verified support

| Component | Requirement / verified baseline | Evidence / boundary |
| --- | --- | --- |
| OMP | 18.8.7 verified; no other version claimed | Actual package-directory loading and normal-session read verified with `/opt/homebrew/bin/omp`; no remote install path is claimed. |
| gh-tea | v0.6.0 for Issue JSON; PR list requires a build with `gh tea pr list` support (v0.7.0 or newer) | Authentication, instance selection, repository resolution, and server-side filtering belong to gh-tea. |
| Node.js | `package.json` requires 20+ | Runtime requirement; not an independent support-version claim. |

The package manifest declares `omp.extensions: ["./index.js"]`. Runtime dependency `lossless-json` is installed with the package; the extension uses the public ExtensionAPI supplied at load time and does not import OMP internals.

## Local install and load

Install the package runtime dependencies from its directory (pnpm and the frozen lockfile are used here):

```sh
cd /absolute/path/to/omp-gitea-plugin
pnpm install --prod --frozen-lockfile
```

In a normal agent session, load that package directory explicitly. This invocation disables discovery and other ambient tools/extensions while still loading the explicit package:

```sh
/opt/homebrew/bin/omp \
  --no-extensions --no-skills --no-rules --no-session --no-lsp --no-title \
  --tools read --mode json --cwd /tmp \
  --extension /absolute/path/to/omp-gitea-plugin \
  -p 'Use the read tool to retrieve teaissue://InsulateJustf/emby-pgsql/3?use=justf&comments=1. Report the exact title, whether the complete original body was returned, and the number of comments returned.'
```

This exact flow was exercised with OMP 18.8.7 and the package directory after `pnpm install --prod --frozen-lockfile`; the model called the session `read`, and the tool result contained the real Gitea issue metadata, full body, and both comments. The model identified the title and reported both comments. The repository path in these commands is a placeholder for the local clone path. The command's `/opt/homebrew/bin/omp` is the verified macOS binary path; use only an OMP version verified separately.

`gh` and the `gh-tea` extension must be installed and available on `PATH`, gh-tea must be authenticated, and the selected instance/repository must resolve. This guide documents local package loading, not a remote package install command. If another extension also wraps `read`, do not load it alongside this one: wrapper composition is not guaranteed.

## URI use

- `teaissue://<number>` resolves the repository from the current session working directory and gh-tea configuration.
- `teaissue://<owner>/<repo>/<number>` explicitly selects a repository; it does not pin an instance.
- `use=<alias>` selects an existing gh-tea instance. For a stable cross-workspace target, specify both the repository and `use`, for example `teaissue://InsulateJustf/emby-pgsql/3?use=justf&comments=1`.
- Comments are requested by default; `comments=1` is explicit and `comments=0` fetches only the issue body. Query order is immaterial. Not-requested comments are distinguished from a requested empty list.

- `teapr://` lists PRs in the current repository; `teapr://<owner>/<repo>` explicitly selects a repository without pinning an instance.
- `state=open|closed|merged|all` defaults to `open`. `limit=<positive decimal>` defaults to `30` and is capped at `100`; author and comma-separated label filters are passed to gh-tea. List order is the server's order.
- List entries include state, draft status, author, update time, labels and a link to the corresponding `teapr://` resource. An empty result is reported explicitly. Malformed filters fail before invoking gh.

- Issue numbers are positive decimal int64 values through `9223372036854775807`; leading zeroes normalize without lossy numeric conversion. Invalid `teaissue:` URIs fail before starting gh.

The model must call `read` in the loaded agent session. Standalone `omp read`, `bash`/`grep` internal URI handling, global scheme registration/autocomplete, and automatic read-wrapper composition are not supported. This adds PR listing only, not PR details or diffs; it also does not add issue search, attachments, timeline events, reactions, selectors or paged-output URIs, direct host URLs, GitHub `issue://` overrides, automatic login, or plugin token/configuration management.

## Verified acceptance matrix

| Acceptance area | Observed behavior and evidence type |
| --- | --- |
| Normal session, package loading, dependencies | Clean OMP 18.8.7 session loaded the package directory through its `omp.extensions` manifest with production dependencies installed; model called `read` for a real Gitea issue and received its metadata, body, and both comments. |
| Native read delegation | Six real model `read` calls against file, missing file, HTTP success/failure, and GitHub issue success/failure had identical result content, details, and error flags with and without the wrapper. |
| CWD and target resolution | Actual loaded-tool reads across two working directories selected the appropriate repositories and fresh revisions. Explicit repo plus `use` worked outside a workspace. Installed gh-tea CLI fixtures covered default instance, repo inference, unknown alias, absent auth, missing issue, and ambiguous remotes without fallback. |
| URI and data boundaries | Consumer tests and loaded-tool runs cover both URI forms, query combinations, malformed selectors/encoding, owner case, one-time decoding, leading zeroes, int64 maximum/overflow, and explicit PR rejection. |
| Complete comments and network use | Actual extension RPC against an isolated Gitea HTTP fixture returned 101 comments in server order across three pages, preserving every body and int64 IDs, including missing final-comment metadata. A later-page failure returned an error with no partial issue/comments. Successful reads made one gh invocation; `comments=0` issued no comment request. This fixture evidence complements, but is not a substitute for, the real Gitea session smoke above. |
| gh-tea v0.6.0 CLI contract | Real installed CLI verified requested JSON fields control comment retrieval, text output keeps its existing behavior, and list rejects view-only `comments`/`isPullRequest` fields. Controlled HTTP fixtures covered pagination and failures; gh-tea itself is not changed here. |
| Missing/invalid/legacy backend behavior | Deterministic registered-tool contract tests with mocked `exec` covered invalid/incomplete JSON. Actual CLI/HTTP/executable negative fixtures covered dependency absence, resolver/auth errors, nonzero exit plus stderr, failed later page and incompatible older-field behavior. The wrapper fails closed, preserves CLI diagnostics, does not retry, and requires the v0.6.0+ JSON contract. |
| Cancellation and timeout | Registered-read RPC cancellation against a stalled isolated HTTP fixture closed the response and returned an error. A separate actual OMP public-executor lifecycle run with installed gh-tea observed cancellation at 1.857s and timeout at 60.012s; both known gh/gh-tea PIDs exited and fixture sockets closed. This establishes those observed process shapes, not arbitrary daemon/reparented descendants or every possible comment-page race. |
| Output completeness limits | A deliberately low configured OMP spill threshold caused the real host to mark a real-Gitea result truncated; the loaded tool returned an explicit error, not partial content or an artifact reference. Separately the fixture RPC returned all 101 comments. OMP's default 50 KiB spill threshold and the observed 40,960-byte inline head/tail behavior are distinct limits; configurations vary, and no unlimited-output guarantee is claimed. |

Issue reads reject PR objects and incomplete CLI JSON, process failure, cancellation, timeout, and OMP-marked truncation instead of presenting partial issue data as complete. PR-list execution and JSON-contract failures are explicit errors. The extension does not claim PR-detail or diff support.
