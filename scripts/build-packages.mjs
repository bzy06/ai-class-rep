import { spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chmod, copyFile, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = "24.21.0";
const CACHE = path.join(ROOT, "build", "cache");
const STAGE = path.join(ROOT, "build", "stage");
const DIST = path.join(ROOT, "dist");

const NODE_FILES = {
  "darwin-arm64": {
    archive: `node-v${VERSION}-darwin-arm64.tar.gz`,
    inner: `node-v${VERSION}-darwin-arm64/bin/node`,
  },
  "darwin-x64": {
    archive: `node-v${VERSION}-darwin-x64.tar.gz`,
    inner: `node-v${VERSION}-darwin-x64/bin/node`,
  },
  "win-x64": {
    archive: `node-v${VERSION}-win-x64.zip`,
    inner: `node-v${VERSION}-win-x64/node.exe`,
  },
  "win-arm64": {
    archive: `node-v${VERSION}-win-arm64.zip`,
    inner: `node-v${VERSION}-win-arm64/node.exe`,
  },
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} 失败`);
  }
}

async function download(url, destination) {
  try {
    const existing = await readFile(destination);
    if (existing.length > 1_000_000) {
      console.log("已有缓存", path.basename(destination));
      return;
    }
  } catch {
    /* 重新下载 */
  }
  console.log("下载", url);
  const temporary = `${destination}.partial`;
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`下载失败 ${response.status} ${url}`);
  await pipeline(response.body, createWriteStream(temporary));
  await rename(temporary, destination);
  if (destination.endsWith(".zip")) run("unzip", ["-t", destination]);
  else run("gzip", ["-t", destination]);
}

async function extractNode(id, archivePath) {
  const spec = NODE_FILES[id];
  const outDir = path.join(CACHE, "node", id);
  const outFile = path.join(outDir, id.startsWith("win") ? "node.exe" : "node");
  await mkdir(outDir, { recursive: true });
  try {
    await readFile(outFile);
    return outFile;
  } catch {
    /* 继续解压 */
  }
  const temp = path.join(CACHE, "extract", id);
  await rm(temp, { recursive: true, force: true });
  await mkdir(temp, { recursive: true });
  if (archivePath.endsWith(".zip")) {
    run("unzip", ["-q", archivePath, spec.inner, "-d", temp]);
  } else {
    run("tar", ["-xzf", archivePath, "-C", temp, spec.inner]);
  }
  await copyFile(path.join(temp, spec.inner), outFile);
  if (!id.startsWith("win")) await chmod(outFile, 0o755);
  return outFile;
}

async function makeIcon() {
  const iconDir = path.join(STAGE, "icon");
  await mkdir(iconDir, { recursive: true });
  const master = path.join(iconDir, "icon-1024.png");
  run("swift", [path.join(ROOT, "scripts", "make-icon.swift"), master]);
  const iconset = path.join(iconDir, "icon.iconset");
  await mkdir(iconset, { recursive: true });
  const sizes = [16, 32, 128, 256, 512];
  for (const size of sizes) {
    run("sips", ["-z", String(size), String(size), master, "--out", path.join(iconset, `icon_${size}x${size}.png`)]);
    run("sips", ["-z", String(size * 2), String(size * 2), master, "--out", path.join(iconset, `icon_${size}x${size}@2x.png`)]);
  }
  const icns = path.join(iconDir, "icon.icns");
  run("iconutil", ["-c", "icns", iconset, "-o", icns]);
  const png256 = await readFile(path.join(iconset, "icon_256x256.png"));
  const ico = Buffer.alloc(6 + 16);
  ico.writeUInt16LE(0, 0);
  ico.writeUInt16LE(1, 2);
  ico.writeUInt16LE(1, 4);
  ico.writeUInt8(0, 6);
  ico.writeUInt8(0, 7);
  ico.writeUInt8(0, 8);
  ico.writeUInt8(0, 9);
  ico.writeUInt16LE(1, 10);
  ico.writeUInt16LE(32, 12);
  ico.writeUInt32LE(png256.length, 14);
  ico.writeUInt32LE(22, 18);
  const icoPath = path.join(iconDir, "icon.ico");
  await writeFile(icoPath, Buffer.concat([ico, png256]));
  return { icns, ico: icoPath };
}

async function copyApp(destination) {
  await mkdir(destination, { recursive: true });
  for (const file of ["server.mjs", "lib.mjs", "package.json"]) {
    await copyFile(path.join(ROOT, file), path.join(destination, file));
  }
  await cp(path.join(ROOT, "public"), path.join(destination, "public"), { recursive: true });
}

const MAC_LAUNCHER = `#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RESOURCES="$ROOT/Resources"
if [[ -x "$RESOURCES/node/darwin-arm64" && "$(/usr/sbin/sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" == "1" ]]; then
  NODE="$RESOURCES/node/darwin-arm64"
elif [[ "$(uname -m)" == "x86_64" && -x "$RESOURCES/node/darwin-x64" ]]; then
  NODE="$RESOURCES/node/darwin-x64"
elif [[ -x "$RESOURCES/node/darwin-arm64" ]]; then
  NODE="$RESOURCES/node/darwin-arm64"
else
  osascript -e 'display alert "课代表" message "这个安装包没有当前芯片的运行环境。"'
  exit 1
fi
DATA="$HOME/Library/Application Support/课代表"
mkdir -p "$DATA"
export KEDAIBIAO_DATA="$DATA"
export PORT="\${PORT:-8787}"
BASE="http://127.0.0.1:\${PORT}"

if /usr/bin/curl -sf "$BASE/api/health" >/dev/null; then
  /usr/bin/open "$BASE/"
  exit 0
fi

"$NODE" "$RESOURCES/app/server.mjs" >> "$DATA/server.log" 2>&1 &
NODE_PID=$!
trap 'kill "$NODE_PID" 2>/dev/null || true' EXIT INT TERM

for _ in $(seq 1 50); do
  if /usr/bin/curl -sf "$BASE/api/health" >/dev/null; then
    /usr/bin/open "$BASE/"
    wait "$NODE_PID"
    exit 0
  fi
  if ! kill -0 "$NODE_PID" 2>/dev/null; then
    osascript -e 'display alert "课代表没有启动" message "日志在个人资料库的 Application Support/课代表/server.log。"'
    exit 1
  fi
  sleep 0.2
done
osascript -e 'display alert "课代表启动超时" message "日志在个人资料库的 Application Support/课代表/server.log。"'
exit 1
`;

const WIN_LAUNCHER = `# 打开课代表。运行环境已放在安装目录里，不需要另外安装 Node。
$ErrorActionPreference = "Stop"
$app = Split-Path -Parent $MyInvocation.MyCommand.Path
$data = Join-Path $env:APPDATA "课代表"
New-Item -ItemType Directory -Force -Path $data | Out-Null
$env:KEDAIBIAO_DATA = $data
$env:PORT = "8787"
$arch = $env:PROCESSOR_ARCHITECTURE
$node = Join-Path $app "node\\win-x64\\node.exe"
if ($arch -eq "ARM64") {
  $arm = Join-Path $app "node\\win-arm64\\node.exe"
  if (Test-Path $arm) { $node = $arm }
}
if (-not (Test-Path $node)) {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show("没有找到随安装包附带的 Node。", "课代表")
  exit 1
}
$ready = $false
try {
  $response = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:8787/api/health" -TimeoutSec 2
  $ready = $response.StatusCode -eq 200
} catch {
  $ready = $false
}
if (-not $ready) {
  $outLog = Join-Path $data "server.log"
  $errLog = Join-Path $data "server.err.log"
  Start-Process -FilePath $node -ArgumentList @("\`"$app\\app\\server.mjs\`"") -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog
  foreach ($delay in 1..30) {
    Start-Sleep -Milliseconds 200
    try {
      $response = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:8787/api/health" -TimeoutSec 2
      if ($response.StatusCode -eq 200) { $ready = $true; break }
    } catch {}
  }
}
if (-not $ready) {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show("课代表没有启动。日志在 $data\\server.log", "课代表")
  exit 1
}
Start-Process "http://127.0.0.1:8787/"
`;

function infoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>课代表</string>
  <key>CFBundleDisplayName</key>
  <string>课代表</string>
  <key>CFBundleIdentifier</key>
  <string>xyz.kedaibiao.app</string>
  <key>CFBundleVersion</key>
  <string>1.0.0</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0.0</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleExecutable</key>
  <string>launcher</string>
  <key>CFBundleIconFile</key>
  <string>icon</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>LSApplicationCategoryType</key>
  <string>public.app-category.education</string>
</dict>
</plist>
`;
}

async function buildMac(nodes, icns) {
  const app = path.join(STAGE, "课代表.app");
  await rm(app, { recursive: true, force: true });
  const contents = path.join(app, "Contents");
  const macOS = path.join(contents, "MacOS");
  const resources = path.join(contents, "Resources");
  await mkdir(macOS, { recursive: true });
  await mkdir(path.join(resources, "node"), { recursive: true });
  await writeFile(path.join(contents, "Info.plist"), infoPlist());
  await copyFile(icns, path.join(resources, "icon.icns"));
  const launcher = path.join(macOS, "launcher");
  await writeFile(launcher, MAC_LAUNCHER);
  await chmod(launcher, 0o755);
  await copyFile(nodes["darwin-arm64"], path.join(resources, "node", "darwin-arm64"));
  await copyFile(nodes["darwin-x64"], path.join(resources, "node", "darwin-x64"));
  await chmod(path.join(resources, "node", "darwin-arm64"), 0o755);
  await chmod(path.join(resources, "node", "darwin-x64"), 0o755);
  await copyApp(path.join(resources, "app"));
  run("codesign", ["--force", "--deep", "--sign", "-", app]);

  const dmgRoot = path.join(STAGE, "dmg");
  await rm(dmgRoot, { recursive: true, force: true });
  await mkdir(dmgRoot, { recursive: true });
  await cp(app, path.join(dmgRoot, "课代表.app"), { recursive: true });
  await mkdir(path.join(dmgRoot, "Applications"), { recursive: true }).catch(() => {});
  try {
    await rm(path.join(dmgRoot, "Applications"), { recursive: true, force: true });
  } catch { /* 新建的空目录 */ }
  run("ln", ["-s", "/Applications", path.join(dmgRoot, "Applications")]);
  await mkdir(DIST, { recursive: true });
  const dmg = path.join(DIST, "课代表-mac.dmg");
  await rm(dmg, { force: true });
  run("hdiutil", ["create", "-volname", "课代表", "-srcfolder", dmgRoot, "-ov", "-format", "UDZO", dmg]);
  return dmg;
}

async function buildWindows(nodes, ico) {
  const payload = path.join(STAGE, "win");
  await rm(payload, { recursive: true, force: true });
  await mkdir(path.join(payload, "node", "win-x64"), { recursive: true });
  await mkdir(path.join(payload, "node", "win-arm64"), { recursive: true });
  await copyFile(nodes["win-x64"], path.join(payload, "node", "win-x64", "node.exe"));
  await copyFile(nodes["win-arm64"], path.join(payload, "node", "win-arm64", "node.exe"));
  await copyApp(path.join(payload, "app"));
  await writeFile(path.join(payload, "打开课代表.ps1"), WIN_LAUNCHER);
  await copyFile(ico, path.join(payload, "icon.ico"));

  const exe = path.join(DIST, "课代表-windows-setup.exe");
  await mkdir(DIST, { recursive: true });
  const nsi = path.join(STAGE, "installer.nsi");
  const payloadNsis = payload.replaceAll("\\", "/");
  const exeNsis = exe.replaceAll("\\", "/");
  const script = `
Unicode true
SetCompressor lzma
!include "MUI2.nsh"
Name "课代表"
OutFile "${exeNsis}"
InstallDir "$LOCALAPPDATA\\课代表"
RequestExecutionLevel user
!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

Section "安装"
  SetOutPath "$INSTDIR"
  File /r "${payloadNsis}/*.*"
  CreateDirectory "$SMPROGRAMS\\课代表"
  CreateShortcut "$SMPROGRAMS\\课代表\\课代表.lnk" "$WINDIR\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" "-WindowStyle Hidden -ExecutionPolicy Bypass -File $\\"$INSTDIR\\打开课代表.ps1$\\"" "$INSTDIR\\icon.ico" 0
  CreateShortcut "$DESKTOP\\课代表.lnk" "$WINDIR\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" "-WindowStyle Hidden -ExecutionPolicy Bypass -File $\\"$INSTDIR\\打开课代表.ps1$\\"" "$INSTDIR\\icon.ico" 0
  CreateShortcut "$SMPROGRAMS\\课代表\\卸载课代表.lnk" "$INSTDIR\\卸载课代表.exe"
  WriteUninstaller "$INSTDIR\\卸载课代表.exe"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\课代表" "DisplayName" "课代表"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\课代表" "UninstallString" '"$INSTDIR\\卸载课代表.exe"'
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\课代表" "DisplayIcon" "$INSTDIR\\icon.ico"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\课代表" "Publisher" "课代表"
  WriteRegDWORD HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\课代表" "NoModify" 1
  WriteRegDWORD HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\课代表" "NoRepair" 1
SectionEnd

Section "Uninstall"
  Delete "$DESKTOP\\课代表.lnk"
  Delete "$SMPROGRAMS\\课代表\\课代表.lnk"
  Delete "$SMPROGRAMS\\课代表\\卸载课代表.lnk"
  RMDir "$SMPROGRAMS\\课代表"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\课代表"
SectionEnd
`;
  await writeFile(nsi, `\uFEFF${script}`, "utf8");
  run("makensis", [nsi]);
  return exe;
}

async function main() {
  await mkdir(CACHE, { recursive: true });
  await rm(STAGE, { recursive: true, force: true });
  await mkdir(STAGE, { recursive: true });
  const nodes = {};
  for (const [id, spec] of Object.entries(NODE_FILES)) {
    const archive = path.join(CACHE, spec.archive);
    await download(`https://cdn.npmmirror.com/binaries/node/v${VERSION}/${spec.archive}`, archive);
    nodes[id] = await extractNode(id, archive);
    console.log("运行环境", id, nodes[id]);
  }
  const { icns, ico } = await makeIcon();
  const dmg = await buildMac(nodes, icns);
  const exe = await buildWindows(nodes, ico);
  console.log("Macintosh 安装包", dmg);
  console.log("Windows 安装包", exe);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
