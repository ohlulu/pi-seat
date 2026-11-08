# pi-seat

[English](./README.md) | [繁體中文](./README.zh-TW.md) | [日本語](./README.ja.md) | [Español](./README.es.md) | **Français**

Gestionnaire multi-comptes pour [Pi](https://github.com/badlogic/pi-mono) : basculez entre vos comptes OAuth Anthropic et OpenAI Codex par session, avec des jauges d'utilisation dans votre terminal.

- **Profils nommés** — `work`, `personal`, `team`… chacun détient son propre grant OAuth dans un store exclusif. Le `auth.json` de Pi n'est jamais modifié. Un profil Anthropic peut contenir à la place une clé API de la Console : passer de l'usage du forfait à la facturation API tient en une commande.
- **Épinglage par session** — lancez deux sessions Pi sur deux comptes différents en même temps via la variable d'environnement `PI_SEAT`.
- **Jauges d'utilisation** — barres d'utilisation sur 5 heures et hebdomadaires pour chaque profil, directement dans la CLI. La couleur traduit le rythme de consommation, pas le niveau : rouge lorsque le rythme actuel dépasse la limite avant la réinitialisation, jaune quand c'est juste, vert quand il reste de la marge.
- **Fail-closed** — si une credential ne peut pas être rafraîchie et vérifiée, les tours de ce provider sont interrompus. Aucune requête ne part avec un compte périmé ou erroné, et un profil mort ne bloque jamais un tour qui tourne sur un autre provider.

## Prérequis

- [bun](https://bun.sh)
- [Pi](https://github.com/badlogic/pi-mono) avec une connexion OAuth Anthropic ou OpenAI Codex

## Installation

```sh
pi install npm:pi-seat    # extension — ajoute /seat à Pi
```

L'installation s'arrête là. `/seat` couvre toutes les commandes : `login`, `use`, `rm`, `rename`, `status`, `whoami`, `usage`.

<details>
<summary>Optionnel : la CLI seat</summary>

L'extension n'importe rien de la CLI ; ne l'installez donc que pour ce que `/seat` ne peut structurellement pas faire — la sortie `--plain` / `--json` pour un segment de prompt shell, et la consultation de l'usage sans ouvrir de session Pi.

`pi install` a déjà placé un exécutable fonctionnel dans `~/.pi/agent/npm/node_modules/.bin/seat` ; ce répertoire n'est simplement pas dans votre `PATH`. Créez un lien vers un répertoire qui, lui, y figure :

```sh
ln -sf ~/.pi/agent/npm/node_modules/.bin/seat /usr/local/bin/seat
```

`bun add -g pi-seat` fonctionne aussi, mais télécharge le même paquet une seconde fois et vous laisse deux installations à maintenir à jour.

</details>

<details>
<summary>Ou depuis les sources</summary>

```sh
git clone https://github.com/ohlulu/pi-seat.git && cd pi-seat && bun install
```

Ajoutez le chemin du dépôt à `packages` dans `~/.pi/agent/settings.json`. Pour la CLI optionnelle, créez le shim `seat` dans votre `PATH` :

```sh
printf '#!/bin/sh\nexec bun /path/to/pi-seat/src/cli/main.ts "$@"\n' > /usr/local/bin/seat
chmod +x /usr/local/bin/seat
```

</details>

## Démarrage rapide

Dans une session Pi :

```
/seat login work        # crée un nouveau grant OAuth, stocké sous "work"
/seat use work          # fait de "work" le défaut global
/seat use work -a w     # …et pointe l'alias "w" dessus
/seat status            # usage, défaut et pin — ↑↓ sélectionner, enter basculer, x reset, esc/q fermer
```

`/seat` et `/seat status` ouvrent une vue d'usage interactive dans une session TUI, et retombent sur du texte partout ailleurs (RPC, `pi -p`). Dans la vue, `↑↓`/`jk` déplacent la sélection et `enter` fait du compte surligné le défaut de ce fournisseur — choisir une ligne built-in rend le fournisseur à la connexion intégrée de Pi. `x` utilise une réinitialisation de limite mise de côté sur le compte surligné (un crédit de reset Codex ou un reset de limite Claude) après une confirmation `y`/`n` dans la vue, qui indique laquelle, son échéance et toute raison pour laquelle le serveur pourrait la refuser ; la ligne `credits` sous les barres indique combien il en reste.

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

### Clés API Anthropic

Un profil Anthropic peut contenir une clé API de la Claude Console au lieu d'un grant OAuth. Les requêtes faites avec ce profil sont facturées à l'organisation Console de la clé, et non sur les limites d'usage de votre forfait ; c'est là que se dépense le crédit API mensuel inclus dans les forfaits Max, Ultra et Team ([détails](https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-ultra-and-team-plans)).

```
/seat login console --api-key -a c    # saisie masquée ; la clé est vérifiée auprès d'Anthropic avant d'être enregistrée
/seat use c                           # passe en facturation API ; /seat use work revient
```

```sh
seat login console --api-key          # CLI : lit la clé sur stdin sans écho, jamais depuis argv
PI_SEAT=console pi                    # épingle une session sur la clé
```

La clé est refusée si c'est un jeton OAuth Claude (`sk-ant-oat…`) ou une clé Admin, ou si Anthropic ne répond pas par un succès à la vérification. Un profil à clé API n'a pas de jauges de forfait : la vue d'usage et `seat` l'affichent avec un lien cliquable vers la page de facturation de la Console, où se trouve le solde (Anthropic n'a pas d'API pour le lire), et `x` n'a aucun reset à dépenser. Pi indique la session comme facturée à l'API, pas comme un abonnement. Seul `anthropic` accepte les clés API.

Ne remplacez pas l'en-tête `user-agent` d'`anthropic` dans `~/.pi/agent/models.json` : il part aussi avec les requêtes à clé API et seat ne peut pas le retirer. Avec une valeur `claude-cli/…`, Anthropic facture la requête comme du Claude Code, que le crédit mensuel ne couvre pas, et elle échoue avec `Your credit balance is too low` si l'organisation n'a pas de crédit acheté. Les requêtes OAuth de Pi envoient déjà ce user-agent d'elles-mêmes : le remplacer ne leur apporte rien.

pi-seat 0.5.0 ou antérieur ne sait pas lire un store contenant un profil à clé API. Supprimez ce profil avant de revenir à une version antérieure.

## Conception de sécurité

Les profils vivent dans `~/.pi/agent/seat.json` (0600, verrou de fichier, écritures atomiques). Les clés API y sont aussi stockées et ne sont jamais affichées. Chaque profil OAuth possède un grant exclusif : les credentials ne sont jamais copiées depuis ou vers le `auth.json` de Pi, car les refresh tokens Anthropic sont à usage unique et un grant partagé provoquerait une double dépense. Les rafraîchissements de token sont single-flight entre processus.

## Licence

MIT. La couche de cycle de vie des credentials est adaptée de [pi-accounts](https://www.npmjs.com/package/@narumitw/pi-accounts) (MIT) — voir [NOTICE](./NOTICE).
