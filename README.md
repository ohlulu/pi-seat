# pi-seat

**English** | [繁體中文](./README.zh-TW.md) | [日本語](./README.ja.md) | [Español](./README.es.md) | [Français](./README.fr.md)

Named multi-account manager for [Pi](https://github.com/badlogic/pi-mono) — switch between Anthropic and OpenAI Codex OAuth accounts per session, with usage meters in your terminal.

- **Named profiles** — `work`, `personal`, `team`… each holding its own OAuth grant in an exclusive store. Pi's own `auth.json` is never written. An Anthropic profile can hold a Console API key instead, so switching between plan usage and API billing is one command.
- **Session pinning** — run two Pi sessions on two different accounts at the same time via the `PI_SEAT` env var.
- **Usage meters** — 5-hour and weekly usage bars for every profile, right in the CLI. Bars are coloured by burn rate, not level: red when the current pace projects past the limit before the window resets, yellow when it is close, green when there is room to spare.
- **Fail-closed** — if a credential cannot be refreshed and verified, turns on that provider abort. No request ever rides a stale or wrong account, and a dead profile never blocks a turn running on another provider.

## Requirements

- [bun](https://bun.sh)
- [Pi](https://github.com/badlogic/pi-mono) with Anthropic and/or OpenAI Codex OAuth login

## Install

```sh
pi install npm:pi-seat    # extension — adds /seat to Pi
```

That is the whole install. `/seat` covers every command: `login`, `use`, `rm`, `rename`, `status`, `whoami`, `usage`.

<details>
<summary>Optional: the seat CLI</summary>

The extension imports nothing from the CLI, so add one only for what `/seat` structurally cannot do — `--plain` / `--json` output for a shell prompt segment, and reading usage without starting a Pi session.

`pi install` already placed a working executable at `~/.pi/agent/npm/node_modules/.bin/seat`; it is simply not on your `PATH`. Link it into a directory that is:

```sh
ln -sf ~/.pi/agent/npm/node_modules/.bin/seat /usr/local/bin/seat
```

`bun add -g pi-seat` also works, but it downloads the same package a second time and leaves you two installs to keep in sync.

</details>

<details>
<summary>From source instead</summary>

```sh
git clone https://github.com/ohlulu/pi-seat.git && cd pi-seat && bun install
```

Add the repo path to `packages` in `~/.pi/agent/settings.json`. For the optional CLI, put a `seat` shim on your `PATH`:

```sh
printf '#!/bin/sh\nexec bun /path/to/pi-seat/src/cli/main.ts "$@"\n' > /usr/local/bin/seat
chmod +x /usr/local/bin/seat
```

</details>

## Quick start

Inside a Pi session:

```
/seat login work        # mint a new OAuth grant, store it as "work"
/seat use work          # make "work" the global default
/seat use work -a w     # …and point the alias "w" at it
/seat status            # usage meters, default and pin — ↑↓ select, enter switch, x reset, esc/q close
```

`/seat` and `/seat status` open an interactive usage view in a TUI session, and fall back to plain text everywhere else (RPC, `pi -p`). In the view, `↑↓`/`jk` move between accounts and `enter` makes the highlighted one that provider's default — selecting a built-in row hands the provider back to Pi's own login. `x` spends a banked usage-limit reset on the highlighted account (a Codex reset credit or a Claude limit reset) after an inline `y`/`n` confirmation that names the reset, its deadline, and any reason the server may refuse it; the `credits` row under the meters shows how many are left.

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

### Anthropic API keys

An Anthropic profile can hold a Claude Console API key instead of an OAuth grant. Requests on it bill the key's Console organization instead of your plan's usage limits; that is where the monthly API credit that Max, Ultra and Team plans include is spent ([details](https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-ultra-and-team-plans)).

```
/seat login console --api-key -a c    # masked prompt; the key is checked with Anthropic before it is stored
/seat use c                           # switch to API billing; /seat use work switches back
```

```sh
seat login console --api-key          # CLI: reads the key from stdin with echo off, never from argv
PI_SEAT=console pi                    # pin one session to the key
```

`-k` is short for `--api-key`. Never put the key on the command line: seat refuses any argument shaped like a key, because it is already in your shell or Pi input history by then. Revoke that key and paste a new one at the prompt. To replace a profile's key from a pipe, `seat rm` it first; the overwrite confirmation needs a terminal.

The key is refused if it is a Claude OAuth token (`sk-ant-oat…`) or an Admin key, or if Anthropic answers the check with anything but success. An API-key profile has no plan meters: the usage view and `seat` list it with a clickable link to the Console billing page, where the balance is (Anthropic has no API for it), and `x` has no reset to spend. Pi labels the session as API billing, not a subscription. Only `anthropic` takes API keys.

Do not override the `anthropic` `user-agent` header in `~/.pi/agent/models.json`. The header is also sent on API-key requests, and seat cannot strip it. With a `claude-cli/…` value, Anthropic bills the request as Claude Code, which the monthly credit does not cover, so it fails with `Your credit balance is too low` once the organization has no purchased credit. Pi's OAuth requests already send that user-agent on their own, so the override does nothing for them.

A store holding an API-key profile cannot be read by pi-seat 0.5.0 or older. Remove the profile before downgrading.

## How it stays safe

Profiles live in `~/.pi/agent/seat.json` (0600, file-locked, atomic writes). API keys are stored there too and are never printed. Every OAuth profile owns an exclusive grant — credentials are never copied from or into Pi's `auth.json`, because Anthropic refresh tokens are single-use and a shared grant would double-spend. Token refreshes are single-flight across processes.

## License

MIT. Credential lifecycle layer adapted from [pi-accounts](https://www.npmjs.com/package/@narumitw/pi-accounts) (MIT) — see [NOTICE](./NOTICE).
