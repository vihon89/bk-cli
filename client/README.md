# BK爆款图片 / 视频 MCP

## 0.4.2 每宿主独立授权

受管MCP配置通过非秘密环境字段 `MUBAI_CLIENT_ID` 选择 `codex/workbuddy/zcode/qwen/openclaw/grok-cli/generic` 授权分区；bootstrap登录子进程也使用同一分区。同电脑不同软件的账号、待确认请求、退出和换号互相隔离，不复用另一个软件的grant。首次升级需为各软件重新完成网站授权；不复制、删除既有全局Key。未设置该字段的旧安装继续使用legacy全局分区，保持兼容。

已有受管entry升级只补充自己的 `env.MUBAI_CLIENT_ID`，保留其他字段；明确指向另一宿主时停止。OpenClaw CLI回退必须仅为该CLI子进程设置 `MUBAI_CLIENT_ID=openclaw`，包括login/status/logout，不能读取其他宿主或legacy凭据。直接手工CLI需使用对应 `--client` 处理授权，业务CLI则设置同一环境字段。高级显式 `MUBAI_API_KEY` 仍优先，网站login会提示先移除环境覆盖。

## 可选远程 MCP（需单独部署）

`node src/server-http.mjs` 提供标准无会话 Streamable HTTP `POST /mcp`，复用同一组业务工具与网站账号/积分账本，不另建钱包。此入口的代码与离线协议测试已提供；未部署，也未在云端 Agent 实际验收。安装默认仍使用 stdio。

管理员必须显式配置 `MUBAI_WEBSITE_ORIGIN`（网站 HTTPS origin）、`MUBAI_RESOURCE_URL`（对外 HTTPS `/mcp` URL）、`MUBAI_STATE_DIR`（服务专用私有绝对目录）。默认仅绑定 `127.0.0.1:8787`，生产由反向代理提供 HTTPS，并保留配置的公共 Host；不信任客户端传入的转发头。若明确需非回环绑定，还需 `MUBAI_HTTP_BIND` 与 `MUBAI_HTTP_ALLOW_NON_LOOPBACK=1`。允许的额外浏览器 origin 通过 `MUBAI_HTTP_ALLOWED_ORIGINS` 逗号列出。仅显式本地验收开关允许 loopback HTTP，不应据此开放公网明文服务。

端点发布 `/.well-known/oauth-protected-resource` 及 `/mcp` 变体。缺失或无效凭据返回401和指向本站资源元数据的 `WWW-Authenticate`；授权服务器元数据位于网站 `/.well-known/oauth-authorization-server`。客户端通过授权码＋PKCE取得面向该精确 resource 的 token，不写进安装配置、URL或对话。每个HTTP请求使用自身 bearer 请求网站 `/api/agent-oauth/session`，并以同token及 `X-Agent-Resource` 调用媒体网关。Cookie、全局环境 Key 或其他请求的账号均不能代替此身份。

远程 `upload_asset(file_path)` 明确不可用，不读取服务器文件或抓取任意URL。首版素材仅接受用户已上传本站、并由网站校验当前账号权限的 `asset_id`。批次网站批准流程与本地相同。

## 0.4.0 本地宿主适配范围

`--client` 接受 `codex|workbuddy|zcode|qwen|openclaw|grok-cli|generic`。这是配置适配范围，尚未在这些真实宿主中完成本版本验收，不代表客户端工具菜单、Skill 发现或实际调用已验证。

| client | 配置目标 | 合并结构 |
| --- | --- | --- |
| codex | `~/.codex/config.toml`，尊重 `CODEX_HOME` | `mcp_servers` |
| workbuddy | `~/.mubai-media-mcp/setup-templates/workbuddy-mcp.json`，需手动导入 | `mcpServers` |
| zcode | `~/.zcode/cli/config.json` | `mcp.servers` |
| qwen | `~/.qwen/settings.json` | `mcpServers` |
| openclaw | `~/.mubai-media-mcp/setup-templates/openclaw-mcp.json`，需先验证版本原生MCP能力再明确导入 | `mcp.servers`，`transport: stdio` |
| grok-cli | `~/.grok/config.toml` | `mcp_servers` |
| generic | `~/.mubai-media-mcp/setup-templates/generic-mcp.json`，只导出供人工配置 | `mcpServers` |

配置保留其他条目，同名 `mubai_media` 冲突时停止，不写入 Key。所有宿主共用受管本地运行时；OpenClaw Skill 安装到 `.openclaw/skills`，其他宿主安装到 `.agents/skills`，实际Skill发现仍需宿主验收。OpenClaw始终先导出模板，不写已有 `openclaw.json`，不猜测原生MCP最低版本；确认当前版本支持后才明确导入。无原生MCP时，其专属Skill指导读取受管current/runtime marker、核验源文件哈希后，通过同一CLI调用全部十项工具，保留系统安全存储、批次批准和原操作恢复。未知宿主选择 `generic` 不会写其私有配置。现有 JSON 配置必须是严格 JSON；不能解析的配置会保留并停止。

`login` 检测到有效 `MUBAI_API_KEY` 环境覆盖时停止，避免网页登录换号成功但业务仍使用旧环境身份。`status/logout` 输出 `credential_source`；退出不会删除外部环境变量。自动网站授权使用 Windows DPAPI/macOS Keychain/Linux Secret Service；Linux 需可用的 `secret-tool` 和系统钥匙串，缺失时停止且不降级明文。macOS/Linux 仍需实机验收。安全版本回滚及自动卸载尚未实现。

升级提交前在受管目录写入私有撤销日志；写入失败恢复旧文件，下次安装也会先恢复被终止的事务，再校验 Skill。恢复发现用户修改时保留文件并停止。日志可能含既有客户端配置的本地备份，不要上传或输出其内容。新操作锁和安装锁核验 PID 与唯一 owner 后，仅回收已确定退出的进程；活进程、无法核实的 PID、旧版文件锁或空锁目录均停止，不能按固定超时抢锁。旧版锁仍需按下文人工核对处理。

本地 stdio MCP 和 CLI，安装后在网站点击授权，使用已登录网站账号的积分生成图片、视频，无需复制或填写密钥。包含商品图、商品视频两份 Skill。包尚未发布到 npm，不能运行假设存在的 `npx mubai-media-mcp`。

## 安装与配置

推荐从网站“连接 AI 工具”页面复制统一安装指令交给当前 Agent。Agent 下载并审阅公开 Node 脚本后，执行安装、核验发行包，并自动打开网站确认授权。浏览器未打开时，使用终端输出的确认链接与短码继续同一请求。需要 Node.js 20 或更高版本和 npm。

统一入口使用纯 Node 核心模块，下载同源清单和 ZIP，校验 SHA-256、大小、精确文件名单、ZIP 文件头和 CRC 后才写入新临时目录。它支持 `--client codex|workbuddy`、`--skill images|video|episode|all`、`--home "隔离绝对目录"`；无法可靠识别客户端时会要求明确 `--client`。`--no-login` 仅用于不创建网站授权的安装验收。

也可下载 ZIP，核对网站公布的 SHA-256 后解压，手动运行安装器。ZIP 包含 `mubai-media-mcp` 目录：

页面从 `/api/agent-access/distribution` 读取版本与校验值，实际下载通过 `/api/agent-access/download` 返回 ZIP 附件。下载得到的应是 ZIP 文件；若浏览器返回网页，请回到连接页面重新获取安装包。

网站开放对话接入后，统一入口会申请对话权限。用户在网页同意后，连接器只同步后台允许的模型。WorkBuddy、Qwen Code 和 OpenClaw 的标准用户配置支持自动导入，重新打开模型选择器，必要时重启客户端。其他客户端会生成本地 OpenAI Chat Completions 连接配置。原生协议不兼容时，可直接使用下述 BK 命令。配置仅包含可撤销的本次对话授权凭据，请勿分享配置文件。同步不收费，发送对话后按实际 Token 用量扣除网站积分。

- 已安装的用户可在当前客户端运行 `login --client <当前客户端> --chat`，领取对话授权或刷新目录。已同意对话权限的账号可继续使用原授权。
- `chat-models --client <当前客户端>` 查询当前目录。`chat-quote --input 对话.json` 可估算积分，文件采用 OpenAI Chat Completions 请求结构。
- 用户确认积分预算后，可用 `chat-complete --input 确认.json`。文件包含 `confirm: true`、本次唯一的 `request_id` 和原请求 `body`。响应不明时复用该请求编号，避免重复扣分。

### 连接器版本

从 0.6.0 起，受管连接器在执行 BK 命令时检查网站发行版本。成功检查缓存 6 小时，网络异常后约 10 分钟可重试。在 Agent 中说「@BK 检查更新」可立即检查。也可以用受管 CLI 执行 `check-update --client workbuddy`。确认具体版本后，Agent 可以调用 `bk_update_connector`，或者运行 `update --client workbuddy --version <已确认版本> --confirm`。更新后重启连接器或 Agent，原网站授权和任务记录继续可用。

网站授权管理展示每个授权最近上报的连接器版本。授权有效时，版本检查也同步当前客户端由 BK 管理的对话模型。后台修改开放范围后，服务器按新目录立即校验。模型选择器需要刷新本地配置后才能显示变化。

Windows（PowerShell），将路径替换为实际解压目录：

```powershell
node "C:\tools\mubai-media-mcp\install.mjs" --client codex --skill images --base-url "https://your-website.example"
```

macOS（终端）：

```sh
node "/Users/your-name/Downloads/mubai-media-mcp/install.mjs" --client codex --skill images --base-url "https://your-website.example"
```

使用 WorkBuddy 时改为 `--client workbuddy`；安装视频 Skill 时用 `--skill video`，同时安装图片与视频则用 `--skill all`。`--skill episode` 额外安装整期视频制作 Skill（Remotion/FredTalk 工作流，含 `check_video_env` 与 `upload_video` 工具；制作规则以本机 FredTalk 仓库自带 Skills 为准）。安装器支持 `--home "绝对目录"`，将运行时、Skill 和配置全部安装到该隔离用户目录；此时忽略外部 `CODEX_HOME`。PowerShell 包装可用 `install.ps1 -Client codex -Skill all [-BaseUrl 地址] [-TargetHome 绝对目录]`。

安装器运行 `npm ci --ignore-scripts`，将共享运行时放在用户目录的 `.mubai-media-mcp/versions/<版本号>`，以 `.mubai-media-mcp/launch.mjs` 作为稳定启动入口。选定 Skill 安装到 `.agents/skills/mubai-product-images`、`.agents/skills/mubai-product-video` 或 `.agents/skills/bk-video-episode`。全部 Skill、Codex 与 WorkBuddy 共用运行时和当前网站账号授权。

同版本安装复用已验证运行时。升级时重新运行新包安装命令，保留已有 Key、其他 MCP 配置、旧运行时与 `.mubai-media` 操作记录。安装器遇到同名非受管配置、用户修改过的 Skill、符号链接路径或同版本内容冲突会停止，不覆盖它们。0.1.0 手工配置的旧入口若同名冲突，需先在本机审阅迁移。

安装器只执行本地 MCP `initialize` / `tools/list`。统一入口随后运行 `login`，授权完成后只读检查网站会话，不生成或扣费。安装后请重启客户端；未授权时工具列表仍可显示，业务调用提示登录。0.2.0 留下的 Key/网站占位值会被识别，网站授权可直接补足，无需手填。

网站确认页显示当前账号及权限，点击授权后客户端自动领取受限凭据，保存在 Windows DPAPI 或 macOS Keychain，不写入 Skill、客户端 JSON、命令行参数或日志。系统安全存储不可用时停止，不降级为明文。授权只用于网站允许的范围；生图/视频使用网站积分，不使用 Codex 模型额度。`service_enabled:false` 表示已连接但生成服务尚未开放。

手动安装后可从安装器输出的运行时目录执行：

```powershell
node "C:/Users/your-name/.mubai-media-mcp/versions/0.4.2/src/cli.mjs" login --base-url "https://your-website.example" --client codex --skill all
node "C:/Users/your-name/.mubai-media-mcp/versions/0.4.2/src/cli.mjs" status
node "C:/Users/your-name/.mubai-media-mcp/versions/0.4.2/src/cli.mjs" logout
```

`login` 默认立即返回待授权状态、确认码和链接，解除Agent命令输出缓冲造成的核对死锁。Agent必须立即向用户显示确认码；用户亲自在网页同意后，原命令追加 `--wait` 领取凭据并检查连接。`login --no-browser` 返回同样的信息但不打开浏览器；`login --force` 明确发起重新授权或更换网站账号。同账号重新授权会替换旧安装凭据；默认重复安装会复用有效会话。`logout` 只移除当前本机账号凭据，不切换到其他保存账号、不删除操作记录；`logout --revoke` 还会撤销服务器端安装授权，影响使用该授权的其他连接。授权响应中断或保存失败时保留同一加密请求重试，保存并读回凭据后才确认领取。

已有手工配置的非占位 `MUBAI_API_KEY` 继续优先使用，网站授权不会覆盖它；本机退出也不会删除用户自行配置的环境 Key。业务授权范围包括 `account:read`、`models:read`、`assets:write`、`image:generate`、`video:generate`、`tasks:read`。

可选项：

| 环境变量 | 用途 |
|---|---|
| `MUBAI_STATE_DIR` | 操作记录根目录，默认用户目录下 `.mubai-media`；所有客户端应使用同一目录 |
| `MUBAI_CREDENTIAL_DIR` | 可选的系统安全存储记录目录；默认从已安装运行时定位共享安装根的 `auth`，隔离测试应使用 `--home` |
| `MUBAI_ASSET_ROOT` | 只允许上传该目录内的本地素材，解析真实路径后验证 |
| `MUBAI_API_SECRET` | 仅用于开启 HMAC 的 JSON 请求；首版 multipart 上传不支持 HMAC，素材授权 Key 应按后台约定配置 |
| `MUBAI_ALLOW_HTTP_LOCALHOST=1` | 仅限本地测试的 loopback HTTP；生产 HTTPS 不需要 |

Windows 私有配置的 ACL 由操作系统账户管理；不要将配置放在公共或共享目录。操作记录不含 Key、提示词或原始素材，但应保留用于提交恢复。

## Codex

安装器仅在不存在 `mubai_media` 时向 `~/.codex/config.toml` 追加配置，保留原有文本和其他 MCP。默认安装尊重绝对路径 `CODEX_HOME`；显式 `--home` 始终使用该目录内 `.codex/config.toml`。已受管的同名项保持原样，不重写其中的 Key。

网站授权的凭据由 MCP 在每次工具调用时从系统安全存储读取；本机退出后不会缓存旧凭据。旧环境 Key 的兼容入口保留。以下仅为生成配置的示意，不需要重复追加：

```toml
[mcp_servers.mubai_media]
command = "node"
args = ["C:/Users/your-name/.mubai-media-mcp/launch.mjs"]
env_vars = ["MUBAI_API_KEY", "MUBAI_STATE_DIR", "MUBAI_ASSET_ROOT"]

[mcp_servers.mubai_media.env]
MUBAI_BASE_URL = "https://your-website.example"
```

安装器实际写入当前 Node 可执行文件的绝对路径。

## WorkBuddy

首次安装会生成 `~/.mubai-media-mcp/setup-templates/workbuddy-mcp.json`，可在“专家·技能·连接器 → 连接器 → 自定义连接器”导入。升级到 0.7.2 后，已导入且指向当前 BK 安装的 `mubai_media` 条目会自动改名为 `BK`，沿用原网站授权。打开「自定义连接器」并信任 BK，之后新开对话输入 `@BK`。列表仍显示旧名称时，完全退出 WorkBuddy 后重新打开。若存在同名冲突，升级会提示检查该条目。以下为首次导入示意：

```json
{
  "mcpServers": {
    "BK": {
      "type": "stdio",
      "command": "node",
      "args": ["C:/Users/your-name/.mubai-media-mcp/launch.mjs"],
      "env": {
        "MUBAI_BASE_URL": "https://your-website.example"
      }
    }
  }
}
```

多个本地客户端使用同一 `MUBAI_STATE_DIR` 有助于恢复同一操作。默认安装使用 stdio；可选远程 MCP OAuth/HTTP 入口需按上方说明单独部署，本版本验收未启动常驻公网监听。

## Skill 与使用流程

安装器已将选定 Skill 放入用户 `.agents/skills`。若 WorkBuddy 版本需要手动导入，可将对应技能文件夹通过“添加技能 → 上传技能”导入。业务生成前须完成上面的本机授权配置。

1. `get_account` 查看余额和限额；`list_models` 读取允许模型和参数规范。
2. 本地商品图调用 `upload_asset`，仅支持 PNG / JPEG / WebP，最大 10 MiB，返回 `asset_id`。
3. `quote_generation` 传 `operation_id/type/model/prompt/params/materials`。`materials` 为 `[{"asset_id":"..."}]`；参数遵循实时模型 schema，不硬编码型号。
4. 通过 `create_batch(operation_ids,max_total_score)` 汇总报价；用户在返回的同源网址亲自批准，`get_batch(batch_id)` 确认为 `approved` 后，再调用 `generate_image` 或 `generate_video`，传原 `operation_id/max_score/batch_id`。对话确认不替代网站批准。客户端使用持久记录里的报价、批次及幂等键恢复提交。
5. `get_task` 或 `wait_task` 读取任务状态。`wait_task` 最多 30 秒，超过时间只停止等待，不取消或重提生成。

首版后端每次报价只接受一个输出（`n=1`）。批量商品任务逐项创建报价和稳定操作 ID，核对总预算后逐项提交。首版只支持绑定商品参考图；复杂的首尾帧角色等未在服务端公开 schema 开放前，不由客户端猜测或拼接。

重新编辑已有任务时先查询其 `model` 和 `type`，报价沿用原模型并带 `source_task_id`。后端会校验该任务归属及原始模型，模型不可用或身份变化时拒绝；客户端不能选择默认模型替代。

CLI 使用相同工具、鉴权和操作记录：

```powershell
node C:/tools/mubai-media-mcp/src/cli.mjs get_account
node C:/tools/mubai-media-mcp/src/cli.mjs quote_generation --input C:/work/quote.json
node C:/tools/mubai-media-mcp/src/cli.mjs generate_image --input C:/work/submit.json
```

`quote.json`：

```json
{
  "operation_id": "product-launch-0001",
  "type": "image",
  "model": "从list_models取得的ID",
  "prompt": "保持商品外观，制作场景图",
  "params": {},
  "materials": [{ "asset_id": "上传返回的ID" }]
}
```

`submit.json`（30 仅为预算字段示例，不代表真实定价）：

```json
{ "operation_id": "product-launch-0001", "max_score": 30 }
```

## 幂等与恢复

- 为一次用户创作固定一个 `operation_id`。提交前将随机幂等键持久化，断线后用原操作重试不会生成新键。记录按网站 origin 和服务端返回的稳定 `account_id`、`api_app_id` 隔离；同一授权轮换 Key 后仍可恢复。授权转移账号后不能继承旧记录，客户端不会回退到缺少账号标识的旧分区。切换为新建的另一个授权时，应先在网站核对原任务。
- 同一操作更换模型、素材、提示词、预算或生成类型会被拒绝；不能自动重新报价后继续消费。已过期报价需要用户决定是否作为新创作重新提交。
- 网络错误可能发生在服务接受请求之后，不能据此认定失败；保留操作记录。`unknown` / `reconciling` 表示需查询或核对。
- 网站按 Asia/Singapore 准入日累计每日授权预算；首版额度不因退款恢复，实际扣费和退款以网站账本为准。
- 多进程使用同一操作时通过文件锁串行处理。进程崩溃遗留 `.lock` 时，先确认文件内 PID 对应的 MCP 进程已停止，保留同名 `.json` 操作记录和所有 `.tmp` 证据，只移除该操作的锁，再用原 `operation_id` 重试。不要清空状态目录绕过错误。
- 本地记录丢失时，先在网站核对任务与消费记录；不得把同一创作直接当新操作提交。

## 验证范围

源码仓库中的 `npm test` 仅连接进程内的 loopback mock 服务，覆盖真实 SDK stdio 握手和工具调用、CLI JSON 输入、丢失响应后恢复、并发操作、跨账号状态隔离、预算冲突和有界轮询。公开下载包不包含测试文件，无需运行此命令。测试不会调用真实上游或扣费。

依赖锁定官方 MCP SDK `1.32.2` 维护线、Zod `4.6.7` 和 TOML 解析器 `smol-toml 1.9.1`，0.3.0 未增加第三方依赖。测试覆盖 ZIP 边界、授权恢复、账号退出、旧 Key 兼容、Windows DPAPI 实际加解密，以及 Windows/macOS 路径。macOS Keychain 目前仅有系统命令模拟测试，未进行 macOS 实机验收。

当前不提供自动卸载命令。需移除时先停止客户端对应 MCP，审阅并移除其注册项及选定 Skill；保留网站 Key 管理信息和 `.mubai-media` 操作记录，避免未完成任务失去恢复依据。

参考：[Codex MCP](https://learn.chatgpt.com/docs/extend/mcp)、[WorkBuddy 连接器](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Connector)、[官方 SDK](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x)。


## BK爆款 / BK 与 @ 调用

升级至0.3.1后，每次安装图片或视频Skill都会同时安装品牌入口 `bk`。BK爆款与BK是同一品牌，示例：`@BK 给这个护肤品做一张上新主图，先报价`、`BK爆款 为咖啡机制作推广视频，先报价`。也识别`@BK爆款`，但只有已安装并启用的Skill且当前账号具备对应权限时才能调用。单独@称呼不是扣费授权。

这是文本语义识别，不承诺第三方客户端出现可选@菜单；以客户端实际已安装技能列表为准。Codex CLI/IDE显式调用为`$bk`，展示名为BK。WorkBuddy可在已安装技能中确认bk已启用；若没有@候选菜单，可直接发送包含BK名称的完整请求。

已有安装继续使用原账号授权和本地记录。更新不会建立新账号、重置预算或清除恢复记录；已有0.3.0用户需重跑网站安装指令升级，单纯刷新网页不会更新本机Skill。


## 按制作目标发起请求（0.3.2）

客户可以说：`@BK 把这个保温杯做成适合店铺上新的主图，先报价`，或`@BK 用这张商品图制作一条推广短视频，先推荐镜头方案和报价`。不需要填写模型编号或接口参数。Agent查询已授权的模型/参数和实际报价，推荐可执行方案，确认预算后提交。默认不展示bk编号，也不凭编号推测质量或速度；只有客户主动指定模型或询问技术细节时才解释公开名称。后台API编号与原任务模型仍保留，恢复/重新编辑不换模型。

## 默认模型与最低积分

- 用户明确指定公开模型名称时，查询`list_models`匹配后传`model`，不替换选择；重新编辑传`source_task_id`，始终锁定原模型。
- 用户未指定模型、也未要求最便宜时，省略`model`，`model_strategy=default`（或省略），由网站读取管理员设置的图片/视频默认模型。禁止Agent自行改选所谓默认。默认模型未配置、不可用、没有权限或超出预算时如实说明，等待处理，不静默换模。
- 用户说“最便宜”“最低积分”时，省略`model`并传`model_strategy=cheapest`。明确相同图片比例和尺寸；视频还必须明确时长。传相同素材与参数，由网站比较当前账号授权内可成功报价且规格匹配的全部候选，仅创建获选模型的一份报价，不由Agent只比较三项便声称最低。规格不明确时给出具体建议并询问，不用缩短时长或降低尺寸凑低价。
- 读取报价返回的`model`、`effective_params`和`selection`，用公开名称解释结果，默认向客户展示规格和产物数量，只有用户明确询问费用时才说明积分。最低积分不代表效果最好；排除无法同规格报价的模型，并列时服务端按目录ID稳定选择。
- 报价一旦建立就固定获选模型；同一operation_id重放不会因管理员改默认或价格变化而换模。报价过期后，未提交的新报价须用新操作ID并重新核对积分；已提交或未知状态始终恢复原操作，不重新选型。

0.4.0 的工具目录包含10项工具。安装验收经真实 launcher/current 指针启动链执行 initialize/tools/list，暂存运行时先使用隔离指针布局；提交配置后再验证实际安装入口，失败撤销本次配置与Skill更改。验收不传凭据、不调用业务工具。


0.4.2设备请求声明authorization_policy_version:2。新网页授权默认max_score=0/daily_score_limit=0/grant_days=0，服务端显式标记后才解释为不限额度与长期有效。客户端只接受expires_at=0且non_expiring=true，旧数据未标记0继续失败。登录请求10分钟、报价/批次期限、每次有限总预算与账本余额校验全部保留。旧客户端请求保持有限默认，升级后重新授权才能选择长期；不会修改已存在授权的额度和期限。服务端可随时撤销，永久客户端仍每次验证网站状态。

## 0.8.16 千问桌面端接入

在「工作 → 连接 → 添加」选择手动填写配置，协议选 Streamable HTTP，地址填 `https://aibaokuan.top/mcp`，Headers 留空。使用「去授权」在 BK 网页确认账号。查询时先在输入框选中 BK爆款，再说「图片模型积分查询」。实机验收 18 个图片模型均成功报价，未提交生成。

`--client qwen` 对应 Qwen Code 命令行。
