# Lectern

一个独立开发的 Electron 桌面应用：经 tmux 管理终端编程代理的 TUI 会话，像讲台一样把它们摆在桌面上，用熟悉的聊天界面阅读和操作，目前支持 Claude Code。macOS 和 Linux 版可以操作本机或通过系统 OpenSSH 连接的机器；Windows 版只能通过 SSH 连接 macOS 或 Linux 机器（Windows 没有 tmux，不提供本机会话）。SSH 目标机器必须是 macOS 或 Linux。

```text
React 界面 ── 限定 IPC ── Electron 主进程
                          ├── 本地 shell
                          └── 系统 ssh ── 原有 SSH 端口
                                          ├── tmux + Claude Code TUI
                                          └── ~/.claude/projects/*/*.jsonl
```

Claude 的登录、模型调用、权限确认和原始会话文件始终属于运行 Claude Code 的机器。客户端不读取 OAuth 凭据、不使用 Agent SDK、不启动远程服务，也不要求远程安装 Node.js。为了显示对话，会经 SSH 将终端画面和 JSONL 内容读入本地内存；本地配置保存目录与连接信息。按当前用户授权，诊断日志默认额外记录正在读取的抓屏和 JSONL 原文，保存在本机并滚动清理，可在「诊断日志」中关闭原文记录。

## 开发运行

开发环境需要 Node.js 22.12+（推荐当前 LTS）和 npm。

```bash
npm ci
npm run dev
```

目标机器需已有 `claude`、`tmux`、POSIX shell 和常用命令（`ps`、`head`、`tail`、`wc`、`ls`、`awk`、`base64`）。请先在目标机器的正常终端完成 Claude 登录和首次设置。连接一台机器时，Lectern 会先用启动会话时的同一个 PATH 检查 `tmux` 和 `claude`：缺少时在对话区顶部常驻提示缺什么，并按该机器的系统给出可复制的安装命令（macOS 用 Homebrew，Debian/Ubuntu 用 apt，Fedora/RHEL 用 dnf；Claude Code 用官方安装程序 `curl -fsSL https://claude.ai/install.sh | bash`），装好后点「重新检查」；在此之前不会在这台机器上开始或续接对话。连不上的机器只显示连接问题，不会误报缺少工具。Claude Code 早于 2.1.300 时只提示升级，不阻止使用。

```bash
# 离线演示：真实 tmux / PTY / JSONL，不请求模型
npm run demo

# 编译与运行
npm run build
npm start

# 自动化验证
npm test
npm run test:e2e
npm run test:history

# 全量离线测试：类型检查、单元测试、构建和全部桌面端到端（Linux 无显示器时自动用 xvfb）
npm run test:all
npm run test:all -- --e2e-only --only e2e,settings-e2e

# 单平台调试产物写入 test-results/package/
npm run pack
npm run dist
```

开发、测试和发行都可以在 Linux 上完成，不需要 Mac。`npm run test:all` 自己隔离 tmux（私有 socket 目录，不碰正在使用的 tmux 会话），日志在 `test-results/test-all/`。GitHub Actions 只在推送 `v*` 标签时自动运行（也可在 Actions 页手动运行 CI 或兼容矩阵）：先跑测试（macOS、Windows 的类型检查和单元测试，Linux 上的 `npm run test:all`）和 Claude Code 多版本兼容矩阵，全部通过后才构建并发布。推送分支和 PR 不触发任何工作流。

发行新版本：升级 `package.json` 和 `package-lock.json` 的版本号，在 `src/shared/release-notes.ts` 顶部写好该版本的更新说明，提交后推送标签：

```bash
git tag v0.2.0 && git push origin v0.2.0
```

Release 工作流先跑全部测试和兼容矩阵，通过后在 GitHub 上构建 macOS（arm64、x64 的 DMG 与 ZIP）、Windows（x64 安装程序）和 Linux（x64 AppImage 与 DEB）安装包，生成 `SHA256SUMS`，以该版本的更新说明在 [sharinka0715/lectern](https://github.com/sharinka0715/lectern/releases) 发布正式（非草稿）Release；安装包同时保留为该次运行的 Actions artifacts。任一测试失败都不会发布。没有配置签名密钥时，Mac 包为 ad hoc 签名、Windows 安装程序未签名；可选密钥见 `.github/workflows/release.yml` 开头。

应用会在启动后和每隔几小时检查 GitHub 上的最新发行版（设置 →「更新」可关闭，也可从菜单「检查更新…」手动检查）。发现新版本时先询问：下载、稍后或跳过此版本；下载的安装包按 `SHA256SUMS` 校验后保存到「下载」文件夹，由你自己打开安装，不会自动安装。发行源取自 `package.json` 的 `repository`，即 https://github.com/sharinka0715/lectern 的 Releases。

演示模式需要本机 POSIX 环境和 tmux，使用独立临时目录、专用 tmux socket 和假 Claude 程序。退出演示应用会关闭该测试服务器。正常模式退出应用会保留 Claude 和 tmux 会话。

`npm run demo` 只连接隔离的测试程序，目录不可增删改；要连接本机真实 Claude Code，请使用 `npm start` 或直接打开打包应用，再添加真实工作目录。

## 连接机器

侧栏按「机器 → 项目文件夹 → 对话」排列。项目文件夹只能在具体机器上添加：点击机器行右侧的文件夹加号（SSH 机器先用「机器」旁的「+ SSH」添加）。第一次打开、还没有任何文件夹时，主界面提供「扫描本机目录」「添加本机文件夹」「添加SSH远程连接」三个入口。在机器上添加时，再点「工作目录」右侧的文件夹按钮，即可在应用内逐级浏览本机或当前 SSH 主机上的目录。进入项目文件夹后点「选择此目录」，再点「添加目录」。也可以直接输入 `/absolute/path`、`~` 或 `~/project`。名称留空时，侧栏会显示所选文件夹的名字。

已有本机 Claude 历史时，点击左侧「发现本机会话」，即可按原始工作目录查看会话数量并批量添加目录。（Windows 版没有本机会话，也就没有这一项。）已经添加的目录不会重复导入；原目录已不存在的记录会单独标出，需要先恢复目录才能按原位置续接。默认扫描保留原有配置环境；只有明确填写自定义 Claude 配置目录时才对新会话使用覆盖值。

远程连接使用 `ssh` 配置别名或 `user@hostname`。例如先在系统 `~/.ssh/config` 中配置：

```sshconfig
Host devbox
  HostName your-development-machine
  User your-user
  IdentityFile ~/.ssh/id_ed25519
  # ProxyJump jumpbox  # 如有需要，仍由系统 OpenSSH 处理
```

日常读取和发送使用 `BatchMode=yes` 和 `StrictHostKeyChecking=yes`，复用 SSH agent、密钥、ProxyJump 和已知主机配置。需要密码、动态验证码、密钥口令或确认新主机指纹的机器，点侧栏机器右侧的「登录」（或连接错误里的「登录 SSH」、设置里的连接），提示会逐条显示在应用内，确认后在后台保留一条 OpenSSH 复用连接，之后的命令都走这条连接。`ssh_config` 设置了 `ControlPath` 时连接放在那里，系统终端也能共用；否则放在 Lectern 的私有目录，退出应用时关闭。主机指纹变化时 OpenSSH 仍会拒绝连接。输入内容只交给本机 OpenSSH，不写入诊断日志。macOS/Linux 支持应用内登录；Windows 仍需先在系统终端登录。连接错误会显示在窗口中，读取自动退避重连；输入绝不自动重发。

在侧栏点「＋ SSH 机器」，填写显示名称、主机和可选端口；也可以点「从 ~/.ssh/config 导入」，在列出的 Host 中勾选要添加的机器（通配符规则不列出，导入的是别名，连接时仍按原配置解析地址、端口、跳板和密钥）。保存机器只在本机登记连接，不连接远端，也不会枚举远端所有 Claude 项目。手动添加文件夹后，Lectern 才扫描该项目的会话。同一地址的不同登录用户或端口分别归组；端口留空时遵循系统 SSH 配置。

macOS/Linux 客户端会优先复用系统已经认证的 SSH ControlMaster；`ssh_config` 已配置 `ControlPersist` 时完全沿用你的持久化设置，关闭客户端不会关闭它。没有这类配置时，客户端自己维护一条复用连接，之后的所有请求都走这一条，直到退出应用。Lectern 只查看名称以 `lectern-` 开头的 tmux 会话（它自己启动的会话都这样命名），不读取你自己开的 tmux 窗口；要让 Lectern 接管自己启动的 Claude，可以用 `tmux new -s lectern-名称` 开窗口。非交互 SSH 找不到 Claude 时，也可识别唯一的现有 nvm 安装，并将其可执行路径传给 tmux。存在多个 nvm Claude 时要求明确非交互 PATH，避免擅自选择版本；不会安装远端依赖或执行交互 shell 配置。

Windows 版只能通过系统 OpenSSH 连接 macOS 或 Linux 机器，tmux 和 Claude Code 装在目标机器上；不提供本机会话，也不使用 WSL。第一次连接某台 SSH 机器时，Lectern 会先确认它运行的是 macOS 或 Linux：如果是 Windows（默认 shell 为 cmd、PowerShell 或 Git Bash）或其他系统，侧栏把这台机器标为「不支持」并说明原因。Windows 版目前不支持应用内登录 SSH（密码、验证码需先在系统终端完成），也不复用 SSH 连接，命令会比 macOS 上慢一些。

默认继承目标已有的 `CLAUDE_CONFIG_DIR` 环境；没有该变量时，从 `~/.claude` 读取历史，启动时不额外设置此变量。只有工作目录高级配置明确填写自定义目录时，才对新进程覆盖 `CLAUDE_CONFIG_DIR`。这使默认启动继续使用原本的 Claude 配置位置。

## 界面和分屏

窗口顶栏位于目录树、聊天与预览面板的上方。按住空白处可以移动窗口。顶部的前进和后退按当前窗格切换最近看过的对话，文件夹菜单可切换本地或 SSH 工作目录。

输入框从一行开始，随换行和自动折行增高，清空后恢复为一行。小键盘的 Enter 与主键盘的 Enter 一样发送，Shift 加任一个 Enter 都是换行。把文件拖到对话里、粘贴（如截图）或点输入框左下角的「+」选择，会在输入框插入 @ 文件路径；SSH 机器上的对话会先把文件上传到那台机器的临时目录，再引用上传后的路径。在输入框里打 @ 可以按名称引用工作目录里的文件：打开对话时应用就在后台列好文件，候选立即出现；node_modules 这类依赖目录和文件特别多的文件夹只列名称，@ 进入后才读取；列表约 5 分钟在后台刷新一次，新建和删除的文件随之更新。缩放、改变窗口大小或输入框变高时，对话保持显示到最新消息。主回复结束但后台 Shell、子代理、Monitor 或工作流仍在运行时，侧栏和顶栏显示「后台运行中」。输入框下方的订阅额度：5h 显示距刷新还有多久，7d 显示刷新的时刻和 GMT 偏移（默认本机时区，SSH 机器在别的时区时可在「设置 → 外观」改选时区）。模型和推理强度在输入框右下角，紧挨着发送按钮；回复进行中时这里是停止按钮，输入框有文字时旁边另有「加入队列」「立即引导」两个图标按钮（悬停显示含义）；压缩对话期间只有「加入队列」，消息在压缩完成后发送。权限模式、上下文、缓存和订阅额度在输入框下方的状态栏，对话较窄时按组换行。Claude Code 版本号显示在对话右上角活动卡片的顶部。「设置 → 外观」可调整字号、主题和输入框最大高度。默认基准字号为 18 px，聊天正文约 17 px，目录和对话标题仍各占一行。左侧目录栏默认宽 304 px，拖动右边缘即可调整。双击边缘恢复默认，键盘聚焦边缘后也可以用方向键调整。重新打开窗口会恢复上次选择的宽度。窗口较窄时会先为聊天区留出空间。

在「设置 → 聊天排版」可分别调整对话行高（默认 130%）、输入框行高（135%）、工具提示字号（13 px）及正文宽度（默认 1000 px，可在 800–1200 px 之间调整）。修改即时生效，窄分屏中正文不会超出可用宽度。

默认在两段回复之间用一行汇总连续操作，包括运行的命令、读写的文件、代理、收发消息和失败次数。有可核对的编辑差异时显示增删行数。展开摘要可按原顺序查看每项操作，再展开单条查看输入、结果或差异。在「设置 → 外观 → 回复详细程度」中可切换为逐条显示。

Claude 列出的任务显示在对话末尾，分别标出待办、进行中和已完成。输入框上方显示原生终端当前活动、耗时和可用的 token 计数。

想看子代理在做什么时，在对话右上角活动卡片的「子代理」里点某一项的「查看对话」（或分区标题旁的按钮），分屏右侧会打开子代理栏：上方列出这个对话的子代理及其状态（运行中、已完成、已停止），下方是所选子代理自己的对话，包括它收到的任务、回复正文、工具调用和结果，思考过程与主对话一样折叠显示。子代理运行时内容随之更新；用 SendMessage 续接后，它重新显示为运行中，新的消息接在后面。很长的子代理记录先显示最近一段，向上滚动可继续读取更早的部分。本机和 SSH 机器上的对话都可以查看。

「设置 → 外观」可分别开关提示缓存倒计时和付费来源／订阅额度。缓存优先使用当前进程 statusLine 提供的到期点，按 JSONL 写入记录推算的时间会标为估计。官方订阅有相应上报时显示 5 小时和每周额度的剩余百分比。

将左侧的另一个对话拖到聊天区的左、右、上或下边缘即可分屏（当前显示的对话不能拖出自己的副本），两侧各自保留输入和原生终端状态，也各有自己的活动卡片和文件侧栏（分屏较窄时文件侧栏浮在对话上方）。同一个对话只会显示在一侧：分屏时把其中一个对话拖到另一侧，会合并回只显示它的单屏；拖入第三个对话则替换放下的那一侧；在侧栏点击另一侧已经打开的对话，会切到那一侧。拖动中间分隔线可调整比例，点击「关闭此分屏」后仍可从目录树返回该会话。要结束 Claude Code 进程，请使用对话工具栏的「关闭对话」。

在设置中可调整同一机器内的目录顺序，管理 SSH 主机别名与端口。用 ⌘K 或 Ctrl+K 可筛选机器、项目和已读取的对话。字体、主题、连接、项目和分屏布局保存在本机。分屏之间切换时，未发送的草稿仅留在当前窗口的内存中。

## 会话操作

新建和续接的对话默认以 auto mode 启动：由 Claude Code 自己判断工具调用的风险，低风险的直接运行。这只对 Lectern 启动的 Claude 进程生效（通过启动参数里的设置），不改你的 Claude 设置文件，也不会弹「是否把 auto mode 设为默认」的提示。在 Claude Code 的用户、项目或托管设置里用 `permissions.disableAutoMode: "disable"` 关掉 auto mode 时，对话按手动模式启动，工具权限在对话里的权限卡上确认。当前模式显示在输入框下方的状态栏。

打开已有对话和上翻历史时，最早一轮从当前分支的用户提问开始。如果读取窗口开头只有 Claude 的回复或工具回执，Lectern 会继续向前找这一轮的提问。到达文件开头仍有缺失时，显示能够恢复的内容。向上滚到顶部附近或点击「加载更早的消息」，默认每次读取 3 MiB，显示这段历史里能还原的所有轮次。在「设置 → 聊天记录」可调整每批大小，下次上翻生效。加载旧消息时会保留当前阅读位置。发生过 compact 的对话仍可翻阅原始 JSONL 里保留的压缩前消息。

Claude Code 有时会在交接时新建会话文件、复制一部分上下文。Lectern 核对旧文件的 `continued-in` 记录和新旧文件的压缩边界后，会把同一次交接的前后段显示为一个会话，侧栏标出段数。聊天按接手后的主线显示；点工具栏「交接前记录」可只读查看任一旧段，包括交接时未复制的提问或工具结果。如果旧段本身也曾切换对话路径，可点「查看其他路径的记录」查找已加载区间内的独有提问，继续上翻可读取更早记录。独立分支、碰巧同名或证据不足的会话各自保留，同名条目可用短 UUID 区分。原始 JSONL 保存在原处。

侧栏优先显示 Claude Code 已保存的自定义名称，其次是自动标题和会话摘要。没有这些记录时才使用首问。将鼠标移到会话行并点击铅笔，或聚焦会话行后按 F2，即可改名。活跃会话通过空闲 TUI 的 `/rename` 改名。纯历史会话按 UUID 在临时原生终端中用 `--resume` 和 `--name` 命名，完成后自动关闭。名称保存在原机器上，也能在 Claude Code 中看到。

输入 `/` 可查找常用命令、当前目标机安装的技能和项目命令。输入 `@` 可查找当前项目里的文件和目录。用 ↑、↓ 选择，按 Tab 插入，按 Esc 收起。候选项直接从目标机文件系统读取。

Claude 调用 `AskUserQuestion` 时，可以在当前分屏直接回答。单题单选点击选项即提交。要自己填写，选择「自定义回答」，写入原屏后再确认。带预览的单选题可以先查看各项预览，点铅笔添加本题的 Notes 备注，与最终选项一起提交。多选题可以同时勾选已有选项和自定义文字。多题可在核对页返回修改，也可以只提交已答部分或明确跳过全部题目。

想让 Claude 先解释选项，点「讨论此题」（Chat about this）即可回到对话。「取消问答」会结束本次提问并等待你的下一条消息。答案和备注由目标机上的 Claude Code 保存在原会话里。

点击聊天下方的「回退对话」，或某条已发送消息下的「回退到这里」，选择并确认后会恢复发送前的对话并将消息放回输入框。工作区文件保留。在聊天框单独发送 `/fork` 会将当前分屏切换至分支，原对话在另一个 tmux pane 中续接，两者均可从侧栏打开。在 Claude Code 2.1.326 上，切换当前进程会话的原生命令为 `/branch`。会话或代理投递的消息按原生来源标记在对话里，可与自己的发言区分。

要压缩当前上下文，等这一轮回复结束，在聊天框发送 `/compact`。也可以附上希望摘要保留的内容，例如 `/compact 保留已确定的方案和待办事项`。历史会话需要先点击「续接会话」。压缩由原机器上的 Claude Code 执行。压缩时，输入框上方跟随原屏显示耗时和 token 估算；这期间发送的消息只能排队，压缩完成后由 Claude Code 发送。完成后可展开「上次压缩完成」查看记录的耗时、压缩前后上下文大小。若桌面端看到了这次压缩的计数，还会显示原屏末次估算。Claude Code 2.1.326 的压缩完成记录未上报实际 token 消耗。「查看终端原屏」可核对当前状态或出错原因。翻看压缩前的消息只读取已有历史。

会话列表是当前所选工作目录内两类来源的合并：JSONL 提供历史，运行中的 Claude pane 提供实时状态，通过明确 UUID 绑定合并成同一项。「发现本机会话」按需扫描历史并添加目录；查看和导入历史只需读取会话文件。点击「续接会话」会在原机器上启动原 UUID 对应的 TUI。

| 发现结果 | 客户端处理 |
| --- | --- |
| 有 JSONL，没有运行中的绑定 pane | 显示历史，可用原版 `--resume` 续接 |
| 有运行中的绑定 pane，首次 JSONL 尚未创建 | 显示运行中、等待首次记录，允许正常输入 |
| JSONL 与运行中的 pane 都存在 | 按 UUID 合并一项，正文和实时画面共同显示 |
| pane 已退出，JSONL 仍存在 | 保留历史，取消运行中标记 |
| pane 已退出，且没有 JSONL | 移除空会话，不保留虚假历史 |
| 同一 UUID 被多个活跃 pane 绑定 | 提示冲突，暂停自动关联、发送和再次续接 |

左侧采用紧凑目录树：工作目录和会话各占一行，展开目录即显示其会话，收起目录不影响当前对话。侧栏只对已添加的文件夹刷新状态；当前会话单独实时轮询。普通 shell 或任意活跃 tmux pane 不会被当作受管理的 Claude 对话；需要确认前台 Claude 进程以及明确会话绑定。历史归属采用初始 cwd，后续工作目录变化不会把原会话从列表中移走。

| 对话右侧圆点 | 含义 |
| --- | --- |
| 无 | 纯历史，没有需处理的事项 |
| 绿色 | 已绑定仍在运行的 Claude pane |
| 闪烁绿色 | 等待回复或正在生成；系统要求减少动态效果时不闪烁 |
| 橙色 | 需要输入、授权或处理原生提示 |
| 红色 | 检测到连接或会话异常 |
| 蓝色 | 新回复已经完成但尚未阅读；不是正在生成的文字 |

文件夹平时不显示圆点，只汇总异常（红）、待输入（橙）和未读完成回复（蓝）。客户端用 Claude 的原生 PID 状态记录识别回复中和待确认，再结合当前可见画面识别错误、输入框和菜单。历史滚屏用于临时正文预览。已消失的 pane 无法证明退出原因时，仅保留为历史。

- **新对话**：启动普通 `claude --session-id <UUID>`，由 tmux 保持运行。
- **停止生成**。回复进行中，点击输入框右下角的方形按钮即可中断当前回合。会话保持打开，可继续发送消息。
- **关闭当前对话**：点击对话右上角「关闭对话」退出当前 Claude 并关闭对应的 tmux pane。已落盘对话转为历史，可在原处续接。尚无 JSONL 的空会话会从列表移除。
- **历史续接**：打开 JSONL 历史，点击继续会话，执行 `claude --resume <UUID>`。已绑定的活跃 pane 会直接复用。
- **已有 pane**：刷新目录后，客户端会将原生 PID 记录与前台进程、工作目录和 tmux 标识核对，按会话 UUID 自动认领对应的 pane。在缺少原生状态记录的 Claude Code 版本上，仍可用已有的 tmux 绑定或手动选择。原生 `/clear` 改变 UUID 后，旧会话失去该 pane 的输入权。
- **右键菜单**。侧栏的机器、文件夹和对话，聊天消息与工具记录，文件预览、终端和活动卡片都有右键菜单，可重命名、复制、引用到输入框、下载等。「归档对话」只把已停止的对话移出侧栏，原机器上的会话记录不变，可在「设置 → 回收站」恢复；正在运行的对话总会显示。输入框和选中的文字使用系统的剪切、复制、粘贴菜单。
- **切换方式与 Ultracode**。默认用 `/model 别名`、`/effort 档位` 一步切换，Claude Code 会同时把它设为这台机器上新会话的默认值；在「设置 → 会话」可改回只对当前会话生效的原生菜单。已配置的自定义模型（菜单描述为「Custom model (ID)」）按 ID 直接切换，不发请求；菜单看不到 ID 的模型仍通过原生菜单切换。推理强度菜单里的 Ultracode 开关只对当前会话生效；Pro 订阅默认关闭动态工作流，Lectern 启动的会话会为该进程打开它，可在同一页关闭。
- **模型与 effort**。候选列表由目标机上的 Claude Code 通过 SDK 接口一次给出（`claude -p` 只发 `initialize`、`get_settings` 两个控制请求，不发消息、不留会话记录），与原生 `/model` 菜单逐行一致，并带每个模型支持的推理强度档位。每台机器（及显式指定的 Claude 配置目录）在打开应用后第一次连上时读取一次，之后一直用到退出应用，不再在机器上保留查询窗口。按钮显示当前业务会话的状态栏值，旧会话可显示该会话上次确认的选择。只有点击具体选项才操作业务终端。
- **执行模式和上下文**。输入框下方显示原生页脚中的执行模式。Lectern 启动的会话显示状态栏报告的上下文占比和窗口容量。第一条请求之前，原版 CLI 可能只报告容量。其余会话可以从最近一次已完成请求的 JSONL 查看输入 token（普通输入、缓存读取和缓存写入）。悬停查看数值来源。
- **目录信任**：原生 Claude 启动时询问信任工作目录，界面会显示目录路径与「信任此目录并继续」「取消并退出」。只有显式点击才发送原生选择；每一步重新校验目录、会话和焦点。主目录若原生提示说明仅本会话有效，确认卡会明确标注。取消后正常返回工作目录，不创建假聊天气泡；普通工具授权不使用这个确认卡。
- **编辑差异**。Edit 卡片显示 Claude Code 写入 JSONL 的差异、行号和工具结果。等待批准时可查看拟修改的片段，NotebookEdit 显示所编辑单元格的前后文本。
- **文件预览**。正文里的文件名须定位成功，才显示为可点击的引用；未找到、有多个可能位置或无法确认的文本保持原样。只写文件名，或写的是相对子目录的路径（如 Claude 在子目录里说的 `build/out.mp4`）时，Lectern 在项目文件夹里找唯一的那个文件；明确写出的绝对路径即使在项目文件夹外，只要文件存在也可以点开。消息里粘贴的图片、工具回执里的图片和正文中已定位的 Markdown 图片，会在原位置显示约两行高的缩略图。点击后加载并放大原图，右键可以按原始分辨率复制或下载原件。无法生成缩略图时，点击图片图标仍可查看原图。对话右上角活动卡片的「附件」里，每张图片显示自己的方形缩略图（长边居中裁掉），条目滚动到可见时才读取；读取中、失败、格式不支持或文件过大（超过 32 MiB）时显示图标。按路径附加的图片（包括上传到 SSH 机器临时目录的截图）在所在机器缩小后再传回，文件没变就不再重新传输或解码；本机 macOS 上，桌面、文稿、下载等隐私文件夹里的附件不在后台读取（项目文件夹本身就在其中时除外），仍显示图标。打开或上翻历史时，内嵌图片的完整 base64 随当前页 JSONL 一起读回。桌面端先显示正文，再为可见图片异步生成缩略图。放大、复制或下载内嵌图片都使用已经收到的原图数据。点击其他文件引用、附件或工具路径可在右侧预览。Office 和 OpenDocument 显示提取的正文。目录可以逐层浏览，其他格式可通过保存对话框下载。查看 SSH 文件只走已有 SSH 连接。打开项目文件夹以外的文件不再单独确认；凭据、Claude 配置和系统目录不能打开。
- **原始终端与手动接管**：点击「终端」查看当前 TUI 原屏，默认只读。点击「接管终端」后直接在原屏输入中文、粘贴文本，使用方向键、Enter、Esc、Tab 和编辑快捷键，无需屏幕按键或独立草稿框。粘贴不会额外发送 Enter。接管期间可以浏览已读取的选项，结束接管后恢复聊天和设置切换。未知提示不自动批准；新建/续接使用左侧入口，登录仍在原机器完成。
- **发送**：多行文本通过 tmux 独立缓冲区和 bracketed paste 传入，再发送 Enter。每一步重新检查 Claude 是否处于前台，避免文本落入退出后的 shell。

有历史时，Claude 可能弹出切换模型的缓存提示。用户选择模型后，客户端只会确认目标名称完全相同的这类提示；其他未知确认仍停留在原屏。重新读取历史可能增加耗时和 token 用量。原机器的服务可能列出暂不可用的模型，是否能实际请求由该服务决定；API 错误且终端输入框为空时仍可通过设置控件重新选择。已确认原生重试输入框就绪时可发送新消息，发送前再次核对空输入框和 pane；不会自动重发失败请求。

登录、订阅、模型端点、远程依赖安装和云同步不在本客户端功能范围内。模型选择只使用原版菜单中已有的配置。无遥测、无自动上传。Markdown 中的远程图片不会自动加载。

窗口统计随原生状态栏回调更新。需要查看分项估算时，可以在原生终端手动执行 `/context`。该命令会追加会话记录。

重新打开软件后，SSH 项目先列出 JSONL 和文件签名。未变化的历史可以复用本机目录索引，新建、改写和删除会反映到侧栏。索引只保存导航所需的信息，包括原生名称、更新时间和已确认的续接关系。首问和聊天正文在打开对话时读取；只有首问可作标题的旧会话，重启后先用短 UUID 区分。对支持的原生版本，客户端会核对数字 PID 状态文件里的会话 UUID、tmux 位置及进程启动标记，结合原屏显示状态。稳定空闲时可复用短期抓屏，打开原始终端后恢复逐次读取。回退、技能请求和压缩摘要的回归样本在 `tests/fixtures/`。

## 实时显示的规则

每个人类输入对应一个稳定的 assistant 气泡。抓屏按当前输入或已知正文匹配，只提供临时预览；JSONL 的文本和工具块成为最终正文。最终正文采用原位替换，而不是把两份内容直接拼接。读取使用字节游标和 UTF-8 增量解码，处理中文分片、半条 JSONL、重复记录和文件截断。

**终端抓屏是启发式预览，不是 token 流协议。** Claude Code 更改 TUI 样式、折叠长输入、滚出缓存或显示复杂工具时，可能暂时不显示预览或出现排版变化；JSONL 落盘后会补全，原始终端始终可查看。不能承诺任意 Claude 版本的每一个中间屏幕都无损。最终正文以可解析的原始 JSONL 为准。

原生状态文件能证明会话身份时，TUI 内执行 `/clear` 后会把同一 pane 关联到新的 UUID。旧 UUID 有 JSONL 时仍可从历史查看。早期 Claude Code 版本缺少这份状态文件时使用显式绑定，需在 TUI 内切换后手动核对。

单次最多读 512 KiB 历史并继续增量加载；目录发现最多扫描 1,000 个 JSONL 文件，单条 JSONL 默认上限 16 MiB，超过时显示提示。当前会话完整历史保存在内存，不建立离线聊天缓存；开启原文诊断时会另存读取片段。超大历史尚未做 UI 虚拟列表。

「发现本机会话」每次最多检查 2,000 个文件、1,000 个项目目录，跳过符号链接和子代理目录。若初始 8 KiB 尚未出现原始工作目录，会在总预算内扩读至 256 KiB / 1 MiB，避免长内部记录遮住会话归属；无法确定或达到上限时会显示提示。

## 诊断与真实本机测试

左下角「诊断日志」可以打开日志目录、切换原文记录、写入问题备注并复制问题编号。日志贯穿 SSH/tmux、字节游标、抓屏变化、JSONL 解码、气泡合并和界面应用状态；错误包含堆栈与关联 ID。默认最多保留 10 个 10 MiB 文件，仅本机存储，无自动上传。

```bash
# 会实际启动本机原版 Claude，并发送一条不使用工具的模型请求
npm run build
npm run test:native

# 真实读取菜单、切换模型与 effort、发送一条短消息并恢复测试会话原选择
npm run test:native:settings

# 在隔离配置和独立 tmux 服务验证普通会话与 Lectern 状态栏并存，不发送模型消息
npm run test:native:statusline

# 真实验证目录信任：主目录只观察并拒绝，临时目录显式同意后进行三轮日常对话
npm run test:native:trust

# 实际 SSH 集成（会发送 Haiku/Sonnet 日常请求；不安装远端依赖）
LECTERN_SSH_HOST=your-ssh-alias npm run test:native:ssh

# 让真实 Claude 写/改 Python 小程序，核对文件工具、Bash 与 UI 的输入/输出
LECTERN_SSH_HOST=your-ssh-alias npm run test:native:ssh:tools

# 不连接 Claude 或 SSH，离线重放已记录的抓屏 / JSONL 和消息合并
npm run diagnostics:replay -- /absolute/path/to/diagnostics --output report.json
```

测试使用独立 GUI 配置和新建的临时工作目录，仍由原版 Claude 使用本机原有登录。报告、截图和原文日志保留在 `test-results/native-*/`。排障步骤、记录范围与重放限制见 [docs/diagnostics.md](docs/diagnostics.md)。

### Claude Code 兼容矩阵

`npm run test:cc-matrix` 用多个真实的 Claude Code 版本驱动 Lectern 桌面应用（Playwright + tmux），模型换成本机回环的假 Anthropic API，不发任何真实模型请求，也不读写你自己的 `~/.claude`、登录凭据或 tmux 服务。需要 Linux 或 macOS、`tmux`，Linux 无显示时自动套 `xvfb-run`。

```bash
npm run build
npm run test:cc-matrix                                  # 按 npm 当前发布计算的全部版本
npm run test:cc-matrix -- --versions latest,2.1.300     # 指定版本（也认 latest、stable）
npm run test:cc-matrix -- --scenarios new-chat,question # 只跑部分场景
npm run test:cc-matrix -- --keep                        # 保留沙箱目录，便于排查（--keep-failed 只保留失败的）
node scripts/cc-matrix/versions.mjs                     # 只看会选哪些版本
```

- **版本选择**（[versions.mjs](scripts/cc-matrix/versions.mjs)）：从 2.1.300 起，每 10 个补丁号取第一个已发布的版本，再加上 `latest` 和 `stable` 两个 dist-tag；`--versions` 或 `CC_MATRIX_VERSIONS` 覆盖，`--from` 或 `CC_MATRIX_FROM` 改起点。
- **安装**（[install.mjs](scripts/cc-matrix/install.mjs)）：每个版本装到 `CC_MATRIX_CACHE`（默认 `~/.cache/cc-matrix/claude-code/<版本>`），不装全局。新版本是「占位包 + 平台二进制可选依赖」，安装时一律 `--ignore-scripts`，再显式运行包里的 `install.cjs`，不行则直接解出平台包，最后用 `claude --version` 核对。
- **隔离**（[sandbox.mjs](scripts/cc-matrix/sandbox.mjs)）：临时 HOME 的 `~/.local/bin/claude` 指向被测版本（应用和远端 shell 都把它放在 PATH 最前面），独立的 `CLAUDE_CONFIG_DIR`（预置首次启动状态）和 `TMUX_TMPDIR`，环境变量从零构造：假 API 同时是 `ANTHROPIC_BASE_URL` 和 HTTP(S) 代理，任何外部连接都被拒绝并记入报告，连向 `*.anthropic.com` 判为失败。结束时按 PID 核对私有 tmux 服务和应用启动过的每个进程都已退出，残留的进程（如没退出的 `claude`）记为失败并停掉；每个版本限时 20 分钟（`--version-timeout` 秒数）。macOS 上 Electron 带 `--use-mock-keychain`，不碰登录钥匙串。
- **假模型**（[fake-api.mjs](scripts/cc-matrix/fake-api.mjs)）：流式 Messages API。提示词里的 `ccm:<名字>` 决定由哪个脚本回答，步数取自该提示之后的助手消息数，所以多轮工具循环可重复、可重试；另有慢速流、按名字挂起（`gate`）、压缩摘要、`count_tokens` 和模型列表。
- **场景**（[scenarios.mjs](scripts/cc-matrix/scenarios.mjs)）：新建和续接的对话是否以 auto mode 启动（包括用户自己默认手动模式的配置，以及用 `disableAutoMode` 退回手动模式的文件夹）、新对话与启动参数、目录信任卡、首次运行、流式预览、工具行、权限卡、AskUserQuestion、thinking、排队/引导/中断、`/compact`、改名、模型与 effort、状态栏、后台任务、历史翻页与续接、图片附件等。

结果写在 `test-results/cc-matrix/`：`report.md` 是「功能 × 版本」表，`report.json` 给机器读，每个版本目录里有假 API 请求记录、诊断日志，失败时另存截图和原屏。CI 的 [claude-code-compat.yml](.github/workflows/claude-code-compat.yml) 每个版本一个 job，每次运行都从 npm 重新计算版本列表；它随每个 `v*` 标签的发行流程运行（不通过就不发布），也可在 Actions 页手动运行并指定版本或场景，最后合并成一张表放在运行摘要里。

## 工程结构

| 目录 | 职责 |
| --- | --- |
| `src/backend` | 系统 SSH / 本地执行、tmux、会话发现、字节游标 |
| `src/core` | JSONL 解码、屏幕抽取、稳定消息气泡合并 |
| `src/diagnostics` | 结构化事件、原文捕获、关联 ID、脱敏和滚动文件 |
| `src/main` | Electron 隔离桥、配置存储、轮询和重连 |
| `src/renderer` | 目录会话树、Markdown 消息、聊天输入、原屏与显式终端接管 |
| `scripts/mock-claude.mjs` | 离线 PTY 模拟器 |
| `tests` | 合并、边界、安全输入、真实 tmux 集成验证 |

发行配置包含 macOS DMG/ZIP、Windows NSIS、Linux AppImage/DEB，由 GitHub Actions 在相应系统的 runner 上构建；正式分发需要配置平台代码签名（在仓库 Secrets 中设置 `MAC_CERTIFICATE`、`MAC_CERTIFICATE_PASSWORD`，公证再加 `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`；Windows 用 `WIN_CERTIFICATE`、`WIN_CERTIFICATE_PASSWORD`）。在其他 Mac 上打开时，macOS 会对从网络下载（带隔离属性）且未经 Apple 公证的应用提示「无法验证开发者」。要彻底不弹窗，需要 Apple Developer Program 的 Developer ID Application 证书并公证：把证书装进钥匙串（或设置 `CSC_LINK`/`CSC_KEY_PASSWORD`），再设置 `APPLE_API_KEY`、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER`（或 `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`）后在 Mac 上运行 `npm run dist:all`，electron-builder 会自动签名、公证并装订。没有开发者账号时，每台 Mac 需要处理一次：在「系统设置 → 隐私与安全性」点「仍要打开」，或执行 `xattr -dr com.apple.quarantine "/Applications/Lectern.app"`；用 `scp`、`rsync` 或 U 盘拷贝的应用没有隔离属性，不会弹出此提示。没有 Developer ID 的 Mac 可先运行一次 `npm run setup:mac-signing`，在登录钥匙串创建本机自签名身份；此后本机构建的签名要求保持不变，macOS 会记住对桌面、文稿等文件夹的授权，不会每次更新都重新询问。Linux DEB 的离线说明位于 `/usr/share/doc/lectern/README.md`。

## 设计参考

参考了 [edemko/claude-chat](https://github.com/edemko/claude-chat) 的 tmux 控制、JSONL 历史和会话绑定思路；本项目独立实现 Electron 架构，没有引入其 hub、PWA、Codex、账户系统或远程安装流程。启动参数以 [Claude Code CLI 文档](https://code.claude.com/docs/en/cli-reference) 为依据。
