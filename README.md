# werewolf

Multi-Agent AI Werewolf with evolving memory systems.

## 本地启动

配置根目录环境变量并启动 PostgreSQL、Redis 后，在两个终端分别运行：

```sh
pnpm dev:api
pnpm dev:web
```

后端默认不监听文件变化，修改后端代码后需要手动重启。HTTP 接口和对局 Worker
在同一个进程中，自动重启会同时断开观战事件流、中止正在执行的对局。

Windows 下 Nest CLI 自动重启会强制结束旧进程；同一个任务多次中断后，可能因失锁次数超限而失败，
因此后端启动命令不启用 `--watch`。已有的监听进程需要先停止，再重新运行 `pnpm dev:api`。

中断的对局可在页面上点击续跑，从已保存的进度恢复。

## Langfuse 只读排查

项目使用固定版本的官方 `@langfuse/cli`。根目录 `.env.local` / `.env` 中已有的
`LANGFUSE_HOST`、`LANGFUSE_PUBLIC_KEY`、`LANGFUSE_SECRET_KEY` 可直接复用，进程环境变量优先。
该入口独立于后端运行，不需要启动 Worker。

```powershell
# 检查平台连接
pnpm langfuse:read health get

# 查看某一局的近期调用，按需将 io 加入 --fields 列表读取模型输入输出
pnpm langfuse:read observations list --session-id <对局ID> --limit 20 --fields core,basic,metadata,model,usage,prompt

# 根据上一条返回的 traceId 查看调用链；parentObservationId 表示父节点
pnpm langfuse:read observations list --trace-id <traceId> --all --max-items 200 --fields core,basic,metadata,usage,prompt

# 查询某一局的错误观测；实际请求需检查类型、名称及 metadata.status，不能把父节点重复计数
pnpm langfuse:read observations list --session-id <对局ID> --level ERROR --limit 20 --fields core,basic,metadata

# 查询 prompt 清单和指定版本；未指定版本时，原生 get 默认读取 production
pnpm langfuse:read prompts list --limit 20
pnpm langfuse:read prompts get turn/generate-system --version 3

# 查看可用命令或官方参数说明
pnpm langfuse:read --help
pnpm langfuse:read observations list --help
```

将示例中的尖括号占位符替换成实际 ID；PowerShell 中带逗号的字段列表也可整体加引号。
`--all` 达到 `--max-items` 时结果可能未取完，应检查返回的分页信息。
只读入口还支持 `metrics get`、`models list/get`；需要机器可读结果时加 `--json`，读取其 `body` 字段。
调用链查询统一走 observations v2；本机 Langfuse 4.15.0 使用已验证兼容的 CLI 4.10 契约快照。

`langfuse:read` 只开放查询命令，拒绝写操作、连接覆盖和密钥展示参数。该限制属于项目命令入口，
不改变 API Key 本身的权限；直接运行原生 CLI 不受此入口限制。排查内容与玩家决策输入相互独立。

验证查询入口：`pnpm test:langfuse`。完整工程检查：`pnpm check`。
官方参考：[CLI](https://langfuse.com/docs/api-and-data-platform/features/cli)。

## 人工问题记录与样本复用

通过命令将已完成行动加入 Langfuse 的 `werewolf/action-samples` 数据集，在平台的 Datasets
页面查看输入、人工说明、来源观测和后续对照结果。人工说明表示提交者的意见，不代表系统已判定错误。

```powershell
# 先列出对局的已完成行动，取得 actionKey
pnpm --filter @werewolf/api prompt:compare --game <对局ID>

# 将具体问题写入 UTF-8 文件，再保存样本；保存不调用模型
pnpm --filter @werewolf/api prompt:sample --game <对局ID> --action '<行动键>' --category fact --note-file E:\werewolf\docs\sample-note.txt

# 查询样本 ID；也可以直接在 Langfuse 数据集页面查看
pnpm langfuse:read dataset-items list --dataset-name werewolf/action-samples --limit 20

# 复用某个样本预览两个版本，确认后加 --run 执行 A/B
pnpm --filter @werewolf/api prompt:compare --sample <样本ID> --baseline 3 --candidate 4
```

类别为 `rule`（规则问题）、`perspective`（视角问题）、`fact`（事实问题）、`display`（展示问题）、
`strategy`（策略意见）或 `reference`（对照样本）。说明为 1–4000 字符，可用 `--dataset` 指定其他集合。
同一集合重复保存同一行动会更新人工说明。源调用固定为该行动最早一次生成调用，说明中应写清具体问题所在步骤。

样本仅保存当时的玩家输入、工具和模型条件；人工说明放在 metadata 中，后续事实与原决定不拼进玩家输入。
复用时校验平台样本与本地原行动一致，已归档、输入被修改或来源不符时停止。原行动及对应接入仍需保留；
当前只对比生成环节的 system 或 user 模板，不自动遍历整个集合。

默认仅生成本地预览；`--run` 才调用模型，每个版本一次，首个版本失败则停止，不自动重试或打分。
样本模式直接在原数据集条目下记录两次实验，不再另建单项数据集。集合的归档和人工说明编辑复用 Langfuse 页面。
平台结构化 input 不可直接套用普通文本 prompt 的 UI 实验，应使用上述命令保留项目的渲染和工具条件。

相关检查：`pnpm --filter @werewolf/api test --runInBand prompt-action.spec.ts prompt-sample.spec.ts prompt-experiment.spec.ts prompt-comparison.spec.ts`。

## Prompt 标签发布与回退

`prompt:label` 使用 Langfuse 原生标签切换已有版本。支持当前 8 个对局模板和 2 个经验模板，
移动前用项目渲染器检查必需变量和未知变量。该检查保证模板可以渲染，策略内容由使用者判断。

```powershell
# 预览当前标签、目标版本和两份正文；版本号仅为示例
pnpm --filter @werewolf/api prompt:label --prompt turn/generate-system --label production --version 4

# 确认预览后执行，--expected 填预览中当前版本；标签尚不存在时填 none
pnpm --filter @werewolf/api prompt:label --prompt turn/generate-system --label production --version 4 --apply --expected 3

# 回退就是将同一标签移回旧版本，当前版本仍需核对
pnpm --filter @werewolf/api prompt:label --prompt turn/generate-system --label production --version 3 --apply --expected 4
```

预览与结果写入 `docs/prompt-labels/<本次编号>/`，命令会打印目录。默认不写平台，显式 `--apply`
才移动标签；当前版本不符会停止，已在目标版本时不重复写入。只移动指定标签，不创建新版本，
不移除其他标签；`latest` 由平台维护，不能使用该命令修改。

也可用 `--label staging` 管理候选版本，但应用仍按原有方式读取 production。标签切换后，
新请求在 SDK 缓存刷新时取得新版本；当前缓存为 60 秒，已保存题面和快照保持原样。
发布与回退本身不调用模型，不会自动把 A/B 的候选版本发布到 production。

若结果为 `not_verified`，先用 `pnpm langfuse:read prompts get <名称> --label <标签>` 核查平台状态。
写请求不自动重试或回退；核对与写入不是平台原子锁，同一模板应避免并发发布。

相关检查：`pnpm --filter @werewolf/api test --runInBand prompt-label.spec.ts prompt-template.spec.ts langfuse-prompt-source.spec.ts`。
官方说明：[Prompt 版本与标签](https://langfuse.com/docs/prompt-management/features/prompt-version-control)。
