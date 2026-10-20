import assert from "node:assert/strict";
import test from "node:test";
import extension from "../index.js";

const detail = {
  number: 7, title: "Detail title", state: "open", isDraft: null,
  url: "https://gitea.example/Owner/Repo/pulls/7", createdAt: "2026-10-14T08:00:00Z",
  updatedAt: "2026-10-14T09:00:00Z", closedAt: null, author: { login: "alice" },
  labels: [{ name: "bug" }, { name: "ready" }], baseRefName: null, headRefName: "feature",
  body: "Body keeps trailing spaces  \nand exact\n\n", merged: false, mergedAt: null, mergeable: true,
  files: [{ path: "src/file.js", previousPath: null, status: "added", additions: "__MAX__", deletions: 0 }],
  comments: [{ id: "__MAX__", author: { login: "bob" }, body: "Comment 1  \n\n", createdAt: "2026-10-14T10:00:00Z", updatedAt: null, url: null }],
  reviews: [{ id: "__MAX_MINUS_1__", author: { login: "carol" }, body: "Review body  \n\n", state: "APPROVED", submittedAt: "2026-10-14T11:00:00Z", commitOid: null, url: null, stale: false, official: true, dismissed: false }],
  reviewComments: [{ id: "__MAX_MINUS_2__", reviewId: "__MAX_MINUS_1__", author: null, body: "Inline body  \n\n", createdAt: null, updatedAt: null, url: null, path: "src/file.js", position: "__MAX__", originalPosition: null }],
};

function stringify(value) {
  return JSON.stringify(value)
    .replaceAll('"__MAX__"', "9223372036854775807")
    .replaceAll('"__MAX_MINUS_1__"', "9223372036854775806")
    .replaceAll('"__MAX_MINUS_2__"', "9223372036854775805")
    .replaceAll('"__OVERFLOW__"', "9223372036854775808");
}

function json(overrides = {}) {
  return stringify({ ...detail, ...overrides });
}

function load({ stdout = json(), code = 0, killed = false, stderr = "" } = {}) {
  let registered;
  let resultHook;
  const pi = {
    zod: { object: (shape) => shape, string: () => ({}) },
    on(event, handler) { if (event === "tool_result") resultHook = handler; },
    registerTool(tool) { registered = tool; },
    async exec(...args) { this.execArgs = args; return { stdout, code, killed, stderr }; },
  };
  extension(pi);
  return { tool: registered, pi, resultHook };
}

async function read(tool, path, ctx = { cwd: "/work/repo" }, signal = new AbortController().signal) {
  return tool.execute("call-1", { path }, signal, undefined, ctx);
}

function text(result) {
  return result.content.map((part) => part.text).join("\n");
}

test("reads short and explicit PR details with exact fields and comments selection", async () => {
  const short = load({ stdout: json({ number: "__MAX__" }) });
  const result = await read(short.tool, "teapr://0009223372036854775807?comments=TRUE&use=work");
  assert.equal(result.isError, undefined);
  assert.equal(short.pi.execArgs[0], "gh");
  assert.deepEqual(short.pi.execArgs[1], ["tea", "pr", "view", "9223372036854775807", "--use", "work", "--json", "number,title,state,isDraft,url,createdAt,updatedAt,closedAt,author.login,labels[].name,baseRefName,headRefName,body,merged,mergedAt,mergeable,files,comments,reviews,reviewComments"]);
  assert.equal(short.pi.execArgs[2].cwd, "/work/repo");
  assert.equal(short.pi.execArgs[2].signal instanceof AbortSignal, true);
  assert.equal(short.pi.execArgs[2].timeout, 60000);

  for (const value of ["0", "false", "FALSE"]) {
    const disabled = load();
    const output = await read(disabled.tool, `teapr://Owner/Repo/7?comments=${value}`);
    assert.equal(output.isError, undefined);
    assert.deepEqual(disabled.pi.execArgs[1], ["tea", "pr", "view", "7", "--repo", "Owner/Repo", "--json", "number,title,state,isDraft,url,createdAt,updatedAt,closedAt,author.login,labels[].name,baseRefName,headRefName,body,merged,mergedAt,mergeable,files"]);
    assert.match(text(output), /Comments were not requested/);
  }
  const enabled = await read(load().tool, "teapr://Owner/Repo/7?comments=anything");
  assert.match(text(enabled), /Comment 1/);
});

test("renders ordered sections and preserves body whitespace and lossless integer text", async () => {
  const output = await read(load().tool, "teapr://7");
  const rendered = text(output);
  assert.equal(output.isError, undefined);
  assert.ok(rendered.indexOf("## Body") < rendered.indexOf("## Files"));
  assert.ok(rendered.indexOf("## Files") < rendered.indexOf("## Reviews"));
  assert.ok(rendered.indexOf("## Reviews") < rendered.indexOf("## Review Comments"));
  assert.ok(rendered.indexOf("## Review Comments") < rendered.indexOf("## Comments"));
  assert.ok(rendered.includes("Body keeps trailing spaces  \nand exact\n\n"));
  assert.ok(rendered.includes("Review body  \n\n"));
  assert.ok(rendered.includes("Inline body  \n\n"));
  assert.match(rendered, /9223372036854775807/);
  assert.match(rendered, /9223372036854775806/);
  assert.match(rendered, /9223372036854775805/);
  assert.match(rendered, /Draft: Missing/);
  assert.match(rendered, /Base: Missing/);
});

test("distinguishes missing data from requested empty collections", async () => {
  const empty = { ...detail, author: null, labels: [], files: [], comments: [], reviews: [], reviewComments: [] };
  const rendered = text(await read(load({ stdout: stringify(empty) }).tool, "teapr://7"));
  assert.match(rendered, /Author: Missing/);
  assert.match(rendered, /Labels: none/);
  assert.match(rendered, /No changed files/);
  assert.match(rendered, /No reviews/);
  assert.match(rendered, /No review comments/);
  assert.match(rendered, /No comments/);
});

test("rejects malformed fields and collection entries atomically", async (t) => {
  for (const [name, overrides] of [
    ["wrong returned number", { number: 8 }], ["overflow number", { number: "__OVERFLOW__" }],
    ["invalid timestamp", { createdAt: "2026-02-30T00:00:00Z" }], ["missing required field", { title: undefined }],
    ["bad author shape", { author: {} }], ["bad labels", { labels: [null] }],
    ["wrong files shape", { files: {} }], ["bad file path", { files: [{ ...detail.files[0], path: null }] }],
    ["bad previous path", { files: [{ ...detail.files[0], previousPath: 3 }] }],
    ["bad status", { files: [{ ...detail.files[0], status: 4 }] }],
    ["bad additions", { files: [{ ...detail.files[0], additions: -1 }] }],
    ["bad comments shape", { comments: {} }], ["bad comment ID", { comments: [{ ...detail.comments[0], id: 0 }] }],
    ["bad comment time", { comments: [{ ...detail.comments[0], createdAt: "nope" }] }],
    ["bad reviews shape", { reviews: [null] }], ["bad review ID", { reviews: [{ ...detail.reviews[0], id: 0 }] }],
    ["bad review time", { reviews: [{ ...detail.reviews[0], submittedAt: "nope" }] }],
    ["bad review flag", { reviews: [{ ...detail.reviews[0], dismissed: "false" }] }],
    ["bad review comments shape", { reviewComments: [null] }],
    ["bad inline ID", { reviewComments: [{ ...detail.reviewComments[0], id: 0 }] }],
    ["bad inline review ID", { reviewComments: [{ ...detail.reviewComments[0], reviewId: 0 }] }],
    ["bad inline time", { reviewComments: [{ ...detail.reviewComments[0], updatedAt: "nope" }] }],
    ["bad inline position", { reviewComments: [{ ...detail.reviewComments[0], position: -1 }] }],
  ]) {
    await t.test(name, async () => {
      const output = await read(load({ stdout: json(overrides) }).tool, "teapr://7");
      assert.equal(output.isError, true);
      assert.doesNotMatch(text(output), /Detail title/);
    });
  }
});

test("rejects invalid detail URIs without execution", async () => {
  for (const path of ["teapr://0", "teapr://9223372036854775808", "teapr://Owner/Repo/7/extra", "teapr://Owner/../7", "teapr://Owner/Repo/7#fragment", "teapr://Owner/Repo/7?unknown=x", "teapr://Owner/Repo/7?comments=0&comments=1", "teapr://Owner/Repo/7?use=", "teapr://Owner/Repo/7?comments=%ZZ", "teapr://Owner/Repo/7/diff/1"]) {
    const { tool, pi } = load();
    const result = await read(tool, path);
    assert.equal(result.isError, true, path);
    assert.equal(pi.execArgs, undefined, path);
  }
});

test("previews only 50 of 52 changed files and provides diff navigation", async () => {
  const files = Array.from({ length: 52 }, (_, index) => ({ path: `file-${index + 1}.txt`, previousPath: null, status: "modified", additions: index, deletions: 0 }));
  const rendered = text(await read(load({ stdout: json({ files }) }).tool, "teapr://Owner/Repo/7?use=work"));
  assert.match(rendered, /file-50\.txt/);
  assert.doesNotMatch(rendered, /file-51\.txt/);
  assert.match(rendered, /2 more files omitted/);
  assert.match(rendered, /teapr:\/\/Owner\/Repo\/7\/diff\?use=work/);
});

test("preserves PR list dispatch alongside detail parsing", async () => {
  for (const [path, args] of [["teapr://", ["tea", "pr", "list"]], ["teapr://123/diff?state=all", ["tea", "pr", "list", "--repo", "123/diff", "--state", "all", "--limit", "30"]]]) {
    const { tool, pi } = load({ stdout: "[]" });
    const output = await read(tool, path);
    assert.equal(output.isError, undefined);
    assert.deepEqual(pi.execArgs[1].slice(0, args.length), args);
  }
});

test("reports detail execution errors, cancellation, timeout and truncation", async () => {
  const failed = await read(load({ code: 1, stderr: "denied" }).tool, "teapr://7");
  assert.match(text(failed), /gh tea pr view exited with code 1/);
  assert.match(text(failed), /denied/);
  assert.match(text(failed), /gh-tea PR read support/);
  const timeout = await read(load({ killed: true, stderr: "timeout" }).tool, "teapr://7");
  assert.match(text(timeout), /cancelled or timed out: timeout/);
  const controller = new AbortController();
  const cancelled = load();
  cancelled.pi.exec = async () => {
    controller.abort();
    return { stdout: json(), code: 0, killed: false, stderr: "" };
  };
  assert.match(text(await read(cancelled.tool, "teapr://7", { cwd: "/work/repo" }, controller.signal)), /cancelled or timed out/);
  const beforeExecution = load();
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  assert.match(text(await read(beforeExecution.tool, "teapr://7", { cwd: "/work/repo" }, alreadyAborted.signal)), /cancelled before execution/);
  assert.equal(beforeExecution.pi.execArgs, undefined);
  const { resultHook } = load();
  const truncated = resultHook({ toolName: "read", input: { path: "teapr://7" }, details: { meta: { truncation: { originalLength: 90000 } } } });
  assert.equal(truncated.isError, true);
  assert.match(text(truncated), /complete PR result is unavailable/);
});

test("preserves native reads and teaissue handling", async () => {
  for (const path of ["README.md", "https://example.test", "issue://owner/repo/1", "pr://owner/repo/1"]) {
    let forwarded;
    const expected = { content: [{ type: "text", text: "native" }], details: { source: path } };
    const { tool, pi } = load();
    const result = await read(tool, path, { cwd: "/work/repo", invokeTool: async (params) => { forwarded = params; return expected; } });
    assert.deepEqual(forwarded, { path });
    assert.equal(result, expected);
    assert.equal(pi.execArgs, undefined);
  }
  const issueJson = JSON.stringify({ number: 1, title: "Legacy issue", state: "open", url: null, createdAt: null, updatedAt: null, closedAt: null, author: null, labels: [], assignees: [], milestone: null, body: "Issue body", isPullRequest: false });
  const teaissue = load({ stdout: issueJson });
  const result = await read(teaissue.tool, "teaissue://Owner/Repo/1?comments=0");
  assert.equal(result.isError, undefined);
  assert.match(text(result), /Legacy issue/);
  assert.equal(teaissue.pi.execArgs[1][1], "issue");
});
