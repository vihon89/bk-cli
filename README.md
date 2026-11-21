# <img src="./assets/bk-icon.png" alt="" width="50" height="50" align="absmiddle"> BK 爆款 CLI

在终端或 AI Agent 中用 BK 账号制作商品图、商品视频和整期口播视频。客户端通过网页授权连接 BK，生成任务使用网站积分。

## 快速入门

需要 Node.js 20+ 和 npm。Windows 请使用 PowerShell。macOS 和 Linux 可直接使用终端。Linux 网页授权需要可用的 Secret Service 和 `secret-tool`。

官网提供[一句话安装入口](https://aibaokuan.top/home/#/ai-tool/install)。把下面这句话发给当前 AI 客户端即可：

> 请按 https://aibaokuan.top/install.md 为当前客户端安装 BK CLI。

### 从源码安装、授权和检查

在克隆的仓库根目录执行以下命令。构建源码包还需要 Python 3.9+。

```sh
npm pack
npm install --global ./bk-baokuan-cli-0.8.17.tgz
mubai-media --version
mubai-media install --client generic --base-url https://aibaokuan.top
mubai-media login --client generic --base-url https://aibaokuan.top --wait
mubai-media status --client generic --verify
```

Windows 如遇到 PowerShell 禁止执行 `.ps1` 启动脚本，使用 `npm.cmd` 和 `mubai-media.cmd` 执行对应命令。

安装会校验发行包、安装锁定依赖并检查本地 MCP 是否能列出工具。登录时在网页核对终端显示的确认码，并点击授权。远程终端可在 `login` 后追加 `--no-browser`，手动打开终端提供的链接。检查返回 `connected: true` 后可以运行 `mubai-media get_account` 查询当前账号的使用额度。安装、授权和查看账号均不产生生成费用。

在 AI Agent 中使用时，可从 [BK 官网安装页](https://aibaokuan.top/home/#/ai-tool/install) 复制 Agent 安装指令，或将上述命令里的 `generic` 替换为实际宿主，例如 `codex`。重启宿主后可尝试「@BK 查询图片模型」。宿主为多个时，终端默认使用 `generic` 授权（如果已安装），也可通过 `MUBAI_CLIENT_ID` 选择。不同宿主各自授权。

### 用一张商品图制作场景图

1. 查看可用模型。创建 `models.json`，内容为 `{"type":"image"}`，执行 `mubai-media list_models --input models.json`。返回的模型参数规范决定可用的比例和尺寸。
2. 上传已获授权使用的商品图。创建 `asset.json`，内容为 `{"file_path":"/你的绝对路径/product.png"}`，执行 `mubai-media upload_asset --input asset.json`，记下返回的 `asset_id`。Windows 的 JSON 路径可写成 `C:/素材/product.png`。
3. 创建 `quote.json`，用实际 `asset_id`、模型 ID 和该模型允许的参数替换示例值，执行 `mubai-media quote_generation --input quote.json` 获取实时报价。

   ```json
   {
     "operation_id": "product-scene-0001",
     "type": "image",
     "model": "从模型目录取得的ID",
     "prompt": "保留商品外观，制作一张自然光下的厨房场景图",
     "params": { "ratio": "1:1", "size": "1K" },
     "materials": [{ "asset_id": "上传返回的ID" }]
   }
   ```

4. 确认报价和本次预算后创建 `submit.json`，填入同一个 `operation_id` 和实际可接受的整数积分上限，例如 `{"operation_id":"product-scene-0001","max_score":30}`。运行 `mubai-media generate_image --input submit.json` 会提交付费任务。`30` 是示例上限，实际消耗以网站报价为准。
5. 用返回的 `task_id` 创建 `task.json`，内容如 `{"task_id":"提交返回的ID"}`。运行 `mubai-media get_task --input task.json` 检查状态和结果。提交后的网络中断可用原提交文件重试。同一创作应保留原操作 ID、预算和任务记录，避免重复生成。

视频、模型同步及各宿主的安装细节见 [客户端说明](client/README.md)。MotionGit 渲染适配器按当前用户权限执行。运行前应审核本地 `.motion` 原包及其代码，`render_motion_case` 需要该文件的绝对路径及审核后的 SHA-256。整期视频的 Remotion 依赖通过独立锁文件安装，并遵循各依赖自己的许可证。

## 从源码构建

`client/` 包含基于 BK CLI 0.8.16 的运行时代码和测试。0.8.17 使用单独版本号，包含整期视频依赖更新与 MotionGit 适配器完整性检查。`bin/` 提供 npm 命令入口，沿用网站安装的运行时、宿主配置和更新机制。

```sh
npm --prefix client ci --ignore-scripts
npm test
npm run build:release
npm pack --ignore-scripts
npm run smoke:package
```

构建发行包需要 Python 3.9+。运行时 ZIP 和清单生成在 `dist/runtime/`。npm 包包含入口、发行包和校验代码，运行时依赖由安装器按锁文件安装。验收从本地 npm 包启动，使用隔离用户目录和模拟服务。

本仓库采用 [Apache-2.0](LICENSE)。第三方依赖适用各自的许可条款。
