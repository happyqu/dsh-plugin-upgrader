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
| `git` | `https://…/repo.git` | lockfile 里的 commit ↔ 远端 HEAD | **`名字@仓库地址#远端HEAD`**（名字**和** commit 都必须在） |
| `link` | `link:D:/my/plugin` | **没有远端，问不出来** | ❌ 不升，标注「本地依赖，自行管理」 |
| `file` | `file:../x.tgz` | 同上 | ❌ 同上 |

对 `link:` 依赖跑 `pnpm view` 毫无意义；对 git 依赖问 npm 版本号也不对。
所以插件**先判定形态，再决定用哪条路径** —— 而且这个判断**只在 Host 半发生一次**，
浏览器那一侧只负责显示，不参与形态判断。

### git 依赖的升级 spec：两个条件缺一不可

git 依赖的安装 spec 是 `名字@仓库地址#commit`。这三段**都是承重的**，而且
**少任何一段都会得到一个「看起来像成功」的失败**。两条都是对着真实 profile + pnpm 11.7.0
实测出来的，不是推测：

| 少了什么 | pnpm 的表现 | 你以为发生了什么 | 实际发生了什么 |
|---|---|---|---|
| **`名字@`** | **exit 0，一切正常** | 升级成功 | DSH 报 `ambiguous-install` → **「升级失败」**，且把 `package.json`/`pnpm-lock.yaml` **回滚** |
| **`#commit`** | exit 0，打印 `Already up to date` | 升级成功 | **什么都没动**，lockfile 仍是旧 commit |

**为什么 `名字@` 不能省**：`installBundle` 靠**对比 pnpm 前后 profile 的 `dependencies`**
来判断「这次装的是哪个包」。而 git 依赖重装后写回的是**同一个 URL**，所以这个 diff 是**空的**；
于是它退回去用 spec 去匹配**依赖名**（`spec === n || spec.startsWith(n + '@')`）。
裸 URL 匹配不上任何名字 → `installed.length === 0` → 抛 `ambiguous-install`。
**关键：这件事发生在 pnpm 已经退出 0 之后** —— 所以日志一片绿，结果却是「升级失败」。

**为什么 `#commit` 不能省**：pnpm 认为「不带 pin 的 git 地址」（以及 `#分支名`、`#HEAD`）
**已经被 lockfile 里那个 commit 满足了**。于是它打印 `Already up to date`、退出 0、
**根本不去重新解析分支**。也就是说：**重装裸 URL 只能升级第一次，之后永远静默空操作。**

> 实测（每个候选写法都在真实 profile 上跑过）：`名字@git+地址` 第一次能走通，
> 但第二次起 lockfile 不再移动；`名字@地址#master`、`#HEAD` 同样第二次起不动；
> **只有 `名字@地址#<具体commit>` 每次都真的移动。**

**钉 commit 不等于永久冻结**：插件**每次升级都重新读一次远端 HEAD**，然后把这个 pin 重写。
所以下一次仍然跟着走。钉的如果是 lockfile 里**已有的**那个 commit，才是空操作。

### 一个必须说明的取舍：跟踪分支的依赖

如果依赖写的是 `地址#分支名`（例如 `#develop`），插件**会按那个分支去查**
（`git ls-remote <url> develop`，不是 HEAD），然后**把该分支当前的 commit 钉进去**。

代价是：**升级之后，manifest 里记录的就是 commit，不再是分支名。**
这是 pnpm 的语义逼出来的，不是插件的选择。实测规律只有一条：

> **pnpm 只在「请求的 specifier 与 lockfile 里记的 specifier 不同」时才重新解析。**

于是所有「重发同一个字符串」的写法都会静默空操作：

| 写法 | 重复升级时会怎样 |
|---|---|
| `#分支名`（原样重发） | ❌ 静默空操作，lockfile 永远不动 |
| `#HEAD` | ❌ 同上 |
| **`#<具体commit>`** | ✅ **每次都动**（每次的 commit 都不同） |

（也测过「每次翻转 `git+` 前缀」这种让字符串持续变化的写法：**确实能每次都动**，
但它每升一次就把用户的 manifest 风格改写一次，属于钻空子，插件**不采用**。）

所以如果你**必须**让依赖一直跟着某个分支走（而不是某个提交），
请不要用本插件升它 —— 升级后请自己把 manifest 改回 `地址#分支名`。
这一点在 UI 上无法完全替你表达，所以写在这里。

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

**插件会帮你把这一行准备好**，不用自己去翻日志：遇到这个拒绝时，
升级结果会显示成 **「需要先授权构建脚本」**，并附带**一键复制**的 YAML ——
内容直接取自 pnpm 自己的输出，所以 commit 一定是对的。

> 这里**不会**自动替你写授权。授权等于允许那份远端代码在你机器上执行构建脚本，
> 属于安全决定，必须由你按下复制、自己粘进去。

**为什么不能用官方那个「允许这些脚本并重试」按钮**：那个流程依赖 pnpm 写入
`allowBuilds: <包名>: "set this to true or false"` 待决标记，而 **git 依赖走的是另一条路径**
（`preparePackage`），直接抛硬错误，**不写待决标记**。所以对 git 依赖，官方按钮无能为力 ——
只能手改 YAML。这一点是读 pnpm 源码确认的，不是推测。

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

### 升级后会「复核」一次，空操作不会被报成成功

`installBundle` 返回 `restart-required` **不等于磁盘真的变了**。实测遇到过一次：
`pnpm add <裸git地址>` 打印 `Already up to date`、退出码 0、锁文件仍指向旧 commit，
而 `installBundle` 照样报告 `restart-required`。

**静默空操作是最糟的失败模式** —— UI 会说「已更新」，实际什么都没动。
所以升级结束会**重新读一次该插件的真实状态**：

| 复核结果 | 界面显示 |
|---|---|
| 确实变了 | 「已更新，重启后生效」 |
| **没变** | **「没有变化（空操作）」** + 原因说明 |
| 复核本身失败 | 保持原状态（「无法确认」≠「没做」） |

复核按依赖形态比较不同的东西：registry 比版本号；**git 依赖比 commit** ——
因为升级 spec 现在明确写了要装哪个 commit，所以复核就是「重新读出来的 pin 是不是那个 commit」。
这比只看状态更严格：状态说不出「pin 移到了我要的那个」和「pin 移到了别处」的区别，
也抓不住「我要的 commit 本来就是当前这个」这种真空操作。

万一读不到当前 commit，结论是**「无法确认」而不是「没做」** ——
因为 git 依赖的状态本身就是从 pin 算出来的，读不到 pin 时状态什么也证明不了。
把它当成空操作会把一次成功的安装报成「什么都没变」。

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
- **git 升级 spec 的两个条件**（必须带名字、必须钉 commit；含「旧 pin 不能被追加成两个 `#`」、
  以及「`#分支` 要按分支查、`#commit` 要退回 HEAD」）
- **commit 复核**（pin 必须等于要装的那个 commit；读不到 pin 时是「无法确认」而非「没做」）
- **配置必须是 Standard Schema**（含负向对照：普通对象必须被 Cordis 拒绝）
- 真实 **Cordis Context** 加载、真服务注入、真 RPC 调用
- **端到端 git 升级**：`verify-cordis-e2e.mjs` 用一个带 git 依赖的合成 profile 跑完整流程，
  并**断言 pnpm 实际收到的 spec 形态** —— 因为上面那两个条件一旦写错，
  表现都是「pnpm 退出码 0」，只看退出码是抓不到的

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
