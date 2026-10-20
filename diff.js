const DIFF_HEADER = /^diff --git (.+)$/;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/;

function decodeQuoted(value) {
  if (!value.startsWith('"')) return value;
  if (!value.endsWith('"')) throw new Error("unterminated quoted Git path");
  const bytes = [];
  for (let i = 1; i < value.length - 1; i += 1) {
    if (value.charCodeAt(i) !== 92) {
      const point = value.codePointAt(i);
      bytes.push(...Buffer.from(String.fromCodePoint(point), "utf8"));
      if (point > 0xffff) i += 1;
      continue;
    }
    i += 1;
    if (i >= value.length - 1) throw new Error("invalid quoted Git path escape");
    const escaped = value[i];
    const simple = { '"': 34, "\\": 92, t: 9, n: 10, r: 13, b: 8, f: 12, v: 11 };
    if (Object.hasOwn(simple, escaped)) { bytes.push(simple[escaped]); continue; }
    if (/[0-7]/.test(escaped)) {
      let octal = escaped;
      while (octal.length < 3 && i + 1 < value.length - 1 && /[0-7]/.test(value[i + 1])) octal += value[++i];
      const byte = Number.parseInt(octal, 8);
      if (byte > 0xff) throw new Error("invalid octal byte in quoted Git path");
      bytes.push(byte);
      continue;
    }
    throw new Error("invalid quoted Git path escape");
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
}

function gitHeaderPaths(line) {
  const header = line.match(DIFF_HEADER);
  if (!header) throw new Error("missing Git diff header");
  const value = header[1];
  if (value.startsWith('"')) {
    const tokens = [];
    let index = 0;
    while (index < value.length) {
      while (value[index] === " ") index += 1;
      if (index >= value.length) break;
      const start = index;
      if (value[index] === '"') {
        index += 1;
        let escaped = false;
        while (index < value.length) {
          if (!escaped && value[index] === '"') { index += 1; break; }
          if (!escaped && value[index] === "\\") escaped = true;
          else escaped = false;
          index += 1;
        }
        if (value[index - 1] !== '"') throw new Error("unterminated quoted Git path");
      } else while (index < value.length && value[index] !== " ") index += 1;
      tokens.push(decodeQuoted(value.slice(start, index)));
    }
    if (tokens.length !== 2 || !tokens[0].startsWith("a/") || !tokens[1].startsWith("b/")) throw new Error("invalid Git diff paths");
    return [tokens[0].slice(2), tokens[1].slice(2)];
  }
  const match = value.match(/^a\/(.*) b\/(.*)$/);
  if (!match) throw new Error("invalid Git diff paths");
  return [match[1], match[2]];
}

function pathHeader(line, prefix) {
  if (!line.startsWith(prefix)) throw new Error("invalid file path header");
  let value = line.slice(prefix.length);
  if (value.startsWith('"')) value = decodeQuoted(value);
  else value = value.split("\t", 1)[0];
  if ((prefix === "--- " && value.startsWith("a/")) || (prefix === "+++ " && value.startsWith("b/"))) value = value.slice(2);
  return value;
}

function parseFile(raw, startOffset, endOffset) {
  const clean = raw.split(/(?<=\n)/).map((line) => line.replace(/\r?\n$/, "").replace(/\r$/, ""));
  if (!clean.length || !DIFF_HEADER.test(clean[0])) throw new Error("invalid Git diff segment");
  const [headerOld, headerNew] = gitHeaderPaths(clean[0]);
  let oldPath = headerOld;
  let path = headerNew;
  let hasOldHeader = false;
  let hasNewHeader = false;
  let added = false;
  let deleted = false;
  let renamed = false;
  let binary = false;
  let modeChanged = false;
  let inBinaryPatch = false;
  let inHunk = false;
  let oldRemaining = 0;
  let newRemaining = 0;
  let additions = 0;
  let deletions = 0;
  for (let index = 1; index < clean.length; index += 1) {
    const line = clean[index];
    if (inBinaryPatch) continue;
    if (inHunk && oldRemaining === 0 && newRemaining === 0) inHunk = false;
    if (inHunk) {
      if (line.startsWith("\\ ")) continue;
      if (line.startsWith("+")) { additions += 1; newRemaining -= 1; }
      else if (line.startsWith("-")) { deletions += 1; oldRemaining -= 1; }
      else if (line.startsWith(" ")) { oldRemaining -= 1; newRemaining -= 1; }
      else throw new Error("malformed unified diff hunk");
      if (oldRemaining < 0 || newRemaining < 0) throw new Error("unified diff hunk exceeds declared line counts");
      continue;
    }
    if (line.startsWith("@@")) {
      const hunk = line.match(HUNK_HEADER);
      if (!hunk) throw new Error("invalid unified diff hunk header");
      oldRemaining = Number(hunk[2] ?? "1");
      newRemaining = Number(hunk[4] ?? "1");
      inHunk = oldRemaining !== 0 || newRemaining !== 0;
      continue;
    }
    if (/^(?:old mode|new mode) /.test(line)) { modeChanged = true; continue; }
    if (/^(?:new file mode|deleted file mode) /.test(line)) {
      if (line.startsWith("new file mode ")) added = true;
      else deleted = true;
      modeChanged = true;
      continue;
    }
    if (line.startsWith("--- ")) { oldPath = pathHeader(line, "--- "); hasOldHeader = true; continue; }
    if (line.startsWith("+++ ")) { path = pathHeader(line, "+++ "); hasNewHeader = true; continue; }
    if (line.startsWith("rename from ")) { oldPath = pathHeader(line, "rename from "); renamed = true; continue; }
    if (line.startsWith("rename to ")) { path = pathHeader(line, "rename to "); renamed = true; continue; }
    if (line === "GIT binary patch") { binary = true; inBinaryPatch = true; continue; }
    if (line.startsWith("Binary files ") && line.endsWith(" differ")) { binary = true; continue; }
    if (/^(?:index |similarity index |dissimilarity index )/.test(line) || line === "\\ No newline at end of file") continue;
    if (line === "") continue;
    throw new Error("unrecognized unified diff metadata");
  }
  if (inHunk && (oldRemaining !== 0 || newRemaining !== 0)) throw new Error("truncated unified diff hunk");
  if (hasOldHeader !== hasNewHeader || (!hasOldHeader && !renamed && !added && !deleted && !binary && !modeChanged)) throw new Error("diff segment has no usable file headers");
  if (oldPath === "/dev/null") { oldPath = null; added = true; }
  if (path === "/dev/null") { path = oldPath; deleted = true; }
  if (!path || path === "/dev/null") throw new Error("diff segment has no usable file path");
  const changeType = binary ? "binary" : added ? "added" : deleted ? "deleted" : renamed ? "renamed" : "modified";
  return { path, ...(renamed && oldPath !== path ? { oldPath } : {}), additions, deletions, changeType, startOffset, endOffset };
}

export function parseUnifiedDiff(text) {
  if (typeof text !== "string") throw new Error("gh tea pr diff contract error: expected raw text");
  if (text === "") return { text, files: [] };
  const starts = [];
  const pattern = /^diff --git .*$/gm;
  for (const match of text.matchAll(pattern)) starts.push(match.index);
  if (!starts.length || starts[0] !== 0) throw new Error("gh tea pr diff contract error: malformed unified diff");
  const files = starts.map((start, index) => {
    const end = starts[index + 1] ?? text.length;
    return parseFile(text.slice(start, end), start, end);
  });
  return { text, files };
}
