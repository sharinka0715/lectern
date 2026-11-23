# 本机诊断与问题复现

当前版本按用户授权默认记录抓屏、JSONL 片段、发送文本和合并后的消息原文。所有日志写入 GUI 所在机器，不自动上传；远端仍只需要原有 SSH、tmux 和 Claude Code。客户端不读取 OAuth 凭据文件，不转储进程环境。

## 使用方法

终端接管也使用相同诊断设置：`capture.terminal.input` 记录文本、普通字符或命名键，`backend.terminal_input.*` 记录 UUID、pane、buffer 装载、提交及错误。`controller.terminal_control.acquired/revoked` 记录本次观察的接管凭证与撤销原因；凭证不能跨会话、pane、重新观察或重新接管使用。排队输入在出错后取消、不重试；已交给 SSH 的输入不能撤回，但不会被转投到新选中的 pane。

手动期间和交还后的当前交互，聊天正文继续从 JSONL 更新，原屏不会作为正文预览。抑制标记在同一进程内切走再返回该会话时保留，下一次普通聊天成功发送后恢复预览。`controller.poll.apply` 的 `manualRecovery`、`terminalControlActive`、`observedStatus` 和 `observedStatusSource` 记录这一决策；回放会独立读取、校验原屏哈希并分类状态，不把未知菜单送进回复归并器。原文日志可能包含手动输入，因此登录和授权码仍应在原机器的原生流程中处理。

正常启动应用，添加本机目录或 SSH 目录并打开会话。左下角「诊断日志」显示本次运行编号、实际目录、原文开关、滚动上限、丢弃计数与写入错误。

遇到重复、漏字、错误关联或卡住时：

1. 在「诊断日志」填写发生的现象，点击「标记问题时间点」。保存问题编号；这会把备注和时间写进同一时间线并刷新到磁盘。
2. 点击「打开日志目录」。尽早复制整个目录到单独位置，避免后续滚动覆盖；退出应用后复制可得到稳定的文件集合。
3. 从工程目录运行下面的重放命令。它只读取本地日志，既不连接 Claude/SSH，也不重新发送消息。

```bash
npm run diagnostics:replay -- /absolute/path/to/saved-diagnostics --output /absolute/path/to/replay.json

# 多次切换或多个会话时，缩小范围
npm run diagnostics:replay -- /absolute/path/to/saved-diagnostics --session SESSION_UUID --watch WATCH_UUID
```

默认目录为 Electron 的 `userData/diagnostics`。macOS 开发运行通常位于 `~/Library/Application Support/lectern/diagnostics`；以面板显示的实际目录为准。正常退出应用会刷新日志，但保留用户的 Claude/tmux 会话。

原文开关立即生效并保存到本机偏好。关闭后只记录状态、长度、哈希等元数据，不会删除已存在的原文日志。日志可能包含工作内容；常见 token、密码赋值和私钥文本会做启发式遮盖，但不保证识别所有秘密，尤其是跨片段的秘密。不要把原文诊断当作可公开分享的匿名报告。

## 记录内容

每行是一个独立 JSON 事件：`schemaVersion`、`runId`、`seq`、UTC `timestamp`、`level`、`event`、`context` 和 `data`。同一运行通过 `seq` 排序；多个运行共享目录时通过 `runId` 区分。

| 环节 | 主要证据 |
| --- | --- |
| IPC / Controller / Backend / transport | `traceId`、`rootOperationId`、`parentOperationId`、`operationId` 串联调用；耗时、退出码、stderr 摘要和错误堆栈 |
| 目录与会话发现 | 工作目录、配置目录模式、JSONL 与 pane 数量、UUID 绑定、失效和冲突原因 |
| 轮询 | `workspaceId`、`sessionId`、`watchId`、`pollId`、pane、游标、文件大小、重置、后续片段和前台进程状态 |
| 原文 | `capture.jsonl` 保存本次实际读取的字节；`capture.screen` 保存含滚屏的原屏；`capture.viewport` 保存当前视口用于状态判定；input / messages 保存输入与消息状态 |
| 解析与合并 | 解码字节、半行缓冲、记录类型、跳过或重复原因、屏幕锚点、候选预览、权威正文接管及消息摘要 |
| 权限卡 | `controller.permission.card`：新卡片或卡片换了归属时记录 `cardId`、所属调用 `toolUseId`（会话记录还没有这次调用、只凭原屏出卡时为空）、`adopted`（会话记录跟上后原卡片认领调用）和原生的 `nativeWaitingFor` |
| 问答卡 | `controller.question.card`：同上，`cardId` 是问答卡的 `interactionId`；会话记录还没有这次 AskUserQuestion、只凭原屏和原生的「input needed」出卡时 `toolUseId` 为空 |
| 卡片被拒后重读 | `controller.card.reread`：问答卡或权限卡的点击恰在 Claude Code 往会话记录追加内容（只凭原屏出卡后写入的调用，或调用前后的请求、标题、模式等记录）时被版本守卫拒绝（未发送按键），重读一次后记录：`same` 为真表示重读仍是同一张卡（令牌不变，绑定到新位置，没有调用的卡认领了调用时 `toolUseId` 即该调用），同一个回答再发一次；为假时照旧报错 |
| SSH 会话名额 | `transport.session.queued`（排队超过 1 秒）、`transport.session.channel_yielded`、`transport.session.unconfirmed`、`transport.ssh.connection_setting`，见下文「SSH 会话名额」 |
| 展示与故障 | `controller.snapshot`、renderer 应用状态、渲染错误、未处理异常/拒绝、进程退出和 `incident.mark` |

实际送入对话解析器的 JSONL 字节使用 base64 保存，避免中文/emoji 恰好在读取边界分片后失真。每页按原始字节读取，包含该页内嵌图片的 base64。原文件游标仍按目标 JSONL 的物理字节计数。抓屏只在哈希变化时写原文；未变化的轮询引用之前的 `captureId`。每次非空 JSONL 增量都会记录，即使其字节和上次完全相同，防止重放时遗漏重复出现但合法的记录。

当前视口与滚屏在同一 shell / SSH 调用中读取。导航状态使用当前视口，防止旧生成/错误提示影响当前状态；消息预览仍可使用滚屏做匹配。未选中会话的导航刷新只记录状态元数据，不保存这些会话的原屏正文。选中会话的 `viewportCaptureId` 和 `viewportApplied` 会进入离线重放，旧版本日志没有这两个字段时保持旧格式兼容。

只有 `controller.poll.apply` 引用的数据才是实际送入 MessageDisplay 的输入。单独的原始 capture 可能来自随后被取消或丢弃的读取，不能见到 capture 就直接重放。乐观输入、打断和失败分别有对应事件；一直没被会话记录认领、在后发的消息被认领时去掉的乐观输入记为 `display.pending.retired`（含当时的预览摘要和是否已标为中断）。

## 文件上限与失败处理

- `events.000.jsonl` 是最新文件，`events.001.jsonl` 等是旧文件。默认每个最多 10 MiB、最多 10 个，总上限约 100 MiB；达到上限会删除最早内容。
- 单次原文最多记录 2 MiB。截断、脱敏和实际保存字节数有明确字段，原字节的长度与 SHA-256 仍用于核对。
- 写盘队列最多 16 MiB。超限会计数并记录 `diagnostics.queue_dropped`；写盘失败展示在面板中，不阻塞 Claude 的输入和回复。当前运行写盘失败后需修正目录问题并重启应用恢复记录。
- 目录和日志文件在 POSIX 系统分别限制为 0700 / 0600。同一 GUI 配置只允许一个实例，避免多个进程同时轮转。
- 日志有界，因此「开启原文」不代表永久保存所有历史。强制结束进程也可能丢失尚未刷新的末尾事件。

## 重放结果的含义

重放器按原始顺序驱动当前版本的 MessageDisplay，在每次快照校验消息集合、消息 ID、正文、工具、来源、状态和通知的摘要。报告包含各 watch 的 `validation`、`warnings`、`trace` 与最后的 `messages`；它本身也可能包含对话原文。

`complete: true` 代表该段已记录过程可重建，不代表 Claude 已完成回复。缺少开头、轮转缺片、队列丢弃、原文关闭、脱敏或截断都会明确降低完整性。重放使用当前代码；升级合并算法后旧日志出现摘要不匹配，也可能正好说明修复改变了行为，需要查看首个分歧，而不是认定日志损坏。

| 退出码 | 含义 |
| --- | --- |
| 0 | 检查点完整且匹配 |
| 1 | 参数或文件读写错误 |
| 2 | 可重建的消息 / 展示状态与原记录不匹配 |
| 3 | 证据不完整，或没有找到匹配的 watch |

遇到问题时，先用 `incident.mark` 时间和 session/watch 定位，再找首个不匹配的 snapshot。对照其前面的 poll.apply、引用的原屏/JSONL、解析决策和 renderer 状态，即可区分输入传输、读取游标、TUI 抽取、正文合并或界面更新的问题。

## 真实本机自动测试

```bash
npm run build
npm run test:native
```

该测试不会由 `npm test` 隐式触发。它实际调用已安装的 `claude`，新建独立 GUI 配置与空工作目录，使用本机原有 Claude 登录，确认自己创建的测试目录后发送日常对话请求（默认晚饭建议，不使用工具或文件）。因此会产生真实模型用量。登录或其他非目录授权需要在原版 Claude 中处理，脚本不会自动登录或接受工具权限。

测试会检查 JSONL 正文、单一气泡、若观察到预览则 ID 保持不变、无日志丢弃或写盘失败。结束只清理自己创建并核对 UUID 的 tmux 会话；保留 `test-results/native-时间/` 内的报告、截图、工作目录和诊断日志。单条短回复可能在第一次轮询前就落盘，不能仅凭它证明所有慢流式场景；相应逐段、延迟落盘和断线场景由离线 E2E / 单元测试覆盖。

开发时可用 `LECTERN_USER_DATA` 隔离 GUI 配置、`LECTERN_LOG_DIR` 指定本机日志目录、`LECTERN_DIAGNOSTIC_CONTENT=0|1` 覆盖本次启动的原文开关。并行测试必须使用各自独立的配置和日志目录。

## SSH 会话名额

目标 sshd 每条连接最多同时开 `MaxSessions` 个会话（默认 10），超出时跳板报「open failed」。Lectern 按主机计数自己开着的会话：常驻命令通道、终端接管的常驻流和一次性会话（可取消的扫描、上传下载、通道全忙时的命令），一个会话从启动 ssh 客户端算到客户端退出。复用用户自己的 master 时（`mode: "shared"`）每台主机最多 4 个、其中通道最多 2 条；走 Lectern 自己的连接时（`mode: "exclusive"`，设置里关掉「复用已有的 SSH 连接」，或这台机器没有用户的 master）最多 8 个、通道最多 3 条。

- `transport.session.queued`：一次排队超过 1 秒时在排到时记一条（超过 10 秒为 warn）。`host`、`port`、`mode`、`limit`、排队的用途 `use`（`command` / `terminal`）、结果 `outcome`（`place` 拿到名额，`channel` 改走变空闲的通道，`aborted` 被取消）、`waitedMs`，以及当时的占用 `channels`、`terminals`、`commands` 和仍在排队的 `waiting`。
- `transport.session.channel_yielded`：名额已满且有请求在排队，一条空闲通道被关掉把名额让出来（随后在有空余时重开）。
- `transport.session.unconfirmed`：超时或取消后，ssh 客户端在关闭输入 5 秒后仍未退出、只能杀掉，远端会话可能还在；这个名额再多占 `holdMs`（30 秒）才归还。正常情况下关闭输入后远端包装立即结束整个进程组，客户端随即退出，不会出现这一条。
- `transport.ssh.connection_setting`：切换了「复用已有的 SSH 连接」（`reuseUserMasters`）；`transport.ssh.private_master_stopped` 是重新开启复用时，对已有用户 master 的主机，Lectern 自己的 master 收到 `-O stop`（不再接新会话，现有终端接管结束后退出）。`transport.ssh.connection`（debug）逐条记录走用户 master 还是私有 master，`transport.channel.opened` 带当时的 `mode`。

## 模型与 effort 操作

SSH 设置操作可以按同一个 `operationId` 对照 `transport.command.request` 和 `transport.command.exited`。`sshCommandBytes` 是 OpenSSH 远端命令的字节数，固定命令 `exec sh -s` 为 10 字节。`stdinBytes` 是单独传入的脚本和编码后输入的总字节数。退出事件保留 OpenSSH 的状态码和标准错误。

按会话 UUID 和 pane ID 可以区分两种设置事务。查询窗口的 `settings.get` 记录后台枚举，`capture.settings.viewport` 保存变化的原生画面，`capture.settings.input` 记录发起的设置命令。用户在桌面端展开或收起已经缓存的菜单时，业务会话中应当有零条设置输入。用户确认切换后，对应业务 UUID 的 `settings.set`、`settings.apply` 与 `settings.verified` 分别记录开始切换、仅本会话提交和回执核验。核验使用同一次提交后 Claude 显示的结果。

启动时，有受管会话的机器在后台各读取一次 model 和 effort。分屏、目录和会话共享本次运行的选项。读取期间仍可操作业务会话。 `controller.snapshot` 的 `settings.initialization/loading/error` 记录查询进度和失败原因。未完成的查询可以通过菜单重试，已完成的列表在本次运行内继续使用。业务 pane 的当前选择来自自身的原生状态栏或上次确认的设置。短期、单次的原生写入凭据在确认切换时生成。

同一快照新增 `executionMode` 与 `contextUsage`。模式证据来自当前输入框 footer，菜单暂时遮挡时保留本 pane 上次明确观察。上下文按最后完成请求的 JSONL `usage.input_tokens + cache_read_input_tokens + cache_creation_input_tokens` 计算，记录 messageId、模型、时间与各部分数值；输出 token 单列，不加进上下文输入。读取分片期间和模型回复期间不把中间值作为最终用量。API 错误保留上次成功值，压缩边界会清空，缺失字段保持未知。原始 JSONL 样本不含可靠窗口容量，`windowTokens/usedPercent` 为 null。消息重放器核对正文与展示状态；这些遥测字段另由原始 JSONL 对照和 parser/Controller 测试验证。

`controller.poll.apply.panePid` 记录设置缓存对应的进程生命周期；同 pane ID 的 PID 更换会重新初始化。`controller.snapshot.nativeInputReady` 表示当前 viewport 严格识别为空输入框，允许明确 API 错误页上的新消息；发送时仍再次核对 pane 与空输入框。`Once fixed, resend your message` 在取消菜单和仅本会话切换后可能保留，识别依赖实际错误与明确回执，不用任意占位文案替代证据。

向业务会话提交设置期间，普通聊天输入被锁定，原生终端仍更新。`controller.poll.apply.screenApplied=false` 和 `controller.screen.skipped` 的 `native-input-transaction` 原因表示菜单画面没有进入回复预览；JSONL 游标继续正常读取。事务跨越的延迟抓屏也会被排除，避免操作结束后把旧菜单当成新回复。离线重放保留这些决定以及设置操作期间的断线/错误状态。

`npm run test:native:settings` 会实际切换、发一条消息并恢复测试会话原选择。若目标服务菜单中有不可用别名，可设置 `LECTERN_TEST_MODEL_LABEL` 为刚从本机原生菜单观察到的标签以选择测试目标；脚本仍要求该标签存在于本次动态读取结果中，不提供预设列表。原服务拒绝请求与客户端解析失败均保存独立报告、原屏和问题编号。

## 目录信任与日常多轮测试

`npm run test:native:trust` 先观察真实主目录提示并明确选择退出，再验证新建的空临时目录的拒绝、再次提示、显式信任与就绪；随后通过同一 Claude TUI 连续进行整理书桌、雨天安排、晚饭建议三轮日常对话。主目录不接受信任、不发送模型请求。可用 `LECTERN_TRUST_DIALOGUE_TURNS=0` 单独重测确认流程，不增加模型用量。

目录确认来自原版 Claude 的当前 viewport。`directory_trust.observed` 是只读观察；`directory_trust.navigate` / `submit` / `closed` 分别记录用户决定后的焦点导航、Enter 提交和关闭核验，`capture.directory_trust.viewport` 保留每一步原屏。日志包含精确 cwd、会话 UUID、pane、信任范围、用户决定和原生焦点。UI 期间的 `trust-start` / `trust-end` 仅改变输入锁，不生成聊天消息；明确取消会停止观察尚无 JSONL 的启动会话。

设置票据与信任票据均为单次使用。目录确认只因工作目录配置变更或真正的 invalidate 而失效；同目录新建其他会话不会让已提交的 No 无法核验。原生确认不确定时不自动重发；未知授权不套用目录信任按钮。

真实对话脚本共用 `scripts/native-dialogue.mjs`：原单轮测试使用晚饭建议，模型切换测试使用礼貌改约，多轮目录测试轮换其他日常场景。`LECTERN_TEST_SCENARIO` 可指定 helper 导出的场景。校验包括场景相关要点、无工具调用、完整 JSONL、无 API 错误、稳定气泡 ID 和原文日志；不再要求模型机械复述固定测试标记。此前保存的固定标记历史仍可通过原报告续接，不会改写旧 JSONL。

## 实际 SSH 集成测试

`LECTERN_SSH_HOST=your-ssh-alias npm run test:native:ssh` 使用独立本地 Electron 配置与日志，通过系统 SSH 扫描并导入目标历史，读取原有会话并验证只读 SHA-256，再对一个无活跃绑定的旧 UUID 做无消息续接。较大历史须等 `connecting` 结束、JSONL 全部读完后比较；第一块 512 KiB 不能代表完整会话。

模型请求只在新建的远端 `/tmp/lectern-ssh-*` 测试目录中进行。脚本先验证目录 No/Yes，再从实时 `/model` 菜单选择 Haiku 和 Sonnet，从 `/effort` 读取可用选项。测试限制拒绝 Opus 和模糊的 Default；这不是生产代码的模型预设。三轮日常场景按报告中的 scenarioOffset 轮换，可用 `LECTERN_SSH_SCENARIO_OFFSET` 指定。每轮记录是否观察到非空预览；观察到的预览必须与最终 JSONL 同一 ID，快速直接落盘的回复据实记录。中间关闭自己的 pane，再从原 UUID 续接。最后额外保存测试专属原始 JSONL，以便独立核对实际模型和正文。

结束仅关闭核对过 UUID、名称及绑定的测试 pane。原有 tmux 窗口和用户 SSH ControlMaster 保留；没有安装远端依赖、启动远端服务或修改用户 shell/tmux 配置。`transport.ssh.connection` 记录复用用户连接还是客户端私有连接，`backend.runtime` 记录实际 Claude 可执行路径和版本。所有原屏、设置、信任、JSONL 游标及问题编号仍写入本机测试目录。

## 原生代码工具验证

`LECTERN_SSH_HOST=your-ssh-alias npm run test:native:ssh:tools` 让原版 Claude 在全新的 `/tmp/lectern-tools-*` 目录写 `stats.py` 和标准库 `unittest`，第二轮修改功能并重测。程序文件全部由模型工具创建/修改，测试器只建立空目录，读取原始记录与文件并独立验证结果。模型来自实时 `/model` 的 Sonnet 选项，不调用 SDK，也不安装远端依赖。

脚本验证实际 `Write`、`Read`、`Edit`、`Bash`，并记录是否观察到独立 `Glob/Grep`；若原生会话以 Bash 的 find/grep 进行搜索，不将其冒称为独立工具调用。一次明确安排的 Bash exit 3 用于核对错误输出，其后程序测试应正常完成。每条 `tool_use.id` 必须匹配 `tool_result.tool_use_id`，工具参数、结果、is_error 和展开后的 DOM 文本逐字核对；`data-tool-id/name/state` 是稳定检查标识。工具结果不能生成新的用户气泡，停止并原 UUID 续接后所有消息/工具字段必须一致。

若模型两轮已经完成、后续验证中断，可传入该测试报告：`npm run test:native:ssh:tools -- /绝对路径/test-results/native-ssh-tools-时间/report.json`。该模式只继承和验证已有两轮，不再发模型消息；报告明确保存 sourceReport 与 inheritedRequests。

未识别的原生提示不会被客户端盲目确认。此次工具运行遇到一次原生 Auto mode 说明，确认其完整正文、Enter 提示和所属 UUID 后由测试人员单次确认；原屏与操作记录分别保存在来源目录的 `native-auto-mode-notice.txt` 和 `manual-notice-confirmation.json`。这不表示 GUI 已支持自动处理该类提示，也未改变端点、计费或权限配置。
