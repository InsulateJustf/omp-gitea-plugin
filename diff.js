import { inflateSync } from "node:zlib";

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
    const simple = { '"': 34, "\\": 92, a: 7, t: 9, n: 10, r: 13, b: 8, f: 12, v: 11 };
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

function quotedPathEnd(value, start) {
  let index = start + 1;
  let escaped = false;
  while (index < value.length) {
    if (!escaped && value[index] === '"') return index + 1;
    if (!escaped && value[index] === "\\") escaped = true;
    else escaped = false;
    index += 1;
  }
  throw new Error("unterminated quoted Git path");
}

function gitHeaderPaths(line, oldHint, newHint) {
  const header = line.match(DIFF_HEADER);
  if (!header) throw new Error("missing Git diff header");
  const value = header[1];
  let oldToken;
  let newToken;
  if (value.startsWith('"')) {
    const end = quotedPathEnd(value, 0);
    if (value[end] !== " ") throw new Error("invalid Git diff paths");
    oldToken = value.slice(0, end);
    newToken = value.slice(end + 1);
  } else {
    const quotedNew = value.lastIndexOf(' "b/');
    if (quotedNew !== -1) {
      oldToken = value.slice(0, quotedNew);
      newToken = value.slice(quotedNew + 1);
    } else {
      const candidates = [];
      for (let split = value.indexOf(" b/"); split !== -1; split = value.indexOf(" b/", split + 1)) {
        const candidateOld = value.slice(0, split);
        const candidateNew = value.slice(split + 1);
        if (candidateOld.startsWith("a/") && candidateNew.startsWith("b/")) {
          candidates.push([candidateOld, candidateNew]);
        }
      }
      const metadataMatch = oldHint != null || newHint != null
        ? candidates.find(([candidateOld, candidateNew]) =>
          (oldHint == null || candidateOld.slice(2) === oldHint) &&
          (newHint == null || candidateNew.slice(2) === newHint))
        : undefined;
      const matching = metadataMatch ?? candidates.find(([candidateOld, candidateNew]) => candidateOld.slice(2) === candidateNew.slice(2));
      [oldToken, newToken] = matching ?? candidates.at(-1) ?? [];
    }
  }
  const oldPath = oldToken?.startsWith('"') ? decodeQuoted(oldToken) : oldToken;
  const newPath = newToken?.startsWith('"') ? decodeQuoted(newToken) : newToken;
  if (!oldPath?.startsWith("a/") || !newPath?.startsWith("b/")) throw new Error("invalid Git diff paths");
  return [oldPath.slice(2), newPath.slice(2)];
}

function pathHeader(line, prefix) {
  if (!line.startsWith(prefix)) throw new Error("invalid file path header");
  let value = line.slice(prefix.length);
  if (value.startsWith('"')) {
    const end = quotedPathEnd(value, 0);
    if (value.slice(end) && !value.slice(end).startsWith("\t")) throw new Error("invalid Git file path header suffix");
    value = decodeQuoted(value.slice(0, end));
  } else value = value.split("\t", 1)[0];
  if ((prefix === "--- " && value.startsWith("a/")) || (prefix === "+++ " && value.startsWith("b/"))) value = value.slice(2);
  return value;
}

function isBinaryPatchLine(line) {
  if (!line) return false;
  const code = line.charCodeAt(0);
  const byteCount = code >= 65 && code <= 90 ? code - 64 : code >= 97 && code <= 122 ? code - 70 : 0;
  return byteCount > 0 && line.length === 1 + Math.ceil(byteCount / 4) * 5 &&
    /^[0-9A-Za-z!#$%&()*+\-;<=>?@^_`{|}~]+$/.test(line.slice(1));
}
const BASE85 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~";

function decodeBinaryBlock(size, kind, lines) {
  const chunks = [];
  let length = 0;
  for (const line of lines) {
    if (!isBinaryPatchLine(line)) throw new Error("invalid Git binary patch payload");
    const byteCount = line.charCodeAt(0) >= 97 ? line.charCodeAt(0) - 70 : line.charCodeAt(0) - 64;
    const encoded = line.slice(1);
    const decoded = Buffer.alloc(Math.ceil(byteCount / 4) * 4);
    for (let offset = 0; offset < encoded.length; offset += 5) {
      let word = 0;
      for (let index = 0; index < 5; index += 1) {
        const digit = BASE85.indexOf(encoded[offset + index]);
        if (digit < 0) throw new Error("invalid Git binary patch payload");
        word = word * 85 + digit;
      }
      if (word > 0xffffffff) throw new Error("invalid Git binary patch payload");
      decoded.writeUInt32BE(word, Math.floor(offset / 5) * 4);
    }
    const bytes = decoded.subarray(0, byteCount);
    chunks.push(bytes);
    length += byteCount;
  }
  if (length === 0) throw new Error("truncated Git binary patch");
  const compressed = Buffer.concat(chunks);
  let inflated;
  try {
    const decoded = inflateSync(compressed, { info: true });
    if (decoded.engine.bytesWritten !== compressed.length) throw new Error("trailing data after Git binary patch zlib stream");
    inflated = decoded.buffer;
  } catch {
    throw new Error("invalid or truncated Git binary patch zlib stream");
  }
  if (BigInt(inflated.length) !== size) throw new Error("Git binary patch inflated size does not match its header");
  if (kind === "delta") validateDeltaInstructions(inflated);
}

function readDeltaVarint(bytes, state) {
  let value = 0n;
  let shift = 0n;
  while (state.offset < bytes.length) {
    const byte = BigInt(bytes[state.offset++]);
    value |= (byte & 0x7fn) << shift;
    if ((byte & 0x80n) === 0n) return value;
    shift += 7n;
  }
  throw new Error("truncated Git binary delta");
}

function validateDeltaInstructions(bytes) {
  const state = { offset: 0 };
  const sourceSize = readDeltaVarint(bytes, state);
  const targetSize = readDeltaVarint(bytes, state);
  let produced = 0n;
  while (state.offset < bytes.length) {
    const command = bytes[state.offset++];
    if (command === 0) throw new Error("invalid Git binary delta opcode");
    if (command & 0x80) {
      let sourceOffset = 0n;
      let copySize = 0n;
      for (let bit = 0; bit < 4; bit += 1) {
        if (command & (1 << bit)) {
          if (state.offset >= bytes.length) throw new Error("truncated Git binary delta copy");
          sourceOffset |= BigInt(bytes[state.offset++]) << BigInt(bit * 8);
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (command & (1 << (bit + 4))) {
          if (state.offset >= bytes.length) throw new Error("truncated Git binary delta copy");
          copySize |= BigInt(bytes[state.offset++]) << BigInt(bit * 8);
        }
      }
      if (copySize === 0n) copySize = 0x10000n;
      if (sourceOffset + copySize > sourceSize) throw new Error("Git binary delta copy exceeds its source");
      produced += copySize;
    } else {
      const literalSize = BigInt(command);
      if (state.offset + Number(literalSize) > bytes.length) throw new Error("truncated Git binary delta literal");
      state.offset += Number(literalSize);
      produced += literalSize;
    }
    if (produced > targetSize) throw new Error("Git binary delta exceeds its target size");
  }
  if (produced !== targetSize) throw new Error("Git binary delta target size is incomplete");
}


function parseFile(raw, startOffset, endOffset) {
  const clean = raw.split(/(?<=\n)/).map((line) => line.replace(/\r?\n$/, "").replace(/\r$/, ""));
  if (!clean.length || !DIFF_HEADER.test(clean[0])) throw new Error("invalid Git diff segment");
  const oldMetadata = clean.slice(1).find((line) => line.startsWith("--- ") || line.startsWith("rename from "));
  const newMetadata = clean.slice(1).find((line) => line.startsWith("+++ ") || line.startsWith("rename to "));
  const oldPrefix = oldMetadata?.startsWith("--- ") ? "--- " : "rename from ";
  const newPrefix = newMetadata?.startsWith("+++ ") ? "+++ " : "rename to ";
  let oldHint = oldMetadata ? pathHeader(oldMetadata, oldPrefix) : null;
  let newHint = newMetadata ? pathHeader(newMetadata, newPrefix) : null;
  if (oldHint === "/dev/null") oldHint = null;
  if (newHint === "/dev/null") newHint = null;
  const binaryMetadata = clean.find((line) => line.startsWith("Binary files ") && line.endsWith(" differ"));
  const binaryPaths = binaryMetadata?.match(/^Binary files (.+) and (.+) differ$/);
  if (binaryPaths) {
    oldHint ??= pathHeader(`--- ${binaryPaths[1]}`, "--- ");
    newHint ??= pathHeader(`+++ ${binaryPaths[2]}`, "+++ ");
  }
  const [headerOld, headerNew] = gitHeaderPaths(clean[0], oldHint, newHint);
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
  let binaryBlockCount = 0;
  let binaryBlockSize = null;
  let binaryBlockKind = null;
  let binaryBlockPayload = [];
  let inHunk = false;
  let hasHunk = false;
  let oldRemaining = 0;
  let newRemaining = 0;
  let additions = 0;
  let deletions = 0;
  for (let index = 1; index < clean.length; index += 1) {
    const line = clean[index];
    if (inBinaryPatch) {
      if (line === "") {
        if (binaryBlockSize !== null) {
          decodeBinaryBlock(binaryBlockSize, binaryBlockKind, binaryBlockPayload);
          binaryBlockSize = null;
          binaryBlockKind = null;
          binaryBlockPayload = [];
        }
        continue;
      }
      if (binaryBlockSize === null) {
        if (binaryBlockCount === 2) throw new Error("unexpected data after Git binary patch blocks");
        const patchHeader = line.match(/^(literal|delta) ([0-9]+)$/);
        if (!patchHeader) throw new Error("invalid Git binary patch header");
        binaryBlockCount += 1;
        binaryBlockKind = patchHeader[1];
        binaryBlockSize = BigInt(patchHeader[2]);
      } else binaryBlockPayload.push(line);
      continue;
    }
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
      if (!hasOldHeader || !hasNewHeader) throw new Error("unified diff hunk is missing file headers");
      const hunk = line.match(HUNK_HEADER);
      if (!hunk) throw new Error("invalid unified diff hunk header");
      hasHunk = true;
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
    if (line.startsWith("--- ")) {
      oldPath = pathHeader(line, "--- ");
      if (oldPath !== "/dev/null" && oldPath !== headerOld) throw new Error("old file header path conflicts with Git diff header");
      hasOldHeader = true;
      continue;
    }
    if (line.startsWith("+++ ")) {
      path = pathHeader(line, "+++ ");
      if (path !== "/dev/null" && path !== headerNew) throw new Error("new file header path conflicts with Git diff header");
      hasNewHeader = true;
      continue;
    }
    if (line.startsWith("rename from ")) { oldPath = pathHeader(line, "rename from "); renamed = true; continue; }
    if (line.startsWith("rename to ")) { path = pathHeader(line, "rename to "); renamed = true; continue; }
    if (line === "GIT binary patch") { binary = true; inBinaryPatch = true; continue; }
    if (line.startsWith("Binary files ") && line.endsWith(" differ")) { binary = true; continue; }
    if (/^(?:index |similarity index |dissimilarity index )/.test(line) || line === "\\ No newline at end of file") continue;
    if (line === "") continue;
    throw new Error("unrecognized unified diff metadata");

  }
  if (inBinaryPatch) {
    if (binaryBlockSize !== null) decodeBinaryBlock(binaryBlockSize, binaryBlockKind, binaryBlockPayload);
    if (binaryBlockCount !== 2) throw new Error("truncated Git binary patch");
  }
  if (inHunk && (oldRemaining !== 0 || newRemaining !== 0)) throw new Error("truncated unified diff hunk");
  if (hasOldHeader !== hasNewHeader || (hasOldHeader && !hasHunk) || (hasHunk && (!hasOldHeader || !hasNewHeader)) ||
    (!hasOldHeader && !renamed && !added && !deleted && !binary && !modeChanged)) {
    throw new Error("diff segment has no usable file headers or complete text hunks");
  }
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
