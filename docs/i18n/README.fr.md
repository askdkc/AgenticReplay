# AgenticReplay

<sub>[English](../../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Deutsch](README.de.md) · **Français** · [Español](README.es.md) · [العربية](README.ar.md)</sub>

AgenticReplay enregistre les échanges avec les API d’IA pour aider à déboguer et à améliorer les
environnements d’exécution d’agents IA. Il capture les requêtes et réponses des clients pris en
charge, y compris le contenu ou les résumés reasoning/thinking renvoyés par l’API.

Comparez la trace aux résultats des outils, aux commandes shell capturées et aux modifications de
fichiers pour repérer où l’exécution a échoué.

## Installation

Nécessite Node.js 24 ou plus récent, Git et un environnement d’exécution d’agents IA configuré.

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

Enregistrez le processus qui envoie les requêtes API, par exemple Claude Code. Les traces sont
stockées dans `.agenticreplay/runs/` dans le projet ; `last` sélectionne la plus récente.
Ouvrez `run.html` dans un navigateur pour la consulter.

Les répertoires utilisent `YYYYMMDDHHmmss-agent-title-id` (UTC), avec uniquement des lettres
ASCII minuscules, des chiffres et des traits d’union : 255 caractères au maximum, dont 80 pour
le titre. Le titre vient de la session ou, à défaut, de la première demande ; les données sensibles
sont masquées et le texte est translittéré en ASCII. Le nom définitif est appliqué à la fin de
l’enregistrement. Les répertoires `run_<id>` existants et les commandes utilisant un run ID restent pris en charge.

Si votre propre environnement utilise `OPENAI_BASE_URL`, remplacez `node agent.js` par sa commande
de lancement :

```console
agenticreplay record generic-openai -- node agent.js
```

Pour Codex avec un abonnement ChatGPT, utilisez l’interception TLS :

```console
agenticreplay record exec --tls-intercept -- codex
```

Les appels API pendant l’enregistrement peuvent être facturés. Le masquage automatique peut laisser
des données sensibles dans les traces : vérifiez-les avant de les partager.

Consultez le [guide d’intégration](../integrations.md) pour les autres environnements et
[le débogage d’une exécution en échec](../how-to/debug-a-failing-agent-run.md) pour un exemple.

## Licence

Apache-2.0. Spécification des traces : CC BY 4.0.
