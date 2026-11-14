"use strict";
// dsh-recovery / restart-button : in-place, length-preserving asar patcher.
//
// Library behind both the command line (lib/apply.cjs) and the recovery
// console tab (app/backend/restart-button.js). Only lib/main.js and
// lib/preload-app.cjs are replaced, and only by byte sequences exactly as long
// as the header's `size`. Entry offsets therefore stay valid for the header the
// running application already holds, so a patch may be applied while DeepSeek
// Harness is open; the new menu shows up after the next restart.
//
//   status  read only : current vs payload vs backup, header integrity state
//   verify  read only : header integrity + syntax of the installed bytes
//   apply   write     : back both entries up, then replace them in place
//   revert  write     : put the backed up bytes back
//
// Every function takes an optional `log(line)` sink and returns structured data
// instead of printing, so nothing here writes to stdout on its own.

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const asar = require("./asar.cjs");

const ROOT = path.resolve(__dirname, "..");
const PAYLOAD_DIR = path.join(ROOT, "payload", "lib");
const DEFAULT_BACKUP_DIR = path.join(ROOT, "backup");
const DEFAULT_STATE_FILE = path.join(ROOT, "state.json");
const ENTRIES = ["lib/main.js", "lib/preload-app.cjs"];
const DEFAULT_ARCHIVE = "D:\\Dev Tools\\DeepSeek Harness\\resources\\app.asar";
const TOOL_VERSION = "1.10.4";

const none = () => {};
const short = (hash) => (hash ? `${hash.slice(0, 16)}…` : "(无)");
const backupName = (entryPath) => `${entryPath.replace(/\//g, "__")}.orig`;
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/**
 * Why one backup file must never be reused across an application update.
 *
 * A DeepSeek Harness update replaces `app.asar` wholesale, so the bytes an older
 * tool version saved belong to the *previous* build. Keeping them silently would
 * make `status` claim 「有原始备份」 (the file exists) while `revert` restores the
 * wrong build — the user believes a rollback is available right up until the
 * moment they need it.
 *
 * **Length is not enough.** 0.2.2-rc.2 → rc.3 changed a single version string
 * inside `lib/main.js`, so both builds' entries are exactly 848505 bytes. A
 * length-only test considered the rc.2 backup valid and a revert would have
 * written rc.2's content back into an rc.3 archive. The archive's own
 * `dshBuildCommit` is what actually identifies a build, so that is recorded with
 * the backup and compared first; bytes are compared as well, which catches a
 * same-build archive that was merely replaced.
 */
const backupFits = (backup, expected) => {
  if (backup === null) return false;
  if (backup.buf.length !== expected.size) return false;
  // A backup written before `buildId` was recorded has to be identified from its
  // own bytes. Skip the test when either side is unknown rather than guess.
  if (backup.buildId !== undefined && expected.buildId !== undefined) return backup.buildId === expected.buildId;
  if (backup.versionHint !== undefined && expected.version !== undefined) return backup.versionHint === expected.version;
  return true;
};

/**
 * Identifies the application build an archive belongs to.
 *
 * `dshBuildCommit` is written by upstream into the archive's root `package.json`
 * and changes on every release, including releases that touch nothing this patch
 * cares about. Version alone is too coarse (prerelease rebuilds share it) and
 * file sizes are demonstrably not unique.
 */
function archiveBuildId(fd, header) {
  const manifest = readRootManifest(fd, header);
  if (manifest === undefined) return undefined;
  const commit = typeof manifest.dshBuildCommit === "string" ? manifest.dshBuildCommit : "";
  const version = typeof manifest.version === "string" ? manifest.version : "";
  if (commit === "" && version === "") return undefined;
  return `${version}+${commit.slice(0, 12)}`;
}

/** The archive's root `package.json`, or undefined when it cannot be read. */
function readRootManifest(fd, header) {
  try {
    const entry = asar.entryAt(header.json, "package.json");
    const start = header.dataOffset + Number(entry.offset);
    const buf = Buffer.alloc(entry.size);
    fs.readSync(fd, buf, 0, entry.size, start);
    return JSON.parse(buf.toString("utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Version string of a *backup file*'s build, read out of the single line that
 * differs between releases when nothing else did (`return "0.2.2-rc.3";`).
 *
 * Backups written by an earlier tool version carry no build id, and 0.2.2-rc.2 →
 * rc.3 changed nothing but that string, so length alone cannot tell them apart.
 * Scanning for the literal is cheap and, unlike a guessed default, it refuses to
 * call an old backup current.
 */
function backupVersionHint(buf) {
  const head = buf.toString("utf8", 0, Math.min(buf.length, 4 * 1024 * 1024));
  const match = /return "(\d+\.\d+\.\d+(?:-[\w.]+)?)";/u.exec(head);
  return match === null ? undefined : match[1];
}

/**
 * Moves a backup from a previous build out of the way.
 *
 * The bytes are kept, never deleted: they are the only copy of that build's
 * original entry, and a user may still be running that build on another machine.
 * The directory name carries the old build so a human can tell them apart.
 */
function archiveStaleBackup(backupDir, entryPath, backupBuf, reason, log, buildId) {
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const cleaned = typeof buildId === "string" ? buildId.replace(/[^0-9A-Za-z.]+/gu, "-").replace(/^-+|-+$/gu, "") : "";
  const label = cleaned === "" ? `${backupBuf.length}B` : cleaned;
  const dir = path.join(backupDir, `stale-${label}-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, backupName(entryPath));
  fs.writeFileSync(target, backupBuf);
  log(`归档      旧备份 ${path.relative(ROOT, target)}（${backupBuf.length} 字节，${reason}）`);
  return target;
}

/**
 * Run synchronous filesystem work with Electron's asar support disabled.
 *
 * Inside Electron (the recovery console) the patched `fs` treats any path
 * containing `.asar` as a virtual directory: `fs.openSync(".../app.asar", "r+")`
 * fails with ENOENT and reads return archive members instead of the raw pickle.
 * Every archive access below therefore runs with `process.noAsar` set, which is
 * safe because all of it is synchronous.
 */
function withoutAsar(fn) {
  const previous = process.noAsar;
  process.noAsar = true;
  try {
    return fn();
  } finally {
    process.noAsar = previous;
  }
}

/**
 * Backup directory and state file to use for one archive.
 *
 * The tool root keeps the historical single-install layout, so an install made
 * by an earlier version of this tool stays recognised. Any other archive gets
 * its own scoped directory: two installs must never share one backup, or a
 * revert would restore the wrong bytes.
 */
function pathsFor(archive, options = {}) {
  const resolved = path.resolve(archive);
  if (options.backupDir && options.stateFile) {
    return { archive: resolved, backupDir: path.resolve(options.backupDir), stateFile: path.resolve(options.stateFile), layout: "explicit" };
  }
  const rootState = readState(DEFAULT_STATE_FILE);
  const rootOwns = rootState?.archive ? samePath(rootState.archive, resolved) : samePath(resolved, DEFAULT_ARCHIVE);
  if (rootOwns) {
    return { archive: resolved, backupDir: DEFAULT_BACKUP_DIR, stateFile: DEFAULT_STATE_FILE, layout: "root" };
  }
  const slug = crypto.createHash("sha256").update(resolved.toLowerCase()).digest("hex").slice(0, 12);
  return {
    archive: resolved,
    backupDir: path.join(ROOT, "backup", slug),
    stateFile: path.join(ROOT, `state-${slug}.json`),
    layout: "scoped"
  };
}

/**
 * Payload bytes for one entry, or a message telling the user to build them.
 *
 * `dir` is only passed by the self test, which builds a synthetic archive too
 * small to patch the real 208 MB one. Every caller in the console passes
 * nothing and therefore reads the payload this repository ships.
 */
function payloadFor(entryPath, dir = PAYLOAD_DIR) {
  const file = path.join(dir, path.basename(entryPath));
  if (!fs.existsSync(file)) {
    throw new Error(`缺少载荷 ${file}；请先运行：node lib\\build-payload.cjs --write`);
  }
  return fs.readFileSync(file);
}

/** Payload hashes for every patched entry, for display. */
function payloadHashes(dir = PAYLOAD_DIR) {
  return ENTRIES.map((entryPath) => {
    const file = path.join(dir, path.basename(entryPath));
    const exists = fs.existsSync(file);
    const buf = exists ? fs.readFileSync(file) : null;
    return { entryPath, file, exists, size: buf === null ? null : buf.length, hash: buf === null ? null : asar.sha256(buf) };
  });
}

function openArchive(archivePath, flags) {
  try {
    return fs.openSync(archivePath, flags);
  } catch (error) {
    const hint = error.code === "ENOENT" ? "路径不存在" : error.code === "EBUSY" || error.code === "EPERM" ? "文件被占用，请先退出 DeepSeek Harness 再试" : error.message;
    throw new Error(`无法以 ${flags} 打开 ${archivePath}：${hint}`);
  }
}

function readState(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Reads one entry from a fresh header; the caller owns the descriptor. */
function snapshot(fd, entryPath) {
  const header = asar.readHeader(fd);
  const { entry, start, buf } = asar.readEntry(fd, header, entryPath);
  const integrity = entry.integrity ?? null;
  return {
    entryPath,
    size: entry.size,
    start,
    buf,
    hash: asar.sha256(buf),
    headerHash: integrity?.hash ?? null,
    blocks: integrity?.blocks ?? null
  };
}

function integrityOk(snap) {
  if (snap.headerHash === null) return { ok: true, detail: "头部无 integrity 元数据" };
  const blocks = Array.isArray(snap.blocks) && snap.blocks.length > 0 ? snap.blocks : [snap.headerHash];
  const bad = blocks.filter((hash) => hash !== snap.hash);
  if (bad.length > 0) return { ok: false, detail: `头部 integrity 与内容不一致（${bad.length}/${blocks.length} 块）` };
  return { ok: true, detail: `头部 integrity 与内容一致（${blocks.length} 块）` };
}

/**
 * `node --check` on a buffer, written to a throwaway file.
 *
 * Inside Electron process.execPath is the app binary, not node, so the child
 * gets ELECTRON_RUN_AS_NODE=1 to make it behave as the bundled node.
 */
function syntaxCheck(buffer, label) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dsh-restart-")), label);
  try {
    fs.writeFileSync(file, buffer);
    const env = { ...process.env };
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = "1";
    execFileSync(process.execPath, ["--check", file], { stdio: ["ignore", "pipe", "pipe"], env, timeout: 20000 });
    return { ok: true, detail: "node --check 通过" };
  } catch (error) {
    const tail = String(error.stderr ?? error.message).trim().split("\n").slice(-3).join(" / ");
    return { ok: false, detail: `node --check 失败：${tail}` };
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
}

/** Which kind of content an entry currently holds. */
function verdictFor(snap, payload, backupBuf) {
  if (payload !== null && asar.sha256(payload) === snap.hash) return "installed";
  if (backupBuf !== null && asar.sha256(backupBuf) === snap.hash) return "original";
  return "unknown";
}

/**
 * `unknown` reads as "something damaged these bytes", but after an application
 * update the entries hold the *official* new content — the patch is simply gone
 * and reinstalling is the whole fix. A backup left over from the previous build
 * is the evidence for that story, so it gets its own verdict and its own wording.
 */
const verdictWithBackupAge = (snap, payload, backupBuf, staleBackup) =>
  staleBackup && verdictFor(snap, payload, null) === "unknown" ? "stale" : verdictFor(snap, payload, backupBuf);

const VERDICT_TEXT = {
  installed: "已安装（= 载荷）",
  original: "未安装（= 备份的原始内容）",
  stale: "未安装（应用更新过，备份属于更新前的版本）",
  unknown: "未知内容",
};

function status(options = {}) {
  return withoutAsar(() => statusRaw(options));
}

function statusRaw({ archive = DEFAULT_ARCHIVE, backupDir, stateFile, payloadDir = PAYLOAD_DIR, log = none } = {}) {
  const paths = pathsFor(archive, { backupDir, stateFile });
  const manifestFile = path.join(paths.backupDir, "manifest.json");
  const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, "utf8")) : { entries: {} };
  const fd = openArchive(paths.archive, "r");
  try {
    const state = readState(paths.stateFile);
    const header = asar.readHeader(fd);
    const buildId = archiveBuildId(fd, header);
    const currentVersion = readRootManifest(fd, header)?.version;
    const entries = [];
    log(`asar      ${paths.archive}`);
    if (buildId !== undefined) log(`应用构建  ${buildId}`);
    log(`载荷目录  ${payloadDir}`);
    log(`状态文件  ${paths.stateFile}${state ? "" : "（不存在，可能尚未安装）"}`);
    if (state?.installedAt) log(`安装时间  ${state.installedAt}`);
    log("");
    for (const entryPath of ENTRIES) {
      const snap = snapshot(fd, entryPath);
      const payloadFile = path.join(payloadDir, path.basename(entryPath));
      const payload = fs.existsSync(payloadFile) ? payloadFor(entryPath, payloadDir) : null;
      const backupFile = path.join(paths.backupDir, backupName(entryPath));
      const backupBuf = fs.existsSync(backupFile) ? fs.readFileSync(backupFile) : null;
      // The manifest records which build each backup came from; a backup saved
      // before that field existed has `buildId === undefined` and falls back to
      // the length test alone, which is what the old tool did.
      const backupBuildId = manifest?.entries?.[entryPath]?.buildId;
      const backup = backupBuf === null
        ? null
        : { buf: backupBuf, buildId: backupBuildId, versionHint: backupBuildId === undefined ? backupVersionHint(backupBuf) : undefined };
      const fits = backupFits(backup, { size: snap.size, buildId, version: currentVersion });
      const verdict = verdictWithBackupAge(snap, payload, fits ? backupBuf : null, backupBuf !== null && !fits);
      const integrity = integrityOk(snap);
      entries.push({
        entryPath,
        size: snap.size,
        hash: snap.hash,
        headerHash: snap.headerHash,
        payloadSize: payload === null ? null : payload.length,
        lengthMismatch: payload !== null && payload.length !== snap.size,
        hasBackup: fits,
        hasStaleBackup: backupBuf !== null && !fits,
        backupSize: backupBuf === null ? null : backupBuf.length,
        backupBuildId,
        verdict,
        integrity
      });
      log(`${entryPath}`);
      log(`  大小      ${snap.size} 字节${payload !== null && payload.length !== snap.size ? `  ← 载荷 ${payload.length} 字节，长度不符！` : ""}`);
      log(`  内容 sha256  ${snap.hash}`);
      log(`  判定      ${VERDICT_TEXT[verdict]}`);
      log(`  头部      ${short(snap.headerHash)}  ${integrity.ok ? "OK" : "不一致"}  ${integrity.detail}`);
      if (backupBuf !== null && !fits) {
        const from = backup?.versionHint ?? backupBuildId ?? "未知构建";
        const why = backupBuf.length !== snap.size
          ? `长度 ${backupBuf.length} 字节，与本条目 ${snap.size} 字节不符`
          : `长度相同但属于另一个构建（备份来自 ${from}，当前是 ${currentVersion ?? buildId ?? "未知构建"}）`;
        log(`  备份      ${why}：这是更新前那个版本的备份，不能用于还原；下次 apply 时会归档并重新备份。`);
      }
      log("");
    }
    const installed = entries.filter((entry) => entry.verdict === "installed").length;
    const conclusion = installed === ENTRIES.length ? "installed" : installed === 0 ? "absent" : "partial";
    log(conclusion === "installed" ? "结论：重启按钮补丁已安装（重启 DeepSeek Harness 后生效）。" : conclusion === "absent" ? "结论：未安装补丁。" : "结论：只有部分条目是载荷内容，请运行 apply 修复。");
    return { archive: paths.archive, backupDir: paths.backupDir, stateFile: paths.stateFile, layout: paths.layout, installedAt: state?.installedAt ?? null, entries, installed, conclusion };
  } finally {
    fs.closeSync(fd);
  }
}

function verify(options = {}) {
  return withoutAsar(() => verifyRaw(options));
}

function verifyRaw({ archive = DEFAULT_ARCHIVE, backupDir, stateFile, payloadDir = PAYLOAD_DIR, log = none } = {}) {
  const paths = pathsFor(archive, { backupDir, stateFile });
  const fd = openArchive(paths.archive, "r");
  const entries = [];
  let failures = 0;
  try {
    log(`asar      ${paths.archive}`);
    log("");
    for (const entryPath of ENTRIES) {
      const snap = snapshot(fd, entryPath);
      const integrity = integrityOk(snap);
      const syntax = syntaxCheck(snap.buf, path.basename(entryPath));
      const payloadFile = path.join(payloadDir, path.basename(entryPath));
      const isPayload = fs.existsSync(payloadFile) && asar.sha256(payloadFor(entryPath, payloadDir)) === snap.hash;
      const ok = integrity.ok && syntax.ok && isPayload;
      if (!ok) failures += 1;
      entries.push({ entryPath, size: snap.size, hash: snap.hash, integrity, syntax, isPayload, ok });
      log(`${ok ? "[OK]  " : "[FAIL]"} ${entryPath}  ${snap.size} 字节  ${snap.hash.slice(0, 16)}…`);
      log(`       ${integrity.detail}；${syntax.detail}；${isPayload ? "内容等于载荷" : "内容不等于载荷（可能未安装或已被其他工具修改）"}`);
    }
    log("");
    log(failures === 0 ? "verify: 两个条目均为载荷内容，头部 integrity 与语法均通过。" : `verify: ${failures} 个条目未通过。`);
    return { archive: paths.archive, entries, failures, ok: failures === 0 };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Keeps the on-disk backup an accurate copy of this build's **original** entry.
 *
 * Two rules, both learned from getting them wrong:
 *
 * 1. The backup must never be filled with the payload. `snap` is whatever the
 *    archive currently holds; when the entry is already patched, copying it into
 *    the backup "succeeds" and leaves a revert that rewrites the payload over
 *    itself — the menu never comes back, yet status says it was restored.
 * 2. The backup must describe the build installed now. A leftover from the
 *    previous release looks fine (a file exists) and only fails when the user
 *    needs it, so it is replaced at the first opportunity instead of only when
 *    the entry is being written.
 *
 * `canCapture` is false when the entry already holds the payload: the original
 * bytes are gone from the archive at that point, so a stale backup is only
 * reported, never overwritten with something worse.
 */
function reconcileBackup(entryPath, { snap, payloadHash, buildId, currentVersion, backupDir, manifest, manifestFile, log }) {
  const backupFile = path.join(backupDir, backupName(entryPath));
  const existing = fs.existsSync(backupFile) ? fs.readFileSync(backupFile) : null;
  const existingBuildId = manifest.entries?.[entryPath]?.buildId;
  const existingVersionHint = existing === null || existingBuildId !== undefined ? undefined : backupVersionHint(existing);
  const canCapture = snap.hash !== payloadHash;
  const fits = backupFits(
    existing === null ? null : { buf: existing, buildId: existingBuildId, versionHint: existingVersionHint },
    { size: snap.size, buildId, version: currentVersion },
  );
  if (fits) {
    // "fits" means it describes the installed build, not that it equals `snap`:
    // the backup is the original and `snap` may already be the payload.
    log(`备份      已存在，保留现有备份 ${path.relative(ROOT, backupFile)}（${snap.size} 字节，属于当前构建）`);
    return "kept";
  }

  if (!canCapture) {
    // Patched, and no usable backup: the original bytes are not in the archive
    // any more, so there is nothing honest to save. Say so instead of pretending.
    log(`备份      缺失或来自旧构建，但这一个条目已打补丁，归档里没有原始内容可备份；`);
    log(`          还原前需要先用官方安装包修复，或先 revert 另一个尚未打补丁的条目。`);
    return "unavailable";
  }

  // Move a previous build's backup aside rather than deleting it: it is the only
  // copy of that build's original entry.
  if (existing !== null) {
    const from = existingVersionHint ?? existingBuildId ?? "未知构建";
    const why = existing.length !== snap.size
      ? `长度 ${existing.length} 字节，与当前 ${snap.size} 字节不符`
      : `长度相同但属于另一个构建（备份来自 ${from}，当前是 ${currentVersion ?? buildId ?? "未知构建"}）`;
    archiveStaleBackup(backupDir, entryPath, existing, why, log, from);
  }
  fs.writeFileSync(backupFile, snap.buf);
  manifest.entries[entryPath] = {
    backupFile: path.relative(ROOT, backupFile),
    size: snap.size,
    sha256: snap.hash,
    headerHash: snap.headerHash,
    buildId,
    version: currentVersion,
    backedUpAt: new Date().toISOString(),
  };
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  log(`备份      ${entryPath} → ${path.relative(ROOT, backupFile)}（${snap.size} 字节，${short(snap.hash)}${currentVersion === undefined ? "" : `，${currentVersion}`}）`);
  return "rebuilt";
}

function apply(options = {}) {
  return withoutAsar(() => applyRaw(options));
}

function applyRaw({ archive = DEFAULT_ARCHIVE, backupDir, stateFile, payloadDir = PAYLOAD_DIR, log = none } = {}) {
  const paths = pathsFor(archive, { backupDir, stateFile });
  const payloads = new Map(ENTRIES.map((entryPath) => [entryPath, payloadFor(entryPath, payloadDir)]));
  fs.mkdirSync(paths.backupDir, { recursive: true });
  const manifestFile = path.join(paths.backupDir, "manifest.json");
  const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, "utf8")) : { entries: {} };
  manifest.entries ??= {};

  const fd = openArchive(paths.archive, "r+");
  const report = [];
  let changed = 0;
  try {
    const header = asar.readHeader(fd);
    const buildId = archiveBuildId(fd, header);
    const currentVersion = readRootManifest(fd, header)?.version;
    if (buildId !== undefined) log(`应用构建  ${buildId}`);
    for (const entryPath of ENTRIES) {
      const snap = snapshot(fd, entryPath);
      const payload = payloads.get(entryPath);
      const wanted = asar.sha256(payload);

      // The backup is repaired before the entry is considered, and repaired even
      // when the entry already holds the payload. Otherwise `apply` on an
      // already-patched archive reports success while leaving a backup from the
      // previous build behind, which is exactly the state `revert` has to refuse.
      const backup = reconcileBackup(entryPath, { snap, payloadHash: wanted, buildId, currentVersion, backupDir: paths.backupDir, manifest, manifestFile, log });

      if (snap.hash === wanted) {
        report.push({ entryPath, action: "skip", hash: snap.hash, size: snap.size, note: "已经是载荷内容", backup });
        log(`跳过      ${entryPath} 已经是载荷内容`);
        continue;
      }
      if (snap.size !== payload.length) {
        throw new Error(`${entryPath} 现有 ${snap.size} 字节，载荷 ${payload.length} 字节；长度不同会平移后续偏移，已中止（未写入任何字节）`);
      }
      const written = asar.writeEntry(fd, asar.readHeader(fd), entryPath, payload);
      fs.fsyncSync(fd);
      changed += 1;
      report.push({ entryPath, action: "write", hash: wanted, previousHash: written.previousHash, hashHits: written.hashHits, size: payload.length });
      log(`写入      ${entryPath}  ${short(written.previousHash)} → ${short(wanted)}（头部哈希串更新 ${written.hashHits} 处）`);
    }
  } finally {
    fs.closeSync(fd);
  }

  const readback = verify({ archive: paths.archive, backupDir: paths.backupDir, stateFile: paths.stateFile, payloadDir, log: (line) => log(line === "" ? "" : `回读 ${line.trim()}`) });
  if (readback.failures > 0) {
    return { archive: paths.archive, backupDir: paths.backupDir, stateFile: paths.stateFile, ok: false, changed, entries: report, readback, error: `回读校验失败 ${readback.failures} 项，可执行 revert 恢复备份` };
  }

  const state = {
    toolVersion: TOOL_VERSION,
    installedAt: new Date().toISOString(),
    archive: paths.archive,
    entries: report,
    backupDir: paths.backupDir,
    layout: paths.layout
  };
  fs.mkdirSync(path.dirname(paths.stateFile), { recursive: true });
  fs.writeFileSync(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`);
  log("");
  log(`apply: 完成。状态写入 ${paths.stateFile}`);
  log("重启 DeepSeek Harness 后，「应用」「编辑」右侧会出现「重启」菜单。");
  return { archive: paths.archive, backupDir: paths.backupDir, stateFile: paths.stateFile, ok: true, changed, entries: report, readback, state };
}

function revert(options = {}) {
  return withoutAsar(() => revertRaw(options));
}

function revertRaw({ archive = DEFAULT_ARCHIVE, backupDir, stateFile, payloadDir = PAYLOAD_DIR, log = none } = {}) {
  const paths = pathsFor(archive, { backupDir, stateFile });
  const payloads = new Map(ENTRIES.map((entryPath) => [entryPath, payloadFor(entryPath, payloadDir)]));
  const manifestFile = path.join(paths.backupDir, "manifest.json");
  const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, "utf8")) : { entries: {} };
  const fd = openArchive(paths.archive, "r+");
  const buildId = archiveBuildId(fd, asar.readHeader(fd));
  let touched = 0;
  try {
    for (const entryPath of ENTRIES) {
      const backupFile = path.join(paths.backupDir, backupName(entryPath));
      if (!fs.existsSync(backupFile)) {
        log(`跳过      ${entryPath} 没有备份，无法还原`);
        continue;
      }
      const original = fs.readFileSync(backupFile);
      const snap = snapshot(fd, entryPath);
      if (snap.hash === asar.sha256(original)) {
        log(`跳过      ${entryPath} 已是备份内容`);
        continue;
      }
      // Restoring the wrong build's bytes would leave a mixture: one entry from
      // the old release, one from the new. Length is checked after this because
      // a same-size cross-build backup is the case that used to slip through.
      const backupBuildId = manifest.entries?.[entryPath]?.buildId;
      if (backupBuildId !== undefined && buildId !== undefined && backupBuildId !== buildId) {
        throw new Error(
          `${entryPath} 的备份来自 ${backupBuildId}，当前应用是 ${buildId}：这份备份属于更新前的版本，不能还原。` +
            `这不是补丁装坏了，而是 DeepSeek Harness 更新过；重新执行 apply 会归档旧备份并记下当前内容的备份。`,
        );
      }
      if (snap.size !== original.length) {
        throw new Error(
          `${entryPath} 现有 ${snap.size} 字节，备份 ${original.length} 字节：这份备份属于更新前的版本，不能用来还原当前内容。` +
            `这不是补丁装坏了，而是 DeepSeek Harness 更新过；重新执行 apply 会归档旧备份并记下当前内容的备份。`,
        );
      }
      const written = asar.writeEntry(fd, asar.readHeader(fd), entryPath, original);
      fs.fsyncSync(fd);
      touched += 1;
      log(`还原      ${entryPath}  ${short(snap.hash)} → ${short(asar.sha256(original))}（头部哈希串更新 ${written.hashHits} 处）`);
    }
  } finally {
    fs.closeSync(fd);
  }

  const verifyFd = openArchive(paths.archive, "r");
  let failures = 0;
  try {
    for (const entryPath of ENTRIES) {
      const snap = snapshot(verifyFd, entryPath);
      const backupFile = path.join(paths.backupDir, backupName(entryPath));
      const expected = fs.existsSync(backupFile) ? asar.sha256(fs.readFileSync(backupFile)) : asar.sha256(payloads.get(entryPath));
      const integrity = integrityOk(snap);
      const ok = snap.hash === expected && integrity.ok;
      if (!ok) failures += 1;
      log(`${ok ? "[OK]  " : "[FAIL]"} 回读 ${entryPath}  ${snap.size} 字节  ${snap.hash.slice(0, 16)}…  ${integrity.detail}`);
    }
  } finally {
    fs.closeSync(verifyFd);
  }
  if (failures > 0) return { archive: paths.archive, ok: false, touched, error: `回读校验失败 ${failures} 项` };
  if (touched > 0 && fs.existsSync(paths.stateFile)) {
    fs.rmSync(paths.stateFile, { force: true });
    log("");
    log(`已删除 ${paths.stateFile}`);
  }
  manifest.revertedAt = new Date().toISOString();
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  log("");
  log(`revert: 完成（${touched} 个条目被还原）。重启 DeepSeek Harness 后退回原菜单。`);
  return { archive: paths.archive, ok: true, touched };
}

module.exports = {
  DEFAULT_ARCHIVE,
  DEFAULT_BACKUP_DIR,
  DEFAULT_STATE_FILE,
  ENTRIES,
  PAYLOAD_DIR,
  ROOT,
  TOOL_VERSION,
  apply,
  backupName,
  pathsFor,
  payloadHashes,
  revert,
  status,
  verify
};
