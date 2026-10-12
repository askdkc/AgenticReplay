# AgenticReplay

<sub>[English](../../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · **한국어** · [Deutsch](README.de.md) · [Français](README.fr.md) · [Español](README.es.md) · [العربية](README.ar.md)</sub>

AgenticReplay는 AI 하네스 디버깅에 맞게 커스텀한 AI API 통신 로거입니다.
지원하는 클라이언트의 요청과 응답을 기록하며, API가 실제로 반환하는 reasoning/thinking
내용이나 요약도 포함합니다. API가 공개하지 않는 내부 사고는 가져올 수 없습니다.
수집한 본문은 저장 전에 민감 정보를 마스킹하며, 불완전한 기록에는 그 상태를 표시합니다.

API 통신을 도구 결과, 수집된 셸 명령 및 파일 변경과 함께 살펴보면 하네스의 실제 동작을
이해하고 결함을 찾아 개선하는 데 도움이 됩니다.

## 설치

Node.js 24 이상, Git, 그리고 평소 사용하는 인증 정보로 실행할 수 있는 설치된 하네스가 필요합니다.

```console
git clone https://github.com/askdkc/AgenticReplay.git
cd AgenticReplay
npm ci
npm run build
npm install -g .
agenticreplay doctor
```

## 사용법

조사하려는 프로젝트에서 실행하세요.

```console
agenticreplay record claude -- -p "Investigate the failing test"
agenticreplay show last
agenticreplay export last -o run.html
```

MCP 서버만이 아니라 Claude Code처럼 AI API 요청을 보내는 하네스를 기록 대상으로 감싸세요.
기록은 해당 프로젝트의 `.agenticreplay/runs/`에 저장되며, `last`는 가장 최근 기록을 선택합니다.
내보낸 HTML은 브라우저에서 확인할 수 있습니다.

`OPENAI_BASE_URL`을 지원하는 사용자 정의 하네스의 경우:

```console
agenticreplay record generic-openai -- node agent.js
```

`node agent.js`를 하네스 실행 명령으로 바꾸세요. ChatGPT 구독으로 로그인한 Codex에는
TLS 가로채기를 사용하세요.

```console
agenticreplay record exec --tls-intercept -- codex
```

기록 중에도 하네스는 평소대로 실행되므로 API 호출에 요금이 발생할 수 있습니다.
기록에 프로젝트의 민감한 데이터가 포함될 수 있으니 공유 전에 내용을 확인하세요.

다른 하네스는 [연동 안내](../integrations.md), 조사 예시는
[실패한 실행 디버깅](../how-to/debug-a-failing-agent-run.md)을 참고하세요.

## 라이선스

코드는 Apache-2.0. 트레이스 명세는 CC BY 4.0이므로 누구든 다시 구현해도 된다.
