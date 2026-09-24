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
