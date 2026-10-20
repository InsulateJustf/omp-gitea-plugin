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
    "teapr://Owner/Repo/12",
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


