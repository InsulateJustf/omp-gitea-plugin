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

test("reads full issue and losslessly renders int64 identifiers", async () => {
  const { tool, pi } = load();
  const signal = new AbortController().signal;
  const result = await read(tool, "teaissue://0007", { cwd: "/work/repo" }, signal);

  assert.equal(result.isError, undefined, text(result));
  assert.match(text(result), /# 7: Issue title/);
  assert.match(text(result), /Issue body\nsecond line/);
  assert.match(text(result), /Comment body\nwith exact text/);
  assert.match(text(result), /9223372036854775806/);
  assert.deepEqual(pi.execArgs, [
    "gh",
    ["tea", "issue", "view", "7", "--json", "number,title,state,url,createdAt,updatedAt,closedAt,author.login,labels[].name,assignees[].login,milestone.title,body,isPullRequest,comments"],
    { cwd: "/work/repo", signal, timeout: 60000 },
  ]);
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

test("selects an explicit repository and instance without changing their case", async () => {
  const { tool, pi } = load();
  const result = await read(tool, "teaissue://Owner/Repo/0007?comments=1&use=Justf", {
    cwd: "/work/another-repo",
  });
  assert.equal(result.isError, undefined, text(result));
  assert.match(text(result), /# 7: Issue title/);
  assert.deepEqual(pi.execArgs, [
    "gh",
    ["tea", "issue", "view", "7", "--repo", "Owner/Repo", "--use", "Justf", "--json", "number,title,state,url,createdAt,updatedAt,closedAt,author.login,labels[].name,assignees[].login,milestone.title,body,isPullRequest,comments"],
    { cwd: "/work/another-repo", signal: pi.execArgs[2].signal, timeout: 60000 },
  ]);
});

test("renders comments as not requested when comments are disabled", async () => {
  const { tool, pi } = load();
  const result = await read(tool, "teaissue://7?comments=0");
  assert.equal(result.isError, undefined, text(result));
  assert.match(text(result), /Issue body\nsecond line/);
  assert.match(text(result), /Comments were not requested\./);
  assert.doesNotMatch(text(result), /Comment body/);
  assert.doesNotMatch(pi.execArgs[1][5], /comments/);
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
