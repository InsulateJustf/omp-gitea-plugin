import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import os from "node:os";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
const [flag, platform, ...extra] = process.argv.slice(2);
if (flag !== "--platform" || extra.length || !["macos", "windows"].includes(platform)) {
  throw new Error("Usage: pnpm verify:release --platform macos|windows");
}
const expectedOs = platform === "macos" ? "darwin" : "win32";
if (process.platform !== expectedOs) {
  throw new Error(`Cannot verify ${platform} release assets on ${process.platform}; run this command on ${expectedOs}.`);
}
const archiveName = `omp-gitea-issue-read-${manifest.version}-${platform}.${platform === "macos" ? "tar.gz" : "zip"}`;
const archivePath = join(projectRoot, "dist", archiveName);
const checksumPath = `${archivePath}.sha256`;
const archiveBytes = await readFile(archivePath);
const expectedHash = createHash("sha256").update(archiveBytes).digest("hex");
const checksum = (await readFile(checksumPath, "utf8")).trim();
if (checksum !== `${expectedHash}  ${archiveName}`) throw new Error("Release archive SHA256 file is missing, malformed, or does not match the archive.");
const rootName = `omp-gitea-issue-read-${manifest.version}`;
const temporary = await mkdtemp(join(os.tmpdir(), "omp-gitea-verify-"));
const extractedRoot = join(temporary, rootName);
const run = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8", cwd: temporary });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`${command} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
};
try {
  if (platform === "macos") {
    const entries = run("tar", ["-tzf", archivePath]).split(/\r?\n/).filter(Boolean);
    if (!entries.length || entries.some((entry) => entry.startsWith("/") || entry.split("/").includes("..") || !(entry === rootName || entry.startsWith(`${rootName}/`)))) {
      throw new Error("Archive contains paths outside its required root directory.");
    }
    run("tar", ["-xzf", archivePath, "-C", temporary]);
  } else {
    const escaped = (value) => value.replaceAll("'", "''");
    run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath '${escaped(archivePath)}' -DestinationPath '${escaped(temporary)}' -Force`]);
  }
  for (const file of ["index.js", "diff.js", "package.json", "README.md", "node_modules/lossless-json/package.json"]) {
    const fullPath = join(extractedRoot, file);
    if (!(await stat(fullPath)).isFile()) throw new Error(`Archive payload is missing ${file}`);
  }
  const extractedManifest = JSON.parse(await readFile(join(extractedRoot, "package.json"), "utf8"));
  const dependencyManifest = JSON.parse(await readFile(join(extractedRoot, "node_modules/lossless-json/package.json"), "utf8"));
  if (extractedManifest.name !== manifest.name || extractedManifest.version !== manifest.version) throw new Error("Extracted package identity/version does not match the selected package.");
  if (dependencyManifest.version !== manifest.dependencies["lossless-json"]) throw new Error("Extracted lossless-json version does not match the selected dependency.");
  if (dependencyManifest.license === undefined) throw new Error("Extracted lossless-json package has no license metadata.");
  const runtimeEntry = join(extractedRoot, "index.js");
  const resolvedRoot = await realpath(extractedRoot);
  const resolvedDependency = await realpath(join(extractedRoot, "node_modules", "lossless-json"));
  const resolvedWithinArchive = relative(resolvedRoot, resolvedDependency);
  if (resolvedWithinArchive.startsWith(`..${sep}`) || resolvedWithinArchive === ".." || resolve(resolvedRoot, resolvedWithinArchive) !== resolvedDependency) {
    throw new Error("Extracted lossless-json dependency resolves outside the archive payload.");
  }
  const imported = await import(pathToFileURL(runtimeEntry).href);
  if (typeof imported.default !== "function") throw new Error("Extracted extension entry does not export its extension registration function.");

  const licensePath = join(extractedRoot, "node_modules", "lossless-json", "LICENSE.md");
  if (!(await stat(licensePath)).isFile()) throw new Error("Extracted lossless-json license file is missing.");
  const diffText = [
    "diff --git a/one.txt b/one.txt",
    "index 1111111..2222222 100644",
    "--- a/one.txt",
    "+++ b/one.txt",
    "@@ -1 +1 @@",
    "-before",
    "+after",
    "diff --git a/two.txt b/two.txt",
    "index 3333333..4444444 100644",
    "--- a/two.txt",
    "+++ b/two.txt",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "",
  ].join("\n");
  let registered;
  imported.default({
    on() {},
    zod: { object: (shape) => shape, string: () => ({}) },
    registerTool(tool) { registered = tool; },
    async exec(_binary, args) {
      if (args[0] !== "tea" || args[1] !== "pr" || args[2] !== "diff" || args[3] !== "1") throw new Error(`Unexpected native command arguments: ${args.join(" ")}`);
      return { code: 0, stdout: diffText, stderr: "" };
    },
  });
  if (registered?.name !== "read" || typeof registered.execute !== "function") throw new Error("Extension did not register its read tool.");
  const all = await registered.execute("smoke", { path: "teapr://Owner/Repo/%31/diff/all" }, undefined, undefined, { cwd: temporary });
  if (all.isError || all.content?.[0]?.text !== diffText) throw new Error("Explicit encoded PR route did not preserve the exact raw diff output.");
  const navigation = await registered.execute("smoke", { path: "teapr://Owner/Repo/%31/diff" }, undefined, undefined, { cwd: temporary });
  const navigationText = navigation.content?.[0]?.text ?? "";
  if (navigation.isError || !navigationText.includes("one.txt") || !navigationText.includes("two.txt") || !navigationText.includes("teapr://Owner/Repo/1/diff/1")) {
    throw new Error("Diff navigation did not return its selected file entries and navigable link.");
  }
  const selected = await registered.execute("smoke", { path: "teapr://Owner/Repo/%31/diff/2" }, undefined, undefined, { cwd: temporary });
  if (selected.isError || selected.content?.[0]?.text !== "diff --git a/two.txt b/two.txt\nindex 3333333..4444444 100644\n--- a/two.txt\n+++ b/two.txt\n@@ -1 +1 @@\n-old\n+new\n") {
    throw new Error("Selected diff navigation did not return the exact raw file segment.");
  }
  const nativeResult = { content: [{ type: "text", text: "native result" }], details: { marker: "native identity" } };
  const delegated = await registered.execute("smoke", { path: "file:///outside-checkout" }, undefined, undefined, {
    invokeTool: async (params) => { if (params.path !== "file:///outside-checkout") throw new Error("Native read received changed arguments."); return nativeResult; },
  });
  if (delegated !== nativeResult || delegated.content[0].text !== "native result") throw new Error("Native read delegation did not preserve the observed result identity and content.");
  console.log(`Verified extracted ${extractedManifest.name}@${extractedManifest.version} with lossless-json@${dependencyManifest.version}: raw encoded diff, file navigation/selection, and native read delegation.`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
