import assert from "node:assert/strict";
import test from "node:test";
import extension from "../index.js";

const issueJson = `{
  "number": 7,
  "title": "Issue title",
  "state": "open",
  "url": "https://gitea.example/Owner/Repo/issues/7",
  "createdAt": "2026-10-14T08:00:00Z",
  "updatedAt": "2026-10-14T09:00:00Z",
  "closedAt": null,
  "author": { "login": "alice" },
  "labels": [{ "name": "bug" }],
  "assignees": [{ "login": "bob" }],
  "milestone": null,
  "body": "Issue body\\nsecond line",
  "isPullRequest": false,
  "comments": [{
    "id": 9223372036854775806,
    "author": { "login": "carol" },
    "body": "Comment body\\nwith exact text",
    "createdAt": "2026-10-14T10:00:00Z",
    "updatedAt": "2026-10-14T10:00:00Z",
    "url": "https://gitea.example/Owner/Repo/issues/7#issuecomment-9223372036854775806"
  }]
}`;

function load({ stdout = issueJson, code = 0, killed = false, stderr = "" } = {}) {
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

const listJson = `[{
  "number": 12,
  "title": "List title",
  "state": "open",
  "isDraft": true,
  "url": "https://gitea.example/Owner/Repo/pulls/12",
  "createdAt": "2026-10-14T08:00:00Z",
  "updatedAt": "2026-10-14T09:00:00Z",
  "author": { "login": "alice" },
  "labels": [{ "name": "bug" }, { "name": "ready" }],
  "baseRefName": "main",
  "headRefName": "feature"
}]`;

test("lists PRs with bounded filters and links back to the selected URI", async () => {
  const { tool, pi } = load({ stdout: listJson });
  const result = await read(tool, "teapr://Owner/Repo?state=all&limit=200&author=alice&label=bug%2Cready&use=work");
  assert.equal(result.isError, undefined);
  assert.match(text(result), /PR #12: List title/);
  assert.match(text(result), /State: open; draft: yes; author: alice; updated: 2026-10-14T09:00:00Z; labels: bug, ready/);
  assert.match(text(result), /teapr:\/\/Owner\/Repo\/12\?use=work/);
  assert.deepEqual(pi.execArgs[1], [
    "tea", "pr", "list", "--repo", "Owner/Repo", "--use", "work",
    "--state", "all", "--limit", "100", "--author", "alice", "--label", "bug,ready",
    "--json", "number,title,state,isDraft,url,createdAt,updatedAt,author.login,labels[].name,baseRefName,headRefName",
  ]);
});

test("uses default PR list filters and reports an empty result explicitly", async () => {
  const { tool, pi } = load({ stdout: "[]" });
  const result = await read(tool, "teapr://");
  assert.equal(text(result), "No pull requests match the requested filters.\nRequested state: open; limit: 30.");
  assert.deepEqual(pi.execArgs[1], [
    "tea", "pr", "list", "--state", "open", "--limit", "30", "--json",
    "number,title,state,isDraft,url,createdAt,updatedAt,author.login,labels[].name,baseRefName,headRefName",
  ]);
});
test("reads full issue and losslessly renders int64 identifiers", async () => {
  const { tool } = load();
  const signal = new AbortController().signal;
  const result = await read(tool, "teaissue://0007", { cwd: "/work/repo" }, signal);

  assert.equal(result.isError, undefined, text(result));
  assert.match(text(result), /# 7: Issue title/);
  assert.match(text(result), /Issue body\nsecond line/);
  assert.match(text(result), /Comment body\nwith exact text/);
  assert.match(text(result), /9223372036854775806/);
});

test("preserves the maximum int64 issue number in the CLI invocation and result", async () => {
  const max = "9223372036854775807";
  const stdout = issueJson.replace('"number": 7', `"number": ${max}`);
  const { tool, pi } = load({ stdout });
  const result = await read(tool, `teaissue://${max}`);
  assert.match(text(result), new RegExp(`# ${max}: Issue title`));
  assert.equal(pi.execArgs[1][3], max);
});

test("rejects invalid issue URIs and out-of-range ids before executing gh", async () => {
  for (const path of [
    "TeaIssue://7",
    "teaissue://0",
    "teaissue://+1",
    "teaissue://9223372036854775808",
    "teaissue://1/extra",
    "teaissue:/1",
  ]) {
    const { tool, pi } = load();
    const result = await read(tool, path);
    assert.equal(result.isError, true, path);
    assert.match(text(result), /Invalid teaissue URI/, path);
    assert.equal(pi.execArgs, undefined, path);
  }
});
test("rejects malformed selectors before the backend can run", async () => {
  for (const path of [
    "teaissue://Owner//Repo/1",
    "teaissue://Owner/./1",
    "teaissue://Owner/%2e%2e/1",
    "teaissue://Owner/Re%2Fpo/1",
    "teaissue://Owner/Re%5cpo/1",
    "teaissue://Owner/Bad%3FRepo/1",
    "teaissue://Owner/Repo/1/",
    "teaissue://Owner/Repo/1#fragment",
    "teaissue://user@host/Owner/Repo/1",
    "teaissue://host:8080/Owner/Repo/1",
    "teaissue://https://host/Owner/Repo/1",
    "teaissue://Owner/Repo/1?line=2",
    "teaissue://Owner/Repo/1?use=",
    "teaissue://Owner/Repo/1?comments=",
    "teaissue://Owner/Repo/1?comments=2",
    "teaissue://Owner/Repo/1?use=one&use=two",
    "teaissue://Owner/Repo/1?comments=1&comments=0",
    "teaissue://Owner/Repo/1?use=%",
    "teaissue://Owner/Repo/1?comments=%2531",
  ]) {
    const { tool, pi } = load();
    const result = await read(tool, path);
    assert.equal(result.isError, true, path);
    assert.match(text(result), /Invalid teaissue URI/, path);
    assert.equal(pi.execArgs, undefined, path);
  }
});


test("renders comments as not requested when comments are disabled", async () => {
  const { tool } = load();
  const result = await read(tool, "teaissue://7?comments=0");
  assert.equal(result.isError, undefined, text(result));
  assert.match(text(result), /Issue body\nsecond line/);
  assert.match(text(result), /Comments were not requested\./);
  assert.doesNotMatch(text(result), /Comment body/);
});

test("accepts a body-only response without comments when comments were not requested", async () => {
  const stdout = issueJson.replace(/,\n  "comments": \[[\s\S]*?\]/, "");
  const { tool } = load({ stdout });
  const result = await read(tool, "teaissue://7?comments=0");
  assert.equal(result.isError, undefined, text(result));
  assert.match(text(result), /Comments were not requested\./);
});

test("distinguishes an empty requested comment list from comments not requested", async () => {
  const stdout = issueJson.replace(/"comments": \[[\s\S]*?\]/, '"comments": []');
  const { tool } = load({ stdout });
  const result = await read(tool, "teaissue://7");
  assert.equal(result.isError, undefined, text(result));
  assert.match(text(result), /No comments\./);
});
test("decodes accepted query values once before selecting behavior", async () => {
  const { tool } = load();
  const result = await read(tool, "teaissue://Owner/Repo/0007?comments=%31");
  assert.equal(result.isError, undefined, text(result));
  assert.match(text(result), /Comment body\nwith exact text/);
});
test("still rejects pull requests when comments are not requested", async () => {
  const stdout = issueJson.replace('"isPullRequest": false', '"isPullRequest": true').replace(/,\n  "comments": \[[\s\S]*?\]/, "");
  const { tool } = load({ stdout });
  const result = await read(tool, "teaissue://7?comments=0");
  assert.equal(result.isError, true);
  assert.match(text(result), /pull request/);
});

test("rejects pull requests and incomplete or mistyped backend JSON", async (t) => {
  const cases = [
    ["pull request", issueJson.replace('"isPullRequest": false', '"isPullRequest": true')],
    ["missing issue field", issueJson.replace('"title": "Issue title",', "")],
    ["invalid issue field type", issueJson.replace('"isPullRequest": false', '"isPullRequest": "false"')],
    ["invalid JSON", "{\"number\":7"],
  ];
  for (const [name, stdout] of cases) {
    await t.test(name, async () => {
      const { tool } = load({ stdout });
      const result = await read(tool, "teaissue://7");
      assert.equal(result.isError, true);
    });
  }
});


test("fails closed when OMP marks a teaissue read result as truncated", () => {
  const { resultHook } = load();
  const result = resultHook({
    toolName: "read",
    input: { path: "teaissue://7" },
    details: { meta: { truncation: { originalLength: 90000 } } },
  });
  assert.equal(result.isError, true);
  assert.match(text(result), /truncated by OMP's output limit/);
});
test("rejects impossible calendar dates and time offsets", async () => {
  for (const value of [
    "2026-02-30T08:00:00Z",
    "2025-02-29T08:00:00Z",
    "2026-01-01T24:00:00Z",
    "2026-01-01T08:60:00Z",
    "2026-01-01T08:00:00+24:00",
    "2026-01-01T08:00:00+00:60",
  ]) {
    const { tool } = load({ stdout: issueJson.replace("2026-10-14T08:00:00Z", value) });
    const result = await read(tool, "teaissue://7");
    assert.equal(result.isError, true, value);
    assert.match(text(result), /RFC3339/, value);
  }
});


test("preserves nonzero exit diagnostics and identifies the required backend", async () => {
  const { tool } = load({ code: 1, stderr: "permission denied" });
  const result = await read(tool, "teaissue://7");
  assert.equal(result.isError, true);
  assert.match(text(result), /exited with code 1/);
  assert.match(text(result), /permission denied/);
  assert.match(text(result), /gh-tea.*0\.6\.0/i);
});
test("rejects trailing JSON, arrays, and malformed or mistyped PR fields", async (t) => {
  const cases = [
    ["trailing garbage", `${issueJson} trailing`],
    ["second top-level value", `${issueJson} {}`],
    ["array root", `[${issueJson}]`],
    ["string PR field", issueJson.replace('"isPullRequest": false', '"isPullRequest": "false"')],
    ["null PR field", issueJson.replace('"isPullRequest": false', '"isPullRequest": null')],
  ];
  for (const [name, stdout] of cases) {
    await t.test(name, async () => {
      for (const uri of ["teaissue://7", "teaissue://7?comments=0"]) {
        const { tool } = load({ stdout });
        const result = await read(tool, uri);
        assert.equal(result.isError, true);
        assert.match(text(result), /gh tea JSON contract error/);
        assert.doesNotMatch(text(result), /Issue title|Comment body/);
      }
    });
  }
});

test("renders requested comments in source order with missing metadata explicit", async () => {
  const comments = [
    { id: "9223372036854775807", author: null, body: "", createdAt: null, updatedAt: null, url: null },
    { id: 12, author: { login: "bob" }, body: "second source comment", createdAt: "2026-10-14T10:00:00Z", updatedAt: null, url: null },
    { id: 13, author: null, body: "third source comment", createdAt: null, updatedAt: null, url: null },
  ];
  const stdout = issueJson.replace(/"comments": \[[\s\S]*?\]/, `"comments": ${JSON.stringify(comments).replace('"id":"9223372036854775807"', '"id":9223372036854775807')}`);
  const { tool } = load({ stdout });
  const result = await read(tool, "teaissue://7");
  assert.equal(result.isError, undefined, text(result));
  const output = text(result);
  assert.match(output, /Comment 9223372036854775807/);
  assert.match(output, /Comment 9223372036854775807\n- Author: Missing\n- Created: Missing\n- Updated: Missing\n- URL: Missing\n\n\n/);
  assert.ok(output.indexOf("Comment 9223372036854775807") < output.indexOf("second source comment"));
  assert.ok(output.indexOf("second source comment") < output.indexOf("third source comment"));
});

test("rejects malformed requested comments without returning the issue body", async () => {
  const stdout = issueJson.replace(/"comments": \[[\s\S]*?\]/, '"comments": {"partial":true}');
  const { tool } = load({ stdout });
  const result = await read(tool, "teaissue://7");
  assert.equal(result.isError, true);
  assert.match(text(result), /comments must be an array/);
  assert.doesNotMatch(text(result), /Issue body|Comment body/);
});
test("keeps gh-tea selection and authentication diagnostics verbatim", async () => {
  for (const stderr of [
    "unknown gh-tea instance alias",
    "cannot resolve repository from this working directory",
    "issue not found",
    "authentication required",
  ]) {
    const { tool } = load({ code: 1, stderr });
    const result = await read(tool, "teaissue://Owner/Repo/7?use=missing");
    assert.equal(result.isError, true);
    assert.match(text(result), new RegExp(stderr));
    assert.match(text(result), /gh-tea.*0\.6\.0/i);
  }
});
test("rejects malformed PR list URIs before execution and keeps native reads delegated", async () => {
  const { tool, pi } = load();
  for (const path of [
    "TEAPR://Owner/Repo?state=other",
    "teapr://Owner/Repo?limit=0",
    "teapr://Owner/Repo?limit=1&limit=2",
    "teapr://Owner/Repo?unknown=x",
    "teapr://Owner/Repo?label=",
  ]) {
    const result = await read(tool, path);
    assert.equal(result.isError, true, path);
  }
  assert.equal(pi.execArgs, undefined);
  const delegated = { content: [{ type: "text", text: "native" }] };
  const native = await read(tool, "README.md", { cwd: "/work/repo", invokeTool: async () => delegated });
  assert.equal(native, delegated);
});
test("uses teapr diagnostics for malformed encoding and rejects selectors before execution", async () => {
  for (const path of ["teapr://Owner/Re%2Fpo", "teapr://?use=%"]) {
    const { tool, pi } = load();
    const result = await read(tool, path);
    assert.equal(result.isError, true, path);
    assert.match(text(result), /Invalid teapr URI/, path);
    assert.doesNotMatch(text(result), /Invalid teaissue URI/, path);
    assert.equal(pi.execArgs, undefined, path);
  }
});

test("normalizes large PR limits and preserves short links and once-encoded use values", async () => {
  const { tool, pi } = load({ stdout: listJson });
  const result = await read(tool, "teapr://?state=closed&limit=000000000000000000000200&use=a%20b%25%2B");
  assert.equal(result.isError, undefined, text(result));
  assert.match(text(result), /teapr:\/\/12\?use=a%20b%25%2B/);
  assert.deepEqual(pi.execArgs[1], [
    "tea", "pr", "list", "--use", "a b%+", "--state", "closed", "--limit", "100",
    "--json", "number,title,state,isDraft,url,createdAt,updatedAt,author.login,labels[].name,baseRefName,headRefName",
  ]);
});

test("renders closed and merged PR states and explicit repository navigation", async () => {
  const rows = ["closed", "merged"].map((state, index) => ({ ...JSON.parse(listJson)[0], number: index + 20, state }));
  const result = await read(load({ stdout: JSON.stringify(rows) }).tool, "teapr://Owner/Repo?state=merged");
  assert.equal(result.isError, undefined, text(result));
  assert.match(text(result), /State: closed/);
  assert.match(text(result), /State: merged/);
  assert.match(text(result), /teapr:\/\/Owner\/Repo\/20/);
  assert.match(text(result), /teapr:\/\/Owner\/Repo\/21/);
});
test("rejects malformed PR metadata and later corrupt entries atomically", async (t) => {
  const nullMetadata = listJson.replace('"author": { "login": "alice" }', '"author": null')
    .replace('"url": "https://gitea.example/Owner/Repo/pulls/12"', '"url": null')
    .replace('"updatedAt": "2026-10-14T09:00:00Z"', '"updatedAt": null')
    .replace('"isDraft": true', '"isDraft": null')
    .replace('"baseRefName": "main"', '"baseRefName": null')
    .replace('"headRefName": "feature"', '"headRefName": null');
  const missing = await read(load({ stdout: nullMetadata }).tool, "teapr://");
  assert.equal(missing.isError, undefined, text(missing));
  assert.match(text(missing), /draft: Missing; author: Missing; updated: Missing/);
  const invalids = [
    ["malformed JSON", "[{"],
    ["invalid author login", listJson.replace('"login": "alice"', '"login": 7')],
    ["invalid update time", listJson.replace("2026-10-14T09:00:00Z", "yesterday")],
    ["invalid base ref", listJson.replace('"baseRefName": "main"', '"baseRefName": 4')],
    ["invalid draft", listJson.replace('"isDraft": true', '"isDraft": "true"')],
  ];
  for (const [name, stdout] of invalids) {
    await t.test(name, async () => {
      const result = await read(load({ stdout }).tool, "teapr://");
      assert.equal(result.isError, true);
      assert.match(text(result), /gh tea pr list JSON contract error/);
      assert.doesNotMatch(text(result), /List title/);
    });
  }
  const laterCorrupt = `[${listJson.slice(1, -1)},{"number":13}]`;
  const result = await read(load({ stdout: laterCorrupt }).tool, "teapr://");
  assert.equal(result.isError, true);
  assert.doesNotMatch(text(result), /List title/);
});

test("names PR list execution failures and handles cancellation, timeout and truncation explicitly", async () => {
  const { tool } = load({ code: 1, stderr: "denied" });
  const failure = await read(tool, "teapr://");
  assert.match(text(failure), /gh tea pr list exited with code 1/);
  assert.match(text(failure), /denied/);
  assert.match(text(failure), /gh-tea PR read support/);

  const throwing = load();
  throwing.pi.exec = async () => { throw new Error("spawn failure"); };
  const thrown = await read(throwing.tool, "teapr://");
  assert.match(text(thrown), /Unable to execute gh tea pr list: spawn failure/);

  const cancelled = load({ killed: true, stderr: "signal" });
  const cancelledResult = await read(cancelled.tool, "teapr://");
  assert.match(text(cancelledResult), /gh tea pr list was cancelled or timed out: signal/);

  const { resultHook } = load();
  const truncated = resultHook({
    toolName: "read",
    input: { path: "teapr://" },
    details: { meta: { truncation: { originalLength: 90000 } } },
  });
  assert.equal(truncated.isError, true);
  assert.equal(text(truncated), "Gitea pull request result was truncated by OMP's output limit. The complete PR result is unavailable.");
});
test("preserves native file, HTTP, issue and PR read results without crossing into Gitea handling", async () => {
  for (const [path, expected] of [
    ["README.md", { content: [{ type: "text", text: "file" }], details: { path: "README.md" } }],
    ["https://example.test", { content: [{ type: "text", text: "HTTP" }], isError: true, details: { status: 503 } }],
    ["issue://owner/repo/1", { content: [{ type: "text", text: "issue" }], details: { source: "native issue" } }],
    ["pr://owner/repo/1", { content: [{ type: "text", text: "PR" }], details: { source: "native PR" } }],
  ]) {
    let forwarded;
    const { tool, pi } = load();
    const result = await read(tool, path, {
      cwd: "/work/repo",
      invokeTool: async (params) => { forwarded = params; return expected; },
    });
    assert.deepEqual(forwarded, { path });
    assert.equal(result, expected);
    assert.equal(pi.execArgs, undefined);
  }
});

test("reports an already-aborted PR read before invoking gh", async () => {
  const { tool, pi } = load();
  const controller = new AbortController();
  controller.abort();
  const result = await read(tool, "teapr://", { cwd: "/work/repo" }, controller.signal);
  assert.equal(result.isError, true);
  assert.match(text(result), /gh tea pr list was cancelled before execution/);
  assert.equal(pi.execArgs, undefined);
});
test("keeps PR numbers lossless and rejects list contract errors atomically", async () => {
  const maxNumber = listJson.replace('"number": 12', '"number": 9223372036854775807');
  const maxRead = await read(load({ stdout: maxNumber }).tool, "teapr://");
  assert.equal(maxRead.isError, undefined);
  assert.match(text(maxRead), /PR #9223372036854775807:/);

  const overflow = listJson.replace('"number": 12', '"number": 9223372036854775808');
  const invalidRead = await read(load({ stdout: overflow }).tool, "teapr://");
  assert.equal(invalidRead.isError, true);
  assert.match(text(invalidRead), /positive int64 range/);
  assert.doesNotMatch(text(invalidRead), /List title/);
});

test("reads exact raw PR diffs and links files back to the selected diff", async () => {
  const raw = [
    "diff --git a/old name.txt b/old name.txt",
    "index 1..2 100644",
    "--- a/old name.txt",
    "+++ b/old name.txt",
    "@@ -1 +1,2 @@",
    "-old",
    "+new",
    "+extra",
    "diff --git a/second b/second",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/second",
    "@@ -0,0 +1 @@",
    "+hello",
  ].join("\n");
  const { tool, pi } = load({ stdout: raw });
  const all = await read(tool, "teapr://Owner/Repo/0012/diff/all?use=work");
  assert.equal(text(all), raw);
  assert.deepEqual(pi.execArgs[1], ["tea", "pr", "diff", "12", "--repo", "Owner/Repo", "--use", "work"]);
  const second = await read(tool, "teapr://Owner/Repo/12/diff/2?use=work");
  assert.equal(text(second), raw.slice(raw.indexOf("diff --git a/second")));
  const navigation = await read(tool, "teapr://Owner/Repo/12/diff?use=work");
  assert.ok(text(navigation).includes("1. modified: old name.txt (+2 -1)"));
  assert.ok(text(navigation).includes("2. added: second (+1 -0)"));
  assert.ok(text(navigation).includes("teapr://Owner/Repo/12/diff/1?use=work"));
  assert.ok(text(navigation).toLowerCase().includes("re-read /diff"));
});

test("decodes explicit PR diff numbers once before routing", async () => {
  const raw = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n";
  const { tool } = load({ stdout: raw });
  const base = "teapr://Owner/Repo/%30%31/diff";
  assert.equal(text(await read(tool, `${base}/all?use=work`)), raw);
  assert.equal(text(await read(tool, `${base}/1?use=work`)), raw);
  assert.match(text(await read(tool, `${base}?use=work`)), /teapr:\/\/Owner\/Repo\/1\/diff\/1\?use=work/);

  const invalid = load({ stdout: raw });
  const result = await read(invalid.tool, "teapr://Owner/Repo/%2531/diff/all");
  assert.equal(result.isError, true);
  assert.equal(invalid.pi.execArgs, undefined);
});

test("rejects malformed PR diff and unsafe indices before backend execution", async () => {
  for (const path of ["TEAPR://12/diff", "teapr://12/diff:raw", "teapr://12/diff/0", "teapr://12/diff/1/extra",
    "teapr://12/diff/all?use=", "teapr://12/diff?use=a&use=b", "teapr://12/diff/all#part",
    "teapr://12/diff/%ZZ", "teapr://12/diff/all?raw=1", "teapr://12/diff?state=all"]) {
    const { tool, pi } = load({ stdout: "diff --git a/x b/x\n" });
    const result = await read(tool, path);
    assert.equal(result.isError, true, path);
    assert.equal(pi.execArgs, undefined, path);
  }
  const valid = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n";
  const huge = await read(load({ stdout: valid }).tool, "teapr://12/diff/999999999999999999999999999999");
  assert.equal(huge.isError, true);
  assert.match(text(huge), /999999999999999999999999999999.*1 files/);
});

test("fails closed for empty-index, malformed, and truncated raw diff output", async () => {
  const empty = load({ stdout: "" });
  assert.equal(text(await read(empty.tool, "teapr://12/diff")), "No file changes.");
  assert.equal(text(await read(empty.tool, "teapr://12/diff/all")), "");
  assert.match(text(await read(empty.tool, "teapr://12/diff/1")), /out of range.*0 files/i);
  for (const raw of [
    "not a diff",
    "diff --git a/x b/x\n--- a/x\n+++ b/x\n",
    "diff --git a/x b/x\n--- a/x\n+++ b/y\n@@ -1 +1 @@\n-a\n+b\n",
    "diff --git a/x b/x\nold mode 100644\nnew mode 100755\n@@ -1 +1 @@\n-a\n+b\n",
    "diff --git a/image b/image\nGIT binary patch\n",
    "diff --git a/image b/image\nGIT binary patch\nliteral 3\nA00000\n\nliteral 0\n\n",
    "diff --git a/image b/image\nGIT binary patch\nliteral 8\nPcmZQ@^7Lb5VrBpU1tI|8\n\nliteral 0\n\n",
    "diff --git a/image b/image\nGIT binary patch\ndelta 3\nKc${NqW&i*H5&#DP\n\nliteral 0\nHcmV?d00001\n\n",
    "diff --git a/old b/new\nsimilarity index 100%\nrename from old\n",
    "diff --git a/old b/new\nsimilarity index 100%\nrename to new\n",
    "diff --git a/x b/x\nold mode 100644\n",
    "diff --git a/x b/x\nnew mode 100755\n",
  ]) {
    const result = await read(load({ stdout: raw }).tool, "teapr://12/diff/all");
    assert.equal(result.isError, true, raw);
  }
});
test("decodes quoted Unicode paths and classifies rename, mode, and binary changes", async () => {
  const quoted = String.raw`diff --git "a/space \303\251 \"x\".txt" "b/space \303\251 \"x\".txt"` +
    "\r\nindex 1..2 100644\r\n--- \"a/space \\303\\251 \\\"x\\\".txt\"\r\n+++ \"b/space \\303\\251 \\\"x\\\".txt\"\r\n" +
    "@@ -1,2 +1,2 @@\r\n-old\r\n+new\r\n----marker\r\n++++marker\r\n\\ No newline at end of file\r\n";
  const rename = "diff --git a/old b/new\nsimilarity index 100%\nrename from old\nrename to new\n";
  const mode = "diff --git a/script b/script\nold mode 100644\nnew mode 100755\n";
  const deleted = "diff --git a/gone b/gone\ndeleted file mode 100644\n--- a/gone\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n";
  const binary = "diff --git a/image b/image\nGIT binary patch\nliteral 8\nPcmZQ@^7Lb5VrBpU1tI|8\n\nliteral 0\nHcmV?d00001\n\n";
  const delta = "diff --git a/delta-image b/delta-image\nGIT binary patch\ndelta 6\nNc${NqX3k432LJ-T0aO40\n\nliteral 0\nHcmV?d00001\n\n";
  const differ = "diff --git a/other-image b/other-image\nBinary files a/other-image and b/other-image differ\n";
  const emptyAddition = "diff --git a/empty b/empty\nnew file mode 100644\n";
  const emptyDeletion = "diff --git a/empty-gone b/empty-gone\ndeleted file mode 100644\n";
  const raw = [quoted, rename, mode, deleted, binary, differ, delta, emptyAddition, emptyDeletion].join("");
  const { tool } = load({ stdout: raw });
  const listing = text(await read(tool, "teapr://12/diff"));
  assert.ok(listing.includes("1. modified: space é \"x\".txt (+2 -2)"));
  assert.ok(listing.includes("2. renamed: new (from old) (+0 -0)"));
  assert.ok(listing.includes("3. modified: script (+0 -0)"));
  assert.ok(listing.includes("4. deleted: gone (+0 -1)"));
  assert.ok(listing.includes("5. binary: image (+0 -0)"));
  assert.ok(listing.includes("7. binary: delta-image (+0 -0)"));
  assert.ok(listing.includes("6. binary: other-image (+0 -0)"));
  assert.ok(listing.includes("8. added: empty (+0 -0)"));
  assert.ok(listing.includes("9. deleted: empty-gone (+0 -0)"));
  const selected = await read(tool, "teapr://12/diff/1");
  assert.equal(text(selected), quoted);
});
test("PR diff execution failures are atomic and retain CLI diagnostics", async () => {
  const failed = load({ code: 2, stderr: "permission denied" });
  const result = await read(failed.tool, "teapr://12/diff/all");
  assert.equal(result.isError, true);
  assert.match(text(result), /gh tea pr diff exited with code 2/);
  assert.match(text(result), /permission denied/);
  assert.match(text(result), /requires gh-tea PR read support/);
  assert.deepEqual(failed.pi.execArgs[1], ["tea", "pr", "diff", "12"]);

  const cancelled = load({ killed: true, stderr: "terminated" });
  const aborted = await read(cancelled.tool, "teapr://12/diff");
  assert.equal(aborted.isError, true);
  assert.match(text(aborted), /gh tea pr diff was cancelled or timed out/);
  assert.match(text(aborted), /terminated/);
});
test("parses mixed quoted and unquoted Git header paths", async () => {
  const forward = String.raw`diff --git a/ascii old "b/unicode\303\251"` +
    "\nsimilarity index 100%\nrename from ascii old\n" + String.raw`rename to "unicode\303\251"` + "\n";
  const reverse = String.raw`diff --git "a/quoted\a-name" b/ascii-new` +
    "\nsimilarity index 100%\n" + String.raw`rename from "quoted\a-name"` + "\nrename to ascii-new\n";
  const result = await read(load({ stdout: `${forward}${reverse}` }).tool, "teapr://15/diff");
  assert.ok(text(result).includes("1. renamed: unicodeé (from ascii old) (+0 -0)"), text(result));
  assert.ok(text(result).includes(`2. renamed: ascii-new (from quoted${String.fromCharCode(7)}-name) (+0 -0)`));
});
test("accepts quoted file headers with Git's trailing tab and preserves unquoted paths with spaces", async () => {
  const quoted = "diff --git \"a/space é \\\"quote\\\".txt\" \"b/space é \\\"quote\\\".txt\"\n" +
    "new file mode 100644\n--- /dev/null\n+++ \"b/space é \\\"quote\\\".txt\"\t\n@@ -0,0 +1,1 @@\n+content\n";
  const metadataOnly = "diff --git a/foo b/bar b/foo b/bar\nold mode 100644\nnew mode 100755\n";
  const binary = "diff --git a/foo b/bar b/foo b/bar\nBinary files a/foo b/bar and b/foo b/bar differ\n";
  const differingPaths = "diff --git a/foo b/old b/new b/path\nBinary files a/foo b/old and b/new b/path differ\n";
  const listing = text(await read(load({ stdout: `${quoted}${metadataOnly}${binary}${differingPaths}` }).tool, "teapr://12/diff"));
  assert.match(listing, /1\. added: space é "quote"\.txt/);
  assert.match(listing, /2\. modified: foo b\/bar/);
  assert.match(listing, /3\. binary: foo b\/bar/);
  assert.match(listing, /4\. binary: new b\/path/);
});

