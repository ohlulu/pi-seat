# pi-seat

**English** | [繁體中文](./README.zh-TW.md) | [日本語](./README.ja.md) | [Español](./README.es.md) | [Français](./README.fr.md)

Named multi-account manager for [Pi](https://github.com/badlogic/pi-mono) — switch between Anthropic and OpenAI Codex OAuth accounts per session, with usage meters in your terminal.

- **Named profiles** — `work`, `personal`, `team`… each holding its own OAuth grant in an exclusive store. Pi's own `auth.json` is never written.
- **Session pinning** — run two Pi sessions on two different accounts at the same time via the `PI_SEAT` env var.
- **Usage meters** — 5-hour and weekly usage bars for every profile, right in the CLI.
- **Fail-closed** — if a credential cannot be refreshed and verified, the turn aborts. No request ever rides a stale or wrong account.

## Requirements

- [bun](https://bun.sh)
- [Pi](https://github.com/badlogic/pi-mono) with Anthropic and/or OpenAI Codex OAuth login

## Install

```sh
git clone https://github.com/ohlulu/pi-seat.git
cd pi-seat && bun install
```

Register the extension by adding the repo path to `packages` in `~/.pi/agent/settings.json`:

```json
{ "packages": ["/path/to/pi-seat"] }
```

Create the `seat` CLI shim somewhere on your `PATH`:

```sh
printf '#!/bin/sh\nexec bun /path/to/pi-seat/src/cli/main.ts "$@"\n' > ~/.pi/agent/bin/seat
chmod +x ~/.pi/agent/bin/seat
```

## Quick start

Inside a Pi session:

```
/seat login work        # mint a new OAuth grant, store it as "work"
/seat use work          # make "work" the global default
/seat use work -a w     # …and point the alias "w" at it
/seat status            # usage meters, default and pin — press esc or q to close
```

`/seat` and `/seat status` open an interactive usage view in a TUI session, and fall back to plain text everywhere else (RPC, `pi -p`).

Pin a session to an account (overrides the default, this session only):

```sh
PI_SEAT=work pi         # bare label = anthropic
PI_SEAT="anthropic:work,openai-codex:team" pi
```

Check usage from the shell:

```sh
seat                    # usage bars for all profiles
seat status --plain     # TSV output for shell prompts
```

`use default` clears the default and restores Pi's built-in login. `rm`, `rename`, and repeatable `-a <alias>` (on both `login` and `use`) work as expected.

## How it stays safe

Profiles live in `~/.pi/agent/seat.json` (0600, file-locked, atomic writes). Every profile owns an exclusive OAuth grant — credentials are never copied from or into Pi's `auth.json`, because Anthropic refresh tokens are single-use and a shared grant would double-spend. Token refreshes are single-flight across processes.

## License

MIT. Credential lifecycle layer adapted from [pi-accounts](https://www.npmjs.com/package/@narumitw/pi-accounts) (MIT) — see [NOTICE](./NOTICE).
