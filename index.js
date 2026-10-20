import { isLosslessNumber, parse } from "lossless-json";
import { parseUnifiedDiff } from "./diff.js";


const MAX_INT64 = "9223372036854775807";
const ISSUE_FIELDS = "number,title,state,url,createdAt,updatedAt,closedAt,author.login,labels[].name,assignees[].login,milestone.title,body,isPullRequest";
const TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/;

function isRfc3339(value) {
  const match = TIME_RE.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, , , offsetHour, offsetMinute] = match;
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  const h = Number(hour);
  const min = Number(minute);
  const sec = Number(second);
  const oh = offsetHour === undefined ? 0 : Number(offsetHour);
  const om = offsetMinute === undefined ? 0 : Number(offsetMinute);
  const leapYear = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return m >= 1 && m <= 12 && d >= 1 && d <= monthDays[m - 1] &&
    h <= 23 && min <= 59 && sec <= 59 && oh <= 23 && om <= 59;
}

function compatibleBackendHint(message) {
  return `${message}\nThis JSON contract requires gh and gh-tea v0.6.0 or newer; install or upgrade the gh-tea extension.`;
}

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
  if (typeof value === "string" && !isRfc3339(value)) {
    throw new Error(`gh tea JSON contract error: ${label} must be RFC3339 or null`);
  }
  return value;
}

function normalizePositiveInt64(raw) {
  const canonical = raw.replace(/^0+(?=\d)/, "");
  if (canonical === "0" || canonical.length > MAX_INT64.length ||
      (canonical.length === MAX_INT64.length && canonical > MAX_INT64)) {
    return null;
  }
  return canonical;
}

function positiveInt64(value, label) {
  if (!isLosslessNumber(value)) throw new Error(`gh tea JSON contract error: ${label} must be an integer`);
  const raw = value.toString();
  if (!/^[0-9]+$/.test(raw)) throw new Error(`gh tea JSON contract error: ${label} must be a positive integer`);
  const canonical = normalizePositiveInt64(raw);
  if (canonical === null) {
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

function validateIssue(value, expectedNumber, commentsRequested) {
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

  let comments = null;
  if (commentsRequested) {
    comments = requiredArray(required(issue, "comments"), "comments").map((entry, index) => {
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
  }
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
  if (issue.comments === null) {
    lines.push("Comments were not requested.");
  } else if (issue.comments.length === 0) {
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

function decodeSegment(segment, label, scheme = "teaissue") {
  let decoded;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    throw new Error(`Invalid ${scheme} URI: malformed encoding in ${label}`);
  }
  if (!decoded || decoded === "." || decoded === ".." || /[\\/]/.test(decoded)) {
    throw new Error(`Invalid ${scheme} URI: invalid ${label}`);
  }
  return decoded;
}

function decodeQueryValue(value, label, scheme = "teaissue") {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error(`Invalid ${scheme} URI: malformed encoding in ${label}`);
  }
}

function decodeQueryKey(value, scheme = "teaissue") {
  return decodeQueryValue(value, "query parameter", scheme);
}

const PR_DETAIL_FIELDS = "number,title,state,isDraft,url,createdAt,updatedAt,closedAt,author.login,labels[].name,baseRefName,headRefName,body,merged,mergedAt,mergeable,files";
const PR_DISCUSSION_FIELDS = ",comments,reviews,reviewComments";

function parseTeaprDetailUri(path) {
  if (!/^teapr:/i.test(path)) return null;
  if (!path.startsWith("teapr://") || path.includes("#")) return null;
  const uri = path.slice("teapr://".length);
  const queryIndex = uri.indexOf("?");
  const pathPart = queryIndex === -1 ? uri : uri.slice(0, queryIndex);
  const queryPart = queryIndex === -1 ? null : uri.slice(queryIndex + 1);
  const rawSegments = pathPart.split("/");
  if (pathPart === "" || (rawSegments.length !== 1 && rawSegments.length !== 3)) return null;
  const segments = rawSegments.map((segment, index) => decodeSegment(segment, `path segment ${index + 1}`, "teapr"));
  const rawNumber = segments.at(-1);
  if (!/^[0-9]+$/.test(rawNumber)) {
    throw new Error("Invalid teapr URI: pull request number must be a decimal integer");
  }
  const number = normalizePositiveInt64(rawNumber);
  if (number === null) throw new Error(`Invalid teapr URI: pull request number must be in the range 1..${MAX_INT64}`);
  let repo;
  if (segments.length === 3) {
    const [owner, name] = segments;
    if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(name)) {
      throw new Error("Invalid teapr URI: owner and repository may contain only letters, numbers, '.', '_' and '-'");
    }
    repo = `${owner}/${name}`;
  }
  const options = { number, repo, comments: true };
  if (queryPart !== null) {
    if (!queryPart) throw new Error("Invalid teapr URI: query must not be empty");
    const seen = new Set();
    for (const pair of queryPart.split("&")) {
      const equals = pair.indexOf("=");
      if (equals <= 0) throw new Error("Invalid teapr URI: malformed query parameter");
      const key = decodeQueryKey(pair.slice(0, equals), "teapr");
      const value = decodeQueryValue(pair.slice(equals + 1), `${key} value`, "teapr");
      if (key !== "use" && key !== "comments") throw new Error(`Invalid teapr URI: unsupported ${key} parameter`);
      if (seen.has(key)) throw new Error(`Invalid teapr URI: repeated ${key} parameter`);
      seen.add(key);
      if (!value) throw new Error(`Invalid teapr URI: empty ${key} value`);
      if (key === "use") options.use = value;
      else options.comments = value !== "0" && value.toLowerCase() !== "false";
    }
  }
  return options;
}

function parseTeaprDiffUri(path) {
  if (!/^teapr:/i.test(path)) return null;
  if (!path.startsWith("teapr://") || path.includes("#")) {
    if (/\/diff(?:\/|$)/i.test(path)) throw new Error("Invalid teapr URI: malformed diff URI");
    return null;
  }
  const uri = path.slice("teapr://".length);
  const queryIndex = uri.indexOf("?");
  const pathPart = queryIndex === -1 ? uri : uri.slice(0, queryIndex);
  const queryPart = queryIndex === -1 ? null : uri.slice(queryIndex + 1);
  const route = pathPart.match(/^(.*)\/diff(?:\/(all|[0-9]+))?$/);
  if (!route) {
    if (/\/diff(?::|\/|$)/.test(pathPart)) throw new Error("Invalid teapr URI: malformed diff route");
    return null;
  }
  const detailSegments = route[1].split("/");
  const shortRoute = detailSegments.length === 1 && /^[0-9]+$/.test(detailSegments[0]);
  const explicitRoute = detailSegments.length === 3;
  if (!shortRoute && !explicitRoute) return null;
  const detail = parseTeaprDetailUri(`teapr://${route[1]}${queryPart === null ? "" : `?${queryPart}`}`);
  if (!detail) throw new Error("Invalid teapr URI: diff route requires a pull request number");
  if (queryPart !== null) {
    for (const pair of queryPart.split("&")) {
      const equals = pair.indexOf("=");
      const key = equals < 0 ? "" : decodeQueryKey(pair.slice(0, equals), "teapr");
      if (key !== "use") throw new Error(`Invalid teapr URI: unsupported ${key || "query"} parameter`);
    }
  }
  let index = null;
  if (route[2] && route[2].toLowerCase() !== "all") {
    if (BigInt(route[2]) < 1n) throw new Error("Invalid teapr URI: diff index must be a positive decimal integer");
    index = route[2];
  }
  return { ...detail, mode: route[2] == null ? "files" : route[2].toLowerCase() === "all" ? "all" : "file", index };
}

function nullableTime(value, label) {
  if (value !== null && (typeof value !== "string" || !isRfc3339(value))) {
    throw new Error(`gh tea JSON contract error: ${label} must be RFC3339 or null`);
  }
  return value;
}

function nullableStringValue(value, label) {
  if (value !== null && typeof value !== "string") {
    throw new Error(`gh tea JSON contract error: ${label} must be a string or null`);
  }
  return value;
}

function validateAuthor(value, label) {
  if (value === null) return null;
  const login = string(required(object(value, label), "login", `${label}.login`), `${label}.login`);
  return login;
}

function validatePrDetail(value, expectedNumber, commentsRequested) {
  const pr = object(value, "root");
  const number = positiveInt64(required(pr, "number"), "number");
  if (number !== expectedNumber) throw new Error("gh tea JSON contract error: returned pull request number does not match the request");
  const title = string(required(pr, "title"), "title");
  const state = string(required(pr, "state"), "state");
  if (!["open", "closed", "merged"].includes(state)) throw new Error("gh tea JSON contract error: state must be open, closed or merged");
  const draft = required(pr, "isDraft");
  if (draft !== null && typeof draft !== "boolean") throw new Error("gh tea JSON contract error: isDraft must be a boolean or null");
  const url = nullableStringValue(required(pr, "url"), "url");
  const createdAt = nullableTime(required(pr, "createdAt"), "createdAt");
  const updatedAt = nullableTime(required(pr, "updatedAt"), "updatedAt");
  const closedAt = nullableTime(required(pr, "closedAt"), "closedAt");
  const author = validateAuthor(required(pr, "author"), "author");
  const labels = requiredArray(required(pr, "labels"), "labels").map((entry, index) =>
    string(required(object(entry, `labels[${index}]`), "name", `labels[${index}].name`), `labels[${index}].name`));
  const baseRefName = nullableStringValue(required(pr, "baseRefName"), "baseRefName");
  const headRefName = nullableStringValue(required(pr, "headRefName"), "headRefName");
  const body = string(required(pr, "body"), "body");
  const merged = required(pr, "merged");
  if (typeof merged !== "boolean") throw new Error("gh tea JSON contract error: merged must be a boolean");
  const mergedAt = nullableTime(required(pr, "mergedAt"), "mergedAt");
  const mergeable = required(pr, "mergeable");
  if (mergeable !== null && typeof mergeable !== "boolean") throw new Error("gh tea JSON contract error: mergeable must be a boolean or null");
  const files = requiredArray(required(pr, "files"), "files").map((entry, index) => {
    const label = `files[${index}]`;
    const file = object(entry, label);
    return {
      path: string(required(file, "path", `${label}.path`), `${label}.path`),
      previousPath: nullableStringValue(required(file, "previousPath", `${label}.previousPath`), `${label}.previousPath`),
      status: string(required(file, "status", `${label}.status`), `${label}.status`),
      additions: nonnegativeInteger(required(file, "additions", `${label}.additions`), `${label}.additions`),
      deletions: nonnegativeInteger(required(file, "deletions", `${label}.deletions`), `${label}.deletions`),
    };
  });
  let comments = null;
  let reviews = null;
  let reviewComments = null;
  if (commentsRequested) {
    comments = requiredArray(required(pr, "comments"), "comments").map((entry, index) => {
      const label = `comments[${index}]`;
      const item = object(entry, label);
      return {
        id: positiveInt64(required(item, "id", `${label}.id`), `${label}.id`),
        author: validateAuthor(required(item, "author", `${label}.author`), `${label}.author`),
        body: string(required(item, "body", `${label}.body`), `${label}.body`),
        createdAt: nullableTime(required(item, "createdAt", `${label}.createdAt`), `${label}.createdAt`),
        updatedAt: nullableTime(required(item, "updatedAt", `${label}.updatedAt`), `${label}.updatedAt`),
        url: nullableStringValue(required(item, "url", `${label}.url`), `${label}.url`),
      };
    });
    reviews = requiredArray(required(pr, "reviews"), "reviews").map((entry, index) => {
      const label = `reviews[${index}]`;
      const item = object(entry, label);
      const flags = {};
      for (const field of ["stale", "official", "dismissed"]) {
        const flag = required(item, field, `${label}.${field}`);
        if (typeof flag !== "boolean") throw new Error(`gh tea JSON contract error: ${label}.${field} must be a boolean`);
        flags[field] = flag;
      }
      return {
        id: positiveInt64(required(item, "id", `${label}.id`), `${label}.id`),
        author: validateAuthor(required(item, "author", `${label}.author`), `${label}.author`),
        body: string(required(item, "body", `${label}.body`), `${label}.body`),
        state: string(required(item, "state", `${label}.state`), `${label}.state`),
        submittedAt: nullableTime(required(item, "submittedAt", `${label}.submittedAt`), `${label}.submittedAt`),
        commitOid: nullableStringValue(required(item, "commitOid", `${label}.commitOid`), `${label}.commitOid`),
        url: nullableStringValue(required(item, "url", `${label}.url`), `${label}.url`),
        ...flags,
      };
    });
    reviewComments = requiredArray(required(pr, "reviewComments"), "reviewComments").map((entry, index) => {
      const label = `reviewComments[${index}]`;
      const item = object(entry, label);
      return {
        id: positiveInt64(required(item, "id", `${label}.id`), `${label}.id`),
        reviewId: positiveInt64(required(item, "reviewId", `${label}.reviewId`), `${label}.reviewId`),
        author: validateAuthor(required(item, "author", `${label}.author`), `${label}.author`),
        body: string(required(item, "body", `${label}.body`), `${label}.body`),
        createdAt: nullableTime(required(item, "createdAt", `${label}.createdAt`), `${label}.createdAt`),
        updatedAt: nullableTime(required(item, "updatedAt", `${label}.updatedAt`), `${label}.updatedAt`),
        url: nullableStringValue(required(item, "url", `${label}.url`), `${label}.url`),
        path: nullableStringValue(required(item, "path", `${label}.path`), `${label}.path`),
        position: nullableNonnegativeInteger(required(item, "position", `${label}.position`), `${label}.position`),
        originalPosition: nullableNonnegativeInteger(required(item, "originalPosition", `${label}.originalPosition`), `${label}.originalPosition`),
      };
    });
  }
  return { number, title, state, draft, url, createdAt, updatedAt, closedAt, author, labels, baseRefName, headRefName, body, merged, mergedAt, mergeable, files, comments, reviews, reviewComments };
}

function nonnegativeInteger(value, label) {
  if (!isLosslessNumber(value) || !/^(0|[1-9][0-9]*)$/.test(value.toString())) {
    throw new Error(`gh tea JSON contract error: ${label} must be a non-negative integer`);
  }
  return value.toString();
}

function nullableNonnegativeInteger(value, label) {
  return value === null ? null : nonnegativeInteger(value, label);
}

function renderPrDetail(pr, options) {
  const lines = [
    `# ${pr.number}: ${pr.title}`,
    "",
    `- Number: ${pr.number}`,
    `- State: ${pr.state}`,
    `- Draft: ${pr.draft === null ? "Missing" : pr.draft}`,
    `- Author: ${displayMissing(pr.author)}`,
    `- Base: ${displayMissing(pr.baseRefName)}`,
    `- Head: ${displayMissing(pr.headRefName)}`,
    `- Created: ${displayMissing(pr.createdAt)}`,
    `- Updated: ${displayMissing(pr.updatedAt)}`,
    `- Closed: ${displayMissing(pr.closedAt)}`,
    `- Labels: ${pr.labels.length ? pr.labels.join(", ") : "none"}`,
    `- URL: ${displayMissing(pr.url)}`,
    `- Merged: ${pr.merged}`,
    `- Merged at: ${displayMissing(pr.mergedAt)}`,
    `- Mergeable: ${pr.mergeable === null ? "Missing" : pr.mergeable}`,
    "",
    "## Body", "",
    pr.body,
    "",
    "## Files", "",
  ];
  const diffLink = options.repo ? `teapr://${options.repo}/${pr.number}/diff` : `teapr://${pr.number}/diff`;
  const linkedDiff = options.use ? `${diffLink}?use=${encodeURIComponent(options.use)}` : diffLink;
  if (pr.files.length === 0) lines.push("No changed files.");
  else {
    for (const file of pr.files.slice(0, 50)) {
      lines.push(`- ${file.path}${file.previousPath === null ? "" : ` (previously ${file.previousPath})`} — ${file.status}; +${file.additions}/-${file.deletions}`);
    }
    if (pr.files.length > 50) lines.push(`- ${pr.files.length - 50} more files omitted.`);
    lines.push(`- Diff: ${linkedDiff}`);
  }
  lines.push("", "## Reviews", "");
  if (pr.reviews === null) lines.push("Reviews were not requested.");
  else if (pr.reviews.length === 0) lines.push("No reviews.");
  else for (const review of pr.reviews) {
    lines.push(`### Review ${review.id}`, `- Author: ${displayMissing(review.author)}`, `- State: ${review.state}`, `- Submitted: ${displayMissing(review.submittedAt)}`, `- Commit: ${displayMissing(review.commitOid)}`, `- URL: ${displayMissing(review.url)}`, `- Stale: ${review.stale}; Official: ${review.official}; Dismissed: ${review.dismissed}`, "", review.body, "");
  }
  lines.push("## Review Comments", "");
  if (pr.reviewComments === null) lines.push("Review comments were not requested.");
  else if (pr.reviewComments.length === 0) lines.push("No review comments.");
  else for (const comment of pr.reviewComments) {
    lines.push(`### Review comment ${comment.id}`, `- Review ID: ${comment.reviewId}`, `- Author: ${displayMissing(comment.author)}`, `- Created: ${displayMissing(comment.createdAt)}`, `- Updated: ${displayMissing(comment.updatedAt)}`, `- URL: ${displayMissing(comment.url)}`, `- Path: ${displayMissing(comment.path)}`, `- Position: ${comment.position === null ? "Missing" : comment.position}`, `- Original position: ${comment.originalPosition === null ? "Missing" : comment.originalPosition}`, "", comment.body, "");
  }
  lines.push("## Comments", "");
  if (pr.comments === null) lines.push("Comments were not requested.");
  else if (pr.comments.length === 0) lines.push("No comments.");
  else for (const comment of pr.comments) {
    lines.push(`### Comment ${comment.id}`, `- Author: ${displayMissing(comment.author)}`, `- Created: ${displayMissing(comment.createdAt)}`, `- Updated: ${displayMissing(comment.updatedAt)}`, `- URL: ${displayMissing(comment.url)}`, "", comment.body, "");
  }
  return lines.join("\n");
}
const PR_LIST_FIELDS = "number,title,state,isDraft,url,createdAt,updatedAt,author.login,labels[].name,baseRefName,headRefName";

function parseTeaprListUri(path) {
  if (!/^teapr:/i.test(path)) return null;
  const invalid = () => { throw new Error("Invalid teapr URI: expected teapr:// or teapr://<owner>/<repo> for a pull request list"); };
  if (!path.startsWith("teapr://") || path.includes("#")) invalid();
  const uri = path.slice("teapr://".length);
  const queryIndex = uri.indexOf("?");
  const pathPart = queryIndex === -1 ? uri : uri.slice(0, queryIndex);
  const queryPart = queryIndex === -1 ? null : uri.slice(queryIndex + 1);
  let repo;
  if (pathPart !== "") {
    const segments = pathPart.split("/").map((segment, index) => decodeSegment(segment, `path segment ${index + 1}`, "teapr"));
    if (segments.length !== 2) invalid();
    const [owner, name] = segments;
    if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(name)) {
      throw new Error("Invalid teapr URI: owner and repository may contain only letters, numbers, '.', '_' and '-'");
    }
    repo = `${owner}/${name}`;
  }
  const options = { repo, state: "open", limit: "30" };
  const seen = new Set();
  if (queryPart !== null) {
    if (!queryPart) invalid();
    for (const pair of queryPart.split("&")) {
      const equals = pair.indexOf("=");
      if (equals <= 0) invalid();
      const key = decodeQueryKey(pair.slice(0, equals), "teapr");
      const value = decodeQueryValue(pair.slice(equals + 1), `${key} value`, "teapr");
      if (!["use", "state", "limit", "author", "label"].includes(key)) invalid();
      if (seen.has(key)) throw new Error(`Invalid teapr URI: repeated ${key} parameter`);
      seen.add(key);
      if (!value) throw new Error(`Invalid teapr URI: empty ${key} value`);
      if (key === "state") {
        if (!["open", "closed", "merged", "all"].includes(value)) {
          throw new Error("Invalid teapr URI: state must be open, closed, merged or all");
        }
        options.state = value;
      } else if (key === "limit") {
        if (!/^[0-9]+$/.test(value) || BigInt(value) <= 0n) {
          throw new Error("Invalid teapr URI: limit must be a positive decimal integer");
        }
        options.limit = BigInt(value) > 100n ? "100" : BigInt(value).toString();
      } else {
        options[key] = value;
      }
    }
  }
  return options;
}

function validatePrList(value) {
  return requiredArray(value, "pull requests").map((entry, index) => {
    const pr = object(entry, `pull request ${index + 1}`);
    const number = positiveInt64(required(pr, "number", `pull request ${index + 1}.number`), "number");
    const title = string(required(pr, "title"), "title");
    const state = string(required(pr, "state"), "state");
    if (!["open", "closed", "merged"].includes(state)) throw new Error("gh tea JSON contract error: state must be open, closed or merged");
    const draft = required(pr, "isDraft");
    if (draft !== null && typeof draft !== "boolean") throw new Error("gh tea JSON contract error: isDraft must be a boolean or null");
    const url = required(pr, "url");
    if (url !== null && typeof url !== "string") throw new Error("gh tea JSON contract error: url must be a string or null");
    const updatedAt = required(pr, "updatedAt");
    if (updatedAt !== null && (typeof updatedAt !== "string" || !isRfc3339(updatedAt))) {
      throw new Error("gh tea JSON contract error: updatedAt must be RFC3339 or null");
    }
    const authorValue = required(pr, "author");
    const author = authorValue === null ? "Missing" : string(required(object(authorValue, "author"), "login", "author.login"), "author.login") || "Missing";
    const labels = requiredArray(required(pr, "labels"), "labels").map((label) =>
      string(required(object(label, "label"), "name", "labels[].name"), "labels[].name"));
    const createdAt = required(pr, "createdAt");
    if (createdAt !== null && (typeof createdAt !== "string" || !isRfc3339(createdAt))) {
      throw new Error("gh tea JSON contract error: createdAt must be RFC3339 or null");
    }
    for (const field of ["baseRefName", "headRefName"]) {
      const ref = required(pr, field);
      if (ref !== null && typeof ref !== "string") throw new Error(`gh tea JSON contract error: ${field} must be a string or null`);
    }
    return { number, title, state, draft, url, updatedAt, author, labels };
  });
}

function renderPrList(prs, options) {
  const filters = `Requested state: ${options.state}; limit: ${options.limit}.`;
  if (prs.length === 0) return `No pull requests match the requested filters.\n${filters}`;
  const selectedRepo = options.repo;
  return `${filters}\n\n${prs.map((pr) => {
    const link = selectedRepo ? `teapr://${selectedRepo}/${pr.number}` : `teapr://${pr.number}`;
    const url = options.use ? `${link}?use=${encodeURIComponent(options.use)}` : link;
    const labels = pr.labels.length ? pr.labels.join(", ") : "none";
    return `PR #${pr.number}: ${pr.title}\nState: ${pr.state}; draft: ${pr.draft === null ? "Missing" : pr.draft ? "yes" : "no"}; author: ${pr.author}; updated: ${displayMissing(pr.updatedAt)}; labels: ${labels}\n${url}`;
  }).join("\n\n")}`;
}

function renderPrDiff(files, options) {
  if (!files.length) return "No file changes.";
  return files.map((file, index) => {
    const link = options.repo
      ? `teapr://${options.repo}/${options.number}/diff/${index + 1}`
      : `teapr://${options.number}/diff/${index + 1}`;
    const url = options.use ? `${link}?use=${encodeURIComponent(options.use)}` : link;
    const rename = file.oldPath ? ` (from ${file.oldPath})` : "";
    return `${index + 1}. ${file.changeType}: ${file.path}${rename} (+${file.additions} -${file.deletions})\n${url}`;
  }).join("\n\n") + "\n\nIndices refer to this diff read; PR updates may reorder files. Re-read /diff before following an index.";
}

function parseIssueUri(path) {
  if (!/^teaissue:/i.test(path)) return null;
  const invalid = () => { throw new Error("Invalid teaissue URI: expected teaissue://<issue number> or teaissue://<owner>/<repo>/<issue number>"); };
  if (!path.startsWith("teaissue://") || path.includes("#")) invalid();

  const uri = path.slice("teaissue://".length);
  const queryIndex = uri.indexOf("?");
  const pathPart = queryIndex === -1 ? uri : uri.slice(0, queryIndex);
  const queryPart = queryIndex === -1 ? null : uri.slice(queryIndex + 1);
  const rawSegments = pathPart.split("/");
  if (rawSegments.length !== 1 && rawSegments.length !== 3) invalid();
  const segments = rawSegments.map((segment, index) => decodeSegment(segment, `path segment ${index + 1}`));
  const rawNumber = segments.at(-1);
  if (!/^[0-9]+$/.test(rawNumber)) invalid();
  const canonical = normalizePositiveInt64(rawNumber);
  if (canonical === null) {
    throw new Error("Invalid teaissue URI: issue number must be in the range 1..9223372036854775807");
  }

  let use;
  let comments = true;
  if (queryPart !== null) {
    if (!queryPart) invalid();
    const seen = new Set();
    for (const pair of queryPart.split("&")) {
      const equals = pair.indexOf("=");
      if (equals <= 0) invalid();
      const key = decodeQueryKey(pair.slice(0, equals));
      const value = decodeQueryValue(pair.slice(equals + 1), `${key} value`);
      if (key !== "use" && key !== "comments") invalid();
      if (seen.has(key)) throw new Error(`Invalid teaissue URI: repeated ${key} parameter`);
      seen.add(key);
      if (value === "") throw new Error(`Invalid teaissue URI: empty ${key} value`);
      if (key === "use") use = value;
      else if (value === "0") comments = false;
      else if (value !== "1") throw new Error("Invalid teaissue URI: comments must be 0 or 1");
    }
  }

  let repo;
  if (segments.length === 3) {
    const [owner, name] = segments;
    if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(name)) {
      throw new Error("Invalid teaissue URI: owner and repository may contain only letters, numbers, '.', '_' and '-'");
    }
    repo = `${owner}/${name}`;
  }
  return { number: canonical, repo, use, comments };
}

function formatExecutionError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/not found|enoent/i.test(message)) return `gh command dependency unavailable: ${message}`;
  return `Unable to execute gh tea issue view: ${message}`;
}

export default function teaissueExtension(pi) {
  pi.on("tool_result", (event) => {
    const path = event.input.path ?? "";
    if (event.toolName !== "read" || !/^(?:teaissue:|teapr:)/i.test(path) || !event.details?.meta?.truncation) {
      return;
    }
    const isPr = /^teapr:/i.test(path);
    return {
      content: [{
        type: "text",
        text: isPr
          ? "Gitea pull request result was truncated by OMP's output limit. The complete PR result is unavailable."
          : "Gitea issue result was truncated by OMP's output limit. The complete issue and comments are unavailable.",
      }],
      isError: true,
    };
  });

  pi.registerTool({
    name: "read",
    label: "Read",
    description: `Read files, URLs, and native GitHub issue:// and pr:// resources normally. This extension handles teaissue://<number> (repository from the current session working directory) or teaissue://<owner>/<repo>/<number> (explicit repository), with optional use=<alias>; comments are requested by default, and comments=0 disables them (comments=1 requests them explicitly). Gitea PR lists use teapr:// or teapr://<owner>/<repo>, with optional state=open|closed|merged|all (default open), limit=<positive decimal> (default 30, maximum 100), author, label, and use filters. Gitea PR details use teapr://<number> or teapr://<owner>/<repo>/<number>, with optional use and comments parameters; discussion is included by default and comments=0 or comments=false disables it. PR diffs use teapr://<number>/diff, /diff/all, or /diff/<positive file index>, with optional explicit owner/repo and use=<alias>; /diff lists files and per-file links, /diff/all returns the original diff, and /diff/I returns an exact file segment. File indices refer to the current diff and should be refreshed from /diff before use. Gitea URI handling is available only through read in the loaded agent session; other paths are passed unchanged to native read.`,
    parameters: pi.zod.object({ path: pi.zod.string() }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      let issue;
      let list;
      let detail;
      let diff;
      try {
        if (typeof params.path !== "string") throw new Error("read path must be a string");
        if (/^teapr:/i.test(params.path)) {
          diff = parseTeaprDiffUri(params.path);
          if (diff == null) {
            detail = parseTeaprDetailUri(params.path);
            if (detail == null) list = parseTeaprListUri(params.path);
          }
        } else issue = parseIssueUri(params.path);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
      if (issue == null && list == null && detail == null && diff == null) {
        if (typeof ctx.invokeTool !== "function") return toolError("Native read delegation is unavailable in this OMP session.");
        return ctx.invokeTool(params);
      }
      if (signal?.aborted) {
        const command = diff ? "gh tea pr diff" : detail ? "gh tea pr view" : list ? "gh tea pr list" : "gh tea issue view";
        return toolError(`${command} was cancelled before execution.`);
      }
      if (diff != null) {
        const args = ["tea", "pr", "diff", diff.number];
        if (diff.repo !== undefined) args.push("--repo", diff.repo);
        if (diff.use !== undefined) args.push("--use", diff.use);
        let result;
        try {
          result = await pi.exec("gh", args, { cwd: ctx.cwd, signal, timeout: 60000 });
        } catch (error) {
          return toolError(`Unable to execute gh tea pr diff: ${error instanceof Error ? error.message : String(error)}\nThis resource requires gh-tea PR read support (pr list, pr view JSON, and pr diff); install a compatible gh-tea build.`);
        }
        if (result.killed || signal?.aborted) {
          return toolError(`gh tea pr diff was cancelled or timed out${result.stderr ? `: ${result.stderr}` : "."}`);
        }
        if (result.code !== 0) {
          return toolError(`gh tea pr diff exited with code ${result.code}${result.stderr ? `:\n${result.stderr}` : " (no stderr)"}\nThis resource requires gh-tea PR read support (pr list, pr view JSON, and pr diff); install a compatible gh-tea build.`);
        }
        let parsed;
        try {
          parsed = parseUnifiedDiff(result.stdout);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const diagnostic = message.startsWith("gh tea pr diff") ? message : `gh tea pr diff contract error: ${message}`;
          return toolError(`${diagnostic}\nThis resource requires gh-tea PR read support (pr list, pr view JSON, and pr diff); install a compatible gh-tea build.`);
        }
        if (diff.mode === "all") return { content: [{ type: "text", text: parsed.text }] };
        if (diff.mode === "file") {
          const requested = BigInt(diff.index);
          const navigation = `teapr://${diff.repo ? `${diff.repo}/` : ""}${diff.number}/diff${diff.use ? `?use=${encodeURIComponent(diff.use)}` : ""}`;
          if (requested > BigInt(parsed.files.length)) {
            return toolError(`PR diff file index ${diff.index} is out of range; this diff has ${parsed.files.length} files. Re-read ${navigation} to navigate.`);
          }
          const file = parsed.files[Number(requested - 1n)];
          return { content: [{ type: "text", text: parsed.text.slice(file.startOffset, file.endOffset) }] };
        }
        return { content: [{ type: "text", text: renderPrDiff(parsed.files, diff) }] };
      }
      if (detail != null) {
        const args = ["tea", "pr", "view", detail.number];
        if (detail.repo !== undefined) args.push("--repo", detail.repo);
        if (detail.use !== undefined) args.push("--use", detail.use);
        args.push("--json", `${PR_DETAIL_FIELDS}${detail.comments ? PR_DISCUSSION_FIELDS : ""}`);
        let result;
        try {
          result = await pi.exec("gh", args, { cwd: ctx.cwd, signal, timeout: 60000 });
        } catch (error) {
          return toolError(`Unable to execute gh tea pr view: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (result.killed || signal?.aborted) {
          return toolError(`gh tea pr view was cancelled or timed out${result.stderr ? `: ${result.stderr}` : "."}`);
        }
        if (result.code !== 0) {
          return toolError(`gh tea pr view exited with code ${result.code}${result.stderr ? `:\n${result.stderr}` : " (no stderr)"}\nThis resource requires gh-tea PR read support (pr list, pr view JSON, and pr diff); install a compatible gh-tea build.`);
        }
        let decoded;
        try {
          decoded = parse(result.stdout);
        } catch (error) {
          return toolError(`gh tea pr view JSON contract error: invalid or incomplete JSON (${error instanceof Error ? error.message : String(error)})\nThis resource requires gh-tea PR read support (pr list, pr view JSON, and pr diff); install a compatible gh-tea build.`);
        }
        try {
          return { content: [{ type: "text", text: renderPrDetail(validatePrDetail(decoded, detail.number, detail.comments), detail) }] };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return toolError(message.includes("gh tea JSON contract error")
            ? `gh tea pr view JSON contract error: ${message.replace(/^gh tea JSON contract error:\s*/, "")}\nThis resource requires gh-tea PR read support (pr list, pr view JSON, and pr diff); install a compatible gh-tea build.`
            : message);
        }
      }
      if (list != null) {
        const args = ["tea", "pr", "list"];
        if (list.repo !== undefined) args.push("--repo", list.repo);
        if (list.use !== undefined) args.push("--use", list.use);
        args.push("--state", list.state, "--limit", list.limit);
        if (list.author !== undefined) args.push("--author", list.author);
        if (list.label !== undefined) args.push("--label", list.label);
        args.push("--json", PR_LIST_FIELDS);
        let result;
        try {
          result = await pi.exec("gh", args, { cwd: ctx.cwd, signal, timeout: 60000 });
        } catch (error) {
          return toolError(`Unable to execute gh tea pr list: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (result.killed || signal?.aborted) {
          return toolError(`gh tea pr list was cancelled or timed out${result.stderr ? `: ${result.stderr}` : "."}`);
        }
        if (result.code !== 0) {
          return toolError(`gh tea pr list exited with code ${result.code}${result.stderr ? `:\n${result.stderr}` : " (no stderr)"}\nThis resource requires gh-tea PR read support (pr list, pr view JSON, and pr diff); install a compatible gh-tea build.`);
        }
        let decoded;
        try {
          decoded = parse(result.stdout);
        } catch (error) {
          return toolError(`gh tea pr list JSON contract error: invalid or incomplete JSON (${error instanceof Error ? error.message : String(error)})\nThis resource requires gh-tea PR read support (pr list, pr view JSON, and pr diff); install a compatible gh-tea build.`);
        }
        try {
          return { content: [{ type: "text", text: renderPrList(validatePrList(decoded), list) }] };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return toolError(message.includes("gh tea JSON contract error")
            ? `gh tea pr list JSON contract error: ${message.replace(/^gh tea JSON contract error:\s*/, "")}\nThis resource requires gh-tea PR read support (pr list, pr view JSON, and pr diff); install a compatible gh-tea build.`
            : message);
        }
      }

      const args = ["tea", "issue", "view", issue.number];
      if (issue.repo !== undefined) args.push("--repo", issue.repo);
      if (issue.use !== undefined) args.push("--use", issue.use);
      const fields = issue.comments ? `${ISSUE_FIELDS},comments` : ISSUE_FIELDS;
      args.push("--json", fields);
      let result;
      try {
        result = await pi.exec("gh", args, {
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
        return toolError(compatibleBackendHint(
          `gh tea issue view exited with code ${result.code}${result.stderr ? `:\n${result.stderr}` : " (no stderr)"}`,
        ));
      }
      let decoded;
      try {
        decoded = parse(result.stdout);
      } catch (error) {
        return toolError(compatibleBackendHint(
          `gh tea JSON contract error: invalid or incomplete JSON (${error instanceof Error ? error.message : String(error)})`,
        ));
      }
      try {
        return { content: [{ type: "text", text: renderIssue(validateIssue(decoded, issue.number, issue.comments)) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(message.includes("gh tea JSON contract error") ? compatibleBackendHint(message) : message);
      }
    },
  });
}
