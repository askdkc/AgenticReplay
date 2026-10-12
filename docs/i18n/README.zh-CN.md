# AgenticReplay

<sub>[English](../../README.md) · **简体中文** · [日本語](README.ja.md) · [한국어](README.ko.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Español](README.es.md) · [العربية](README.ar.md)</sub>

AgenticReplay 记录 AI 运行框架的 API 通信，帮助定位问题并改进框架。
它捕获受支持客户端的请求和响应，包括 API 实际返回的 reasoning/thinking 内容或摘要。

将记录与工具结果、捕获的 shell 命令和文件变更对照，查找运行中出错的环节。

## 安装

需要 Node.js 24 或更新版本、Git，以及已配置好的 AI 运行框架。

```console
git clone https://github.com/askdkc/AgenticReplay.git
cd AgenticReplay
npm ci
npm run build
npm install -g .
agenticreplay doctor
```

## 使用

在要调查的项目中运行：

```console
agenticreplay record claude -- -p "Investigate the failing test"
agenticreplay show last
agenticreplay export last -o run.html
```

记录 Claude Code 等发送 API 请求的运行框架。记录保存在项目的 `.agenticreplay/runs/` 中；
`last` 选择最新的记录。在浏览器中打开 `run.html` 即可查看。

保存目录名采用 `YYYYMMDDHHmmss-agent-title-id`（UTC），仅包含小写 ASCII 字母、数字和连字符，
总长度不超过255个字符，标题不超过80个字符。优先使用会话标题，否则使用第一条用户请求；
隐藏敏感信息后转写为 ASCII。名称在记录结束时确定。现有的 `run_<id>` 目录和使用 run ID 的命令仍然可用。

对于读取 `OPENAI_BASE_URL` 的自定义框架，将 `node agent.js` 替换为启动命令：

```console
agenticreplay record generic-openai -- node agent.js
```

通过 ChatGPT 订阅使用 Codex 时，采用 TLS 拦截：

```console
agenticreplay record exec --tls-intercept -- codex
```

记录时的 API 调用可能产生费用。即使经过自动脱敏，记录仍可能包含敏感信息；分享前请检查。

其他框架请参阅[集成指南](../integrations.md)，调查示例请参阅
[调试失败的运行](../how-to/debug-a-failing-agent-run.md)。

## 许可证

Apache-2.0。追踪规范：CC BY 4.0。
