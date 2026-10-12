# AgenticReplay

<sub>[English](../../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · **Español** · [العربية](README.ar.md)</sub>

AgenticReplay registra las comunicaciones con API de IA para ayudar a depurar y mejorar los
entornos de ejecución de agentes de IA. Captura las solicitudes y respuestas de los clientes
compatibles, incluido el contenido o los resúmenes de reasoning/thinking que devuelve la API.

Compara la traza con los resultados de las herramientas, los comandos de shell capturados y los
cambios en archivos para localizar dónde falló la ejecución.

## Instalación

Requiere Node.js 24 o posterior, Git y un entorno de ejecución de agentes de IA configurado.

```console
git clone https://github.com/askdkc/AgenticReplay.git
cd AgenticReplay
npm ci
npm run build
npm install -g .
agenticreplay doctor
```

## Uso

Ejecuta estos comandos en el proyecto que quieras investigar:

```console
agenticreplay record claude -- -p "Investigate the failing test"
agenticreplay show last
agenticreplay export last -o run.html
```

Registra el proceso que envía las solicitudes a la API, como Claude Code. Las trazas se guardan
en `.agenticreplay/runs/` dentro del proyecto; `last` selecciona la más reciente.
Abre `run.html` en un navegador para consultarla.

Si tu entorno utiliza `OPENAI_BASE_URL`, sustituye `node agent.js` por su comando de inicio:

```console
agenticreplay record generic-openai -- node agent.js
```

Para Codex con una suscripción de ChatGPT, utiliza la interceptación TLS:

```console
agenticreplay record exec --tls-intercept -- codex
```

Las llamadas a la API durante la grabación pueden generar costes. El filtrado automático puede
dejar datos sensibles en las trazas; revísalas antes de compartirlas.

Consulta la [guía de integración](../integrations.md) para otros entornos y
[la depuración de una ejecución fallida](../how-to/debug-a-failing-agent-run.md) para un ejemplo.

## Licencia

Apache-2.0. Especificación de trazas: CC BY 4.0.
