# pi-app 架构上下文（审计 / 重构用）

### 决策记录：侧栏项目固定顺序（2026）

侧栏项目列表默认按最近使用（MRU）排序：打开项目时 `configStore.addRecentProject` 把项目移到最前，且当前工作区始终置顶（`project-sidebar.tsx` 的 `diskPaths`）。新增配置项 `recentProjectsFixedOrder`（默认 `false`，保持 MRU 行为）：开启后 `nextRecentProjects` 不再移动已有项目（新项目追加到末尾），侧栏按存储顺序展示且当前项目不置顶（仅高亮）。纯函数：`src/main/recent-projects.ts`、`src/renderer/src/features/workspace/project-folder-order.ts`。设置页「最近项目」区开关直接写配置并派发 `pi-desktop:settings-changed` 事件通知侧栏即时重排。

**闪烁根因（勿回退）**：`ui-store.setWorkspace` 曾把当前工作区 unshift 到 `recentProjects` 最前——固定模式下侧栏先跳顶，随后 `reloadSidebarSettings` 从主进程拉回真实顺序——先跳再弹回 = 每次切换可见闪烁。修复：`setWorkspace` 不再重排 `recentProjects`（侧栏顺序以主进程配置为唯一事实源；MRU 模式由 `projectFolderOrder` 的“当前置顶”规则兜底即时显示）。另：`reloadSidebarSettings` 在顺序无变化时保持数组引用稳定，避免固定模式下每次切换都触发整个侧栏重渲染。
## 会话树交互术语（glossary）

- **查看跳转（view-jump）**：单击会话树节点，时间线非破坏性定位到该节点对应的消息。历史未加载时先触发只读补拉，加载完成后再跳转；不改变会话叶子、不回退、不打断用户输入。
- **回退（rewind）**：双击会话树节点或使用回退按钮，将会话当前位置移动到该节点（改变叶子，可再回退恢复）。
- **全局统一**：右栏会话树面板与双击 Esc 的会话树浮层交互一致：单击或 Enter=查看跳转，双击=回退。

### 决策记录：单击=查看、双击=回退（2026）

会话树曾两次被改错：`a34ffa2` 把单击改成仅选中（“点击没反应”），后续提交又把单击改成直接回退（破坏性）。正确语义：**单击/Enter=非破坏性查看跳转**（时间线定位到该节点，不改叶子、不打扰输入；未加载的历史只读补拉并增量合并，时间线始终代表真实最新）；**双击=回退**（navigateTree）。勿再改为“单击=回退”。
## 外部会话同步术语（glossary）

- **外部更新（external update）**：非本 app worker 对会话 JSONL 的追加（典型：CLI 并发写同一会话）。app 空闲时**自动**把磁盘新尾部合并进时间线视图（不改变 worker 内存态）；同步状态由 composer 上方**三态指示器**呈现（见下）；完整手动刷新走右上角「刷新会话数据」按钮。
- **外部同步状态（external sync state）**：当前查看会话的视图状态，不是应用级或工作区级状态。切换会话时立即归零；新会话只有在自身检测到外部更新后才进入同步中或异常状态。

### 决策记录：外部更新走视图层只读合并，不重载 worker（2026）

CLI 与 app 同开一会话时，CLI 追加 JSONL。检测到外部更新后，app 只把磁盘新尾部合并进时间线视图（读路径 `session.getMessages` 本就磁盘直读、不依赖 worker），**绝不自动重载/覆盖 worker 内存态**——避免并发写互相覆盖与上下文丢失。监测机制：fs.watch 当前工作区会话目录（一个 watcher）+ 事件路由（命中当前会话→尾合并；新文件→刷新列表），切换会话只改路由；**定时轮询（~3s）兜底 Windows 丢事件**，另 debounce + 窗口聚焦时强制刷新。

### 决策记录：外部同步失败只在已确认活动窗口内报错（2026）

watcher/轮询通知只代表"文件变了"，不代表一定有外部 CLI 在写（app 自己延迟落盘、预览进程重启、授权上下文变化等都会触发通知），因此**未确认来源的读取失败保持静默**：每次通知最多重试 3 次（0ms / 500ms / 2s），全失败且未确认过外部活动时维持 idle。只有当前会话在 5s 活动窗口内成功合并过外部新增、随后连续失败，才亮"外部同步异常"；error 状态带 10s 慢速自检，成功后自动恢复（无新增→idle，有新增→active）。手动「刷新会话数据」失败仍立即反馈（明确操作，必须给结果）。**注意**：main watcher 发完事件就更新了 `knownMtimes`，同一写入不会再次触发轮询——重试必须由 renderer 自己做。

### 决策记录：外部同步状态严格属于当前查看会话（2026）

`externalSyncPhase` 是当前查看会话的视图状态，不跨会话继承。切换会话（含缓存命中路径 `focusSessionSync`）、切换工作区、进入空白会话时立即重置为 idle，并用**代际 token** 作废所有在飞读取——旧会话的异步结果不得修改新会话的时间线或同步状态；idle/error 定时器同样按代际失效。

### 决策记录：外部同步用三态指示器，不做发送前确认弹窗（2026）

实时同步已把磁盘尾部并入视图，弹窗冗余且打断输入。composer 上方**三态指示器**（`externalSyncPhase` 驱动）：外部写入合并成功 → **绿色脉冲「正在同步外部对话」**，约 5s 无外部写入自动隐藏（本轮结束）；IPC 同步异常 → **橙/红「外部同步异常」**，点击触发完整重载；空闲不渲染。**实现注意**：zustand `setState` 返回 `undefined`，判断"是否有新增"必须在 updater 内用局部变量捕获，不能靠返回值。

### TODO：实时思考过程同步（等待 pi 支持流式落盘）

pi CLI 的会话 JSONL 是**消息级落盘**（磁盘无流式中间条目，thinking+text+toolCall 同一条消息一次性 append）。因此 app 同步 CLI 会话的粒度上限 = 每条消息完成，CLI 思考过程中 app 看不到中间状态。**等 pi 支持思考块逐块落盘后**再回来做实时思考同步。勿再优化 watcher debounce/轮询间隔（那是消息级延迟，不是思考级）。

## 对话文件汇总术语（glossary）

- **对话文件汇总（turn file summary）**：每个已完成回合保留的改动文件卡片。单击文件行在卡片内展开或收起该回合的**最终净 diff**；文件行同时提供打开文件、复制路径和进入 Git Review 的独立操作。
- **回合文件基线（turn file baseline）**：某文件在本回合第一次修改之前的内容状态。回合结束后用最终文件状态与该基线比较，生成最终净 diff；中间多次编辑默认不展示。
- **最终净 diff（final net diff）**：文件回合结束状态相对于回合文件基线的差异。它不等同于当前工作区相对 `HEAD` 的 Git diff，也不展示本回合内已被后续编辑抵消的中间变化。
- **汇总路径操作（summary path actions）**：文件汇总中面向路径的快捷操作。默认复制绝对路径；复制工作区相对路径、在文件夹中显示等低频操作放在二级菜单。

### 决策记录：回合最终净 diff 用 Worker 内存基线结算（2026）

每个已完成回合保留文件汇总卡片；单击文件行展开该回合的**最终净 diff**。实现：Worker 在 edit/write/insert 等可提取路径的修改工具**执行前**读原文件建基线（每文件每回合首次为准，只放内存、不写临时文件、不写会话 JSONL），`turn_end` / `agent_settled` 时读最终文件，用 `diff` 库生成 unified diff 发出 `turn_diff` 事件；成功/失败/中止都结算，净零变化不产出条目。**持久化**：基线不持久化（进程周期内有效）；结算后的 diff 文本由主进程写 app 私有数据目录 `userData/turn-diffs/`（每会话最多 50 条），重启后由 `session.getTurnDiffs` 恢复——不写会话 JSONL。限制：单文件快照上限默认 1 MiB（设置 0–16 MiB，0=关闭，Worker 初始化时读取、重启生效）、二进制不缓存、超出工作区不缓存、每回合预算 = 单文件上限×16 封顶 64 MiB、diff 文本 256KB/3000 行截断；未缓存文件在卡片中给出原因（超限/二进制/工作区外/不可读/预算）。**匹配链**（精确→降级）：turnId → runId → 回合序号（Worker 每个 turn_start 占号，与视图回合序号对齐）→ 仅视图最后一个已完成回合允许用该会话最新记录兜底。**无净 diff 记录的回退**：用回合工具记录（JSONL 自带的 edit/write 参数）渲染逐操作 diff（标注「来自工具记录」）；连工具记录都没有时行点击直接打开文件。**结算必须等待本回合在飞捕获完成**（pendingOps 计数），否则 turn_end 早于 stat/read 完成时会静默丢 diff。中间逐操作过程不另建界面（时间线工具行已有）。

### 决策记录：右栏导航用 store 意图，不再依赖瞬时 CustomEvent（2026）

Review / Files 面板是懒加载组件；先切面板再同步派发 CustomEvent 时，事件会在面板挂载前丢失（"点击无反应"根因）。改为 ui-store 中的一次性导航意图（panel + scope + path + seq），面板挂载后用模块级已消费 seq 消费一次（防卸载重挂重复消费），同时保留 CustomEvent 作为已挂载时的即时通道（双通道幂等）。Review 打开时统一切到 git scope（该 scope 才有真实 diff；turn/session scope 只有文件元数据）。**三个坑（勿回退）**：
1. `React.StrictMode` 双跑 effect 时，Files 面板的 `resetTabs()` 挂载 effect 会把意图 effect 刚打开的文件清掉——挂载首跑必须跳过 reset（用 ref 记录已见 workspaceRoot）。
2. `FileDiffView` 的展开态是 `useState(defaultOpen)` 只在挂载时生效——面板已挂载时新焦点请求必须用 focusToken 递增触发 effect 重新展开。
3. `parseGitStatus` 不能对整串 `trim()`：porcelain v1 第一行的行首状态空格会被吃掉，第一个未暂存文件（`' M path'`）路径残缺（`rc/...` 样式）永远匹配不上焦点路径，表现为「点击某文件的 git review 无效」。按行清洗（仅去 `\r`），保留行首状态列。

## 会话显示特性术语（glossary）

- **过程内容（activity item）**：时间线里非对话正文的条目——思考块（thinking）、工具调用行（tool-call，含命令执行）、skill 调用块。与对话正文（user/assistant 气泡）相对。
- **活动窗口（activity window）**：过程内容的滚动展开窗口，大小 N 可在设置中配置。默认折叠所有过程内容，仅**自动展开最新 N 个**；有新增过程内容时，超出窗口的最旧项回到折叠态。**用户手动展开/折叠优先于窗口**（窗口不强制折叠用户明确展开的项）。N=0 表示禁用窗口（保持纯手动行为）。整个时间线统一计数，不按回合分界。
- **元事件条目（non-message entry）**：`model_change` / `thinking_level_change` 等非消息 JSONL 条目。默认不展示；设置开关打开后，在时间线中以一行小字展示（如「切换到 acme/example-model · thinking: high」），相邻的 model+thinking 变更合并为一条。
- **skill 调用块（skill invocation）**：以 `<skill name="..." location="...">` 开头的独立用户消息（pi 把 skill 内容作为用户消息注入）。渲染为一行折叠摘要「调用 skill: <name>」，点击展开全文；**默认折叠、不受活动窗口 N 限制**；摘要层不显示 location 路径（含本机用户名，避免泄漏）。

### 决策记录：活动窗口与 skill/元事件展示（2026）

时间线可读性与信息容积的权衡：过程内容全展开则 AI 执行时刷屏，全折叠则看不到进展。定案：**默认折叠 + 滑动窗口自动展开最新 N 个 + 手动优先**（见 glossary「活动窗口」）；skill 调用块单独折叠（默认折叠、不受窗口限制）；元事件条目默认隐藏、开关可开。这三类均为纯展示层行为，**开关与 N 存放 app 私有 config-store，不进 pi settings**。
## 会话归档术语（glossary）

- **归档（archived）**：把会话从默认列表隐藏；元数据存 configStore（`Record<规范化会话文件路径, 归档时间戳>`），侧栏"已归档"视图可恢复/删除。归档会话收到新消息**不会**自动取消归档。

### 决策记录：归档状态只用元数据，不移动文件（2026）

会话文件路径是 TUI 与 app 共享的稳定定位键，移动/重命名会破坏 worker 绑定与树引用。因此**归档 = configStore `Record<路径, 时间戳>`**，文件原地不动。
## 会话管理特性术语（glossary）

- **自动命名（auto-name）**：手动触发（重命名对话框内"自动生成"），用规则从会话首条用户消息提取标题（剥离行首 `/` 命令调用、剔除 URL 与文件路径——不适宜作标题、折叠空白、截断约 40~50 字），结果经 `session_info` 写入 JSONL（与 TUI `/name` 同机制），**不重命名会话文件或文件夹**。已有人工命名（存在 `session_info`）的会话点自动命名时覆盖。

### 决策记录：会话标题只用元数据，不重命名文件（2026）

会话文件路径（`~/.pi/agent/sessions/<编码cwd>/<时间戳>_<uuid>.jsonl`）是 TUI 与 app 共享的稳定定位键，重命名会破坏 `sessionDisplayNames` 键、worker 绑定、树引用等。因此：**标题 = JSONL `session_info`（TUI 可见）+ configStore overlay（app 本地）**。勿再考虑重命名会话文件/文件夹。

## 进程边界

| 进程 | 目录 | 职责 |
|------|------|------|
| Main | `src/main/` | 窗口、IPC、`config-store`、Worker 生命周期、sandbox 工作区 |
| Preload | `src/preload/` | `contextBridge` → `piDesktop`；`invoke` 仅允许 `packages/shared/ipc-channels.ts` |
| Renderer | `src/renderer/src/` | React UI；全局状态 `stores/ui-store.ts` |
| Worker | `src/worker/` | Pi SDK 会话；经 Main 桥接 |

## IPC 接缝（单一注册表）

- `src/main/ipc/registry.ts` — `registerHandler` / `sendEvent`
- `src/main/ipc.ts` — `registerAllHandlers()` 引导；逐步迁出内联 `registerHandler`
- `src/main/ipc/handlers/*` — 按域：`dialog`, `workspace`, `workspace-fs`, `session`, `prompt`, `settings`, …
- 契约列表：`packages/shared/ipc-channels.ts`（与 Main 注册必须同步，见 `scripts/tests/ipc-channel-sync.test.mjs`）

## 事件流

Renderer `piDesktop.onEvent` ← Main `sendEvent(win, AppEvent)` ← Worker。

- 类型：`packages/shared/app-events.ts`
- 会话守卫：`packages/shared/app-event-session.ts`
- 归约：`src/renderer/src/stores/apply-app-event.ts`（`ui-store` 调用，勿再把大段 switch 塞回 store）

## 安全默认值

- `src/main/window.ts`：`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` 默认（`PI_RENDERER_SANDBOX=0` 可关；见 `doc/THREAT-MODEL.md`）
- Codex JWT：`src/main/secret-store.ts` + `asr-config-store.ts`（safeStorage，明文迁移）

## 质量门禁

- `npm run typecheck` — web + node
- `npm run test:scripts` — CI `quality.yml`
- `node scripts/ci-audit.mjs` — CI `dependency-audit`（critical 门禁）
- `doc/IPC-CONTRACTS.md` — IPC Backend-API 文档
- FMSM iter14 整改：**sandbox 默认 true**；`test:e2e`；CI `e2e-smoke` + `script-tests-win`；报告 `docs/audit/*iter14*`

## 严苛评分（FMSM 2026-07-01）

| 项 | 严苛分 | PRD 目标 |
|----|--------|----------|
| Overall | **8.0 A**（iter13：FMSM 整改 + PRD gates） | ≥8.0 ✓ |
| Testing | **7.4**（`scripts/tests` 29 文件，`fmsm-prd-gates` ≥27） | ≥7.0 ✓ |
| ipc **36**；ui-store **329**；apply-app-event **71**；worker/index **≤1100** 行；`as any` **≤22** | `worker-session-events` / `worker-timeline` / `worker-compaction-patch` 已拆 |

Trellis：`07-01-fmsm-remediate-a` 已归档 `archive/2026-07/`。威胁模型：`doc/THREAT-MODEL.md`（含 safeStorage）。

## 路线图共识术语（glossary，2026-08-14 访谈确认）

- **pi-app 定位**：用户友好、可靠的界面；底层能力与功能扩展依赖 pi 生态（不在 app 内另造内核或工作流）。相对其它社区 pi UI，选择 pi-app 的理由 = 友好可靠 + 完整生态兼容。
- **双线（已确认定义）**：pi TUI 自身即极客线；pi-app 承担桌面主流线。pi-app 路线图只覆盖桌面主流线，TUI 改进不属本仓库排期（必要时仅作上游依赖追踪）。
- **优先级**：桌面体验是首要任务；工作流功能复用 pi 生态，不预装官方包。
- **迭代节奏**：基础体验周更；大功能 1–3 个月周期迭代。
- **否决记录（第二轮）**：「官方工作流包（batteries-included，plan/todo/cost 预装）」被否决——复用 pi 本身的扩展基建，改为 UI 化插件管理（搜索/安装/卸载，候选待确认）。
- **移动端（C1）**：排在桌面大功能（G3/G4）之后、推广（G5）之前（2026-08-14 调整）；参考 orca；桌面线稳固后启动评估。
- **存量治理（R0）**：对现有功能做 review / rethink / 精简 / 修复，路线图最高优先，先于一切新功能。首轮盘点产物：`doc/R0-FEATURE-REVIEW.md`（清单 + 13 个重叠热点 + 三档精简建议）。
- **双轨道骨架**：轨道 1「周更打磨轨」（G1 桌面体验连续小项，每周发版）+ 轨道 2「大功能轨」（G2 插件管理 UI → G3 会话树深化 → G4 多会话并行/subagent 面板化，1–3 个月/项）；之后 C1 移动端；G5 推广为最后一项；里程碑 M1/M2/M3 是验收点而非硬排期。
- **非目标（明确不做）**：权限审批弹窗（已移除，坚持事后审查）、官方预装包（已否决）、MCP 官方包（归社区）、TUI 上游改造（pi-mono 极客线）、app 内另造内核/与 CLI 数据分叉。
- **执行方式**：模型辅助快速迭代开发；周更轨小改动快速回归，大功能轨 1–3 个月立项迭代。
- 完整路线图见 `doc/ROADMAP.md`（2026-08-14 共识定稿）。
- **路线图语言要求**：`doc/ROADMAP.md` 面向普通人，讲人话、无行话黑话，宁可啰嗦。
- **基建服务插件**：pi-app 已有的基建能力（展示/交互原语）以通用组件形式服务插件（例：schema 驱动的配置表单，下拉框代替手填 JSON 字段）；约束：核心必须保持精简、可维护、不臃肿——原语必须通用可复用，禁止为单个插件写专用代码。
- **G2 范围（2026-08-14）**：插件管理界面 = 搜索/安装/卸载 + 配置表单；明确**不做**「任意 JSON 文件通用编辑器」（无 schema 做不了下拉框，属范围蔓延）。
- **配置表单实现约束**：字段说明放 adapter 配置（沿用 builtin/用户/项目三层覆盖），不改 npm 包；写回走 pi SDK 设置语义（合并+锁），与终端版不冲突；先静态 schema MVP，动态选项后置。
- **M2 拆两段**：先搜索/安装/卸载（1 个月内），后配置表单（随后 1–2 个月）。

## 模型作用域术语（glossary，2026 访谈确认）

- **会话模型（session model）**：当前会话使用的模型，写入会话 JSONL 的 `model_change` 条目，按会话持久化；重新打开会话时从会话文件恢复。
- **全局默认模型（global default model）**：pi 配置里 `defaultProvider` / `defaultModel`，决定新会话的初始模型；**只由设置页修改**。

### 决策记录：会话内切模型不写全局默认（2026）

pi SDK 的 `AgentSession.setModel()` 会**双写**：会话模型（`agent.state.model` + `appendModelChange`）与全局默认（`settingsManager.setDefaultModelAndProvider`）。上游 pi CLI 的 `/model` 就是这语义（模型选择器代码里注释过「上游语义」），但桌面端有独立的设置页默认模型选择器——静默改写全局默认是意外副作用（在会话 A 切模型 → 新会话 B 莫名继承、设置页默认被改）。定案：**worker `handleSetmodel` 在 `setModel` 前后快照/还原全局默认**（还原前先比较，无变化不写盘；失败路径同样还原，覆盖 SDK 写默认后抛错的场景）。会话 JSONL 已按会话持久化模型，还原不影响会话自身。**已知同类问题（未在本轮处理）**：`setThinkingLevel` 同样会写 `defaultThinkingLevel`，可后续按同一模式加还原。

## composer 撤销 / 光标术语（glossary，2026 访谈确认）

- **原生编辑（native edit）**：浏览器自己执行的输入（输入法组合、原生 Shift+Enter、原生粘贴），参与 Chromium 的 contenteditable 撤销栈。
- **程序化插入（programmatic insert）**：JS 手动改 DOM（`insertTextAtCursor`、直接 `insertNode`、JS 调 `execCommand('insertText')`）——**会污染原生撤销栈**：之后按 Ctrl+Z 会把整个输入（含粘贴前输入的内容）整段清空。只有浏览器自己执行的插入可正常撤销/重做。
- **行首光标卡住（line-start caret stick）**：孤立 `<br>`（或 `<div>` 边界）之后的文本行开头，按 ← 键会把光标弹回本行末尾并卡住，永远到不了上一行。`<br>` 后紧跟一个 ZWSP（零宽字符）即可正常跨行——ZWSP 不显示、`serializeRichInput` 会剥掉。

### 决策记录：纯文本粘贴走浏览器原生插入（2026）

composer 曾对纯文本粘贴 `preventDefault` 后手动插 DOM——实测（真实 Chromium 回归脚本 `scripts/regression/composer-undo.mjs`）这会污染撤销栈：输入 "abc" 后粘贴 "hello world"，再 Ctrl+Z 会**清空整个输入**而非回到 "abc"。定案：**纯文本/富文本粘贴一律不拦截**（`useComposerAttachments.handlePaste` 只对文件/图片类 `preventDefault`），让浏览器原生插入保住撤销栈；富文本（Word/网页）来源的块级包装标签（div/p/li 等）由 `serializeRichInput` 按换行处理，不动 DOM 就不破坏撤销。**附件 chip 用 `execCommand('insertHTML')` 插入**（原生命令，可单独 Ctrl+Z 撤掉；jsdom 无 execCommand 时走手动兜底）。**Shift+Enter 同样改走原生**（不再手动插 br）。已知代价：图片+文字组合粘贴（chip+文本）仍为程序化插入，该组合的撤销不完美，属低频。

### 决策记录：所有 `<br>` 统一补 ZWSP 光标锚点（2026）

行首光标卡住的根因是孤立 `<br>`（来源：`renderRichTextFromPlain`/`renderRichFromSegments` 重建 DOM、原生 Shift+Enter、原生多行粘贴——原生多行纯文本粘贴实测插入单个含 `\n` 的文本节点，无 br）。定案：**新增 `anchorLineBreakCaret`（composer-editor-caret.ts），在两个 DOM 重建函数末尾 + rich-input 每次 input 事件后调用**（已带锚点的行跳过）。实测：粘贴后补锚点**不破坏**原生撤销（Ctrl+Z 仍只撤掉粘贴内容）。

## 斜杠命令拦截术语（glossary，2026-08-18 访谈确认）

- **内置命令泄漏（builtin leak）**：pi 内置斜杠命令（如 `/reload`、`/export`、`/login`）被桌面端当作普通聊天文本发给模型——命令既不执行也无任何提示。根因：pi 内置命令只在 TUI 层拦截（`interactive-mode.js` 的 submit 链），SDK 层 `session.prompt()` 只处理扩展命令/skill/模板，内置命令会原样落到 LLM；桌面端不用 TUI，必须自己拦截。曾误以为 `/compact` 按钮已生效——它此前走 `runExtensionCommand('/compact')`，同样把文本发给了模型，属于同一种泄漏。
- **生效 SDK 内置清单（active-SDK builtin catalog）**：pi 内置命令清单的唯一事实源 = 生效 SDK 的 `dist/core/slash-commands.js`（`BUILTIN_SLASH_COMMANDS`，纯数据模块）。worker 新增 `getBuiltins` RPC 从当前 `activeSdkPath` 同目录导入（失败回退内置包），经 `ipc:commands.builtins` 同步到 renderer（`slash-catalog.ts` 缓存）——跟随用户装的 pi 版本（内置/全局/用户 SDK）自动更新，不维护硬编码行为表。
- **路由表 + 安全默认（routing table + safe default）**：内置命令行为按名字查路由表：有原生实现 → 执行；未实现 → 默认 toast 拦截（可带指向等效 UI 的提示，如 `/login`→设置、`/name`→右键重命名、`/quit`→窗口关闭按钮）；未知 `/xxx` → 透传模型（与 pi TUI 兜底行为一致）。效果：新 pi 内置出现时**自动落入默认拦截**（有 toast），永远不会再静默泄漏；后续想原生实现某个命令 = 路由表加一个 case。
- **桌面原生命令（desktop-native command）**：桌面端自己实现的斜杠命令（含 pi 没有的 `thinking/clear/help/review/run/skills/prompts`），与 pi 内置重叠时（`model/compact/new/fork/clone/tree/settings`）以桌面实现优先。

### 决策记录：内置命令统一走生效 SDK 清单 + 路由表 + 安全默认（2026）

`/reload` 在 pi-app 里被当作普通文本发给模型并得到 AI 回复——暴露一类系统性问题：pi 内置命令在 SDK 层不拦截，桌面端不维护硬编码清单就会漏。定案：**拦截集合 = 生效 SDK 的 `BUILTIN_SLASH_COMMANDS`（worker `getBuiltins` 动态导入，renderer `slash-catalog.ts` 缓存 + 兜底名集）∪ 桌面原生命令**；行为走 `slash-exec.ts` 路由表，未实现命令 toast 拦截（`composer:toast.builtinNotSupported` + 可选 `builtinHints.*` 提示），未知斜杠透传。本次实装：`/reload` → worker `reloadResources()`（`session.reload`）；`/compact` 修正为 worker `compact` RPC → `session.compact()`（真压缩，不再发文本给模型）。popover 列表由 `commands.list` + `commands.builtins` 合并生成（`use-composer-slash.ts`），`composer-constants.ts` 的 `BUILTIN_COMMANDS` 退役为 `DESKTOP_NATIVE_COMMANDS`。新增 IPC 均已在 `packages/shared/ipc-channels.ts` 登记（有同步门禁）。
