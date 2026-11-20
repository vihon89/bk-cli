#!/usr/bin/env node
import { install, parseArguments } from './src/installer.mjs';

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('node install.mjs --client codex|workbuddy|zcode|qwen|openclaw|grok-cli|kimi|deepseek-harness|generic --skill images|video|episode|all [--base-url https://website.example] [--home ABSOLUTE_HOME]\n');
  } else {
    const result = await install(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write('本地 MCP 与 Skill 安装完成；仅验证 initialize/tools/list，未调用网站、未生成或扣费。\n');
    if (result.base_url_status !== 'configured') process.stdout.write('已有配置保持原样；网站授权可从系统安全存储提供缺失的网站地址。\n');
    if (result.native_capability_required) process.stdout.write('OpenClaw 原生 MCP 需先验证当前版本能力再明确导入；未修改 openclaw.json，已安装受管 CLI 回退 Skill。\n');
    else if (result.configuration_status === 'workbuddy_renamed') process.stdout.write('旧连接器已自动改名为 BK。请打开 WorkBuddy 的「自定义连接器」并信任 BK；如果列表还显示旧名称，请完全退出 WorkBuddy 后重新打开。原网站授权可继续使用。\n');
    else if (result.configuration_status === 'workbuddy_registered') process.stdout.write('WorkBuddy 已配置 BK；如界面提示，请信任并启用 BK。\n');
    else process.stdout.write(result.manual_import_required ? '请将输出的 stdio JSON 导入客户端；通过网站点击授权，无需填写 Key。\n' : '请重启当前客户端；通过网站点击授权，无需填写 Key。\n');
  }
} catch (error) {
  process.stderr.write(`${error.code || 'INSTALL_FAILED'}: ${error.message}\n`);
  process.exitCode = 1;
}
