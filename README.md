# OMP Gitea read extension

An OMP extension that wraps the session's native `read` tool for `teaissue:` URIs and Gitea PR lists, details, changed-file navigation, and raw diffs at `teapr://` URIs. Issue reads invoke `gh tea issue view`; PR lists invoke `gh tea pr list`; PR details invoke `gh tea pr view`; diff reads invoke `gh tea pr diff`. Other inputs go unchanged to OMP's native `read`.

## Verified support

| Component | Requirement / verified baseline | Evidence / boundary |
| --- | --- | --- |
| OMP | 18.8.7 verified; no other version claimed | Actual package-directory loading and normal-session read verified with `/opt/homebrew/bin/omp`; no remote install path is claimed. |
| gh-tea | v0.6.0 for Issue JSON; PR reads require `pr list`, `pr view --json` and `pr diff` support | Observed PR backend: v0.7.1, VCS `6d73b9a3d976b65858750dcfc1d6d67d3d85d71d`, darwin/arm64 (list build Go 1.26.0; temporary detail-verification build Go 1.27.1, `vcs.modified=false`). Repository resolution, authentication, pagination and filtering belong to gh-tea. No minimum PR-support release or unobserved build is claimed. |
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
- Issue numbers are positive decimal int64 values through `9223372036854775807`; leading zeroes normalize without lossy numeric conversion. Invalid `teaissue:` URIs fail before starting gh.

- `teapr://` lists PRs in the current repository; `teapr://<owner>/<repo>` explicitly selects a repository without pinning an instance. Add `use=<alias>` when a stable cross-workspace target is needed.
- `state=open|closed|merged|all` defaults to `open`; `closed` excludes merged PRs. `limit=<positive decimal>` defaults to `30` and is capped losslessly at `100`. `author=<login>` accepts `@me`; comma-separated labels in `label=<names>` must all match. Filtering precedes the limit and server order is retained.
- List entries include number, title, actual state, draft status, author, update time, labels and a `teapr://<number>` or `teapr://<owner>/<repo>/<number>` detail link preserving the explicit repository and `use` selection. Null metadata is displayed as `Missing`; null draft is not inferred from the title. Empty results say `No pull requests match the requested filters.`
- Only `use`, `state`, `limit`, `author` and `label` are accepted for lists. Values are decoded once; malformed encodings, selectors, fragments, unknown/repeated/empty parameters and invalid repository paths fail before gh executes. For example: `teapr://Owner/Repo?use=work&state=all&limit=10&author=%40me&label=bug%2Cready`.

- `teapr://<number>` and `teapr://<owner>/<repo>/<number>` read a complete PR detail. Only `use` and `comments` are accepted. Discussion is requested by default; `comments=0` or case-insensitive `comments=false` disables **all three** discussion collections. Every other nonempty value enables them. This deliberately differs from the strict `teaissue` `0|1` rule.
- Detail output preserves the original body and each collection's server order: metadata, Body, Files, Reviews, Review Comments, Comments. It shows actual merged, mergeable and nullable draft values, not GitHub review decisions or a safe-to-merge inference. Missing metadata is `Missing`; unrequested discussions and requested empty collections are distinct.
- Files are fetched completely but previewed up to 50 entries. An omitted-file count links to the corresponding `/diff`, preserving short/explicit repository and `use`. `teapr://<number>/diff` lists changed files in raw diff order with additions/deletions, change type and per-file links. The indices are for that read only; refresh `/diff` after PR updates before following a file index.
- `teapr://<number>/diff/all` returns the complete original unified diff unchanged; `teapr://<number>/diff/<I>` returns the exact raw segment for the 1-based file index. Explicit repository forms (`teapr://<owner>/<repo>/<number>/diff...`) and `use=<alias>` are preserved in links. Empty `/diff` navigation says `No file changes.`, while `/diff/all` is empty text and an index is out of range.
- Literal numeric short routes `teapr://<number>/diff` are reserved for PR diff navigation and accept only `use`. Thus `teapr://123/diff` means PR 123's changed files; to list repository `123/diff`, encode the repository segment (`teapr://123/%64iff`). Named repositories such as `Owner/diff` remain available as list/detail routes (`teapr://Owner/diff`, `teapr://Owner/diff/12`).
- Diff routes accept only `use`; malformed routes, selectors, query parameters, bad indices and damaged diff output fail explicitly before or during the single `gh tea pr diff <number>` invocation. Complete output is required; OMP truncation, cancellation, timeout or CLI errors never produce a successful partial diff.
- Each valid detail read makes one `gh tea pr view <number> --json <fields>` invocation with a 60-second timeout and session cancellation. A compatible backend must return every selected field and the complete selected collections. Invalid/incomplete JSON, missing fields, mismatched numbers, invalid types/IDs/timestamps, any collection failure, cancellation, timeout and host truncation fail the entire read. No partial preview or artifact is a complete successful result.

The session's native `read` continues to handle files, URLs, and GitHub `issue://` and `pr://` resources; this extension adds Gitea `teaissue:` and PR-list/detail/diff `teapr:` handling. Gitea URI handling is available only through `read` in the loaded agent session, not standalone `omp read`, `bash`/`grep` internal URI handling, global scheme registration/autocomplete, or automatic read-wrapper composition. This does not add issue search, attachments, timeline events, reactions, selectors or paged-output URIs, direct host URLs, GitHub overrides, automatic login, or plugin token/configuration management.


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
| PR-list session and navigation | Normal OMP 18.8.7 model-driven session reads with installed gh-tea v0.7.1 exercised closed/merged at limit 1, `@me` plus AND labels, null draft, explicit repo/use and cwd-resolved short links, empty results, and exact int64 `9223372036854775807`. Each assertion inspected the actual read tool result, not the model's summary. |
| PR-list pagination and atomic failure | An isolated synthetic-token HTTP fixture placed the first matching PR on page 2 after 50 nonmatching rows; actual OMP read returned that PR at limit 1. The real CLI also returned 100 ordered results across 50-row pages. A second-page 500 and malformed server JSON produced `isError: true` through OMP read without partial PR entries. Registered-read regressions additionally cover malformed selected fields and incomplete CLI JSON. |
| PR-list lifecycle and truncation | A stalled OMP read's cancellation closed the fixture socket and all sampled OMP/gh/gh-tea processes exited (4.114s whole session). The 60,000ms executor timeout also closed the socket and those processes exited (65.079s whole session, including model overhead). A temporary 1-KiB host spill threshold produced the exact PR truncation error with `isError: true`, not an artifact/partial success. These observations cover the sampled process trees, not arbitrary daemonized descendants. |
| PR-detail session and complete collections | Normal OMP 18.8.7 model-driven sessions loaded this package alone and directly called registered `read` against the real gh-tea build and an isolated synthetic-token HTTP Gitea fixture. Files/comments/reviews each had 101 entries across three 50-row pages; the final distinct comment/review bodies and inline messages from two distinct reviews were present in the untruncated result. File preview showed 50 entries, 51 omitted and the corresponding repo/use-preserving `/diff` link. |
| PR-detail discussion selection and atomic failure | A separate `comments=0` session returned the original body and all three not-requested states; HTTP logs contained only PR metadata and file pages, no discussion requests. A file-page-2 HTTP 500 and malformed server JSON returned complete `isError: true` diagnostics, not partial PR details. Registered-read regressions additionally cover malformed selected fields, missing fields, mismatched numbers, all discussion IDs/types/times, null metadata, exact whitespace and `0`/`false`/`FALSE`/other-value semantics. |
| PR-detail lifecycle and output limits | Actual registered-read RPC abort and a stalled HTTP request exceeding the real 60,000ms executor timeout returned errors without partial details. The timeout session took about 67.5s including model overhead. Logged gh-tea child PIDs were absent after both operations; the RPC host exited code 0 after stdin close. Signal exit codes were not captured, and no arbitrary daemonized-process guarantee is claimed. A temporary `--config` overlay (`tools.artifactSpillThreshold: 1`, zero artifact head/tail bytes/lines) forced a 29,008-byte result to the exact PR truncation error with `isError: true` and zero preview bytes. No persistent host configuration changed. |
| PR-detail malformed contract | An actual CLI/HTTP fixture returned valid JSON with PR number 13 for requested number 12. Registered `read` returned the `gh tea pr view JSON contract error` mismatch diagnostic and compatibility hint, without the PR body or other partial details. |
| PR diff parser and navigation | Registered-read regressions cover exact `/diff/all` preservation and per-file slicing, explicit repo/use command selection, ordered file links and refresh guidance, quoted UTF-8/octal paths, spaces and quotes, add/rename/mode/binary changes, hunk counts, CRLF, empty and malformed diffs, huge indices, and CLI failure/cancellation. These deterministic tests do not establish real OMP/gh-tea runtime behavior. |
| Real Gitea PR evidence boundary | A normal OMP session successfully read an all-state list from authorized real Gitea. Both accessible repositories, `InsulateJustf/.omp` and `InsulateJustf/emby-pgsql`, had empty all-state PR lists. Nonempty real-server PR evidence is unavailable; nonempty/filter/failure proof above uses the real CLI with a local fixture, not a live PR. No remote data, private configuration or global binaries were changed. |

Issue reads reject PR objects and incomplete CLI JSON, process failure, cancellation, timeout, and OMP-marked truncation instead of presenting partial issue data as complete. PR-list, PR-detail and PR-diff execution and contract failures are explicit errors.
