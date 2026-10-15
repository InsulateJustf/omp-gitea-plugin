import { isLosslessNumber, parse } from "lossless-json";

const MAX_INT64 = "9223372036854775807";
const ISSUE_FIELDS = "number,title,state,url,createdAt,updatedAt,closedAt,author.login,labels[].name,assignees[].login,milestone.title,body,isPullRequest,comments";
const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function toolError(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

function required(object, key, label = key) {
  if (!Object.hasOwn(object, key)) throw new Error(`gh tea JSON contract error: missing ${label}`);
  return object[key];
}

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`gh tea JSON contract error: ${label} must be an object`);
  }
  return value;
}

function string(value, label) {
  if (typeof value !== "string") throw new Error(`gh tea JSON contract error: ${label} must be a string`);
  return value;
}

function nullableString(value, label) {
  if (value !== null && typeof value !== "string") {
    throw new Error(`gh tea JSON contract error: ${label} must be a string or null`);
  }
  if (typeof value === "string" && !TIME_RE.test(value)) {
    throw new Error(`gh tea JSON contract error: ${label} must be RFC3339 or null`);
  }
  return value;
}

function positiveInt64(value, label) {
  if (!isLosslessNumber(value)) throw new Error(`gh tea JSON contract error: ${label} must be an integer`);
  const raw = value.toString();
  if (!/^[0-9]+$/.test(raw)) throw new Error(`gh tea JSON contract error: ${label} must be a positive integer`);
  const canonical = raw.replace(/^0+(?=\d)/, "");
  if (canonical === "0" || canonical.length > MAX_INT64.length ||
      (canonical.length === MAX_INT64.length && canonical > MAX_INT64)) {
    throw new Error(`gh tea JSON contract error: ${label} is outside the positive int64 range`);
  }
  return canonical;
}

function optionalLogin(value, label) {
  if (value === null) return "Missing";
  const loginValue = required(object(value, label), "login", `${label}.login`);
  if (loginValue === null) return "Missing";
  const login = string(loginValue, `${label}.login`);
  return login || "Missing";
}

function requiredArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`gh tea JSON contract error: ${label} must be an array`);
  return value;
}

function validateIssue(value, expectedNumber) {
  const issue = object(value, "root");
  const number = positiveInt64(required(issue, "number"), "number");
  if (number !== expectedNumber) throw new Error("gh tea JSON contract error: returned issue number does not match the request");
  const title = string(required(issue, "title"), "title");
  const state = string(required(issue, "state"), "state");
  const url = required(issue, "url");
  if (url !== null && typeof url !== "string") throw new Error("gh tea JSON contract error: url must be a string or null");
  const createdAt = nullableString(required(issue, "createdAt"), "createdAt");
  const updatedAt = nullableString(required(issue, "updatedAt"), "updatedAt");
  const closedAt = nullableString(required(issue, "closedAt"), "closedAt");
  const author = optionalLogin(required(issue, "author"), "author");
  const labels = requiredArray(required(issue, "labels"), "labels").map((entry, index) =>
    string(required(object(entry, `labels[${index}]`), "name", `labels[${index}].name`), `labels[${index}].name`),
  );
  const assignees = requiredArray(required(issue, "assignees"), "assignees").map((entry, index) =>
    string(required(object(entry, `assignees[${index}]`), "login", `assignees[${index}].login`), `assignees[${index}].login`),
  );
  const milestoneValue = required(issue, "milestone");
  const milestone = milestoneValue === null
    ? "Missing"
    : string(required(object(milestoneValue, "milestone"), "title", "milestone.title"), "milestone.title");
  const body = string(required(issue, "body"), "body");
  const isPullRequest = required(issue, "isPullRequest");
  if (typeof isPullRequest !== "boolean") throw new Error("gh tea JSON contract error: isPullRequest must be a boolean");
  if (isPullRequest) throw new Error("This teaissue URI refers to a pull request; only issues are supported.");

  const comments = requiredArray(required(issue, "comments"), "comments").map((entry, index) => {
    const label = `comments[${index}]`;
    const comment = object(entry, label);
    const id = positiveInt64(required(comment, "id", `${label}.id`), `${label}.id`);
    const commentAuthor = optionalLogin(required(comment, "author", `${label}.author`), `${label}.author`);
    const commentBody = string(required(comment, "body", `${label}.body`), `${label}.body`);
    const commentCreatedAt = nullableString(required(comment, "createdAt", `${label}.createdAt`), `${label}.createdAt`);
    const commentUpdatedAt = nullableString(required(comment, "updatedAt", `${label}.updatedAt`), `${label}.updatedAt`);
    const commentUrl = required(comment, "url", `${label}.url`);
    if (commentUrl !== null && typeof commentUrl !== "string") {
      throw new Error(`gh tea JSON contract error: ${label}.url must be a string or null`);
    }
    return { id, author: commentAuthor, body: commentBody, createdAt: commentCreatedAt, updatedAt: commentUpdatedAt, url: commentUrl };
  });
  return { number, title, state, url, createdAt, updatedAt, closedAt, author, labels, assignees, milestone, body, comments };
}

function displayMissing(value) {
  return value === null || value === "" ? "Missing" : value;
}

function renderIssue(issue) {
  const lines = [
    `# ${issue.number}: ${issue.title}`,
    "",
    `- Number: ${issue.number}`,
    `- State: ${displayMissing(issue.state)}`,
    `- URL: ${displayMissing(issue.url)}`,
    `- Author: ${displayMissing(issue.author)}`,
    `- Created: ${displayMissing(issue.createdAt)}`,
    `- Updated: ${displayMissing(issue.updatedAt)}`,
    `- Closed: ${displayMissing(issue.closedAt)}`,
    `- Labels: ${issue.labels.length ? issue.labels.join(", ") : "Missing"}`,
    `- Assignees: ${issue.assignees.length ? issue.assignees.join(", ") : "Missing"}`,
    `- Milestone: ${displayMissing(issue.milestone)}`,
    "",
    "## Body",
    "",
    issue.body,
    "",
    "## Comments",
    "",
  ];
  if (issue.comments.length === 0) {
    lines.push("No comments.");
  } else {
    for (let index = 0; index < issue.comments.length; index++) {
      const comment = issue.comments[index];
      if (index > 0) lines.push("", "---", "");
      lines.push(
        `### Comment ${comment.id}`,
        `- Author: ${displayMissing(comment.author)}`,
        `- Created: ${displayMissing(comment.createdAt)}`,
        `- Updated: ${displayMissing(comment.updatedAt)}`,
        `- URL: ${displayMissing(comment.url)}`,
        "",
        comment.body,
      );
    }
  }
  return lines.join("\n");
}

function parseIssueUri(path) {
  if (!path.startsWith("teaissue:")) return null;
  const match = /^teaissue:\/\/([0-9]+)$/.exec(path);
  if (!match) throw new Error("Invalid teaissue URI: expected teaissue://<positive issue number>");
  const canonical = match[1].replace(/^0+(?=\d)/, "");
  if (canonical === "0" || canonical.length > MAX_INT64.length ||
      (canonical.length === MAX_INT64.length && canonical > MAX_INT64)) {
    throw new Error("Invalid teaissue URI: issue number must be in the range 1..9223372036854775807");
  }
  return canonical;
}

function formatExecutionError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/not found|enoent/i.test(message)) return `gh command dependency unavailable: ${message}`;
  return `Unable to execute gh tea issue view: ${message}`;
}

export default function teaissueExtension(pi) {
  pi.on("tool_result", (event) => {
    if (event.toolName !== "read" || !event.input.path?.startsWith("teaissue:") || !event.details?.meta?.truncation) {
      return;
    }
    return {
      content: [{
        type: "text",
        text: "Gitea issue result was truncated by OMP's output limit. The complete issue and comments are unavailable.",
      }],
      isError: true,
    };
  });

  pi.registerTool({
    name: "read",
    label: "Read",
    description: "Read files, URLs, and GitHub issue:// URIs normally. For a Gitea issue, call read directly with path teaissue://<issue-number> in this agent session; the issue number is read from the current repository. This wrapper does not add support to the standalone omp read command. Other paths are passed to the native read tool.",
    parameters: pi.zod.object({ path: pi.zod.string() }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      let number;
      try {
        if (typeof params.path !== "string") throw new Error("read path must be a string");
        number = parseIssueUri(params.path);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
      if (number === null) {
        if (typeof ctx.invokeTool !== "function") return toolError("Native read delegation is unavailable in this OMP session.");
        return ctx.invokeTool(params);
      }
      if (signal?.aborted) return toolError("gh tea issue view was cancelled before execution.");

      let result;
      try {
        result = await pi.exec("gh", ["tea", "issue", "view", number, "--json", ISSUE_FIELDS], {
          cwd: ctx.cwd,
          signal,
          timeout: 60000,
        });
      } catch (error) {
        return toolError(formatExecutionError(error));
      }
      if (result.killed || signal?.aborted) {
        return toolError(`gh tea issue view was cancelled or timed out${result.stderr ? `: ${result.stderr}` : "."}`);
      }
      if (result.code !== 0) {
        return toolError(`gh tea issue view exited with code ${result.code}${result.stderr ? `:\n${result.stderr}` : " (no stderr)"}`);
      }
      let decoded;
      try {
        decoded = parse(result.stdout);
      } catch (error) {
        return toolError(`gh tea JSON contract error: invalid or incomplete JSON (${error instanceof Error ? error.message : String(error)})`);
      }
      try {
        return { content: [{ type: "text", text: renderIssue(validateIssue(decoded, number)) }] };
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    },
  });
}
