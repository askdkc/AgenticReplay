# AgenticReplay

<sub>[English](../../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Deutsch](README.de.md) · **Français** · [Español](README.es.md) · [العربية](README.ar.md)</sub>

AgenticReplay est un outil de journalisation des communications avec les API d’IA, adapté au
débogage des harness d’IA. Il enregistre les requêtes et réponses des clients pris en charge,
y compris le contenu ou les résumés reasoning/thinking que l’API renvoie réellement. Il ne peut pas
récupérer un raisonnement interne que l’API n’expose pas. Les données sensibles des corps capturés
sont masquées avant leur stockage ; les captures incomplètes sont signalées.

Comparez les communications API aux résultats des outils, aux commandes shell capturées et aux
modifications de fichiers pour comprendre le comportement réel du harness, repérer les défauts
et orienter les améliorations.

## Installation

Nécessite Node.js 24 ou plus récent, Git et un harness installé avec ses identifiants habituels.

```console
git clone https://github.com/askdkc/AgenticReplay.git
cd AgenticReplay
npm ci
npm run build
npm install -g .
agenticreplay doctor
```

## Utilisation

Exécutez ces commandes dans le projet à examiner :

```console
agenticreplay record claude -- -p "Investigate the failing test"
agenticreplay show last
agenticreplay export last -o run.html
```

Lancez avec AgenticReplay le harness qui envoie les requêtes aux API d’IA, comme Claude Code,
et pas seulement son serveur MCP. Les enregistrements sont stockés dans `.agenticreplay/runs/`
dans ce projet ; `last` sélectionne le plus récent. L’export HTML permet de consulter la trace
dans un navigateur.

Pour un harness personnalisé qui respecte `OPENAI_BASE_URL` :

```console
agenticreplay record generic-openai -- node agent.js
```

Remplacez `node agent.js` par la commande de votre harness. Pour Codex connecté avec un abonnement
ChatGPT, utilisez l’interception TLS :

```console
agenticreplay record exec --tls-intercept -- codex
```

Pendant l’enregistrement, le harness fonctionne normalement et les appels API peuvent être facturés.
Les traces peuvent contenir des données sensibles du projet ; vérifiez-les avant de les partager.

Consultez les [intégrations](../integrations.md) pour les autres harness et
[le débogage d’une exécution en échec](../how-to/debug-a-failing-agent-run.md) pour un exemple.

## Licence

Apache-2.0 pour le code. La spécification de trace est en CC BY 4.0, pour que chacun puisse la
réimplémenter.
