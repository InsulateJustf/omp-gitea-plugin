import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import os from "node:os";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
const [flag, platform, ...extra] = process.argv.slice(2);
if (flag !== "--platform" || extra.length || !["macos", "windows"].includes(platform)) {
  throw new Error("Usage: pnpm build:release --platform macos|windows");
}
const expectedOs = platform === "macos" ? "darwin" : "win32";
if (process.platform !== expectedOs) {
  throw new Error(`Cannot build ${platform} release assets on ${process.platform}; run this command on ${expectedOs}.`);
}
const baseName = `omp-gitea-issue-read-${manifest.version}-${platform}`;
const archiveName = `${baseName}.${platform === "macos" ? "tar.gz" : "zip"}`;
const outputDir = join(projectRoot, "dist");
const temporary = await mkdtemp(join(os.tmpdir(), "omp-gitea-release-"));
const rootName = `omp-gitea-issue-read-${manifest.version}`;
const packageDir = join(temporary, rootName);
try {
  await mkdir(packageDir, { recursive: true });
  for (const file of ["index.js", "diff.js", "package.json", "README.md"]) {
    await cp(join(projectRoot, file), join(packageDir, file));
  }
  const dependencyDir = join(projectRoot, "node_modules", "lossless-json");
  const dependencyManifest = JSON.parse(await readFile(join(dependencyDir, "package.json"), "utf8"));
  if (dependencyManifest.version !== manifest.dependencies["lossless-json"]) {
    throw new Error(`Expected lossless-json ${manifest.dependencies["lossless-json"]}, found ${dependencyManifest.version}`);
  }
  await cp(dependencyDir, join(packageDir, "node_modules", "lossless-json"), { recursive: true, dereference: true });
  const archivePath = join(outputDir, archiveName);
  await mkdir(outputDir, { recursive: true });
  await rm(archivePath, { force: true });
  if (platform === "macos") {
    const result = spawnSync("tar", ["-czf", archivePath, "-C", temporary, rootName], { stdio: "inherit" });
    if (result.error || result.status !== 0) throw result.error ?? new Error(`tar exited with status ${result.status}`);
  } else {
    const escaped = (value) => value.replaceAll("'", "''");
    const command = `$ErrorActionPreference = 'Stop'; Compress-Archive -LiteralPath '${escaped(packageDir)}' -DestinationPath '${escaped(archivePath)}' -Force`;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { stdio: "inherit" });
    if (result.error || result.status !== 0) throw result.error ?? new Error(`Compress-Archive exited with status ${result.status}`);
  }
  const bytes = await readFile(archivePath);
  const checksum = createHash("sha256").update(bytes).digest("hex");
  await writeFile(join(outputDir, `${archiveName}.sha256`), `${checksum}  ${archiveName}\n`);
  console.log(`Created dist/${archiveName} and dist/${archiveName}.sha256`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
