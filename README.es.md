# pi-seat

[English](./README.md) | [繁體中文](./README.zh-TW.md) | [日本語](./README.ja.md) | **Español** | [Français](./README.fr.md)

Gestor de múltiples cuentas para [Pi](https://github.com/badlogic/pi-mono): cambia entre cuentas OAuth de Anthropic y OpenAI Codex por sesión, con medidores de uso en tu terminal.

- **Perfiles con nombre** — `work`, `personal`, `team`… cada uno con su propio grant OAuth en un almacén exclusivo. El `auth.json` de Pi nunca se modifica. Un perfil de Anthropic puede guardar en su lugar una API key de la Console, así que pasar del uso del plan a la facturación por API es un solo comando.
- **Fijación por sesión** — ejecuta dos sesiones de Pi con dos cuentas distintas a la vez mediante la variable de entorno `PI_SEAT`.
- **Medidores de uso** — barras de uso de 5 horas y semanales para cada perfil, directamente en la CLI. El color refleja el ritmo de consumo, no el nivel: rojo cuando al ritmo actual se superará el límite antes de que se reinicie la ventana, amarillo cuando queda justo y verde cuando sobra margen.
- **Fail-closed** — si una credencial no puede refrescarse y verificarse, se abortan los turnos de ese proveedor. Ninguna petición viaja con una cuenta obsoleta o equivocada, y un perfil muerto nunca bloquea un turno que corre en otro proveedor.

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
/seat status            # uso, predeterminado y pin — ↑↓ seleccionar, enter cambiar, x reset, esc/q cerrar
```

`/seat` y `/seat status` abren una vista de uso interactiva en una sesión TUI, y caen a texto plano en cualquier otro modo (RPC, `pi -p`). En la vista, `↑↓`/`jk` mueven la selección y `enter` hace que la cuenta resaltada sea el predeterminado de ese proveedor — elegir una fila built-in devuelve el proveedor al login integrado de Pi. `x` gasta un reset de límite de uso guardado en la cuenta resaltada (un crédito de reset de Codex o un reset de límite de Claude) tras una confirmación `y`/`n` en la misma vista, que indica cuál es, su fecha límite y cualquier motivo por el que el servidor podría rechazarlo; la fila `credits` bajo las barras muestra cuántos quedan.

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

### API keys de Anthropic

Un perfil de Anthropic puede guardar una API key de la Claude Console en lugar de un grant OAuth. Las solicitudes con ese perfil se facturan a la organización de Console de la key, no a los límites de uso de tu plan; ahí se gasta el crédito mensual de API que incluyen los planes Max, Ultra y Team ([detalles](https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-ultra-and-team-plans)).

```
/seat login console --api-key -a c    # entrada enmascarada; la key se verifica con Anthropic antes de guardarla
/seat use c                           # pasa a facturación por API; /seat use work vuelve
```

```sh
seat login console --api-key          # CLI: lee la key de stdin sin eco, nunca de argv
PI_SEAT=console pi                    # fija una sesión a la key
```

`-k` es la forma corta de `--api-key`. Nunca pongas la key en la línea de comandos: en ese momento ya está en el historial de tu shell o de Pi, así que seat rechaza cualquier argumento con forma de key. Revoca esa key y pega una nueva en el prompt. Para reemplazar la key de un perfil existente desde un pipe, primero haz `seat rm`: la confirmación de sobrescritura necesita una terminal.

La key se rechaza si es un token OAuth de Claude (`sk-ant-oat…`) o una Admin key, o si Anthropic no responde con éxito a la verificación. Un perfil con API key no tiene medidores del plan: la vista de uso y `seat` lo muestran con un enlace clicable a la página de facturación de la Console, donde está el saldo (Anthropic no tiene API para consultarlo), y `x` no tiene ningún reset que gastar. Pi marca la sesión como facturación por API, no como suscripción. Solo `anthropic` acepta API keys.

No sobrescribas el header `user-agent` de `anthropic` en `~/.pi/agent/models.json`: también viaja en las solicitudes con API key y seat no puede quitarlo. Con un valor `claude-cli/…`, Anthropic factura la solicitud como Claude Code, que el crédito mensual no cubre, y falla con `Your credit balance is too low` si la organización no tiene crédito comprado. Las solicitudes OAuth de Pi ya envían ese user-agent por sí mismas, así que la sobrescritura no les aporta nada.

pi-seat 0.5.0 o anterior no puede leer un almacén que contenga un perfil con API key. Elimina ese perfil antes de bajar de versión.

### Gasto de las API keys

Anthropic no tiene una API para el saldo restante, pero su Admin API informa cuánto ha gastado cada key. Asigna a un perfil con API key un ciclo mensual y la Admin key de su organización de Console, y la vista de uso y `seat` mostrarán el gasto desde el inicio del ciclo en lugar del enlace de facturación.

```sh
seat since console 11/27/2026         # o 2026-11-27; cada mes empieza un ciclo nuevo el día 27
seat admin-key console                # Admin key desde stdin sin eco, verificada antes de guardarla
```

```
● console · API key
  spent $23.47 since 2026-11-27
  resets 2026-12-27 · data as of 14:05
```

El ciclo empieza a las 00:00 en la zona horaria de la máquina que ejecutó `since`, y en un mes sin ese día el siguiente ciclo empieza el último día. Una Admin key pertenece a una sola organización de Console, así que cada perfil con API key lleva la suya: dos API keys de dos organizaciones necesitan dos Admin keys. Créala en Console, en Settings → Admin keys; la Admin API solo está disponible para cuentas de organización, no individuales. Se guarda en `seat.json` junto a las demás credenciales, nunca se imprime, solo sirve para listar las keys de la organización y leer el gasto, y se elimina con `seat admin-key console --rm`. Los datos de gasto de Anthropic llegan con hasta 24 horas de retraso (normalmente menos de 4), por eso se muestra la hora de los datos. Dentro de Pi, `/seat since` y `/seat admin-key` hacen lo mismo.

pi-seat 0.6.0 o anterior no puede leer un store con un ciclo o una Admin key: antes de bajar de versión, ejecuta `seat since <label> --clear` y `seat admin-key <label> --rm` para cada perfil.

## Diseño de seguridad

Los perfiles viven en `~/.pi/agent/seat.json` (0600, bloqueo de archivo, escrituras atómicas). Las API keys también se guardan ahí y nunca se imprimen. Cada perfil OAuth posee un grant exclusivo: las credenciales nunca se copian desde ni hacia el `auth.json` de Pi, porque los refresh tokens de Anthropic son de un solo uso y un grant compartido provocaría un doble gasto. Los refrescos de token son single-flight entre procesos.

## Licencia

MIT. La capa de ciclo de vida de credenciales está adaptada de [pi-accounts](https://www.npmjs.com/package/@narumitw/pi-accounts) (MIT) — véase [NOTICE](./NOTICE).
