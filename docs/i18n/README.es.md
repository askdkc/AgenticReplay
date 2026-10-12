# AgenticReplay

<sub>[English](../../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · **Español** · [العربية](README.ar.md)</sub>

AgenticReplay es un registrador de comunicaciones con API de IA, adaptado para depurar harness
(entornos de ejecución) de IA. Registra las solicitudes y respuestas de los clientes compatibles,
incluido el contenido o los resúmenes de reasoning/thinking que la API devuelve realmente.
No puede obtener razonamientos internos que la API no expone. Los datos sensibles de los cuerpos
capturados se ocultan antes de guardarlos, y las capturas incompletas se marcan.

Compara la comunicación con la API con los resultados de las herramientas, los comandos de shell
capturados y los cambios en archivos para entender el comportamiento real del harness, identificar
defectos y orientar las mejoras.

## Instalación

Requiere Node.js 24 o posterior, Git y un harness instalado con sus credenciales habituales.

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

Ejecuta con AgenticReplay el harness que envía las solicitudes a la API de IA, como Claude Code,
y no solo su servidor MCP. Las grabaciones se guardan en `.agenticreplay/runs/` dentro de ese
proyecto; `last` selecciona la más reciente. La exportación HTML permite consultar la traza
en un navegador.

Para un harness propio que respete `OPENAI_BASE_URL`:

```console
agenticreplay record generic-openai -- node agent.js
```

Sustituye `node agent.js` por el comando de tu harness. Para Codex con una suscripción de ChatGPT,
utiliza la interceptación TLS:

```console
agenticreplay record exec --tls-intercept -- codex
```

Durante la grabación, el harness funciona normalmente y las llamadas a la API pueden generar costes.
Las trazas pueden contener datos sensibles del proyecto; revísalas antes de compartirlas.

Consulta las [integraciones](../integrations.md) para otros harness y
[la depuración de una ejecución fallida](../how-to/debug-a-failing-agent-run.md) para un ejemplo.

## Licencia

Apache-2.0 para el código. La especificación de traza es CC BY 4.0, para que cualquiera pueda
reimplementarla.
