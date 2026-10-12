# AgenticReplay

<sub>[English](../../README.md) · **简体中文** · [日本語](README.ja.md) · [한국어](README.ko.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Español](README.es.md) · [العربية](README.ar.md)</sub>

AgenticReplay 是为调试 AI harness（运行框架）定制的 AI API 通信记录工具。
它记录受支持客户端的请求和响应，包括 API 实际返回的 reasoning/thinking 内容或摘要。
它无法获取 API 未公开的内部思考。捕获的正文会在保存前进行敏感信息脱敏，不完整的记录会被标记。

将 API 通信与工具结果、已捕获的 shell 命令和文件变更对照，了解运行框架的实际行为，
定位缺陷并指导改进。

## 安装

需要 Node.js 24 或更新版本、Git，以及已安装并配置好常用凭据的运行框架。

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

应记录 Claude Code 等发送 AI API 请求的运行框架，而不只是它的 MCP 服务器。
记录保存在该项目的 `.agenticreplay/runs/` 中；`last` 选择最新的记录。
导出的 HTML 可在浏览器中查看。

对于支持 `OPENAI_BASE_URL` 的自定义运行框架：

```console
agenticreplay record generic-openai -- node agent.js
```

将 `node agent.js` 替换为你的运行框架启动命令。对于通过 ChatGPT 订阅登录的 Codex，
使用 TLS 拦截：

```console
agenticreplay record exec --tls-intercept -- codex
```

记录时运行框架仍正常执行，API 调用可能产生费用。
记录可能包含项目敏感数据，分享前请检查内容。

其他运行框架请参阅[集成说明](../integrations.md)，调查示例请参阅
[调试失败的运行](../how-to/debug-a-failing-agent-run.md)。

## 许可证

代码采用 Apache-2.0。Trace 规范采用 CC BY 4.0，所以任何人都可以重新实现它。
