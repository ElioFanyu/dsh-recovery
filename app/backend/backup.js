"use strict";
// 环境备份：把「换电脑 / 重装 DSH 后需要重新配置」的东西打成一个文件。
//
// 备份的是**配置意图**，不是运行产物。区分得很清楚：
//
//   * 能直接用文件表达的（Profile 清单、补丁层、技能、各插件的设置 JSON），
//     整体原样收进包内，恢复时字节级写回；
//   * 装不到的东西（node_modules、session、rewind 快照、附件、缓存、运行时）
//     一律不进包 —— 它们要么能用 pnpm 重新装出来，要么属于历史记录；
//   * 凭据（.credentials.yaml、各家登录态）默认不含，必须显式勾选，因为
//     备份文件一旦泄露等同于账号被盗。
//
// 本地插件（`link:` 依赖）的源码不在包内：它本来就在用户自己的仓库里。
// 包内记下路径 + git remote + commit，恢复时优先按 remote 重新 clone。

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  ensureDir,
  fileSizeOrZero,
  formatBytes,
  isDirectory,
  isFile,
  pathExists,
  readJson,
  removeEntry,
  timestampId,
  uniquePath,
  writeFileAtomic,
  writeJsonAtomic,
} = require("./util");
const { createZip, readZip } = require("./zip");

const BACKUP_FORMAT = "dsh-environment-backup";
const BACKUP_VERSION = 1;
const MANIFEST_NAME = "manifest.json";
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;

/** Skill roots the runtime actually loads, in precedence order. */
const SKILL_ROOTS = [
  { key: "dsh", label: "DSH 技能" },
  { key: "agents", label: "公共 Agent 技能" },
];

/**
 * Absolute skill roots.
 *
 * `~/.dsh/skills` follows the Harness home (so an explicit `DSH_HOME` or the
 * console's own data-directory setting is honoured), while `~/.agents/skills`
 * is shared with other agent tools and always sits in the real home. `base` and
 * `agentsBase` let `--verify` point every root at a throwaway directory: a test
 * must never write into the user's real skills.
 */
function skillRoots(options = {}) {
  const base = typeof options.base === "string" && options.base !== "" ? options.base : path.join(os.homedir(), ".dsh");
  const agentsBase = typeof options.agentsBase === "string" && options.agentsBase !== "" ? options.agentsBase : path.join(os.homedir(), ".agents");
  const home = base;
  const agents = agentsBase;
  return {
    dsh: path.join(home, "skills"),
    agents: path.join(agents, "skills"),
  };
}

/**
 * Files and directories inside the Harness home that carry user configuration.
 *
 * `group` drives how the panel presents them and how a restore treats them;
 * `secrets: true` means "only with the explicit opt-in". Anything not listed
 * here is deliberately excluded (see the exclusion list below the table).
 */
const HOME_ENTRIES = [
  {
    key: "profile",
    group: "profile",
    label: "Profile 清单与插件层",
    desc: "package.json（依赖 + 启用的插件层）、cordis.patch.yml（各插件的设置）、pnpm-workspace.yaml、pnpm-lock.yaml",
    kind: "files",
    files: ["package.json", "cordis.patch.yml", "cordis.yml", "pnpm-workspace.yaml", "pnpm-lock.yaml"],
    required: true,
  },
  {
    key: "market",
    group: "plugin-state",
    label: "插件市场分组与禁用状态",
    desc: "插件市场的分组、区域与哪些插件被禁用",
    kind: "files",
    inProfile: true,
    files: [".dsh-market/state.json"],
  },
  {
    key: "skills-manager",
    group: "plugin-state",
    label: "技能管理器的自定义技能目录",
    desc: "技能管理器登记的额外技能来源目录（roots.json）",
    kind: "files",
    files: ["skills-manager/roots.json", "skills-manager/state.json"],
  },
  {
    key: "agent-huawei",
    group: "plugin-state",
    label: "华为云账号偏好",
    desc: "启用的模型、上下文配额、账号顺序（不含 accessKey）",
    kind: "files",
    files: [".dsh-connect-huawei/prefs.json"],
  },
  {
    key: "free-model",
    group: "plugin-state",
    label: "免费模型设置",
    desc: "dsh-our-free-model 的设置、模型目录与可用性缓存",
    kind: "files",
    files: ["our-free-model/settings.json", "our-free-model/catalog.json", "our-free-model/availability.json"],
  },
  {
    key: "channel-pack",
    group: "plugin-state",
    label: "渠道包设置",
    desc: "渠道网关开关、模型禁用表与 provider 顺序",
    kind: "files",
    files: ["channel-pack/state.json"],
  },
  {
    key: "im",
    group: "plugin-state",
    label: "IM 集成设置",
    desc: "侧栏模式与界面语言（群历史、附件不进包）",
    kind: "files",
    files: ["integrations/dsh-im/sidebar-settings.json", "integrations/dsh-im/interface-language.json"],
  },
  {
    key: "agency",
    group: "agent",
    label: "Agent 专家与子代理",
    desc: "自定义专家人格、子代理登记与工具过滤规则",
    kind: "files",
    files: ["agency-expert-personas.json", "agency-subagents.json", "agency-subagent-ids.json"],
  },
  {
    key: "workspace",
    group: "workspace",
    label: "工作区与存储单元",
    desc: "工作区清单（路径、标题、排序）与各存储单元的数据（不含会话缓存）",
    kind: "storage",
    files: ["storages/workspace.json", "storages/archive_manager_favorites.json"],
  },
  {
    key: "mcp",
    group: "plugin-state",
    label: "MCP 连接器配置",
    desc: "已连接的 MCP 服务器、治理策略与工具目录。**连接凭据随此文件一起走**",
    kind: "files",
    files: ["storages/mcp_connector.json"],
  },
  {
    key: "huawei-accounts",
    group: "secret",
    label: "华为云账号（含 accessKey）",
    desc: "账号列表与本机保存的 CodeArts 凭据",
    kind: "files",
    secrets: true,
    files: [".dsh-connect-huawei/accounts.json"],
  },
  {
    key: "workbuddy-vault",
    group: "secret",
    label: "WorkBuddy 登录令牌",
    desc: "国内区与国际区的账号令牌",
    kind: "tree",
    secrets: true,
    files: ["workbuddy-vault"],
  },
  {
    key: "credentials",
    group: "secret",
    label: "统一凭据库",
    desc: ".credentials.yaml：各 provider 的 API Key 与 OAuth 记录",
    kind: "files",
    secrets: true,
    files: [".credentials.yaml"],
  },
  {
    key: "openai-gateway",
    group: "secret",
    label: "本地网关 API Key",
    desc: "openai-gateway 的访问密钥",
    kind: "files",
    secrets: true,
    files: ["openai-gateway/api-key"],
  },
];

/**
 * Paths that are always excluded, with the reason shown in the panel.
 *
 * Kept as data rather than prose so the report can state, per backup, what was
 * left out and why — a bundle that silently lacks half the state is worse than
 * one that says so.
 */
const EXCLUDED = [
  { match: "profiles/<名称>/node_modules", reason: "可用 pnpm 重新安装，体积数百 MB" },
  { match: "sessions/", reason: "会话历史，不属于配置" },
  { match: "rewind-snapshots/", reason: "回滚快照，属于历史记录" },
  { match: "attachments/", reason: "对话附件" },
  { match: "cache/", reason: "缓存，可重建" },
  { match: "dsh-runtimes/", reason: "运行时依赖，由应用自带" },
  { match: "state/codex-subscription/", reason: "登录态缓存与诊断日志" },
  { match: "storages/session_projcache/", reason: "每个会话的项目缓存" },
  { match: "integrations/dsh-im/group-history.sqlite", reason: "群消息历史" },
  { match: "integrations/dsh-im/group-files/", reason: "群文件" },
  { match: "profiles/<名称>/.plugin-manager/logs/", reason: "pnpm 操作日志" },
  { match: "profiles/.dsh-recovery/", reason: "恢复器自己的检查点" },
  { match: "dsh-recovery.config.json", reason: "恢复器本机设置，换机后应重新指定" },
];

/** Home-relative paths that carry credentials. Never restored from a "no secrets" bundle. */
const SECRET_ENTRIES = [".credentials.yaml", ".dsh-connect-huawei/accounts.json", "workbuddy-vault", "openai-gateway/api-key"];

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function safeSegment(value) {
  return String(value).replace(/[^A-Za-z0-9._@+-]/gu, "_");
}

/** Absolute path of one profile file inside the Harness home. */
function profileFilePath(home, profileName, name) {
  return path.join(home, "profiles", profileName, ...String(name).split("/"));
}

/** Walking a tree without following junctions: a linked folder is one entry. */
function walkTree(root, options = {}) {
  const skip = options.skip ?? (() => false);
  const files = [];
  const stack = [{ dir: root, prefix: "" }];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absolute = path.join(current.dir, entry.name);
      const relative = current.prefix === "" ? entry.name : `${current.prefix}/${entry.name}`;
      if (skip(relative, absolute)) continue;
      if (entry.isSymbolicLink()) {
        // A junction is a pointer, not content: copy it as nothing rather than
        // walking into the target (which may be a whole other repository).
        continue;
      }
      if (entry.isDirectory()) stack.push({ dir: absolute, prefix: relative });
      else if (entry.isFile()) files.push({ relative, absolute, bytes: fileSizeOrZero(absolute) });
    }
  }
  files.sort((left, right) => left.relative.localeCompare(right.relative, "en"));
  return files;
}

/** Skill folders: one directory per skill, each with a SKILL.md. */
function scanSkillRoot(root) {
  if (!isDirectory(root)) return [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const dir = path.join(root, entry.name);
    const main = ["SKILL.md", "skill.md", "README.md"].map((name) => path.join(dir, name)).find((file) => isFile(file));
    if (main === undefined) continue;
    const files = walkTree(dir);
    const front = readFrontmatter(main);
    skills.push({
      name: entry.name,
      dir,
      main,
      mainName: path.basename(main),
      bytes: files.reduce((sum, file) => sum + file.bytes, 0),
      fileCount: files.length,
      summary: front.summary,
      displayName: front.displayName,
      version: front.version,
    });
  }
  skills.sort((left, right) => left.name.localeCompare(right.name, "en"));
  return skills;
}

/** The small YAML header a SKILL.md starts with, read without a YAML parser. */
function readFrontmatter(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return {};
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(text);
  if (match === null) return {};
  const field = (name) => {
    const line = new RegExp(`^${name}\\s*:\\s*(.+)$`, "mu").exec(match[1]);
    if (line === null) return undefined;
    return line[1].replace(/^["']|["']$/gu, "").trim() || undefined;
  };
  return { displayName: field("displayName") ?? field("name"), summary: field("summary") ?? field("description"), version: field("version") };
}

/** Where a local (linked) plugin's source actually lives, plus its git origin. */
function describeLocalPlugin(profileDir, name, spec) {
  let target;
  if (/^link:/iu.test(spec)) target = spec.slice(5);
  else if (/^file:/iu.test(spec)) target = spec.slice(5);
  else {
    const installed = path.join(profileDir, "node_modules", ...String(name).split("/"));
    try {
      if (fs.lstatSync(installed).isSymbolicLink()) target = fs.readlinkSync(installed);
    } catch {}
  }
  if (typeof target !== "string" || target === "") return { name, spec };
  const dir = path.resolve(profileDir, target);
  const git = readGitOrigin(dir);
  return { name, spec, path: dir, exists: isDirectory(dir), ...git };
}

function readGitOrigin(dir) {
  const head = path.join(dir, ".git", "HEAD");
  const config = path.join(dir, ".git", "config");
  if (!isFile(head)) return {};
  let commit;
  try {
    const text = fs.readFileSync(head, "utf8").trim();
    if (!text.startsWith("ref: ")) commit = text;
    else {
      const ref = path.join(dir, ".git", text.slice(5));
      if (isFile(ref)) commit = fs.readFileSync(ref, "utf8").trim();
    }
  } catch {}
  let remote;
  try {
    const text = fs.readFileSync(config, "utf8");
    // Read `url` from the [remote "origin"] section only. `[^\[]*?` stops at the
    // next section header; a bare `url = …` in another section must not win.
    const section = /\[remote "origin"\]([\s\S]*?)(?=\n\[|$)/u.exec(text);
    remote = section === null ? undefined : /^\s*url\s*=\s*(.+)$/mu.exec(section[1])?.[1]?.trim();
  } catch {}
  // Uncommitted changes are NOT guessed here: `.git/index` timestamps do not
  // prove anything, and a wrong "有未提交修改" would send the user hunting for
  // a problem that does not exist. The restore path re-clones from `remote` at
  // `commit`, which is exact.
  return { remote, commit };
}

// ---------------------------------------------------------------------------
// Collect
// ---------------------------------------------------------------------------

/**
 * Everything a backup would contain, as data. Read-only: nothing is written.
 *
 * `includeSecrets` gates the `secret` group; everything else is always read so
 * the panel can show the full picture and the size estimate before anything is
 * decided.
 */
function collect(home, options = {}) {
  const includeSecrets = options.includeSecrets === true;
  const profileName = typeof options.profileName === "string" && options.profileName !== "" ? options.profileName : "desktop";
  const profileDir = path.join(home, "profiles", profileName);
  const manifest = readJson(path.join(profileDir, "package.json"));
  const manifestValue = manifest.ok && manifest.value !== null && typeof manifest.value === "object" ? manifest.value : {};
  const dependencies = manifestValue.dependencies !== null && typeof manifestValue.dependencies === "object" ? manifestValue.dependencies : {};
  const bundles = Array.isArray(manifestValue.dsh?.profile?.bundles) ? manifestValue.dsh.profile.bundles : [];

  const groups = [];
  for (const entry of HOME_ENTRIES) {
    if (entry.secrets === true && !includeSecrets) {
      groups.push({ ...describeEntry(home, profileName, entry), included: false, reason: "凭据未勾选" });
      continue;
    }
    groups.push(describeEntry(home, profileName, entry));
  }

  const plugins = Object.entries(dependencies).map(([name, spec]) => {
    const local = /^(?:link|file):/iu.test(String(spec));
    const row = { name, spec: String(spec), local };
    if (local) Object.assign(row, describeLocalPlugin(profileDir, name, String(spec)));
    return row;
  });

  const roots = skillRoots({ base: home, agentsBase: options.agentsBase });
  const skillRootRows = [
    { key: "dsh", label: "DSH 技能", dir: roots.dsh, mutable: true },
    { key: "agents", label: "公共 Agent 技能", dir: roots.agents, mutable: true },
  ].map((root) => {
    const skills = scanSkillRoot(root.dir);
    return { key: root.key, label: root.label, dir: root.dir, exists: isDirectory(root.dir), skills };
  });

  const present = groups.filter((entry) => entry.included !== false && entry.files.length > 0);
  const bytes = present.reduce((sum, entry) => sum + entry.bytes, 0) + skillRootRows.reduce((sum, root) => sum + root.skills.reduce((inner, skill) => inner + skill.bytes, 0), 0);

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    home,
    profileName,
    profileDir,
    profileValid: manifest.ok,
    dependencies: Object.keys(dependencies).length,
    bundles: bundles.length,
    groups,
    plugins,
    registryPlugins: plugins.filter((plugin) => plugin.local !== true),
    localPlugins: plugins.filter((plugin) => plugin.local === true),
    skillRoots: skillRootRows,
    skillCount: skillRootRows.reduce((sum, root) => sum + root.skills.length, 0),
    includeSecrets,
    bytes,
    excluded: EXCLUDED,
    unsupported: unsupportedNotes(profileDir, dependencies),
  };
}

/** One entry of HOME_ENTRIES, with the files it would actually contribute. */
function describeEntry(home, profileName, entry) {
  const files = [];
  // Profile files are recorded under `profiles/<name>/…` so the archive keeps
  // the same shape as the home it came from; the restore step then re-targets
  // them at whichever profile is selected at restore time.
  const base = entry.key === "profile" || entry.inProfile === true ? path.join(home, "profiles", profileName) : home;
  const prefix = entry.key === "profile" ? `profiles/${profileName}/` : entry.inProfile === true ? `profiles/${profileName}/` : "";
  for (const relative of entry.files) {
    const absolute = path.join(base, ...relative.split("/"));
    if (entry.kind === "tree") {
      if (!isDirectory(absolute)) continue;
      for (const file of walkTree(absolute)) {
        files.push({ relative: `${prefix}${relative}/${file.relative}`, absolute: file.absolute, bytes: file.bytes });
      }
      continue;
    }
    if (!isFile(absolute)) continue;
    files.push({ relative: `${prefix}${relative}`, absolute, bytes: fileSizeOrZero(absolute) });
  }
  return {
    key: entry.key,
    group: entry.group,
    label: entry.label,
    desc: entry.desc,
    kind: entry.kind,
    secrets: entry.secrets === true,
    required: entry.required === true,
    included: true,
    files,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
  };
}

/** Config that lives somewhere this bundle cannot reach, stated rather than hidden. */
function unsupportedNotes(profileDir, dependencies) {
  const notes = [];
  const linked = Object.entries(dependencies).filter(([, spec]) => /^(?:link|file):/iu.test(String(spec)));
  if (linked.length > 0) {
    notes.push(
      `${linked.length} 个本地插件（${linked.map(([name]) => name).join("、")}）只记录路径与 git 提交，源码不在备份里。` +
        "恢复时按 remote 重新 clone；没有 remote 的目录需要你自己拷过去。",
    );
  }
  if (isDirectory(path.join(profileDir, "node_modules"))) {
    notes.push("node_modules 不进备份：联网插件按清单重新安装，本地插件靠重新 link。");
  }
  return notes;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Build the backup archive.
 *
 * The layout is a JSON manifest plus `files/…` blobs, so an unzip with any tool
 * shows what is inside and a corrupted manifest never hides the payload.
 */
function buildArchive(home, options = {}) {
  const collected = options.preview === true ? collect(home, options) : collect(home, options);
  const createdAt = new Date().toISOString();
  const entries = [];
  const manifestFiles = [];

  for (const group of collected.groups) {
    if (group.included === false) continue;
    for (const file of group.files) {
      if (file.bytes > MAX_ENTRY_BYTES) {
        manifestFiles.push({ group: group.key, source: file.relative, skipped: `超过单文件上限 ${formatBytes(MAX_ENTRY_BYTES)}` });
        continue;
      }
      let data;
      try {
        data = fs.readFileSync(file.absolute);
      } catch (error) {
        manifestFiles.push({ group: group.key, source: file.relative, skipped: `读取失败: ${error.code ?? String(error)}` });
        continue;
      }
      const name = `files/home/${file.relative}`;
      entries.push({ name, data });
      manifestFiles.push({ group: group.key, source: file.relative, entry: name, bytes: data.length, sha256: sha256(data) });
    }
  }

  const manifestSkills = [];
  for (const root of collected.skillRoots) {
    for (const skill of root.skills) {
      const files = walkTree(skill.dir);
      let bytes = 0;
      for (const file of files) {
        if (file.bytes > MAX_ENTRY_BYTES) continue;
        let data;
        try {
          data = fs.readFileSync(file.absolute);
        } catch {
          continue;
        }
        const name = `files/skills/${root.key}/${skill.name}/${file.relative}`;
        entries.push({ name, data });
        bytes += data.length;
      }
      manifestSkills.push({
        root: root.key,
        name: skill.name,
        main: skill.mainName,
        fileCount: files.length,
        bytes,
        displayName: skill.displayName,
        summary: skill.summary,
        version: skill.version,
      });
    }
  }

  const manifest = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt,
    source: {
      platform: `${process.platform} ${process.arch}`,
      home: collected.home,
      profileName: collected.profileName,
      hostname: os.hostname(),
      dshVersion: options.dshVersion,
      consoleVersion: options.consoleVersion,
    },
    includesSecrets: collected.includeSecrets,
    profile: {
      name: collected.profileName,
      dependencies: collected.dependencies,
      bundles: collected.bundles,
    },
    registryPlugins: collected.registryPlugins.map((plugin) => ({ name: plugin.name, spec: plugin.spec })),
    localPlugins: collected.localPlugins.map((plugin) => ({
      name: plugin.name,
      spec: plugin.spec,
      path: plugin.path,
      exists: plugin.exists === true,
      remote: plugin.remote,
      commit: plugin.commit,
    })),
    skills: manifestSkills,
    files: manifestFiles,
    excluded: collected.excluded,
    notes: collected.unsupported,
  };

  entries.unshift({ name: MANIFEST_NAME, data: `${JSON.stringify(manifest, undefined, 2)}\n` });
  entries.push({ name: "README.txt", data: readmeText(manifest) });

  const archive = createZip(entries);
  if (archive.length > MAX_ARCHIVE_BYTES) throw new Error(`备份包 ${formatBytes(archive.length)} 超过上限 ${formatBytes(MAX_ARCHIVE_BYTES)}`);
  return { archive, manifest, entryCount: entries.length };
}

function readmeText(manifest) {
  return [
    "DSH 环境备份",
    `生成时间: ${manifest.createdAt}`,
    `来源: ${manifest.source.home} · Profile ${manifest.source.profileName}`,
    "",
    "包含内容：",
    "  manifest.json        本包的完整清单（插件、技能、每个文件的哈希）",
    "  files/home/…          Profile 清单、补丁层、各插件设置等原始文件",
    "  files/skills/…        ~/.dsh/skills 与 ~/.agents/skills 下的技能目录",
    "",
    manifest.includesSecrets
      ? "⚠ 本包包含凭据（.credentials.yaml、登录令牌、accessKey）。它等同于账号密码，请勿分享或上传到公开位置。"
      : "本包不含任何凭据：恢复后需要重新登录各账号。",
    "",
    "不包含：node_modules（可用 pnpm 重新安装）、会话历史、回滚快照、附件、缓存。",
    "本地插件只记录路径与 git 提交，源码不在本包内。",
    "",
    "恢复方式：DSH 恢复器 → 环境备份 → 从此文件恢复。",
  ].join("\r\n");
}

/** Write a backup into the console's own directory and return its path. */
function exportBackup(home, options = {}) {
  const dir = backupsDir();
  ensureDir(dir);
  const { archive, manifest, entryCount } = buildArchive(home, options);
  const file = uniquePath(path.join(dir, `dsh-backup-${timestampId()}-${safeSegment(manifest.source.profileName)}.zip`));
  writeFileAtomic(file, archive);
  return { file, bytes: fs.statSync(file).size, entryCount, manifest };
}

function backupsDir() {
  return path.join(__dirname, "..", "..", "backups");
}

function listBackups() {
  const dir = backupsDir();
  if (!isDirectory(dir)) return [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const rows = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".zip")) continue;
    const file = path.join(dir, entry.name);
    const stat = fs.statSync(file);
    let summary;
    try {
      summary = peekBackup(file);
    } catch (error) {
      summary = { error: error instanceof Error ? error.message : String(error) };
    }
    rows.push({
      name: entry.name,
      file,
      bytes: stat.size,
      modifiedAt: new Date(stat.mtimeMs).toISOString(),
      createdAt: summary.createdAt,
      profileName: summary.profileName,
      includesSecrets: summary.includesSecrets === true,
      pluginCount: summary.pluginCount,
      skillCount: summary.skillCount,
      error: summary.error,
    });
  }
  rows.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt, "en"));
  return rows;
}

/** Read only the manifest of a backup file, for listing and pre-restore review. */
function peekBackup(file) {
  const stat = fs.statSync(file);
  if (stat.size > MAX_ARCHIVE_BYTES) throw new Error(`备份文件 ${formatBytes(stat.size)} 超过上限`);
  const entries = readZip(fs.readFileSync(file));
  const raw = entries.get(MANIFEST_NAME);
  if (raw === undefined) throw new Error("备份文件里没有 manifest.json，可能不是恢复器生成的备份");
  let manifest;
  try {
    manifest = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    throw new Error(`manifest.json 无法解析: ${error.message}`);
  }
  if (manifest?.format !== BACKUP_FORMAT) throw new Error(`不是 DSH 环境备份（format=${manifest?.format ?? "?"}）`);
  if (Number(manifest.version) > BACKUP_VERSION) throw new Error(`备份格式版本 ${manifest.version} 比本恢复器支持的 ${BACKUP_VERSION} 新，请升级恢复器`);
  return {
    manifest,
    entries,
    createdAt: manifest.createdAt,
    profileName: manifest.source?.profileName,
    includesSecrets: manifest.includesSecrets === true,
    pluginCount: (manifest.registryPlugins?.length ?? 0) + (manifest.localPlugins?.length ?? 0),
    skillCount: manifest.skills?.length ?? 0,
    fileCount: entries.size,
  };
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

/**
 * Plan a restore against the current home, without writing anything.
 *
 * Every planned action names what it would do to an existing file, so the panel
 * can show "覆盖 3 / 新增 2 / 相同 5" before the user commits. A backup is also
 * checked for foreign paths: an entry whose name escapes its root is dropped
 * with a warning rather than written.
 */
function planRestore(home, file, options = {}) {
  const peeked = peekBackup(file);
  const manifest = peeked.manifest;
  const profileName = typeof options.profileName === "string" && options.profileName !== "" ? options.profileName : manifest.source?.profileName ?? "desktop";
  const warnings = [];
  const actions = [];

  for (const row of manifest.files ?? []) {
    if (typeof row.entry !== "string") {
      warnings.push(`${row.source ?? "?"}: ${row.skipped ?? "备份时已跳过"}`);
      continue;
    }
    const relative = normaliseEntry(row.entry);
    if (relative === undefined) {
      warnings.push(`${row.entry}: 不在已知位置内（可能试图写到数据目录之外），已忽略`);
      continue;
    }
    const target = targetForEntry(home, profileName, relative);
    if (target === undefined) {
      warnings.push(`${row.entry}: 不认识的位置，已忽略`);
      continue;
    }
    const buffer = peeked.entries.get(row.entry);
    if (buffer === undefined) {
      warnings.push(`${row.entry}: 备份里缺少这个文件的数据`);
      continue;
    }
    if (typeof row.sha256 === "string" && sha256(buffer) !== row.sha256) {
      warnings.push(`${row.entry}: 内容哈希与清单不符，已跳过`);
      continue;
    }
    // A bundle that declares "no credentials" but carries them is either
    // hand-edited or produced by something else. Restoring a credential the
    // user believes they excluded is the one failure mode worth refusing.
    const secretEntry = SECRET_ENTRIES.some((prefix) => relative === prefix || relative.startsWith(`${prefix}/`));
    if (secretEntry && peeked.includesSecrets !== true) {
      warnings.push(`${row.entry}: 这是凭据文件，但备份声明不含凭据，已跳过`);
      continue;
    }
    actions.push({
      kind: "file",
      source: row.entry,
      target,
      bytes: buffer.length,
      state: compareExisting(target, buffer),
      group: row.group,
      secret: secretEntry,
    });
  }

  const roots = skillRoots({ base: home, agentsBase: options.agentsBase });
  for (const skill of manifest.skills ?? []) {
    const dir = roots[skill.root];
    if (dir === undefined) {
      warnings.push(`技能 ${skill.name}: 未知的技能根 ${skill.root}`);
      continue;
    }
    const target = path.join(dir, safeSegment(skill.name));
    const prefix = `files/skills/${skill.root}/${skill.name}/`;
    const files = [...peeked.entries.entries()].filter(([name]) => name.startsWith(prefix));
    if (files.length === 0) {
      warnings.push(`技能 ${skill.name}: 备份里没有它的文件`);
      continue;
    }
    actions.push({
      kind: "skill",
      source: `files/skills/${skill.root}/${skill.name}`,
      target,
      bytes: files.reduce((sum, [, buffer]) => sum + buffer.length, 0),
      files: files.map(([name, buffer]) => ({ relative: name.slice(prefix.length), data: buffer })),
      state: isDirectory(target) ? "exists" : "new",
      label: skill.displayName ?? skill.name,
    });
  }

  const localPlugins = (manifest.localPlugins ?? []).map((plugin) => ({
    ...plugin,
    present: typeof plugin.path === "string" && isDirectory(plugin.path),
    cloneable: typeof plugin.remote === "string" && plugin.remote !== "",
  }));

  const secrets = peeked.includesSecrets;

  return {
    file,
    manifest,
    profileName,
    actions,
    localPlugins,
    includesSecrets: secrets,
    warnings,
    counts: {
      overwrite: actions.filter((action) => action.state === "different").length,
      same: actions.filter((action) => action.state === "same").length,
      create: actions.filter((action) => action.state === "new").length,
      skills: actions.filter((action) => action.kind === "skill").length,
    },
    registryPlugins: manifest.registryPlugins ?? [],
    skillCount: (manifest.skills ?? []).length,
    notes: manifest.notes ?? [],
    excluded: manifest.excluded ?? EXCLUDED,
  };
}

/** `files/home/...` → the home-relative path it came from; undefined when unknown. */
function normaliseEntry(entry) {
  const name = String(entry).replace(/\\/gu, "/");
  if (!name.startsWith("files/home/")) return undefined;
  const relative = name.slice("files/home/".length);
  if (relative === "" || relative.split("/").includes("..")) return undefined;
  return relative;
}

/**
 * Where a home-relative backup entry belongs now.
 *
 * Profile files land in the *currently selected* profile rather than the one the
 * backup came from: restoring a `desktop` backup into a fresh install makes no
 * sense if it recreates a profile the user is not running. Only the five files a
 * profile actually owns are accepted, so an entry cannot smuggle anything into
 * `node_modules` or outside the profile. Everything else keeps its
 * home-relative position.
 */
const PROFILE_OWNED_PATHS = new Set([
  "package.json",
  "cordis.patch.yml",
  "cordis.yml",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  ".dsh-market/state.json",
]);

function targetForEntry(home, profileName, relative) {
  const parts = relative.split("/");
  if (parts.includes("..")) return undefined;
  if (parts[0] === "profiles") {
    if (parts.length < 3) return undefined;
    const inside = parts.slice(2).join("/");
    if (!PROFILE_OWNED_PATHS.has(inside)) return undefined;
    return path.join(home, "profiles", profileName, ...inside.split("/"));
  }
  return path.join(home, ...parts);
}

function compareExisting(target, buffer) {
  if (!isFile(target)) return "new";
  try {
    return sha256(fs.readFileSync(target)) === sha256(buffer) ? "same" : "different";
  } catch {
    return "different";
  }
}

/**
 * Apply a restore plan.
 *
 * Order matters: skills and ordinary config are written first, the Profile
 * manifest last, because that file is what makes the next launch try to load
 * the plugins. A profile is snapshotted (by the caller) before this runs, so the
 * whole restore is reversible through 回滚.
 */
function applyRestore(plan, options = {}) {
  const home = options.home;
  const peeked = peekBackup(plan.file);
  const written = [];
  const skipped = [];
  const profileName = plan.profileName;

  const fileActions = plan.actions.filter((action) => action.kind === "file");
  const manifestAction = fileActions.find((action) => action.target === path.join(home, "profiles", profileName, "package.json"));
  const others = fileActions.filter((action) => action !== manifestAction);

  for (const action of [...others, ...(manifestAction === undefined ? [] : [manifestAction])]) {
    const buffer = action.source === undefined ? undefined : peeked.entries.get(action.source);
    if (buffer === undefined) {
      skipped.push({ target: action.target, reason: "备份里缺少数据" });
      continue;
    }
    ensureDir(path.dirname(action.target));
    writeFileAtomic(action.target, buffer);
    written.push({ target: action.target, bytes: buffer.length, group: action.group });
  }

  for (const action of plan.actions.filter((entry) => entry.kind === "skill")) {
    for (const file of action.files) {
      const target = path.join(action.target, ...file.relative.split("/"));
      ensureDir(path.dirname(target));
      writeFileAtomic(target, file.data);
    }
    written.push({ target: action.target, bytes: action.bytes, group: "skill" });
  }

  return { written, skipped, profileName };
}

// ---------------------------------------------------------------------------
// Local plugin recovery
// ---------------------------------------------------------------------------

/**
 * Bring local (`link:`) plugins back.
 *
 * A linked plugin is not a package to install — it is a folder somewhere on
 * disk that the profile points at. Three cases, in order:
 *
 *   present  the folder is already there (same machine, or restored by hand);
 *   clone    the backup recorded a git remote, so it is cloned to the original
 *            path and checked out at the recorded commit;
 *   manual   neither: the folder must be supplied by the user, and the panel
 *            says which path to put it at.
 */
function restoreLocalPlugins(plugins, options = {}) {
  const results = [];
  for (const plugin of plugins ?? []) {
    if (typeof plugin.path !== "string" || plugin.path === "") {
      results.push({ name: plugin.name, state: "manual", message: "备份里没有记录路径" });
      continue;
    }
    if (isDirectory(plugin.path)) {
      results.push({ name: plugin.name, state: "present", path: plugin.path, message: "目录已存在" });
      continue;
    }
    if (typeof plugin.remote !== "string" || plugin.remote === "") {
      results.push({ name: plugin.name, state: "manual", path: plugin.path, message: "没有 git remote，需要手动放置源码" });
      continue;
    }
    if (options.clone !== true) {
      results.push({ name: plugin.name, state: "ready", path: plugin.path, remote: plugin.remote, commit: plugin.commit, message: `可 clone ${plugin.remote}` });
      continue;
    }
    try {
      ensureDir(path.dirname(plugin.path));
      git(["clone", plugin.remote, plugin.path]);
      if (typeof plugin.commit === "string" && plugin.commit !== "") {
        try {
          git(["-C", plugin.path, "checkout", "--detach", plugin.commit]);
        } catch {}
      }
      results.push({ name: plugin.name, state: "cloned", path: plugin.path, remote: plugin.remote, message: `已 clone 到 ${plugin.path}` });
    } catch (error) {
      results.push({ name: plugin.name, state: "failed", path: plugin.path, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

function git(args) {
  const { spawnSync } = require("node:child_process");
  const result = spawnSync("git", args, { encoding: "utf8", windowsHide: true, timeout: 120000 });
  if (result.error !== undefined) throw new Error(`无法运行 git：${result.error.message}`);
  if (result.status !== 0) throw new Error(`${(result.stderr ?? "").trim() || `git ${args[0]} 退出码 ${result.status}`}`);
  return result.stdout;
}

module.exports = {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  EXCLUDED,
  HOME_ENTRIES,
  SKILL_ROOTS,
  applyRestore,
  backupsDir,
  buildArchive,
  collect,
  exportBackup,
  listBackups,
  peekBackup,
  planRestore,
  restoreLocalPlugins,
  scanSkillRoot,
};
