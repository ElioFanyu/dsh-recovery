"use strict";
// DSH Recovery — Electron entry point.
//
// This console is deliberately self-contained: it does not load the DSH
// runtime, any profile bundle, or any third-party module. It only needs to
// read and repair a Harness home, so it keeps working when the profile it is
// repairing cannot boot.

const path = require("node:path");
const fs = require("node:fs");

const { app, BrowserWindow, ipcMain, shell } = require("electron");

const { RecoveryController } = require("./backend/ipc");
const { PROJECT_ROOT } = require("./backend/paths");
const paths = require("./backend/paths");
const { runVerify } = require("./backend/verify");

// Keep the console's Chromium profile inside the tool instead of polluting
// AppData, so removing the folder removes every trace of it.
app.setPath("userData", path.join(PROJECT_ROOT, ".runtime", "userdata"));

// Window/taskbar icon lives next to the backend so `app\` stays self-contained.
// A missing icon must never stop the console from opening.
const ICON_PATH = path.join(__dirname, "assets", "icon.png");

const CHANNELS = [
  "recovery:status",
  "recovery:refresh",
  "recovery:targets",
  "recovery:set-target",
  "recovery:choose-target",
  "recovery:adopt-target",
  "recovery:forget-target",
  "recovery:choose-home",
  "recovery:reset-home",
  "recovery:reset-data",
  "recovery:profiles",
  "recovery:select-profile",
  "recovery:set-bundle-enabled",
  "recovery:enable-all-bundles",
  "recovery:uninstall-bundle",
  "recovery:restore-removed",
  "recovery:discard-removed",
  "recovery:sanitize-profile",
  "recovery:open-profile-dir",
  "recovery:open-path",
  "recovery:show-item",
  "recovery:open-plugin",
  "recovery:checkpoints",
  "recovery:create-checkpoint",
  "recovery:restore-checkpoint",
  "recovery:delete-checkpoint",
  "recovery:delete-all-checkpoints",
  "recovery:diagnostics",
  "recovery:export-diagnostics",
  "recovery:restart-button-apply",
  "recovery:restart-button-revert",
  "recovery:restart-button-verify",
  "recovery:plugin-updater",
  "recovery:plugin-repair",
  "recovery:plugin-install",
  "recovery:plugin-install-market",
  "recovery:plugin-update",
  "recovery:plugin-check",
  "recovery:plugin-version-check",
  "recovery:plugin-update-all",
  "recovery:self-update-check",
  "recovery:self-update-apply",
  "recovery:open-external",
  "recovery:awesome-choose-dir",
  "recovery:awesome-set-dir",
  "recovery:copy-text",
  "recovery:awesome-forget-dir",
  "recovery:awesome-check",
  "recovery:awesome-write",
  "recovery:backup-export",
  "recovery:backup-choose-file",
  "recovery:backup-preview",
  "recovery:backup-restore",
  "recovery:backup-delete",
  "recovery:cookies-clear",
  "recovery:cookies-restore",
  "recovery:launch",
  "recovery:stop",
  "recovery:restart",
  "recovery:quit",
];

let controller;
let mainWindow;

// `--self-check` runs the whole read pipeline (targets, home, profiles,
// checkpoints, diagnostics) without opening a window, prints a compact digest
// and exits non-zero when something looks unrecoverable. It is the smoke test
// CI or a user can run after updating the installed application.
const selfCheck = process.argv.includes("--self-check");

// `--verify` exercises the destructive actions (disable/uninstall bundles,
// create/restore/delete checkpoints, launch/stop) against a throwaway fixture
// under `.runtime\verify-*`, then proves `recovery:quit` really exits. It never
// reads or writes the real DSH home, the installed application or the config.
const verify = process.argv.includes("--verify");

// `--ui-check` opens the window like a normal run, drives the renderer (clicks
// the restart-button tab), saves a screenshot and exits. It is the end-to-end
// check that index.html really loads app.js and that the backend state reaches
// a panel: a missing <script> tag once shipped a blank window that no headless
// check can see.
const uiCheck = process.argv.includes("--ui-check");

// Both headless modes run without a window and must work while a console window is open.
const headless = selfCheck || verify;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits for the console window to exist and finish loading, or throws. */
async function waitForWindow(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (mainWindow === undefined) {
    if (Date.now() > deadline) throw new Error(`窗口未在 ${timeoutMs} 毫秒内创建`);
    await sleep(50);
  }
  while (mainWindow.webContents.isLoading()) {
    if (Date.now() > deadline) throw new Error(`页面未在 ${timeoutMs} 毫秒内加载完成`);
    await sleep(50);
  }
  return mainWindow;
}

/**
 * End-to-end UI check: renders the app, clicks through to the restart-button
 * panel and proves the panel, its buttons and the preload bridge are there.
 */
async function runUiCheck({ shot }) {
  const issues = [];
  // Evidence that the registry scan really ran and rendered, so the digest can
  // show it instead of just "no issues".
  let scanResult;
  const win = await waitForWindow(20000);
  // A renderer exception surfaces as an opaque "Script failed to execute", so
  // every console message is collected and reported alongside the issues.
  const consoleMessages = [];
  win.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    consoleMessages.push({ level, message, line, sourceId });
    // Renderer errors must reach the terminal: an opaque "Script failed to
    // execute" without the message cannot be acted on.
    if (String(level) === "3" || String(level) === "error") process.stderr.write(`renderer: ${message} (${sourceId}:${line})\n`);
  });
  // app.js waits for `api.status()` before its first render; give it a moment.
  await sleep(900);

  let before;
  try {
    before = await win.webContents.executeJavaScript(
      "({ tabs: [...document.querySelectorAll('#tabs [data-action=\"tab\"]')].map((node) => node.textContent), bridge: Object.keys(window.recovery ?? {}), panelCount: document.querySelectorAll('.panel').length, active: document.querySelector('.panel[data-active=\"true\"]')?.dataset.panel ?? null, error: window.__renderError ?? null })",
    );
  } catch (error) {
    throw new Error(`读取页面失败：${error instanceof Error ? error.message : String(error)}；控制台：${JSON.stringify(consoleMessages.slice(-8))}`);
  }
  if (typeof before.error === "string") {
    throw new Error(`渲染失败：${before.error}；控制台：${JSON.stringify(consoleMessages.slice(-8))}`);
  }
  // Eight panels. 插件管理 和 插件更新 were merged (both rendered the same
  // package list from two backends), and 切换 Profile went into 数据与 Profile
  // (a profile is a subdirectory of the data directory).
  if (before.tabs.length !== 8) issues.push(`页签数量为 ${before.tabs.length}，期望 8`);
  if (!before.tabs.some((label) => label.includes("重启按钮"))) issues.push("页签中没有「重启按钮」");
  if (!before.tabs.some((label) => label.includes("插件管理"))) issues.push("页签中没有「插件管理」");
  if (before.tabs.some((label) => label.includes("插件更新"))) issues.push("页签中仍有独立的「插件更新」（应已并入「插件管理」）");
  if (before.tabs.some((label) => label.includes("切换 Profile"))) issues.push("页签中仍有独立的「切换 Profile」（应已并入「数据与 Profile」）");
  if (!before.tabs.some((label) => label.includes("收录插件"))) issues.push("页签中没有「收录插件」");
  if (!before.tabs.some((label) => label.includes("环境备份"))) issues.push("页签中没有「环境备份」");
  if (!before.tabs.some((label) => label.includes("Profile"))) issues.push("页签中没有承载 Profile 切换的「数据与 Profile」");
  if (before.panelCount !== 8) issues.push(`面板数量为 ${before.panelCount}，期望 8`);
  for (const method of [
    "restartButtonApply",
    "restartButtonRevert",
    "restartButtonVerify",
    "enableAllBundles",
    "deleteAllCheckpoints",
    "chooseTarget",
    "adoptTarget",
    "forgetTarget",
    "pluginUpdater",
    "pluginRepair",
    "pluginInstall",
    "pluginInstallMarket",
    "pluginUpdate",
    "pluginCheck",
    "awesomeSetDir",
    "awesomeForgetDir",
    "awesomeCheck",
    "awesomeWrite",
    "cookiesClear",
    "cookiesRestore",
    "backupExport",
    "backupChooseFile",
    "backupPreview",
    "backupRestore",
    "backupDelete",
    "copyText",
    "openExternal",
  ]) {
    if (!before.bridge.includes(method)) issues.push(`preload 桥缺少 ${method}`);
  }

  // The two one-click actions must be reachable from their panels, not just
  // present in the bridge.
  const panelProbe =
    "((id) => { const node = document.querySelector(`.panel[data-panel=\"${id}\"]`); return node === null ? null : { text: node.innerText, actions: [...node.querySelectorAll('button[data-action]')].map((b) => ({ action: b.dataset.action, arg: b.dataset.arg, label: b.textContent, disabled: b.disabled })) }; })";
  const pluginsPanel = await win.webContents.executeJavaScript(`${panelProbe}("plugins")`);
  if (pluginsPanel === null) issues.push("找不到「插件管理」面板");
  else {
    if (!pluginsPanel.actions.some((button) => button.action === "enable-all-bundles")) issues.push("插件管理面板缺少「一键启用全部插件」按钮");
    // Every plugin row must offer its own "open" action, and the label has to
    // agree with the source: 本地 -> folder, 联网 -> homepage. A row whose
    // target is unknown renders the button disabled instead of hiding it, so
    // the count below stays meaningful.
    const openers = pluginsPanel.actions.filter((button) => button.action === "open-plugin");
    // Count rows and openers in the DOM: the plugin list also mentions 已启用 /
    // 已禁用 in chips and hints, so counting words in the text is not a row count.
    const rowCounts = await win.webContents.executeJavaScript(
      "(() => { const p = document.querySelector('.panel[data-panel=\"plugins\"]'); return p === null ? null : { rows: p.querySelectorAll('.row.row--plugin').length, openers: p.querySelectorAll('.row.row--plugin button[data-action=\"open-plugin\"]').length }; })()",
    );
    if (rowCounts !== null && rowCounts.openers !== rowCounts.rows) {
      issues.push(`插件管理：${rowCounts.rows} 行插件只渲染了 ${rowCounts.openers} 个「打开」按钮`);
    }
    if (rowCounts === null || rowCounts.rows === 0) issues.push("插件管理面板没有任何插件行");
    const mislabelled = openers.filter((button) => button.label !== "打开文件夹" && button.label !== "打开官网");
    if (mislabelled.length > 0) issues.push(`插件管理：「打开」按钮文案异常 ${mislabelled.map((b) => b.label).join(", ")}`);
    // A stopped app must not print the word "undefined" anywhere in the panel
    // or the footer; that used to happen when a missing action was appended
    // with the native DOM append.
    if (/undefined/u.test(pluginsPanel.text)) issues.push("插件管理面板出现了 undefined 文字");

    // 内置组件 must not be rendered as a group any more: they cannot be toggled
    // or uninstalled, and they pushed actionable plugins below the fold. The
    // headline keeps their count so nothing is silently hidden.
    const builtinCard = await win.webContents.executeJavaScript(
      `(() => {
        const p = document.querySelector('.panel[data-panel="plugins"]');
        if (p === null) return null;
        const titles = [...p.querySelectorAll('section.card .card__title')].map((n) => n.textContent ?? '');
        return { titles, text: p.innerText };
      })()`,
    );
    if (builtinCard !== null) {
      const builtinTitled = builtinCard.titles.filter((title) => title.startsWith("内置组件"));
      if (builtinTitled.length > 0) issues.push(`插件管理：仍在渲染「内置组件」分组（${builtinTitled.join(", ")}）`);
    }

    // Within each group, disabled rows must sort last. Checked per card so a
    // regression in either the local or the registry list is caught.
    const ordering = await win.webContents.executeJavaScript(
      `(() => {
        const p = document.querySelector('.panel[data-panel="plugins"]');
        if (p === null) return null;
        const out = {};
        for (const card of p.querySelectorAll('section.card')) {
          const title = card.querySelector('.card__title')?.textContent ?? '';
          if (!title.startsWith('本地插件') && !title.startsWith('联网插件')) continue;
          const rows = [...card.querySelectorAll('.row.row--plugin')].map((row) => ({
            enabled: (row.innerText ?? '').includes('已启用'),
          }));
          const firstOff = rows.findIndex((row) => row.enabled !== true);
          const lastOn = rows.map((row) => row.enabled === true).lastIndexOf(true);
          out[title.split('（')[0]] = { rows: rows.length, firstOff, lastOn };
        }
        return out;
      })()`,
    );
    for (const [group, info] of Object.entries(ordering ?? {})) {
      if (info.firstOff === -1) continue;
      if (info.lastOn > info.firstOff) {
        issues.push(`插件管理：${group} 里启用的插件排在了已禁用之后（首个禁用在第 ${info.firstOff + 1} 行，最后启用在第 ${info.lastOn + 1} 行）`);
      }
    }
  }
  const footerText = await win.webContents.executeJavaScript("document.getElementById('footer-actions')?.innerText ?? ''");
  if (/undefined/u.test(footerText)) issues.push(`页脚出现了 undefined 文字：${footerText.trim()}`);

  // 残留的 dsh-auth-* cookie: the card must exist on 快速恢复 with both actions,
  // and the destructive one must be disabled while the app is running — that is
  // the state Chromium's exclusive lock enforces anyway, so a live button would
  // only produce a failure toast.
  const quickPanel = await win.webContents.executeJavaScript(`${panelProbe}("quick")`);
  if (quickPanel === null) issues.push("找不到「快速恢复」面板");
  else {
    if (!quickPanel.text.includes("残留的登录 cookie")) issues.push("快速恢复面板缺少「残留的登录 cookie」卡片");
    for (const action of ["cookies-clear", "cookies-clear-preview"]) {
      if (!quickPanel.actions.some((button) => button.action === action)) issues.push(`残留 cookie 卡片缺少按钮 ${action}`);
    }
    if (!quickPanel.text.includes("dsh-auth-")) issues.push("残留 cookie 卡片没有说明受影响的 cookie 前缀");
    // The card must not claim a count it could not read.
    const lockWording = quickPanel.text.includes("被独占");
    const hasCount = /\d+\s*条\s*dsh-auth-/u.test(quickPanel.text);
    if (lockWording && hasCount) issues.push("残留 cookie 卡片在文件被占用时仍然报出了条目数（会误导）");
  }  // The reported bug only appears while the application is stopped, which the
  // live window cannot always reproduce (it may well be running). Ask the
  // renderer for both states of the real builder instead.
  //
  // This must call `footerButtons()`, the function the footer actually renders
  // with. An earlier version iterated `footerActions()` and filtered the holes
  // out itself, which hid the very crash it was meant to catch: reading
  // `.label` off the `stop: undefined` hole threw only in the real render path.
  const footerStates = await win.webContents.executeJavaScript(
    "(() => { const out = {}; for (const running of [false, true]) { try { const list = footerButtons(running); out[String(running)] = { labels: list.map((v) => v.label), holey: list.filter((v) => v === undefined).length }; } catch (error) { out[String(running)] = { error: String(error && error.message) }; } } return out; })()",
  );
  for (const [key, expected] of [
    ["false", ["刷新状态", "启动", "退出"]],
    ["true", ["刷新状态", "停止", "重启", "退出"]],
  ]) {
    const got = footerStates?.[key];
    if (got === undefined) {
      issues.push(`页脚状态 ${key} 无法求值`);
      continue;
    }
    if (typeof got.error === "string") {
      issues.push(`页脚状态 ${key} 渲染抛异常：${got.error}`);
      continue;
    }
    // A label list that differs means a button went missing or gained an
    // "undefined" label.
    if (got.holey > 0) issues.push(`页脚状态 ${key} 有 ${got.holey} 个空按钮`);
    if (JSON.stringify(got.labels) !== JSON.stringify(expected)) {
      issues.push(`页脚状态 ${key} 的按钮为 ${got.labels.join("/")}，期望 ${expected.join("/")}`);
    }
  }
  const checkpointsPanel = await win.webContents.executeJavaScript(`${panelProbe}("checkpoints")`);
  if (checkpointsPanel === null) issues.push("找不到「回滚」面板");
  else {
    const sweep = checkpointsPanel.actions.find((button) => button.action === "delete-all-checkpoints");
    if (sweep === undefined) issues.push("回滚面板缺少「一键删除全部」按钮");
    else if (checkpointsPanel.text.includes("还没有检查点") && sweep.disabled !== true) issues.push("没有检查点时「一键删除全部」按钮仍可点击");
  }

  // The plugin panel carries both halves now: management (enable / disable /
  // uninstall / open) and updates (pnpm install / upgrade / repair). The actions
  // must be there even on a healthy profile: an update is a manual action, not a
  // repair, so "no problems" cannot hide it.
  const updaterPanel = pluginsPanel;
  if (updaterPanel === null) issues.push("找不到「插件管理」面板（同时也承载插件更新）");
  else {
    for (const action of ["plugin-repair", "plugin-update", "plugin-install"]) {
      if (!updaterPanel.actions.some((button) => button.action === action)) issues.push(`插件管理面板缺少按钮 ${action}`);
    }
    if (!updaterPanel.text.includes("插件市场") && !updaterPanel.text.includes("dshmarket")) {
      issues.push("插件管理面板没有提到插件市场自身");
    }
    // 安装市场 and 升级市场 are mutually exclusive, and which one is right
    // depends on the machine: a profile without the market must offer the
    // install (nothing in the app can do it), one with it must offer the
    // update. Exactly one of the two must be there, and it must agree with the
    // version text beside it.
    const installMarket = updaterPanel.actions.find((button) => button.action === "plugin-install-market");
    const updateMarket = updaterPanel.actions.find(
      (button) => button.action === "plugin-update" && button.arg === "dshmarket",
    );
    const marketInstalled = updaterPanel.text.includes("更新插件市场本身");
    // The status metric must agree with the buttons: an install card that also
    // printed a version, or an update card with no version, would contradict
    // itself on screen.
    if (marketInstalled === updaterPanel.text.includes("尚未安装")) {
      issues.push(`插件管理：市场卡片的状态与按钮不一致（installed=${marketInstalled}）`);
    }
    if (marketInstalled) {
      if (installMarket !== undefined) issues.push("插件市场已安装，却仍显示「安装插件市场」按钮");
      if (updateMarket === undefined) issues.push("插件市场已安装，但没有「升级到最新」按钮");
    } else {
      if (installMarket === undefined) issues.push("插件市场未安装，却没有「安装插件市场」按钮");
      if (updateMarket !== undefined) issues.push("插件市场未安装，却显示了「升级到最新」按钮");
    }

    // Clicking a card action must not break the window. The renderer re-renders
    // after every action, and a throw inside that render is caught by the same
    // handler as a failed action — so a rendering bug surfaced as an error toast
    // on a *successful* click, with the footer blanked. 检查安装 is the safe
    // button to click here: it writes nothing, so this runs on any machine.
    const clickable = updaterPanel.actions.find(
      (button) => button.action === "plugin-check" && button.arg === "dshmarket",
    );
    if (clickable === undefined) {
      issues.push("插件管理面板没有可点击的市场「检查安装」按钮");
    } else if (clickable.disabled !== true) {
      await win.webContents.executeJavaScript(
        `document.querySelector('.panel[data-panel="plugins"] button[data-action="plugin-check"][data-arg="dshmarket"]').click()`,
      );
      await sleep(1200);
      const afterClick = await win.webContents.executeJavaScript(
        `({ footer: [...document.querySelectorAll('#footer-actions button')].length, renderError: window.__renderError ?? null, toasts: [...document.querySelectorAll('#toasts .toast')].map((node) => node.textContent) })`,
      );
      if (afterClick.renderError !== null) issues.push(`点击市场「检查安装」后渲染异常：${afterClick.renderError}`);
      if (afterClick.footer === 0) issues.push("点击市场「检查安装」后页脚按钮消失");
      // A rendering crash arrives as a toast too; the action itself only
      // reports success or a real refusal.
      const crash = (afterClick.toasts ?? []).find((text) => /reading 'label'|Cannot read propert/u.test(text));
      if (crash !== undefined) issues.push(`点击市场「检查安装」弹出了渲染异常：${crash}`);
    }

    // 本地 and 联网 plugins are listed separately, and a local row must not
    // offer 升级: pnpm would replace the link with a registry download.
    const groups = await win.webContents.executeJavaScript(
      `(() => {
        const panel = document.querySelector('.panel[data-panel="plugins"]');
        if (panel === null) return null;
        const cards = [...panel.querySelectorAll('section.card')];
        const named = (prefix) => cards.find((card) => (card.querySelector('.card__title')?.textContent ?? '').startsWith(prefix));
        const local = named('本地插件');
        const registry = named('联网插件');
        const updatable = (card) => card === undefined ? null : [...card.querySelectorAll('button[data-action="plugin-update"]')].length;
        const rowNames = (card) => card === undefined ? null : [...card.querySelectorAll('.row__name')].map((node) => node.textContent);
        return {
          hasLocal: local !== undefined,
          hasRegistry: registry !== undefined,
          localUpdates: updatable(local),
          registryUpdates: updatable(registry),
          localRows: rowNames(local),
          registryRows: rowNames(registry),
        };
      })()`,
    );
    if (groups === null) {
      issues.push("无法读取插件管理面板的插件分组");
    } else {
      if (groups.hasLocal !== true) issues.push("插件管理面板没有「本地插件」分组");
      if (groups.hasRegistry !== true) issues.push("插件管理面板没有「联网插件」分组");
      if (groups.localUpdates !== 0) {
        issues.push(`「本地插件」分组出现了 ${groups.localUpdates} 个升级按钮（会把 link 换成 registry 副本）`);
      }
      // A machine with no local plugins renders an empty group, which is fine;
      // what must never happen is a plugin appearing in both lists.
      const both = (groups.localRows ?? []).filter((name) => (groups.registryRows ?? []).includes(name));
      if (both.length > 0) issues.push(`插件同时出现在本地与联网分组：${both.join("、")}`);
    }
  }

  // 收录插件 must open with its rules visible and its one primary action
  // reachable, even before any directory is configured.
  const awesomePanel = await win.webContents.executeJavaScript(`${panelProbe}("awesome")`);
  if (awesomePanel === null) issues.push("找不到「收录插件」面板");
  else {
    for (const action of ["awesome-check", "awesome-choose-repo", "awesome-choose-list"]) {
      if (!awesomePanel.actions.some((button) => button.action === action)) issues.push(`收录插件面板缺少按钮 ${action}`);
    }
    const checkButton = awesomePanel.actions.find((button) => button.action === "awesome-check");
    // 「检查」 is live only once a repository is configured. Which of the two
    // states holds depends on the machine's saved config, so both are valid —
    // what must never happen is the button disagreeing with the badge.
    const repoConfigured = awesomePanel.text.includes("已指定插件仓库");
    if (checkButton !== undefined && checkButton.disabled === repoConfigured) {
      issues.push(repoConfigured ? "已指定仓库却禁用「检查并生成条目」" : "没有指定仓库时「检查并生成条目」应当禁用");
    }
    // The blocking card must offer the copy buttons that hand its contents off.
    if (awesomePanel.text.includes("必须修正")) {
      for (const action of ["awesome-copy-fixes"]) {
        if (!awesomePanel.actions.some((button) => button.action === action)) issues.push(`「必须修正」卡片缺少按钮 ${action}`);
      }
    }
    if (!awesomePanel.text.includes("dsh.bundle")) issues.push("收录插件面板没有列出 dsh.bundle 规则");
    if (!awesomePanel.text.includes("收录到 awesome-dsh-plugin")) issues.push("收录插件面板缺少主卡片");
  }

  // The tab that absorbed 切换 Profile must actually offer a profile row to
  // select, plus the data-directory controls it always had. A merged tab that
  // silently dropped the profile list would look fine to the compiler.
  const dataPanel = await win.webContents.executeJavaScript(`${panelProbe}("data")`);
  if (dataPanel === null) issues.push("找不到「数据与 Profile」面板");
  else {
    for (const action of ["choose-home", "reset-home", "reset-data"]) {
      if (!dataPanel.actions.some((button) => button.action === action)) issues.push(`数据与 Profile 面板缺少按钮 ${action}`);
    }
    if (!dataPanel.text.includes("选择 Profile") && !dataPanel.text.includes("Profile 根目录")) {
      issues.push("数据与 Profile 面板没有 Profile 相关区域");
    }
    // Every non-current profile row must have a working 选择 button; a tab that
    // rendered the list but no way to switch would look fine to the compiler.
    // Built with a quote-free selector so the nested quoting cannot drift.
    const profileProbe =
      "(() => { const n = document.querySelector('.panel[data-panel=' + JSON.stringify('data') + ']'); " +
      "if (n === null) return null; " +
      "return { chooses: n.querySelectorAll('button[data-action=' + JSON.stringify('select-profile') + ']').length, " +
      "current: (n.innerText.match(/当前 Profile/g) ?? []).length }; })()";
    const profileRows = await win.webContents.executeJavaScript(profileProbe);
    if (profileRows === null) issues.push("无法读取「数据与 Profile」面板的 Profile 行");
    else if (profileRows.chooses + profileRows.current === 0) {
      issues.push("数据与 Profile 面板没有任何 Profile 行（既没有「选择」也没有「当前 Profile」）");
    }
  }

  // 插件管理 must offer a registry check and a one-click upgrade. Both are new
  // entry points, so a refactor that drops them would otherwise pass.
  if (pluginsPanel !== null) {
    for (const action of ["plugin-version-check", "plugin-update-all"]) {
      if (!pluginsPanel.actions.some((button) => button.action === action)) issues.push(`插件管理面板缺少按钮 ${action}`);
    }
    // 一键升级 must stay disabled until a scan says something is pending: an
    // enabled button with nothing to do would run pnpm over every plugin.
    const updateAll = pluginsPanel.actions.find((button) => button.action === "plugin-update-all");
    const hasOutdated = /\d+ 个待升级/u.test(pluginsPanel.text) || /一键升级（\d+）/u.test(pluginsPanel.text);
    if (updateAll !== undefined && hasOutdated !== true && updateAll.disabled !== true) {
      issues.push("插件管理：没有检测到更新时「一键升级」仍可点击");
    }
    if (!pluginsPanel.text.includes("插件更新")) issues.push("插件管理面板缺少「插件更新」区域");

    // Click 「检测更新」 for real. This is the check that would have caught the
    // `row is not a function` regression: the scan itself succeeded, then the
    // RENDER of its result threw and blanked the page. Asserting the button
    // exists is not enough — the code path has to be run.
    const checkButton = pluginsPanel.actions.find((button) => button.action === "plugin-version-check");
    if (checkButton === undefined) {
      issues.push("插件管理面板没有「检测更新」按钮");
    } else if (checkButton.disabled !== true) {
      await win.webContents.executeJavaScript(
        `document.querySelector('.panel[data-panel="plugins"] button[data-action="plugin-version-check"]').click()`,
      );
      // The scan hits the npm registry, so allow real network time; the point is
      // to reach the re-render, not to measure latency.
      await sleep(6000);
      const afterScan = await win.webContents.executeJavaScript(
        `({
           renderError: window.__renderError ?? null,
           footer: [...document.querySelectorAll('#footer-actions button')].length,
           cards: [...document.querySelectorAll('.panel[data-panel="plugins"] section.card')].length,
           text: document.querySelector('.panel[data-panel="plugins"]')?.innerText ?? '',
           toasts: [...document.querySelectorAll('#toasts .toast')].map((node) => node.textContent),
         })`,
      );
      if (afterScan.renderError !== null) issues.push(`点击「检测更新」后渲染异常：${afterScan.renderError}`);
      if (afterScan.footer === 0) issues.push("点击「检测更新」后页脚按钮消失（渲染崩溃）");
      // The page went blank in the reported bug; a panel with no cards is that
      // same failure seen from the outside.
      if (afterScan.cards === 0) issues.push("点击「检测更新」后插件面板没有任何卡片（页面被清空）");
      // The scan must produce a POSITIVE result, not merely "no crash": the
      // result card reports how many packages were compared. Requiring that
      // sentence is what separates "the scan ran and rendered" from "nothing
      // happened because the click did not reach the backend".
      const compared = /已检查\s*\d+\s*个联网插件/u.test(afterScan.text);
      if (!compared) {
        issues.push(
          `点击「检测更新」后没有出现「已检查 N 个联网插件」的结果（面板文字：${afterScan.text.slice(0, 200).replace(/\s+/gu, " ")}）`,
        );
      }
      const scanCrash = (afterScan.toasts ?? []).find((text) =>
        /is not a function|Cannot read propert|undefined is not/u.test(text),
      );
      if (scanCrash !== undefined) issues.push(`点击「检测更新」弹出了代码异常：${scanCrash}`);
      scanResult = { compared, cards: afterScan.cards, sample: afterScan.text.slice(0, 160) };
    }
  }

  // Pointing the console at an install that auto-detection missed must be
  // reachable from the diagnostics panel even when only one install is known.
  const diagnosticsPanel = await win.webContents.executeJavaScript(`${panelProbe}("diagnostics")`);
  if (diagnosticsPanel === null) issues.push("找不到「诊断」面板");
  else {
    for (const action of ["choose-target", "choose-target-exe", "self-update-check", "self-update-apply"]) {
      if (!diagnosticsPanel.actions.some((button) => button.action === action)) issues.push(`诊断面板缺少按钮 ${action}`);
    }
    if (!diagnosticsPanel.text.includes("更新恢复器")) issues.push("诊断面板缺少「更新恢复器」卡片");
    // 立即更新 must be disabled until a check says there is something to apply.
    const applyButton = diagnosticsPanel.actions.find((button) => button.action === "self-update-apply");
    const knownUpdate = /任务|有新版本|落后远端/u.test(diagnosticsPanel.text);
    if (applyButton !== undefined && applyButton.disabled !== true && knownUpdate !== true) {
      issues.push("更新恢复器：「立即更新」在还没检查就绪时可点击");
    }
  }

  // 残留 cookie 卡片在「快速恢复」的最下方，滚动后的整页截图看不到它，
  // 所以单独把它滚进视野再拍一张，作为这次新增功能的可视证据。
  await win.webContents.executeJavaScript(`document.querySelector('[data-action="tab"][data-arg="quick"]').click()`);
  await sleep(400);
  {
    const cookieCardFound = await win.webContents.executeJavaScript(`(() => {
      const cards = [...document.querySelectorAll('.panel[data-panel="quick"] section.card')];
      const target = cards.find((c) => (c.querySelector('.card__title')?.textContent ?? '').includes('残留的登录 cookie'));
      if (target === undefined) return false;
      target.scrollIntoView({ block: 'start' });
      return true;
    })()`);
    if (cookieCardFound !== true) issues.push("快速恢复面板里找不到「残留的登录 cookie」卡片");
    await sleep(500);
    fs.writeFileSync(shot.replace(/\.png$/i, "-cookie-card.png"), (await win.webContents.capturePage()).toPNG());
  }

  // Same reason as above: 「更新恢复器」 sits at the bottom of 诊断, so a
  // whole-page shot cuts it off. Scrolling to it also proves it renders.
  await win.webContents.executeJavaScript(`document.querySelector('[data-action="tab"][data-arg="diagnostics"]').click()`);
  await sleep(400);
  {
    const selfUpdateFound = await win.webContents.executeJavaScript(`(() => {
      const cards = [...document.querySelectorAll('.panel[data-panel="diagnostics"] section.card')];
      const target = cards.find((c) => (c.querySelector('.card__title')?.textContent ?? '').includes('更新恢复器'));
      if (target === undefined) return false;
      target.scrollIntoView({ block: 'start' });
      return true;
    })()`);
    if (selfUpdateFound !== true) issues.push("诊断面板里找不到「更新恢复器」卡片");
    await sleep(500);
    fs.writeFileSync(shot.replace(/\.png$/i, "-self-update.png"), (await win.webContents.capturePage()).toPNG());
  }

  await win.webContents.executeJavaScript("document.querySelector('[data-action=\"tab\"][data-arg=\"restart\"]').click()");
  await sleep(400);

  // Capture each panel that gained a one-click button (plus the overview
  // panel), so a ui-check run also leaves visual evidence for those screens.
  const extraShots = {};
  for (const [panelId, suffix] of [["quick", "quick"], ["plugins", "plugins"], ["awesome", "awesome"], ["checkpoints", "checkpoints"], ["backup", "backup"], ["data", "data"], ["diagnostics", "diagnostics"]]) {
    await win.webContents.executeJavaScript(`document.querySelector('[data-action="tab"][data-arg="${panelId}"]').click()`);
    await sleep(400);
    const file = shot.replace(/\.png$/i, `-${suffix}.png`);
    const image = await win.webContents.capturePage();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, image.toPNG());
    extraShots[suffix] = { file, bytes: fs.statSync(file).size };
  }

  await win.webContents.executeJavaScript("document.querySelector('[data-action=\"tab\"][data-arg=\"restart\"]').click()");
  await sleep(400);

  const panel = await win.webContents.executeJavaScript(
    "(() => { const node = document.querySelector('.panel[data-active=\"true\"]'); return node === null ? null : { id: node.dataset.panel ?? null, text: node.innerText, buttons: [...node.querySelectorAll('button[data-action]')].map((button) => ({ action: button.dataset.action, label: button.textContent, disabled: button.disabled })) }; })()",
  );
  if (panel === null) issues.push("点击「重启按钮」页签后没有活动面板");
  else {
    if (panel.id !== "restart") issues.push(`活动面板为 ${panel.id}，期望 restart`);
    if (!panel.text.includes("重启按钮补丁")) issues.push("面板中没有「重启按钮补丁」卡片");
    if (!panel.text.includes("app.asar")) issues.push("面板中没有 app.asar 信息");
    if (!panel.text.includes("已安装")) issues.push("面板没有报告「已安装」（当前 app.asar 已是补丁内容）");
    const actions = panel.buttons.map((button) => button.action);
    for (const action of ["restart-button-apply", "restart-button-verify", "restart-button-revert"]) {
      if (!actions.includes(action)) issues.push(`面板缺少按钮 ${action}`);
    }
    const applyButton = panel.buttons.find((button) => button.action === "restart-button-apply");
    const revertButton = panel.buttons.find((button) => button.action === "restart-button-revert");
    if (applyButton?.disabled !== true) issues.push("已安装时「安装补丁」按钮仍可点击");
    if (revertButton?.disabled === true) issues.push("「还原补丁」按钮被禁用，但存在备份");
  }

  const image = await win.webContents.capturePage();
  fs.mkdirSync(path.dirname(shot), { recursive: true });
  fs.writeFileSync(shot, image.toPNG());

  // 环境备份: a read-only panel, so the assertions are about content reaching
  // the DOM. The two export buttons must both be there — "含凭据" is a separate,
  // deliberate click, not a checkbox someone can forget — and the secret groups
  // must be visibly marked when they are not being included.
  await win.webContents.executeJavaScript("document.querySelector('[data-action=\"tab\"][data-arg=\"backup\"]').click()");
  await sleep(400);
  const backupPanel = await win.webContents.executeJavaScript(
    "(() => { const node = document.querySelector('.panel[data-active=\"true\"]'); return node === null ? null : { id: node.dataset.panel ?? null, text: node.innerText, buttons: [...node.querySelectorAll('button[data-action]')].map((button) => ({ action: button.dataset.action, arg: button.dataset.arg ?? null, label: button.textContent, disabled: button.disabled })) }; })()",
  );
  if (backupPanel === null) issues.push("点击「环境备份」页签后没有活动面板");
  else {
    if (backupPanel.id !== "backup") issues.push(`活动面板为 ${backupPanel.id}，期望 backup`);
    for (const needle of ["打包这些内容", "Profile 与插件清单", "技能", "恢复"]) {
      if (!backupPanel.text.includes(needle)) issues.push(`环境备份面板缺少「${needle}」`);
    }
    const exportButtons = backupPanel.buttons.filter((button) => button.action === "backup-export");
    if (exportButtons.length !== 2) issues.push(`「导出备份」按钮为 ${exportButtons.length} 个，期望 2（不含凭据 / 含凭据）`);
    if (!exportButtons.some((button) => button.arg === "secrets")) issues.push("缺少「导出备份（含凭据）」按钮");
    if (!backupPanel.buttons.some((button) => button.action === "backup-choose-file")) issues.push("缺少「从文件恢复…」按钮");
    // A backup panel that silently included credentials would be the single
    // worst outcome of this feature, so the default wording is asserted.
    if (!backupPanel.text.includes("不含凭据")) issues.push("面板没有声明「不含凭据」");
    const image2 = await win.webContents.capturePage();
    fs.writeFileSync(shot.replace(/\.png$/i, "-backup-tab.png"), image2.toPNG());
  }

  return {
    issues,
    tabs: before.tabs,
    activePanelBefore: before.active,
    activePanel: panel?.id ?? null,
    buttons: panel?.buttons ?? [],
    panelText: panel?.text ?? "",
    backup: backupPanel === null ? null : { actions: backupPanel.buttons.map((button) => `${button.action}${button.arg === null ? "" : `=${button.arg}`}`), text: backupPanel.text.slice(0, 600) },
    oneClick: {
      plugins: pluginsPanel?.actions.filter((button) => button.action === "enable-all-bundles") ?? [],
      checkpoints: checkpointsPanel?.actions.filter((button) => button.action === "delete-all-checkpoints") ?? [],
    },
    updater: updaterPanel === null ? null : { actions: updaterPanel.actions, text: updaterPanel.text },
    // Whether the real 「检测更新」 click produced a rendered result.
    scanResult: scanResult ?? null,
    awesome: awesomePanel === null ? null : { actions: awesomePanel.actions, text: awesomePanel.text.slice(0, 400) },
    extraShots,
    shot,
    shotBytes: fs.statSync(shot).size,
  };
}

function selfCheckDigest(state) {
  const issues = [];
  if (state.selected === undefined) issues.push("未识别到目标应用安装目录");
  if (state.home.exists !== true) issues.push(`DSH 数据目录不存在: ${state.home.path}`);
  const detail = state.selectedProfileDetail;
  if (detail !== undefined) {
    if (detail.exists !== true) issues.push(`Profile 目录不存在: ${detail.dir}`);
    if (detail.manifestError !== undefined) issues.push(`插件清单无法解析: ${detail.manifestError}`);
    if (detail.patchError !== undefined) issues.push(`插件补丁无法解析: ${detail.patchError}`);
  }
  for (const entry of state.checkpoints) {
    if (entry.metaValid !== true) issues.push(`检查点元数据无效: ${entry.id}`);
  }
  return {
    console: state.console,
    home: { path: state.home.path, exists: state.home.exists, source: state.home.source, profiles: state.home.profileNames },
    target: state.selected === undefined ? undefined : {
      kind: state.selected.kind,
      label: state.selected.label,
      appVersion: state.selected.appVersion,
      electronVersion: state.selected.electronVersion,
      exe: state.selected.exe,
    },
    targetCount: state.targets.length,
    targets: state.targets.map((entry) => ({ id: entry.id, kind: entry.kind, label: entry.label, appVersion: entry.appVersion, dir: entry.dir })),
    running: state.running,
    profiles: state.profiles.map((entry) => ({
      name: entry.name,
      exists: entry.exists,
      plugins: entry.plugins.length,
      bundles: entry.bundles.length,
      disabled: entry.patchDisabledCount,
      quarantined: entry.removed.length,
    })),
    selectedProfile: state.selectedProfile,
    checkpoints: state.checkpoints.map((entry) => ({ id: entry.id, createdAt: entry.createdAt, metaValid: entry.metaValid, files: entry.files.length })),
    diagnostics: { dir: state.diagnostics.dir, count: state.diagnostics.count, latest: state.diagnostics.latest?.name },
    safeModeHomes: state.safeModeHomes.length,
    issues,
  };
}

function broadcast(state) {
  if (mainWindow !== undefined && mainWindow !== null && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("recovery:status-changed", state);
  }
}

function argvValue(prefix) {
  const match = process.argv.find((argument) => argument.startsWith(prefix));
  return match === undefined ? undefined : match.slice(prefix.length);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 880,
    minWidth: 940,
    minHeight: 640,
    show: false,
    backgroundColor: "#f4f4f6",
    autoHideMenuBar: true,
    title: "DSH 恢复器",
    ...(fs.existsSync(ICON_PATH) ? { icon: ICON_PATH } : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      devTools: true,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });

  // The renderer never navigates away and never opens windows of its own.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/u.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file://")) event.preventDefault();
  });

  void mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  return mainWindow;
}

const ready = (async () => {
  // `--verify` / `--self-check` must not hand anything to the OS: the 打开
  // assertions would open a File Explorer window per check and leave a trail of
  // `verify-<timestamp>` folders on the desktop. The actions still resolve and
  // return their target, which is what the checks actually assert.
  controller = new RecoveryController({ version: app.getVersion(), onState: broadcast, allowShell: headless !== true });
  const targetId = argvValue("--target=");
  const profileName = argvValue("--profile=");
  const dshHome = argvValue("--home=");
  if (targetId !== undefined || profileName !== undefined || dshHome !== undefined) {
    // `--ui-check` points the console at throwaway homes and profiles. Those
    // arguments must stay in memory for that run: persisting them left the
    // console aimed at a fixture directory that the run itself deleted, so the
    // next normal launch showed every panel empty. The headless self tests do
    // the same and keep the real config byte-identical.
    if (uiCheck) {
      controller.config = {
        ...controller.config,
        ...(targetId === undefined ? {} : { targetId }),
        ...(profileName === undefined ? {} : { profileName }),
        ...(dshHome === undefined ? {} : { dshHome }),
      };
    } else {
      controller.persist({
        ...(targetId === undefined ? {} : { targetId }),
        ...(profileName === undefined ? {} : { profileName }),
        ...(dshHome === undefined ? {} : { dshHome }),
      });
    }
  }
  await controller.refresh({ sizes: false });
  if (selfCheck) {
    const digest = selfCheckDigest(controller.state);
    process.stdout.write(`${JSON.stringify(digest, undefined, 2)}\n`);
    process.stdout.write(digest.issues.length === 0 ? "self-check: ok\n" : `self-check: ${digest.issues.length} problem(s)\n`);
    app.exit(digest.issues.length === 0 ? 0 : 1);
    return;
  }
  if (verify) {
    let outcome;
    try {
      outcome = await runVerify({ version: app.getVersion(), targets: controller.state.targets });
    } catch (error) {
      // Never leave a headless run hanging: report and exit instead.
      process.stderr.write(`verify: 未捕获异常 ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      app.exit(2);
      return;
    }
    process.stdout.write(`${JSON.stringify(outcome, undefined, 2)}\n`);
    process.stdout.write(
      outcome.failed === 0 ? `verify: ok (${outcome.passed} checks)\n` : `verify: ${outcome.failed} of ${outcome.passed + outcome.failed} checks failed\n`,
    );
    if (outcome.failed > 0) {
      app.exit(1);
      return;
    }
    // Final check: the 退出 button path must really terminate the process. If
    // it does not, this timer keeps the process alive and reports the failure.
    setTimeout(() => {
      process.stderr.write("verify: recovery:quit 未在 4 秒内退出\n");
      app.exit(3);
    }, 4000);
    try {
      await controller.dispatch("recovery:quit", []);
    } catch (error) {
      process.stderr.write(`verify: recovery:quit 失败 ${error instanceof Error ? error.message : String(error)}\n`);
      app.exit(4);
    }
    return;
  }
  if (uiCheck) {
    // `--ui-check` must NOT run inside this promise: every IPC handler awaits
    // `ready`, so the renderer's first `status()` call would deadlock against
    // the check that is waiting for the renderer. It is started by the
    // whenReady block below instead, after `ready` has resolved.
    return;
  }
})();

/** Drives the already-rendered window and reports; only `--ui-check` calls this. */
async function startUiCheck() {
  const shot = argvValue("--ui-shot=") ?? path.join(PROJECT_ROOT, ".runtime", "ui-restart-tab.png");
  // A UI check must not rewrite the user's saved selection. It used to: a run
  // with `--home=…\fixture-home --profile=demo` persisted both, and because
  // the run also deletes that fixture, the next normal launch opened every
  // panel empty against a directory that no longer existed. Comparing the file
  // byte for byte is what makes that failure visible instead of silent.
  const configFile = paths.configPath();
  let configBefore;
  try {
    configBefore = fs.readFileSync(configFile);
  } catch {
    configBefore = undefined;
  }
  try {
    const outcome = await runUiCheck({ shot });
    try {
      const configAfter = fs.readFileSync(configFile);
      const unchanged = configBefore !== undefined && configBefore.equals(configAfter);
      if (!unchanged) outcome.issues.push(`ui-check 改写了控制台配置: ${configFile}`);
    } catch {
      outcome.issues.push(`ui-check 删除了控制台配置: ${configFile}`);
    }
    process.stdout.write(`${JSON.stringify(outcome, undefined, 2)}\n`);
    process.stdout.write(outcome.issues.length === 0 ? "ui-check: ok\n" : `ui-check: ${outcome.issues.length} problem(s)\n`);
    app.exit(outcome.issues.length === 0 ? 0 : 1);
  } catch (error) {
    process.stderr.write(`ui-check: 未捕获异常 ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    app.exit(2);
  }
}

function registerChannels() {
  for (const channel of CHANNELS) {
    ipcMain.handle(channel, async (_event, ...args) => {
      await ready;
      try {
        return await controller.dispatch(channel, args);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error), state: controller.state };
      }
    });
  }
}

// A self-check or verify run must still work while a console window is open, so
// both skip the single-instance lock entirely.
if (!headless && !uiCheck && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow === undefined) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.on("window-all-closed", () => {
    app.quit();
  });

  registerChannels();

  void app.whenReady().then(async () => {
    if (headless) return;
    // The AppUserModelID must be set before the window exists so Windows groups
    // the window, its taskbar entry and the Start-menu shortcut together.
    app.setAppUserModelId("dev.dsh.recovery");
    createWindow();
    if (uiCheck) {
      // `ready` resolved before the window existed, so the renderer can now
      // call the IPC channels the check drives.
      await ready;
      await startUiCheck();
    }
  });
}
