# Pi 配置

安装 [Pi](https://pi.dev/) 后，把仓库克隆到任意目录，在仓库根目录运行：

```sh
PI_CODING_AGENT_DIR="$PWD/agent" pi
```

不用复制配置。Pi 会安装缺失的扩展；如果这个配置目录还没有凭据，首次使用时用 `/login` 登录自己的模型提供商。

如果 `~/.pi` 不存在或为空，也可以直接克隆到 `~/.pi`，之后在任何项目里运行 `pi` 即可。已有 `~/.pi` 时，不用替换它，使用上面的独立目录方式。

## 共享与本机设置

- Git 跟踪 `agent/settings.json` 和 `agent/web-search.json`。后者把 pi-web-access 的搜索工具命名为 `web_search_general`，避免和 pi-deepseek-search 的 `web_search` 同名。
- Pi 可能自动写回更新公告状态或设备 ID。提交共享配置时，请只暂存有意修改的设置，不要提交这些字段。
- 凭据、会话、信任记录、MCP 和模型端点配置不提交。代理和 `ssrf.allowRanges` 等网络例外也不应加入共享配置。
