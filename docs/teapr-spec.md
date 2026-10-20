# Gitea Pull Request 读取规格

## Problem Statement

加载 omp-gitea-plugin 的 agent 会话目前只能经 teaissue 读取 Gitea Issue，不能像原生 GitHub pr 读取那样发现 PR、阅读完整描述与评审、浏览变更文件和原始 diff。已安装 gh-tea 的命令帮助没有 PR 命令，因此不能用 mock 成功或 Issue 详情冒充 PR 支持。

本文将既有 PR 计划整理为可拆票规格。此次授权为文档和跨仓库开票，不包含功能实现、安装后端、发布版本或创建 Gitea 验证数据。旧计划“本轮不创建 issue”的限制已被本次开票授权替代。

## Solution

在公开 ExtensionAPI 的会话内 read wrapper 增加 teapr 读取，经一次 gh tea CLI 调用实时读取列表、单 PR 和 diff。gh-tea 负责现有 Tea/Host、认证、仓库解析、服务器筛选与完整取数；插件负责 URI、严格校验、展示和导航。所有错误显式失败，不展示部分成功。

Tea 是指向 Gitea Host 并持有认证身份的命名配置项；Host 是实例基础 URL。PR 不是普通 Issue。Discussion Comment 针对整个 PR，Review 是对某次版本的整体反馈，Review Comment 附着在变更文件或 diff 位置。Changed File 是变更涉及的文件；Diff 是完整或单文件 unified diff 文本。

## User Stories

1. As an agent user, I want to list PRs in the current repository, so that I can discover work without knowing a number.
2. As an agent user, I want state, author and label filters with a bounded limit, so that I can find relevant PRs.
3. As an agent user, I want explicit repository and Tea selection, so that reads remain correctly targeted outside a checkout.
4. As an agent user, I want full PR descriptions and metadata, so that I can understand intent without summary loss.
5. As an agent user, I want actual merged, mergeable and draft information, so that I am not shown invented GitHub conclusions.
6. As an agent user, I want files, reviews, review comments and discussion comments, so that I can inspect all feedback.
7. As an agent user, I want to disable all three discussion collections, so that I can request only the PR itself.
8. As an agent user, I want missing metadata distinguished from false and empty collections, so that unknown information is not misrepresented.
9. As an agent user, I want changed-file navigation and per-file raw diff, so that I can inspect a narrow change.
10. As an agent user, I want the original complete diff, so that whitespace and binary changes remain intact.
11. As an agent user, I want malformed URIs and out-of-range indices rejected, so that I cannot accidentally read the wrong resource.
12. As an agent user, I want complete pagination and atomic failure, so that partial discussions cannot appear complete.
13. As an agent user, I want cancellation, timeout and truncation to be explicit errors, so that I can trust successful results.
14. As an existing user, I want teaissue and native read behavior preserved, so that adding PR support does not break other resources.
15. As an installer, I want documented observed compatibility and reproducible loading, so that unimplemented or untested support is never advertised.

## Implementation Decisions

### Shared URI and execution interface

Use public ExtensionAPI only, keep read parameters `{ path: string }`, existing native delegation and Issue validation. No internal router imports. Only lowercase teapr scheme is valid; case-insensitive recognition catches malformed variants rather than delegating them. Decode path/query exactly once; preserve repository case; owner/repo allows letters, digits, underscore, dot and hyphen. Reject empty/dot/dot-dot/decoded slash or backslash segments, malformed encoding, fragments, unsupported selectors, unknown/repeated/empty parameters, empty query and surplus path segments before executing gh. PR number is canonical decimal in 1..9223372036854775807, never rounded through JS Number.

| URI | Result | Allowed query |
| --- | --- | --- |
| teapr:// or teapr://owner/repo | PR list | use,state,limit,author,label |
| teapr://N or teapr://owner/repo/N | PR detail | use,comments |
| Single PR + /diff | Changed files and per-file links | use |
| Single PR + /diff/all | Original unified diff | use |
| Single PR + /diff/I | Original file segment, I starts at 1 | use |

The literal numeric short form `teapr://N/diff` is reserved for PR diff navigation (only `use` is allowed). Consequently, a repository named `diff` under a numeric owner uses an encoded segment such as `teapr://123/%64iff` for list reads; named-owner `teapr://Owner/diff`, `teapr://Owner/Diff`, plus numeric-owner `teapr://123/Diff` remain list routes, and `teapr://Owner/diff/12` remains a detail route.

List defaults open/30, state open|closed|merged|all, positive decimal limit clamped at 100 after lossless comparison. Author/label are nonempty single filter values; comma-separated labels match all names. Detail includes discussion by default; comments=0 or case-insensitive false disables all three collections; any other nonempty value enables them. This does not change teaissue's existing 0|1 rule. Diff indices remain decimal strings until range-checked against file count; out-of-range errors include count and /diff navigation.

Each read executes gh once, using argument arrays, invocation cwd, cancellation signal and 60000 ms timeout. Add --repo owner/repo and --use alias only when explicitly supplied. Repository alone does not pin the Host; stable cross-directory targeting requires repo plus use. No token/config reads or independent resolver in the plugin. Native file/HTTP/issue/pr results and teaissue PR rejection remain unchanged. All generated links preserve short versus explicit repository forms and use, encoding query values once.

### gh-tea CLI and data contract

- `gh tea pr list --state S --limit L [--author A] [--label names] --json fields`: selected-field JSON array, default open/30, positive limit, preserve server order. Apply state/author/labels before limit, fetching enough pages; closed excludes merged, merged includes only merged, all includes all. Resolve @me as the authenticated user.
- `gh tea pr view N --json fields`: reject ordinary Issue, missing/inaccessible PR; only fetch selected optional collections.
- `gh tea pr diff N`: exact raw unified diff including obtainable binary changes, no color/header/JSON/patch-mail envelope. Diagnostics only on stderr.
- All commands reuse existing --repo/--use/cwd/auth semantics; no new authentication or generic API interface.

Exact list field selection: number,title,state,isDraft,url,createdAt,updatedAt,author.login,labels[].name,baseRefName,headRefName.

Exact detail selection: number,title,state,isDraft,url,createdAt,updatedAt,closedAt,author.login,labels[].name,baseRefName,headRefName,body,merged,mergedAt,mergeable,files. Append comments,reviews,reviewComments only when discussion is enabled.

Dot/array projection matches existing Issue JSON: author.login becomes author:{login}, labels[].name becomes labels:[{name}]. Unknown fields fail; list rejects view-only fields. All selected fields exist, absent data is null or [], and unselected optional collections trigger no corresponding network reads.

| Data | Required shape |
| --- | --- |
| Base | number positive int64 JSON integer; title/body string; state open/closed/merged; url string/null; author {login:string}/null; labels [{name:string}] |
| Time and refs | createdAt/updatedAt/closedAt/mergedAt RFC3339/null; baseRefName/headRefName string/null from base.ref/head.ref |
| Actual state | isDraft boolean/null from server draft, never fixed client WIP-prefix inference; merged boolean; mergeable boolean/null, not a safe-to-merge guarantee |
| files | [{path:string,previousPath:string/null,status:string,additions:nonnegative integer,deletions:nonnegative integer}], all pages, original status |
| comments | [{id,author,body,createdAt,updatedAt,url}], positive int64 id, body string, author/time/URL nullable as above |
| reviews | [{id,author,body,state,submittedAt,commitOid,url,stale,official,dismissed}], positive int64 id, body/state strings, submittedAt RFC3339/null, commitOid/url string/null, flags boolean |
| reviewComments | [{id,reviewId,author,body,createdAt,updatedAt,url,path,position,originalPosition}], positive int64 IDs, body string, author/time/URL nullable, path string/null, positions nonnegative JSON integer/null |

Preserve all ID precision, body text and collection order. Fully fetch files, comments and reviews pages and every review's inline comments. The known SDK review-comments method returns the complete set per review; do not invent pagination arguments. Selected-collection failure is nonzero with no partial success JSON. Existing SDK lacks draft and list author/label options; backend must obtain authoritative data rather than silently omit it. Backend internal design is not prescribed.

### Plugin validation and presentation

Use lossless JSON parsing and existing validators where semantics fit. Time validators apply only to timestamps, not nullable URL/ref strings. Missing fields, wrong types, wrong requested number, invalid IDs/time or incomplete JSON fail atomically. PR data must not pass through Issue validation.

Lists show number/title/state/draft when true/author/update/labels/detail link. Echo state and limit, not a claim to show every PR. Empty result: `No pull requests match the requested filters.`

Detail sections: metadata, Body, Files, Reviews, Review Comments, Comments. Show number/title/state/isDraft/author/base/head/created/updated/closed/labels/URL/merged/mergedAt/mergeable. Preview at most 50 files with explicit omission and /diff navigation. Keep all bodies unchanged. Review state and stale/official/dismissed remain server values. Review comments show path, position/original position and review ID, not invented source line/side/reply fields. Preserve separate server ordering rather than manufacture a global timeline. Null metadata displays Missing; null draft is not false. Disabled discussion is explicitly not requested; requested [] is explicitly empty.

Preserve dependency/stderr/timeout/cancellation diagnostics but name actual PR command, not issue view. Compatibility hint: `This resource requires gh-tea PR read support (pr list, pr view JSON, and pr diff); install a compatible gh-tea build.` No invented minimum version; preserve Issue's existing hint. Truncated teapr read becomes an error: `Gitea pull request result was truncated by OMP's output limit. The complete PR result is unavailable.` Artifact previews are not successful complete results.

### Diff module interface

One focused parser retains original text and returns unified text plus ordered file metadata: path, optional oldPath, additions, deletions, changeType, startOffset, endOffset. Offsets are JS string indices, not bytes. Split at line-start diff --git; full diff returns untouched input, file diff slices [startOffset,endOffset). Preserve newlines, whitespace and binary payload. Decode Git quoted paths, escapes and octal UTF-8 bytes; use file headers, rename and mode metadata to determine path/type. Count additions/deletions only inside hunks, never header lines. Classify modified|added|deleted|renamed|binary, including Binary files differ and GIT binary patch. Pure rename/mode changes may have zero counts.

Empty stdout is no files; /diff says `No file changes.`, /diff/all returns empty text, every file index is out of range. Nonempty malformed diff, missing usable headers/path or damaged structure fails, not an empty result. Indices refer to this read; PR updates may reorder them, so navigation says to refresh /diff. No cache/snapshot or synthetic fallback.

## Testing Decisions

The primary plugin seam is the registered read tool, using existing tool-registration tests, not source-text assertions or exported private validators. Check behavior, int64/encoding boundaries, actual bodies, filters, navigation and native delegation. A focused diff parser may be exercised for uncertain parsing cases, but integration must prove /diff/2 exactly equals the second raw segment of /diff/all.

Each ticket includes its own deterministic regression coverage, real CLI/surface smoke and documentation; there is no deferred QA/wiring ticket. Backend uses CLI with isolated Gitea HTTP fixture. Plugin uses actual OMP extension loading and real gh-tea build, plus readable real PR without creating remote data. First declared OMP baseline is 18.8.7; dependencies must be installed and compatible. Run plugin pnpm test during implementation, not this documentation task.

Matrix: default/disabled/empty discussions; exact whitespace; maximum int64; malformed/duplicate/unknown query and selectors before exec; list defaults/cap/empty/closed versus merged; missing/null metadata; original native success/error; CLI failure/cancellation/timeout/bad JSON/truncation; diff added/deleted/rename/mode/binary/empty/damaged/quoted/Unicode/hunk header-like lines/out-of-range.

Use temporary synthetic-token Gitea fixture with 101 files/comments/reviews, page size 50, unique last-page markers, inline messages on two reviews, second-page 500, mixed closed/merged before limit=1, stalled requests and low OMP output limit. Drive plugin cases through actual OMP read, observe cancellation/60-second timeout process exit and atomic failure. Fixture wiring remains throwaway; permanent tests must protect consumer behavior. Never alter private config/global binaries. If no authorized real PR exists after checking available repositories, record fixture evidence and missing real-server proof explicitly; do not claim actual Gitea verification.

## Out of Scope

PR writes; generic API command; new auth/instance resolution; direct Gitea URL/host/alias path prefixes; raw/media/line selectors; output pagination; retries/cache/MCP/HTTP plugin fallback; synthesized patches or GitHub reviewDecision/mergeStateStatus; standalone omp read support; grep/bash URI support; global completion; automatic composition of competing read wrappers. No release number or untested OMP version is promised.

## Further Notes

Approved split: backend list A, detail B, raw diff C; plugin list D blocked by A, detail E blocked by B, diff F blocked by C. These are capability dependencies, not a forced serial chain. Shared wrapper edits require integration coordination, not invented blockers. Each ticket is self-contained and carries its exact relevant contract, so remote agents need not access an ignored local plan. All use ready-for-agent; a blocked ticket is not on the runnable frontier until its native blocker is complete.

This spec is planning evidence, not evidence that teapr works. The creation session observed existing read/Issue test seams and absence of PR in installed gh-tea help; it did not run future functionality.

Design references: [OMP v18.8.7 protocol](https://github.com/can1357/oh-my-pi/blob/v18.8.7/packages/coding-agent/src/internal-urls/issue-pr-protocol.ts), [public ExtensionAPI](https://github.com/can1357/oh-my-pi/blob/v18.8.7/packages/coding-agent/src/extensibility/extensions/types.ts), [Gitea PR API](https://docs.gitea.com/api/operations/repo-get-pull-request), [review comments API](https://docs.gitea.com/api/operations/repo-get-pull-review-comments).

## Published tickets

Formal spec published for remote readers: https://github.com/InsulateJustf/omp-gitea-plugin/issues/6#issuecomment-6188426808

| Slice | Ticket | Native blocked by |
| --- | --- | --- |
| A — backend list | https://github.com/InsulateJustf/gh-tea/issues/7 | None |
| B — backend detail | https://github.com/InsulateJustf/gh-tea/issues/8 | None |
| C — backend raw diff | https://github.com/InsulateJustf/gh-tea/issues/9 | None |
| D — plugin list | https://github.com/InsulateJustf/omp-gitea-plugin/issues/6 | InsulateJustf/gh-tea#7 |
| E — plugin detail | https://github.com/InsulateJustf/omp-gitea-plugin/issues/7 | InsulateJustf/gh-tea#8 |
| F — plugin diff | https://github.com/InsulateJustf/omp-gitea-plugin/issues/8 | InsulateJustf/gh-tea#9 |
