# teaissue 插件：已确认契约与实施计划

日期：2026-10-14。状态：三轮设计访谈的推荐方案均获用户确认；仅完成设计，不代表已经实现或通过运行验收。

本文件是本轮唯一交付文档。后续实现须另获指令，不因本计划自动开始。

## 1. 目标与非目标

目标：正常 omp 对话中，模型以 `read({ path: "teaissue://1" })` 读取 Gitea 单条 issue 的元信息、正文和完整评论。后端只通过 `gh tea` 调用 gh-tea；不使用 MCP。

支持承诺限定为加载本插件的正常 agent session 内、模型实际调用的 `read`。提到 URI 不等于宿主自动抓取；插件通过工具描述告知模型如何读取。

不支持：

- 独立 `omp read teaissue://…`，以及未加载本插件的会话。
- bash、grep 或其他直接使用内部 URI router 的入口。
- 全局 scheme 注册、原生 URI 自动补全、多个 read wrapper 自动组合。
- issue 列表/搜索/过滤、PR 阅读、附件下载、时间线事件或 reactions 展开。
- 行 selector、raw selector、媒体 selector、输出分页 URI。
- 直接接受 Gitea host URL、覆盖 GitHub `issue://`、替换全局 gh 命令。
- 新增通用 `gh tea api`、resolve 子命令、错误 envelope 或自动登录。

普通文件、HTTP URL、GitHub `issue://` 和其他非 teaissue 输入原样委托原生 read。

## 2. 证据基线

| 对象 | 本轮核对结果 |
| --- | --- |
| 插件目录 | 初始为空且不是 Git 仓库；按本机规则执行 git init，尚无插件实现 |
| gh-tea 仓库 | `~/Documents/workdir/gh-tea-new`；main；核对时工作区干净 |
| gh-tea HEAD | `290bde78331fe29b27cc14c3b25102bc130a5251` |
| 已安装命令 | omp 18.8.7；gh-tea v0.5.0 |
| view JSON | 当前没有 comments 或 isPullRequest；JSON 分支在文本评论逻辑之前返回 |
| 评论分页 | 已有 issueCommentPages，页大小 50；任一页错误向上传递 |
| SDK | code.gitea.io/sdk/gitea v0.21.0；Comment 有 ID、HTMLURL、Poster、Body 和时间；Issue 有 PullRequest 元信息 |
| 执行 interface | omp 18.8.7 公开 pi.exec 支持 cwd、signal、timeout；返回 stdout、stderr、code、killed |

本轮实际运行：Git 基线查询、git init、go env GOMODCACHE、gh tea issue view --help、gh extension list、omp --version。读取了本地源码、SDK 缓存和下文引用的官方源码/文档。

本轮未运行插件、未访问私有 Gitea、未读凭据、未运行构建或测试。可行性证据不能替代端到端验收。

## 3. 两仓库的 module 与 seam

跨仓库 seam 是既有 `gh tea issue view` CLI，不是新的 HTTP client 或通用请求层。

| Module | 拥有的行为 | 不拥有的行为 |
| --- | --- | --- |
| omp-gitea-plugin | URI 解析、模型可见 read 描述、调用时 cwd、参数数组、结果验证、Markdown 展示、取消与 60 秒执行时限、原生 read 委托 | token/配置读取、实例 resolver、Gitea HTTP 请求、后端分页 |
| gh-tea | 配置/认证、实例与仓库选择、Gitea 请求、完整评论分页、字段投影、CLI 成败 | teaissue URI 解析、omp 工具说明、Markdown 展示或 selector |

插件作为独立 extension package 分发，使用 package.json 的 omp.extensions 声明入口，仅使用公开 ExtensionAPI。无需将 omp 宿主代码嵌入 gh-tea，不导入 omp 内部 router。

注册同名 read，保留宿主兼容的 path 参数 schema；非目标输入通过 ctx.invokeTool 原样委托同名原生工具。不会获得其他插件 wrapper 的自动串接；实际部署须避免竞争注册 read。

## 4. URI interface

### 4.1 支持的形式

| URI | 后端参数与含义 |
| --- | --- |
| `teaissue://N` | 当前调用会话 cwd 的 issue N；实例和仓库交给 gh-tea |
| `teaissue://owner/repo/N` | 加 `--repo owner/repo`；实例仍交给 gh-tea |
| 上述任一形式加 `?use=work` | 加 `--use work`，work 是 gh-tea 配置别名 |
| 上述任一形式加 `?comments=0` | 仅请求主体字段，不请求评论 |
| 上述任一形式加 `?comments=1` | 显式请求完整评论，与默认行为一致 |

两个 query 参数可以组合，顺序无关。示例：`teaissue://owner/repo/1?use=work&comments=0`。

### 4.2 严格语法

- 文档支持的 scheme 拼写为小写 teaissue://。属于 teaissue: 但不符合约定语法的输入由插件报错，不交给原生 read 掩盖错误。
- N 为正十进制整数，范围 1 至 9223372036854775807，与 gh-tea 的正 int64 编号一致。
- 拒绝编号中的正负号、空白、小数和指数写法；接受前导零，调用后端前规范化。
- 编号规范化不得经过有损的 JavaScript Number 转换。
- owner/repo 保留大小写，不使用普通 URL hostname 小写化后的值作为 owner。
- 按路径段解码一次；拒绝非法编码、空段、`.`、`..`、解码后的 `/` 或 `\\`，以及 gh-tea 不接受的仓库名字符。
- 不允许尾随斜线、fragment、userinfo/port/host URL 变体或 selector 后缀。
- query 只接受 use 和 comments，各至多出现一次；拒绝未知参数、重复参数及空值。
- query 值解码一次；use 非空且不修剪，不转换为 host URL；comments 仅接受字面量 0 或 1。
- 不对已解码值进行二次解码，不根据解析失败尝试另一种目标解释。

边界验收必须覆盖大小写 owner、编码分隔符、重复参数、最大编号及越界编号，而非只覆盖常用短 URI。

## 5. 实例与仓库选择

插件每次以当前 ctx.cwd 执行 gh tea，不使用扩展加载时捕获的 cwd，不维护另一套 resolver。

- use 显式提供时映射为 --use，必须是已有配置别名。
- repo 显式提供时映射为 --repo owner/repo。
- 未提供 use：沿用 gh-tea 当前行为，从 cwd 的 git remotes 匹配配置实例；无匹配时使用默认实例；多实例匹配则失败。
- 未提供 repo：只从所选实例对应的 remotes 推断；无仓库或多仓库匹配则失败。
- 显式 repo 不锁定实例：即使写了 owner/repo，仍可能依据当前 cwd 或默认配置选实例。
- 需要跨工作区稳定指向时，使用显式 owner/repo 加 use 的完整地址。
- 缺认证、别名不存在或实例/仓库歧义均保留 gh-tea 失败；插件不猜仓库、不换实例重试。

不增加插件 token、host、默认仓库或 config 路径配置入口；gh-tea 继续拥有既有配置行为。

## 6. gh-tea JSON interface

### 6.1 view 字段与调用

保留现有字段，给 issue view --json 增加两个可选字段：

- comments：完整结构化评论数组；仅在选择时访问评论接口。
- isPullRequest：由 Issue.PullRequest 元信息产生的布尔值，不发 PR 专用请求。

两字段均为 view 专属。issue list --json comments 和 issue list --json isPullRequest 必须报未知/不支持字段，不能因共用白名单而错误接受。

插件主体字段表固定为：

```text
number,title,state,url,createdAt,updatedAt,closedAt,author.login,labels[].name,assignees[].login,milestone.title,body,isPullRequest
```

默认或 comments=1 时追加 comments。comments=0 时不追加。

目标调用示例，当前 v0.5.0 尚不能运行此契约：

```sh
gh tea issue view 1 --repo owner/repo --use work \
  --json 'number,title,state,url,createdAt,updatedAt,closedAt,author.login,labels[].name,assignees[].login,milestone.title,body,isPullRequest,comments'
```

实现用 pi.exec 的参数数组，不拼 shell 字符串。上述 shell 示例只用于说明 CLI interface。

### 6.2 评论结构

```json
{
  "comments": [
    {
      "id": 123,
      "author": { "login": "alice" },
      "body": "评论原文",
      "createdAt": "2026-10-14T08:00:00Z",
      "updatedAt": "2026-10-14T08:00:00Z",
      "url": "https://gitea.example/owner/repo/issues/1#issuecomment-123"
    }
  ]
}
```

- id 为源评论 ID，JSON 整数；插件不得在解析或展示中使整数失真。
- body 原样保留，空正文为字符串空值，不修剪或改写 Markdown。
- Poster 缺失时 author 为 null；存在时为含 login 的对象，与既有 author.login 投影风格一致。
- createdAt、updatedAt 为 RFC3339；源数据缺失/SDK 零时间为 null，不伪造时间。
- url 从 HTMLURL 映射；源数据缺失时为 null，不猜测链接。
- 选中 comments 且无评论时返回 []，不是 null。
- 未选中 comments 时不输出该字段、不调用评论接口。
- 复用完整分页逻辑，按服务端分页返回顺序连接；不排序、不去重、不加入时间线事件。
- 任一评论页失败则整个 JSON view 失败；在所有数据取得并可编码之前不输出成功 JSON。
- 不承诺分页读取是服务端事务快照；抓取期间讨论发生变动仍受源接口语义约束。

### 6.3 --comments 与 --json

| 调用 | 行为 |
| --- | --- |
| issue view N | 保留既有文本行为，不取评论 |
| issue view N --comments | 保留既有文本评论行为 |
| issue view N --json title --comments | 只输出 title，不取评论 |
| issue view N --json title,comments | 输出 title 与完整评论 |

JSON 内容只由 --json 字段表决定。插件不传 --comments，不改变普通 view 默认网络开销。不把本次 JSON 全有或全无的要求扩展为文本模式重构。

### 6.4 PR 排除

插件始终请求 isPullRequest，包括 comments=0。

- false：继续渲染 issue。
- true：明确返回不支持 PR 的工具错误，不把其正文作为成功 issue 展示。
- 缺失或非布尔值：后端契约不匹配，失败。

不依据 URL 路径猜测类型，不引入 PR 阅读功能。gh-tea 原有 issue view 对 PR 编号的既有 CLI 行为不因本计划全局改变。

## 7. 执行与失败 interface

每次读取最多一次 gh tea issue view 执行；不缓存、不自动重试、不额外执行能力探测命令。

执行选项：cwd 为调用时 ctx.cwd；signal 跟随工具取消；timeout 为 60000 毫秒，覆盖该子进程内的主体和全部评论读取。

| 情况 | 契约 |
| --- | --- |
| URI 非法/不支持参数 | 插件报语法错误，不运行后端 |
| gh 或 gh-tea 不可用 | 工具失败，指出命令依赖，不尝试安装或其他后端 |
| gh-tea 非零退出 | 保留退出码与 stderr 供诊断，不解析自然语言错误文本 |
| 某页评论失败 | 整体失败，不返回主体或部分评论作为完整成功 |
| 旧后端拒绝新字段 | 失败并提示需要符合契约的 gh-tea；不改成旧字段重试 |
| stdout 无效 JSON/缺少请求字段/字段类型错误 | 契约错误，不以空对象或伪造默认值补齐 |
| isPullRequest 为 true | 明确不支持 PR |
| 取消或超时 | 终止子进程，不返回部分结果；验证不止于停止等待 |
| 执行输出被截断或超出安全处理限制 | 明确失败，不将残缺结果标成完整讨论 |

成功 stdout 只能包含一个完整 JSON 对象；失败通过非零退出与 stderr 表达。后端不新增版本化错误 envelope 或稳定错误码。插件须检查退出/取消状态后再消费 JSON，不把失败进程偶然输出的内容当成功。

JSON 编号及评论 ID 的 int64 语义必须无损保留；实现阶段优先选择成熟的无损 JSON 解析方式，不允许因 Number 精度不足悄悄改值或缩小已批准的编号范围。

## 8. read 返回内容

成功返回 Markdown：标题、编号、状态、源 issue URL、作者、创建/更新/关闭时间、标签、负责人、里程碑、正文，随后按顺序逐条展示评论作者、时间、URL 和正文。

- 缺失元信息明确标为缺失，不伪造用户、时间或 URL。
- comments=0 显示未请求评论；请求后返回 [] 才显示没有评论。
- 正文和评论保留原始文本内容；展示标题不改变其数据语义。
- 评论是外部来源数据，不是插件或系统指令；插件不执行其中命令。
- 不主动裁剪长讨论，不新增分页 URI、临时文件回读协议或 selector。
- 不承诺无限长结果。必须实测 pi.exec 输出链路与宿主工具结果限制，确认是否存在无法检测的截断。
- 如果公开宿主 interface 无法满足完整性/终止要求，应记录具体证据并重新提交设计决策，不能静默降级或宣称完成。

工具 description 说明对 teaissue URI 直接调用 read，不能引导模型运行不支持该 wrapper 的独立 omp read。非 teaissue 请求保留原生结果与错误，不重新实现文件、HTTP 或 GitHub 读取。

## 9. 兼容与分发

- 首个支持基线为 omp 18.8.7；其他版本通过实际加载及回归后才加入支持声明。
- gh-tea v0.5.0 不满足新契约。即使 comments=0，也要求 isPullRequest，因此不保留旧版主体兼容路径。
- gh-tea 最低发行版本须等增强实际发布后记录，不预填不存在的版本号。
- 初次验证使用本地 extension 路径/manifest，按已核对的官方加载方式操作；不预先声称某个尚未核对的远端安装命令可用。
- 不新增内部 router 依赖或全局 gh 行为修改。其他 read wrapper 冲突属于部署约束，不声称自动组合。

## 10. 后续实施顺序（本轮不执行）

### 阶段一：gh-tea 机器输出增强

目标仓库：~/Documents/workdir/gh-tea-new。

1. 修改 cmd/issue.go，分清 view 与 list 支持的字段集合；增加 view 的 comments、isPullRequest。
2. 复用 SDK 元信息和现有 issueCommentPages；只在字段请求时读取评论。
3. 映射固定评论结构；保持未选中字段省略及空数组语义。
4. 取得全部数据后再编码 JSON，保证评论中途失败不留下看似成功的 stdout。
5. 在既有 cmd/issue_test.go 风格下保留消费者可见的回归测试：零评论、跨页、后页失败、缺失作者/时间/URL、未请求时无评论请求、PR 标志及 list 拒绝 view 字段。
6. 更新 README 的字段、flag 关系和兼容说明；不改 resolver、认证、普通文本评论语义。
7. 运行相关测试、实际 CLI smoke，再按仓库现有流程进行完整验证和提交。发布后记录真实最低发行版本。

阶段一不需要 omp 插件参与即可独立验证。插件的解析/展示开发可基于本文件的固定契约进行，但真实集成依赖此后端可用。

### 阶段二：omp extension

目标仓库：~/Documents/workdir/omp-gitea-plugin。

1. 建立独立 extension package，声明 omp.extensions 和明确支持版本；依赖随包可解析，不依赖宿主内部源码。
2. 注册兼容原生参数的 read wrapper，描述支持 URI 与不支持入口。
3. 实现严格 URI 解析、无损编号处理及参数数组构造。
4. 使用 pi.exec 调用 gh tea；显式传 ctx.cwd、signal 和 60 秒 timeout。
5. 验证执行状态和 JSON 契约，拒绝 PR；结构化渲染完整 Markdown。
6. 非 teaissue 原样调用 ctx.invokeTool；不模拟原生 read 行为。
7. 为不确定且消费者可见的边界增加确定性测试，如非法编码、大小写保留、int64 极值、JSON 缺字段、PR 拒绝；不写仅验证字符串复制、转发或源代码文本的测试。
8. 用真实 omp 加载插件完成下节端到端验收，更新使用/支持说明后提交。

阶段二必须使用真实可调用后端完成 smoke；parser 测试或 mock 返回值不能单独证明交付完成。

## 11. 验收矩阵（尚未执行）

| 范围 | 必须观察到的结果 |
| --- | --- |
| 正常对话 | 输入“请读取 teaissue://1”，模型调用 read，真实 Gitea 标题/正文/评论进入工具结果 |
| 原生委托 | 普通文件、HTTP、原生 issue:// 均保持原生读取及失败语义 |
| 调用 cwd | 两仓库/会话读取相同编号，无启动目录或前次调用串仓；显式 repo/use 指向预期目标 |
| 实例 resolver | 无匹配 remote 时沿用默认实例；多实例/多仓库、无 repo、未知 use、缺认证明确失败 |
| URI | 两种路径、两个 query 参数及其组合正确；未知/重复/空参数、非法路径、fragment/selector 拒绝 |
| 编号与编码 | 前导零规范化、owner 大小写保留、只解码一次、int64 最大值无损、越界拒绝 |
| 评论 | 零条、多页、最后一页与后页失败；原文、顺序及缺失元信息符合结构契约 |
| 网络开销 | comments=0 不访问评论接口；默认请求完整评论；只请求一次 CLI，不自动降级重试 |
| CLI flags | JSON 字段决定评论请求；文本模式保持既有行为；list 拒绝 view 专属字段 |
| PR | isPullRequest=true 时插件拒绝展示；不靠 URL 猜类型；字段缺失明确失败 |
| 失败输出 | 非零退出及 stderr 可诊断；无效/残缺 JSON、缺字段不伪装成功；后页失败无成功 JSON |
| 旧后端 | v0.5.0 在含评论和 comments=0 两路径均清晰报契约不兼容，不绕过 PR 检查 |
| 取消与超时 | 真实子进程终止，无遗留请求继续运行；不只验证 promise 提前返回 |
| 长讨论 | 在宿主真实输出链路下确认完整性；到限制时明确失败，无静默截断 |
| 加载与部署 | 在指定 omp 二进制中加载实际包；非内部 import；部署无竞争 read wrapper |

后端行为测试可使用隔离的 HTTP fixture 验证分页/错误边界；最终 smoke 必须包含真实 CLI 与真实 omp surface。无法访问的私有实例或配置属于实施验收所需环境，不以 fixture 代替真实集成证明。

## 12. 仍需实现验证的风险，不是未决产品选项

- pi.exec 与真实打包版 omp 的动态加载兼容性。
- 执行链路的输出上限、截断可检测性和宿主模型可见结果限制。
- signal/timeout 下进程树是否真正退出。
- Gitea 实例/API 版本对 SDK 分页及缺失字段的实际响应。
- gh-tea 新契约的真实发布版本与可安装产物。

产品行为与跨仓库契约已确认；这些风险必须通过后续证据关闭，不能在本轮文档中写成已完成。

## 13. 依据

本机研究记录：

- ~/.omp/notes/teaissue-plugin-feasibility.md
- ~/.omp/notes/teaissue-omp-plugin-sources.md
- ~/.omp/notes/teaissue-gh-tea-contract.md

一手来源：

- [OMP 18.8.7 extension loading](https://github.com/can1357/oh-my-pi/blob/v18.8.7/docs/extension-loading.md)
- [OMP 18.8.7 extension interface 与原生委托](https://github.com/can1357/oh-my-pi/blob/v18.8.7/docs/extensions.md)
- [OMP ExecOptions / ExecResult](https://github.com/can1357/oh-my-pi/blob/v18.8.7/packages/coding-agent/src/exec/exec.ts)
- [OMP standalone read CLI](https://github.com/can1357/oh-my-pi/blob/v18.8.7/packages/coding-agent/src/cli/read-cli.ts)
- [OMP 原生 issue URI 行为](https://github.com/can1357/oh-my-pi/blob/v18.8.7/packages/coding-agent/src/internal-urls/issue-pr-protocol.ts)
- [gh-tea issue 实现基线](https://github.com/InsulateJustf/gh-tea/blob/290bde78331fe29b27cc14c3b25102bc130a5251/cmd/issue.go)
- [gh-tea resolver 基线](https://github.com/InsulateJustf/gh-tea/blob/290bde78331fe29b27cc14c3b25102bc130a5251/pkg/tea/resolve.go)
- [Gitea issue 响应与 pull_request 元信息](https://docs.gitea.com/api/1.24/operations/issue-get-issue/#200)
- [Gitea issue comments endpoint](https://docs.gitea.com/api/1.24/operations/issue-get-comments/)
