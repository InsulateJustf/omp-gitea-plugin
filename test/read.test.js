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


