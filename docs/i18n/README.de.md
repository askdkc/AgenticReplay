# AgenticReplay

<sub>[English](../../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · **Deutsch** · [Français](README.fr.md) · [Español](README.es.md) · [العربية](README.ar.md)</sub>

AgenticReplay ist ein Logger für KI-API-Kommunikation, angepasst zum Debuggen von KI-Harnesses.
Er zeichnet Anfragen und Antworten unterstützter Clients auf, einschließlich der Inhalte oder
Zusammenfassungen von reasoning/thinking, die die API tatsächlich zurückgibt. Interne Denkprozesse,
die die API nicht offenlegt, kann er nicht abrufen. Erfasste Inhalte werden vor dem Speichern um
sensible Daten bereinigt; unvollständige Aufzeichnungen werden gekennzeichnet.

Vergleiche die API-Kommunikation mit Werkzeugergebnissen, erfassten Shell-Befehlen und
Dateiänderungen, um das tatsächliche Verhalten des Harnesses zu verstehen, Fehler zu finden und
Verbesserungen abzuleiten.

## Installation

Erforderlich sind Node.js 24 oder neuer, Git und ein installierter Harness mit den üblichen Zugangsdaten.

```console
git clone https://github.com/askdkc/AgenticReplay.git
cd AgenticReplay
npm ci
npm run build
npm install -g .
agenticreplay doctor
```

## Verwendung

Führe diese Befehle im Projekt aus, das du untersuchen möchtest:

```console
agenticreplay record claude -- -p "Investigate the failing test"
agenticreplay show last
agenticreplay export last -o run.html
```

Starte den Harness, der die KI-API-Anfragen sendet, etwa Claude Code, über AgenticReplay;
zeichne nicht nur seinen MCP-Server auf. Aufzeichnungen liegen im Projekt unter
`.agenticreplay/runs/`; `last` wählt die neueste Aufzeichnung. Den HTML-Export kannst du im Browser ansehen.

Für einen eigenen Harness, der `OPENAI_BASE_URL` berücksichtigt:

```console
agenticreplay record generic-openai -- node agent.js
```

Ersetze `node agent.js` durch den Startbefehl deines Harnesses. Nutze TLS-Interception für Codex,
wenn du mit einem ChatGPT-Abonnement angemeldet bist:

```console
agenticreplay record exec --tls-intercept -- codex
```

Beim Aufzeichnen läuft der Harness normal weiter; API-Aufrufe können Kosten verursachen.
Aufzeichnungen können sensible Projektdaten enthalten. Prüfe sie vor dem Teilen.

Weitere Harnesses findest du unter [Integrationen](../integrations.md), ein Beispiel unter
[Fehlgeschlagene Läufe untersuchen](../how-to/debug-a-failing-agent-run.md).

## Lizenz

Apache-2.0 für den Code. Die Trace-Spezifikation steht unter CC BY 4.0, damit sie jeder neu
implementieren darf.
