# AgenticReplay

<sub>[English](../../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · **한국어** · [Deutsch](README.de.md) · [Français](README.fr.md) · [Español](README.es.md) · [العربية](README.ar.md)</sub>

AgenticReplay는 AI 하네스의 API 통신을 기록해 오류 분석과 개선을 돕습니다.
지원하는 클라이언트의 요청과 응답을 수집하며, API가 실제로 반환하는 reasoning/thinking 내용이나 요약도 기록합니다.

로그를 도구 실행 결과, 수집된 셸 명령 및 파일 변경과 비교해 문제가 발생한 지점을 찾을 수 있습니다.

## 설치

Node.js 24 이상, Git, 사용 설정을 마친 AI 하네스가 필요합니다.

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

Claude Code처럼 API 요청을 보내는 하네스를 실행해 기록합니다.
로그는 프로젝트의 `.agenticreplay/runs/`에 저장되며, `last`는 가장 최근 기록을 선택합니다.
브라우저에서 `run.html`을 열어 확인할 수 있습니다.

저장 디렉터리 이름은 `YYYYMMDDHHmmss-agent-title-id`(UTC)입니다. 소문자 ASCII 문자, 숫자,
하이픈만 사용하며 전체는 255자 이하, 제목은 80자 이하입니다. 세션 제목이 없으면 첫 사용자 요청을
사용하고, 민감한 정보를 가린 뒤 ASCII로 변환합니다. 이름은 기록 종료 시 확정됩니다.
기존 `run_<id>` 디렉터리와 run ID를 사용하는 명령도 계속 지원합니다.

`OPENAI_BASE_URL`을 읽는 사용자 정의 하네스에서는 `node agent.js`를 실행 명령으로 바꾸세요.

```console
agenticreplay record generic-openai -- node agent.js
```

ChatGPT 구독으로 Codex를 사용한다면 TLS 가로채기를 사용하세요.

```console
agenticreplay record exec --tls-intercept -- codex
```

기록 중 API 호출에 요금이 발생할 수 있습니다. 자동 마스킹 후에도 로그에 민감 정보가 남을 수 있으니 공유 전에 확인하세요.

다른 하네스는 [연동 가이드](../integrations.md), 조사 예시는
[실패한 실행 디버깅](../how-to/debug-a-failing-agent-run.md)을 참고하세요.

## 라이선스

Apache-2.0. 트레이스 명세: CC BY 4.0.
