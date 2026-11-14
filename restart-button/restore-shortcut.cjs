#!/usr/bin/env node
"use strict";
// Restore the DeepSeek Harness desktop shortcut to the target recorded before the
// guarded launcher was installed.
//
// Kept as a Node script rather than PowerShell on purpose: the shortcut path
// contains Chinese characters and `powershell -File` decodes a BOM-less UTF-8
// script as the system ANSI codepage, which silently corrupts those literals. The
// path is never spelled out here — it is read back from the record file.

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const TOOL_DIR = __dirname;
const RECORD = path.join(TOOL_DIR, "shortcut-original.json");

if (!fs.existsSync(RECORD)) {
  console.error(`没有找到 ${RECORD}：说明从未改写过快捷方式，无需还原。`);
  process.exit(1);
}

// PowerShell 5.1 writes `-Encoding utf8` with a BOM, so the first character
// would break JSON.parse.
const original = JSON.parse(fs.readFileSync(RECORD, "utf8").replace(/^\uFEFF/u, ""));
if (typeof original.target !== "string" || original.target === "") {
  console.error(`${RECORD} 里没有记录原始目标，无法还原。`);
  process.exit(1);
}

// WScript.Shell is driven through PowerShell with every path passed as an
// environment variable, so nothing that needs correct Unicode survives a script
// file decode: the bytes travel through the environment instead.
const script = [
  "$ErrorActionPreference = 'Stop'",
  "$shell = New-Object -ComObject WScript.Shell",
  "$lnk = $shell.CreateShortcut($env:DSH_LNK)",
  "$lnk.TargetPath = $env:DSH_TARGET",
  "$lnk.Arguments = $env:DSH_ARGS",
  "$lnk.WorkingDirectory = $env:DSH_DIR",
  "$lnk.IconLocation = $env:DSH_ICON",
  "$lnk.Save()",
  "$check = ($shell.CreateShortcut($env:DSH_LNK)).TargetPath",
  "if ($check -ne $env:DSH_TARGET) { Write-Error \"还原失败：$check\" }",
].join("\n");

try {
  execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    stdio: "inherit",
    env: {
      ...process.env,
      DSH_LNK: original.shortcut,
      DSH_TARGET: original.target,
      DSH_ARGS: original.arguments ?? "",
      DSH_DIR: original.workingDir ?? "",
      DSH_ICON: original.iconLocation ?? "",
    },
  });
  console.log(`已还原快捷方式：${original.shortcut} → ${original.target}`);
} catch (error) {
  console.error(`还原失败：${error.message}`);
  process.exit(1);
}
