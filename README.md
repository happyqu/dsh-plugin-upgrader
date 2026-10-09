# @happyqu/dsh-plugin-upgrader

一个 DSH 插件：**列出你装的所有第三方插件，检查哪些有新版本，并一键（或批量）升级。**

DSH 官方**不提供**这个能力——官方只管「装/卸/启用/禁用」。
`pluginManager.inspect()` 对已安装的包直接以 `already-installed` 拒绝，
所以运行时不回答「有没有新版」。这个插件补的就是这块。

## 安装

**推荐**：用官方 Plugins 页的「添加插件」填包名 `@happyqu/dsh-plugin-upgrader`，装完重启 DSH。

命令行也可以（**`--profile` 是必须的** —— `dsh plugin` 只是把参数转发给该 profile 目录里的 pnpm）：

```bash
dsh plugin --profile web add @happyqu/dsh-plugin-upgrader
dsh --profile web --dump-config   # 确认插件行已进入配置树
# 重启 dsh web
```

包自带 `cordis.patch.yml`，以 `insert` 方式追加插件行。本地开发可从插件目录运行 `dsh plugin --profile web add .`。

> **Desktop 应用的 `desktop` profile 由 Electron 进程独占**，CLI 会明确拒绝
> （`profile "desktop" is managed exclusively by the Electron application`）——
> `add` 和 `--dump-config` 都一样。用 Desktop 的话请走上面的 Plugins 页面。

**装完要重启 DSH** —— 原因见下面「升级后必须重启」一节，跟升级是同一个语义。

---

## 它解决什么

你装了一堆第三方插件，但：

- **不知道哪些有更新** → 打开「升级中心」，一屏列出所有第三方插件及其状态，点「检查更新」即知。
- **不想一个个手配** → **零配置**。自动发现当前 profile 里的第三方插件，不用维护白名单。
- **升级很麻烦** → **一键升级**；有多个可升级时，**全部升级**会依次升完。
- **升级到底生效没** → 明写「**已更新，重启后生效**」。

---

## 界面在哪

| 位置 | 内容 |
|---|---|
| **设置 → Plugins → 升级中心**（我们自己的 tab） | 插件列表 + 「检查更新」+ 每行「升级到 x.y.z」+「全部升级」 |
| **某个插件的详情页 → 标题旁** | 标签：`可升级 0.1.3 → 0.1.4` / `已是最新` / `本地依赖` |
| **某个插件的详情页 → 正文下方** | 当前版本 / 最新版本 / 依赖形态 / 升级按钮 |

> 注意：升级中心在**设置面板**里的 Plugins 分区，**不是**侧栏那个独立的 Plugins 面板。

---

## 检查更新是手动的（打开页面不发请求）

**打开升级中心只会读本地文件**，列出「装了哪些插件」，状态一律是 **未检查**。
这**不会发任何网络请求**。

要查更新，点按钮：

- **「检查更新」**（页面顶部）→ 逐个插件查询，**每个插件一次网络调用**（registry 包走 `pnpm view`，git 依赖走 `git ls-remote`）。
- **某一行右边的「检查」** → **只查这一个插件**，一次调用。有十几个插件时推荐这个。

结果缓存 6 小时，所以重复看同一个插件不会反复联网。这个设计是刻意的：
如果你装了 20 个插件，「打开页面 = 20 次网络查询」会很慢，所以**代价由你的点击决定**。

---

## 怎么用

```

1. 打开「设置 → Plugins → 升级中心」
2. 看到插件列表，全部是「未检查」
3. 点「检查更新」（全部查），或点某一行的「检查」（只查这个）
4. 列表变成：
     ● 可升级   @someone/plugin-a   0.1.3 → 0.1.4
     ● 已是最新 @someone/plugin-b   2.0.0
     ● 本地依赖 my-local-plugin    link: 本地目录
5. 点「升级到 0.1.4」，或点「全部升级」
6. 看到「已更新，重启后生效」→ 重启 DSH
```

---

## 三种依赖形态，三种处理（这是最容易做错的地方）

profile 的 `package.json` 里，依赖有四种形态，**「最新版本」的含义完全不同**：

| 形态 | 例子 | 检查方式 | 升级时实际装什么 |
|---|---|---|---|
| `registry` | `^0.1.3` | 问注册表最新版，做 semver 比较 | `名字@新版本` |
| `git` | `https://…/repo.git` | lockfile 里的 commit ↔ 远端 HEAD | **不带 pin 的仓库 URL**（让 pnpm 重新解析 HEAD） |
| `link` | `link:D:/my/plugin` | **没有远端，问不出来** | ❌ 不升，标注「本地依赖，自行管理」 |
| `file` | `file:../x.tgz` | 同上 | ❌ 同上 |

对 `link:` 依赖跑 `pnpm view` 毫无意义；对 git 依赖问 npm 版本号也不对。
所以插件**先判定形态，再决定用哪条路径** —— 而且这个判断**只在 Host 半发生一次**，
浏览器那一侧只负责显示，不参与形态判断。

### git 依赖升级会被 `allowBuilds` 拦住（需要授权构建脚本）

升级 git 依赖时，pnpm 可能报：

```
[ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED] The git-hosted package "…" needs to execute
build scripts but is not in the "allowBuilds" allowlist.
```

**这不是插件的问题，是 pnpm 的安全门禁**：git 包要跑构建脚本必须显式授权。pnpm 还会把
该写的 key 直接给你。**关键：这个 key 必须带上解析出的 commit**：

```yaml
# ✅ 有效 —— 钉住精确 commit
allowBuilds:
  some-pkg@git+https://host/repo.git#0123456789abcdef0123456789abcdef01234567: true

# ❌ 无效 —— 少了 commit，pnpm 依然拒绝
allowBuilds:
  some-pkg@git+https://host/repo.git: true
```

**为什么必须钉 commit**：pnpm 对 git 依赖的匹配是**精确集合成员判断**
（`createAllowBuildFunction` 里 `allowedDepPathBuilds.has(depPath)`），
而 git 依赖的 `depPath` 带 resolved commit。而且 git 版本属于 `nonSemverVersion`，
会让 `trustPackageIdentity` 为假，所以**按包名匹配那条分支根本不会走到**——
写裸包名也没用。

**代价**：远端每前进一个 commit，就要改一次这一行。这是 pnpm 的有意设计
（授权「某次提交」而不是「某仓库永久」）。

> 实测口径：每个候选写法都在**独立 pnpm store** 里跑真实 `pnpm add` 才可信。
> 共用 store 会得出错误结论 —— 一旦某次构建成功，pnpm 把副作用记在 store 里，
> 之后同样的安装会**跳过构建**，也就跳过了 `allowBuilds` 检查，于是看起来「裸包名也行」。
> 复现脚本：`node scripts/probe-allowbuilds-isolated.mjs`

---

## 配置

配置写在 profile 的 `cordis.patch.yml` 里（**当前需要手改**，页面表单尚未做）：

```yaml
- id: plugin-upgrader
  config:
    checkTtlMs: 21600000        # 检查结果缓存多久（默认 6 小时）
    concurrency: 3              # 同时最多几个注册表查询
    ignored:                    # 不想看到 / 不想升的
      - some-plugin             # 忽略整个插件
      - other-plugin@1.2.3      # 只忽略这个版本
```

字段会被校验（非法值会让插件拒绝启动并报出原因），不写则用默认值。

**默认零配置**：不写 `ignored` 就自动管理全部第三方插件。

> 说明：插件已经带了一份配置 schema，但**在官方 Plugins 页里出现可编辑表单**
> 还需要另外注册 `plugins.bundle.config` 插槽（官方文档要求）。那是 P4 的工作；
> 现在请直接改 YAML。

---

## 重要：升级后必须重启

**这不是偷懒，是 DSH 的结构决定的。**

升级走的官方通路是 `pluginManager.installBundle(spec)`。
它的实现里有一行：

```js
if (Object.hasOwn(before, name)) return "restart-required"
```

`before` 是安装**前**的依赖快照。升级的包**本来就在里面**，所以升级**必然**走到
`restart-required`，**不会**热重载。

也就是说：**磁盘上的文件被换成新版了，但正在运行的代码还是旧版。**
下次启动才会加载新代码。官方自己的文档也这么写：

> *"installed plugins do not update automatically: upgrading means uninstalling and installing the new version."*

所以「升级成功」和「已生效」在本插件里是**两个不同的状态**。

---

## 安全边界

- **不做后台自动升级。** 官方 `plugin_manager` 工具每次调用前强制走
  `approveEscalation(danger-full-access)`；直接调服务层**不经过**这道检查。
  自动升级等于在无审批的情况下改写全局 profile、并自动接受上游发布的任意代码。
  所以升级**必须由你点击**。
- **不改官方层。** `dsh-base`、`dsh-web-app` 等由 DSH 安装自带，
  `listBundles()` 会给出 `readOnlyReason`，插件自动排除。
- **不升自己。** 正在运行的升级器去替换自己的代码，没有好处。
- **只读检查。** 除了你点的那次升级，插件只发注册表查询，不改任何东西。

---

## 开发

```bash
npm test           # 四套离线测试：逻辑 + Cordis 激活 + Cordis 端到端 + 客户端渲染
npm run test:pack  # 打 tarball 装进隔离 profile，验证真的能加载（发布前必跑）
npm run test:live  # 对着本机真实 profile 跑发现与注册表查询（找不到 profile 时自动跳过）
```

其它诊断脚本（都不联网改你的 profile）：

```bash
node scripts/diagnose-real-upgrade.mjs    # 用真 Cordis 挂载插件，对着 profile 的副本跑全流程
node scripts/probe-allowbuilds-isolated.mjs  # 逐个候选写法测 allowBuilds（每个独立 store）
```

`npm publish` 时 `prepublishOnly` 会自动跑 `npm test && npm run test:pack`。

**包名重命名时的坑**：包名出现在**四个**承重位置，其中三个**错了不会报错、只会静默失效**：

| 位置 | 错了会怎样 |
|---|---|
| `package.json` 的 `name` | 正常报错 |
| `lib/client.js` 的 `register id` | **静默失效**：bundle 永远挂不上 |
| `lib/index.js` 的 `SELF_NAME` | **静默失效**：插件会把自己列为可升级目标 |
| `cordis.patch.yml` 的 `name` | **静默失效**：加载时解析不到 |

所以 `verify-all.mjs` 有一组专门的断言锁死这四处一致（含 `lib/client.js` 的 id 与包名相等）。

测试刻意覆盖了容易出错的地方：

- semver 的 **prerelease** 比较（本机到处是 `-rc.N`，`0.2.0-rc.2 < 0.2.0-rc.10 < 0.2.0`）
- **依赖形态**识别（四种形态各一条）
- **lockfile 解析**（git commit 就在里面）
- **自动发现**（官方层必须被排除）
- 缓存的 TTL / 并发上限 / 请求去重 / **失败不污染上次成功结果**
- **终态归一**（`restart-required` 必须是独立状态）
- **配置必须是 Standard Schema**（含负向对照：普通对象必须被 Cordis 拒绝）
- 真实 **Cordis Context** 加载、真服务注入、真 RPC 调用

### 已知开发摩擦：Host 半改完要重启

把插件装进运行中的 profile 后，**改动 Host 半的代码再 toggle 启用，运行时报的仍是旧代码的错误**
——宿主不会重新 import 模块（实测：在模块顶层加写文件探针，toggle 后探针从未触发）。
Client 半有 HMR，Host 半没有。这是 DSH 的既有行为，也正好是
「升级必须重启」这条语义的另一面。

---

## 文件结构

```
lib/
  index.js      Host 入口：apply(ctx, config)、服务装配、RPC 端点
  config.js     手写 Standard Schema（零依赖，替代 schemastery）
  discover.js   自动发现：listBundles() → 筛出第三方插件
  shapes.js     依赖形态识别 + profile/lockfile 解析
  registry.js   版本查询（pnpm view / git ls-remote）
  semver.js     版本比较（含 prerelease）
  cache.js      TTL + 并发上限 + 去重 + 失败降级
  upgrade.js    installBundle 封装 + 进度事件归集 + 终态归一
  client.js     Client 半：升级中心页 + 详情页角标/区块
cordis.patch.yml  插入本插件那一行
scripts/          测试与诊断脚本（scripts/ 不进 npm 包）
```

发布内容由 `package.json` 的 `files` 决定：只有 `lib`、`cordis.patch.yml`、`README.md`、`LICENSE`。

---

## 依赖

**刻意零 `@deepseek-ai/dsh-*` peer 依赖。**
DSH 会检查每个插件声明的 peer 范围是否匹配当前运行时，不匹配就**整个 bundle 被跳过**。
一个「升级器」如果被版本门禁拦住就毫无意义，所以本插件不 import 任何 DSH 包，
所有事实都从**服务**（`pluginManager` / `profileContext`）和 Node 标准库拿。

唯一声明的是 `@deepseek-ai/cordis`（它不匹配 `dsh-*` 通配，不参与那道检查）。

---

## License

MIT
