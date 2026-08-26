# pi-seat

[English](./README.md) | [繁體中文](./README.zh-TW.md) | [日本語](./README.ja.md) | **Español** | [Français](./README.fr.md)

Gestor de múltiples cuentas para [Pi](https://github.com/badlogic/pi-mono): cambia entre cuentas OAuth de Anthropic y OpenAI Codex por sesión, con medidores de uso en tu terminal.

- **Perfiles con nombre** — `work`, `personal`, `team`… cada uno con su propio grant OAuth en un almacén exclusivo. El `auth.json` de Pi nunca se modifica.
- **Fijación por sesión** — ejecuta dos sesiones de Pi con dos cuentas distintas a la vez mediante la variable de entorno `PI_SEAT`.
- **Medidores de uso** — barras de uso de 5 horas y semanales para cada perfil, directamente en la CLI.
- **Fail-closed** — si una credencial no puede refrescarse y verificarse, el turno se aborta. Ninguna petición viaja con una cuenta obsoleta o equivocada.

## Requisitos

- [bun](https://bun.sh)
- [Pi](https://github.com/badlogic/pi-mono) con sesión OAuth de Anthropic u OpenAI Codex

## Instalación

```sh
pi install npm:pi-seat    # extensión — añade /seat a Pi
```

Esa es toda la instalación. `/seat` cubre todos los comandos: `login`, `use`, `rm`, `rename`, `status`, `whoami`, `usage`.

<details>
<summary>Opcional: la CLI seat</summary>

La extensión no importa nada de la CLI, así que instalála solo para lo que `/seat` no puede hacer por diseño: la salida `--plain` / `--json` para un segmento del prompt de la shell, y consultar el uso sin abrir una sesión de Pi.

`pi install` ya dejó un ejecutable funcional en `~/.pi/agent/npm/node_modules/.bin/seat`; simplemente ese directorio no está en tu `PATH`. Enlázalo a un directorio que sí lo esté:

```sh
ln -sf ~/.pi/agent/npm/node_modules/.bin/seat /usr/local/bin/seat
```

`bun add -g pi-seat` también funciona, pero descarga el mismo paquete por segunda vez y te deja dos instalaciones que mantener actualizadas.

</details>

<details>
<summary>O desde el código fuente</summary>

```sh
git clone https://github.com/ohlulu/pi-seat.git && cd pi-seat && bun install
```

Añade la ruta del repositorio a `packages` en `~/.pi/agent/settings.json`. Para la CLI opcional, crea el shim `seat` en tu `PATH`:

```sh
printf '#!/bin/sh\nexec bun /path/to/pi-seat/src/cli/main.ts "$@"\n' > /usr/local/bin/seat
chmod +x /usr/local/bin/seat
```

</details>

## Primeros pasos

Dentro de una sesión de Pi:

```
/seat login work        # crea un nuevo grant OAuth y lo guarda como "work"
/seat use work          # convierte "work" en el predeterminado global
/seat use work -a w     # …y apunta el alias "w" a él
/seat status            # uso, predeterminado y pin — ↑↓ seleccionar, enter cambiar, esc/q cerrar
```

`/seat` y `/seat status` abren una vista de uso interactiva en una sesión TUI, y caen a texto plano en cualquier otro modo (RPC, `pi -p`). En la vista, `↑↓`/`jk` mueven la selección y `enter` hace que la cuenta resaltada sea el predeterminado de ese proveedor — elegir una fila built-in devuelve el proveedor al login integrado de Pi.

Fija una sesión a una cuenta (prevalece sobre el predeterminado, solo en esa sesión):

```sh
PI_SEAT=work pi         # etiqueta sola = anthropic
PI_SEAT="anthropic:work,openai-codex:team" pi
```

Consulta el uso desde la shell:

```sh
seat                    # barras de uso de todos los perfiles
seat status --plain     # salida TSV para prompts de shell
```

`use default` borra el predeterminado y restaura el login integrado de Pi. `rm`, `rename` y el repetible `-a <alias>` (tanto en `login` como en `use`) funcionan como esperas.

## Diseño de seguridad

Los perfiles viven en `~/.pi/agent/seat.json` (0600, bloqueo de archivo, escrituras atómicas). Cada perfil posee un grant OAuth exclusivo: las credenciales nunca se copian desde ni hacia el `auth.json` de Pi, porque los refresh tokens de Anthropic son de un solo uso y un grant compartido provocaría un doble gasto. Los refrescos de token son single-flight entre procesos.

## Licencia

MIT. La capa de ciclo de vida de credenciales está adaptada de [pi-accounts](https://www.npmjs.com/package/@narumitw/pi-accounts) (MIT) — véase [NOTICE](./NOTICE).
