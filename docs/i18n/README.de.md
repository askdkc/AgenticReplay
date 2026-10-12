# AgenticReplay

<sub>[English](../../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · **Deutsch** · [Français](README.fr.md) · [Español](README.es.md) · [العربية](README.ar.md)</sub>

AgenticReplay zeichnet KI-API-Kommunikation auf, um Fehler in KI-Harnesses zu finden und sie zu
verbessern. Erfasst werden Anfragen und Antworten unterstützter Clients, einschließlich der
reasoning/thinking-Inhalte oder Zusammenfassungen, die die API zurückgibt.

Vergleiche den Trace mit Werkzeugergebnissen, erfassten Shell-Befehlen und Dateiänderungen, um die
Fehlerstelle im Ablauf zu finden.

## Installation

Voraussetzung: Node.js 24 oder neuer, Git und ein eingerichteter KI-Harness.

```console
git clone https://github.com/askdkc/AgenticReplay.git
cd AgenticReplay
npm ci
npm run build
npm install -g .
agenticreplay doctor
```

## Verwendung

Führe diese Befehle im zu untersuchenden Projekt aus:

```console
agenticreplay record claude -- -p "Investigate the failing test"
agenticreplay show last
agenticreplay export last -o run.html
```

Zeichne den Harness auf, der die API-Anfragen sendet, etwa Claude Code. Die Aufzeichnungen liegen
im Projekt unter `.agenticreplay/runs/`; `last` wählt die neueste. Öffne `run.html` im Browser,
um den Trace anzusehen.

Aufzeichnungsverzeichnisse heißen `YYYYMMDDHHmmss-agent-title-id` (UTC). Sie enthalten nur
kleine ASCII-Buchstaben, Ziffern und Bindestriche: höchstens 255 Zeichen insgesamt, davon bis zu
80 für den Titel. Der Titel stammt aus der Sitzung oder ersatzweise aus der ersten Nutzeranfrage;
sensible Angaben werden maskiert, der Text nach ASCII transliteriert. Der endgültige Name wird
beim Abschluss der Aufzeichnung gesetzt. Bestehende `run_<id>`-Verzeichnisse und Befehle mit
Run-ID werden weiterhin unterstützt.

Liest dein eigener Harness `OPENAI_BASE_URL`, ersetze `node agent.js` durch seinen Startbefehl:

```console
agenticreplay record generic-openai -- node agent.js
```

Für Codex mit einem ChatGPT-Abonnement nutze TLS-Interception:

```console
agenticreplay record exec --tls-intercept -- codex
```

API-Aufrufe beim Aufzeichnen können Kosten verursachen. Auch nach der automatischen Bereinigung
können sensible Daten im Trace bleiben. Prüfe ihn vor dem Teilen.

Weitere Harnesses findest du im [Integrationsleitfaden](../integrations.md), ein Beispiel unter
[Fehlgeschlagene Läufe untersuchen](../how-to/debug-a-failing-agent-run.md).

## Lizenz

Apache-2.0. Trace-Spezifikation: CC BY 4.0.
