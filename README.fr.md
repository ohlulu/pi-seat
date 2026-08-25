# pi-seat

[English](./README.md) | [繁體中文](./README.zh-TW.md) | [日本語](./README.ja.md) | [Español](./README.es.md) | **Français**

Gestionnaire multi-comptes pour [Pi](https://github.com/badlogic/pi-mono) : basculez entre vos comptes OAuth Anthropic et OpenAI Codex par session, avec des jauges d'utilisation dans votre terminal.

- **Profils nommés** — `work`, `personal`, `team`… chacun détient son propre grant OAuth dans un store exclusif. Le `auth.json` de Pi n'est jamais modifié.
- **Épinglage par session** — lancez deux sessions Pi sur deux comptes différents en même temps via la variable d'environnement `PI_SEAT`.
- **Jauges d'utilisation** — barres d'utilisation sur 5 heures et hebdomadaires pour chaque profil, directement dans la CLI.
- **Fail-closed** — si une credential ne peut pas être rafraîchie et vérifiée, le tour est interrompu. Aucune requête ne part avec un compte périmé ou erroné.

## Prérequis

- [bun](https://bun.sh)
- [Pi](https://github.com/badlogic/pi-mono) avec une connexion OAuth Anthropic ou OpenAI Codex

## Installation

```sh
pi install npm:pi-seat    # extension — ajoute /seat à Pi
bun add -g pi-seat        # CLI seat dans votre PATH
```

<details>
<summary>Ou depuis les sources</summary>

```sh
git clone https://github.com/ohlulu/pi-seat.git && cd pi-seat && bun install
```

Ajoutez le chemin du dépôt à `packages` dans `~/.pi/agent/settings.json`, puis créez le shim `seat` dans votre `PATH` :

```sh
printf '#!/bin/sh\nexec bun /path/to/pi-seat/src/cli/main.ts "$@"\n' > ~/.pi/agent/bin/seat
chmod +x ~/.pi/agent/bin/seat
```

</details>

## Démarrage rapide

Dans une session Pi :

```
/seat login work        # crée un nouveau grant OAuth, stocké sous "work"
/seat use work          # fait de "work" le défaut global
/seat use work -a w     # …et pointe l'alias "w" dessus
/seat status            # usage, défaut et pin — esc ou q pour fermer
```

`/seat` et `/seat status` ouvrent une vue d'usage interactive dans une session TUI, et retombent sur du texte partout ailleurs (RPC, `pi -p`).

Épinglez une session à un compte (prioritaire sur le défaut, pour cette session uniquement) :

```sh
PI_SEAT=work pi         # label seul = anthropic
PI_SEAT="anthropic:work,openai-codex:team" pi
```

Consultez l'utilisation depuis le shell :

```sh
seat                    # barres d'utilisation de tous les profils
seat status --plain     # sortie TSV pour les prompts shell
```

`use default` efface le défaut et restaure la connexion intégrée de Pi. `rm`, `rename` et l'option répétable `-a <alias>` (sur `login` comme sur `use`) fonctionnent comme attendu.

## Conception de sécurité

Les profils vivent dans `~/.pi/agent/seat.json` (0600, verrou de fichier, écritures atomiques). Chaque profil possède un grant OAuth exclusif : les credentials ne sont jamais copiées depuis ou vers le `auth.json` de Pi, car les refresh tokens Anthropic sont à usage unique et un grant partagé provoquerait une double dépense. Les rafraîchissements de token sont single-flight entre processus.

## Licence

MIT. La couche de cycle de vie des credentials est adaptée de [pi-accounts](https://www.npmjs.com/package/@narumitw/pi-accounts) (MIT) — voir [NOTICE](./NOTICE).
