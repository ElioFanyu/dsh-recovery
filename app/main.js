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
  "recovery:plugin-remove",
  "recovery:plugin-check",
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
  // Nine panels: 收录插件 joined the eight so that adding a plugin to
  // awesome-dsh-plugin becomes a checked, guided operation instead of manual
  // YAML editing.
  if (before.tabs.length !== 10) issues.push(`页签数量为 ${before.tabs.length}，期望 10`);
  if (!before.tabs.some((label) => label.includes("重启按钮"))) issues.push("页签中没有「重启按钮」");
  if (!before.tabs.some((label) => label.includes("插件更新"))) issues.push("页签中没有「插件更新」");
  if (!before.tabs.some((label) => label.includes("收录插件"))) issues.push("页签中没有「收录插件」");
  if (!before.tabs.some((label) => label.includes("环境备份"))) issues.push("页签中没有「环境备份」");
  if (before.panelCount !== 10) issues.push(`面板数量为 ${before.panelCount}，期望 10`);
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
  }
  const footerText = await win.webContents.executeJavaScript("document.getElementById('footer-actions')?.innerText ?? ''");
  if (/undefined/u.test(footerText)) issues.push(`页脚出现了 undefined 文字：${footerText.trim()}`);
  // The reported bug only appears while the application is stopped, which the
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

  // The updater panel must expose its actions even on a healthy profile: an
  // update is a manual action, not a repair, so "no problems" cannot hide it.
  const updaterPanel = await win.webContents.executeJavaScript(`${panelProbe}("updater")`);
  if (updaterPanel === null) issues.push("找不到「插件更新」面板");
  else {
    for (const action of ["plugin-repair", "plugin-update", "plugin-install"]) {
      if (!updaterPanel.actions.some((button) => button.action === action)) issues.push(`插件更新面板缺少按钮 ${action}`);
    }
    if (!updaterPanel.text.includes("插件市场") && !updaterPanel.text.includes("dshmarket")) {
      issues.push("插件更新面板没有提到插件市场自身");
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
      issues.push(`插件更新：市场卡片的状态与按钮不一致（installed=${marketInstalled}）`);
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
      issues.push("插件更新面板没有可点击的市场「检查安装」按钮");
    } else if (clickable.disabled !== true) {
      await win.webContents.executeJavaScript(
        `document.querySelector('.panel[data-panel="updater"] button[data-action="plugin-check"][data-arg="dshmarket"]').click()`,
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
        const panel = document.querySelector('.panel[data-panel="updater"]');
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
      issues.push("无法读取插件更新面板的插件分组");
    } else {
      if (groups.hasLocal !== true) issues.push("插件更新面板没有「本地插件」分组");
      if (groups.hasRegistry !== true) issues.push("插件更新面板没有「联网插件」分组");
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

  // Pointing the console at an install that auto-detection missed must be
  // reachable from the diagnostics panel even when only one install is known.
  const diagnosticsPanel = await win.webContents.executeJavaScript(`${panelProbe}("diagnostics")`);
  if (diagnosticsPanel === null) issues.push("找不到「诊断」面板");
  else {
    for (const action of ["choose-target", "choose-target-exe"]) {
      if (!diagnosticsPanel.actions.some((button) => button.action === action)) issues.push(`诊断面板缺少按钮 ${action}`);
    }
  }

  await win.webContents.executeJavaScript("document.querySelector('[data-action=\"tab\"][data-arg=\"restart\"]').click()");
  await sleep(400);

  // Capture each panel that gained a one-click button (plus the overview
  // panel), so a ui-check run also leaves visual evidence for those screens.
  const extraShots = {};
  for (const [panelId, suffix] of [["quick", "quick"], ["plugins", "plugins"], ["updater", "updater"], ["awesome", "awesome"], ["checkpoints", "checkpoints"], ["backup", "backup"], ["diagnostics", "diagnostics"]]) {
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
    updater: updaterPanel === null ? null : { actions: updaterPanel.actions, text: updaterPanel.text.slice(0, 400) },
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
  controller = new RecoveryController({ version: app.getVersion(), onState: broadcast });
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
