# chagee-cli

MVP TypeScript CLI for CHAGEE ordering (region-aware, pickup-first).

> Warning: This project is alpha and highly experimental. Use at your own risk.
> Attribution: Every line of code in this repository is written by AI.

This README is split into two tracks:

- `Using the CLI` for ordering usage.
- `Developing chagee-cli` for contributors.

## Table of Contents

- [Overview](#overview)
- [Using the CLI](#using-the-cli)
- [Setup and Configuration](#setup-and-configuration)
- [Important Login Path (Manual Token)](#important-login-path-manual-token)
- [TUI Guide](#tui-guide)
- [Ordering Workflows](#ordering-workflows)
- [Command and State Reference](#command-and-state-reference)
- [Troubleshooting and FAQ](#troubleshooting-and-faq)
- [Developing chagee-cli](#developing-chagee-cli)
- [Contributing Guide](./CONTRIBUTING.md)
- [License](./LICENSE)
- [Project Notes](#project-notes)

## Overview

- Status: alpha, highly experimental. Use at your own risk.
- Default region: Singapore (`SG`)
- Extensible regions: yes (via custom region profiles)
- Fulfillment: pickup only
- Delivery: not implemented
- Discounts/promotions: not implemented yet
- Default mode: `dry-run` (safe; `place` will not submit real order)

## Using the CLI

Use this section if your goal is to run the tool and place orders.

### Setup and Configuration

#### Prerequisites

- Node.js 20+
- npm 10+

#### Install and Start

If you are only using the tool, use the compiled run path:

```bash
npm install
npm run build
npm start
```

Before creating real orders, configure app ID outside source code:

```bash
export CHAGEE_APP_ID="<your-app-id>"
```

Notes:

- `npm start` runs the compiled CLI entrypoint (`dist/cli.js`).
- On an interactive terminal, `chagee` starts the TUI by default.
- `npm run dev` is mainly for development (hot-run via `tsx`).

### Important Login Path (Manual Token)

If `login` cannot finish automatically, use this flow.

1. Log in to `https://h5.chagee.com.sg/main` in your normal browser session.
2. Open DevTools -> `Network`.
3. Select any authenticated CHAGEE API request.
4. Copy request header `authorization` value.
5. In CLI, run one of:

```text
login token <token>
# legacy aliases still accepted:
login paste
login import <token>
```

Notes:

- `login paste` reads token from clipboard.
- `login import` also accepts full copied header lines, for example:
  `authorization: Bearer <token>`
- After import, CLI validates token against profile endpoints before saving session.

#### CLI Flags

`chagee` supports startup flags:

```bash
chagee --help
chagee --version
chagee --tui
chagee --tui --yolo
chagee --json
chagee --mode dry-run
chagee --region SG
chagee --command "status"
chagee --command "stores sort=wait" --command "status" --json
chagee "/status"
```

Supported options:

- `-h, --help`
- `-v, --version`
- `--tui`
- `--yolo` (enables shell ordering commands)
- `--json`
- `--mode <dry-run|live>`
- `--region <CODE>`
- `-c, --command "<command>"` (repeatable)

`chagee-tui` also supports:

- `-h, --help`
- `-v, --version`
- `--yolo`

#### Install as Global Command

Install from local checkout:

```bash
npm install
npm run build
npm install -g .
```

Then use:

```bash
chagee
chagee-tui
```

For active development, use link mode:

```bash
npm link
```

Uninstall global command later:

```bash
npm uninstall -g chagee-cli
```

### TUI Guide

#### TUI Mode

Start the pane-based TUI:

```bash
npm start
# or
npm run tui
```

The TUI is built with Ink + React and uses the same command engine and APIs as line mode.

#### TUI Status Header

Example:

`Phase:UNAUTH Mode:live Region:SG Shell:SAFE Watch:ON Mouse:ON Loc:1.3498,103.8489`

Meaning:

- `Phase`: current session phase (`UNAUTH`, `READY`, `ORDER_CREATED`, etc.).
- `Mode`: command safety mode (`dry-run` or `live`).
- `Region`: active region profile code (default `SG`).
- `Shell`: `SAFE` (default) or `YOLO`.
- `Watch`: whether auto-refresh store polling is active.
- `Mouse`: whether TUI mouse handling is enabled.
- `Loc`: current latitude/longitude used for store distance sorting and queries.

Notes:

- `UNAUTH` + `live` can happen: login state and mode are independent.
- Changing `mode`, `region`, `watch`, or `locate` updates this header.

#### TUI Keybindings

- `Tab`: cycle focus forward (`stores -> menu -> cart -> console -> stores`)
- `Shift+Tab`: cycle focus backward
- `Up` / `Down` in `stores/menu/cart`: move selected row
- `Up` / `Down` in `console`: scroll visible output/logs
- `Ctrl+P` / `Ctrl+N` in `console`: previous/next command history
- `Enter (console pane)`: run typed slash command
- `Enter (stores pane)`: run `use <storeNo>`
- `Enter (menu pane)`: open staged variant/customization picker; `Enter` advances stage and adds on final stage
- `Left` / `Right` (menu variant picker): adjust quantity before add
- `Esc` (menu variant picker): go back one stage; closes picker from first stage
- `Enter (cart pane)`: increment selected line qty (`qty`)
- `Left` / `-` (cart pane): decrease selected line qty
- `Right` / `+` (cart pane): increase selected line qty
- `/`: jump to console input
- `/mouse`: reports current mouse capture state
- `Ctrl+C`: quit TUI

Layout:

- Top: three panes (`Stores`, `Menu`, `Cart`)
- Bottom: one `Console` pane for command input, updates, and order/payment notifications.

Console notes:

- Slash commands are supported (`/login`, `/otp`, `/stores`, `/status`, etc.).
- SAFE shell mode is default: ordering commands in shell are blocked unless app was started with `--yolo`.
- Panel interactions still allow ordering flow in SAFE mode.
- Mouse click capture is enabled by default for pane navigation.
- Use `/mouse off` if you want native terminal text selection/copy behavior.
- Store capacity auto-refresh starts on launch (`/watch on interval=10 sort=distance quiet=1`).
- Location is validated on startup via IP geolocation for `default/ip` sessions. Browser/manual coordinates are preserved.
- Distance heartbeat: backend re-checks IP geolocation every ~60s during store refresh for non-manual/non-browser sessions.
- For higher precision, run `/locate` (browser geolocation) or set manually with:
  `stores lat=<your-lat> lng=<your-lng>`

Mouse support:

- terminal text highlight/copy is preserved (no pane click selection)

#### Safety Model

- `dry-run` is default: `place` will not create a real order.
- `live` mode enables real order creation.
- Use `live on` before placing a real order, then `live off` after.
- Sensitive values (for example `appId`) must be supplied via environment/config, not hardcoded in repo.

#### Region Profiles

Built-in:

- `SG` (Singapore)

Region commands:

- `debug region list`
- `debug region show [code]`
- `debug region set <code>`
- `debug region file` (prints `~/.chagee-cli/regions.json`)

Add custom regions by creating `~/.chagee-cli/regions.json`:

```json
[
  {
    "code": "MY",
    "name": "Malaysia",
    "country": "MY",
    "apiBase": "https://api-sea.chagee.com",
    "defaultPhoneCode": "+60",
    "currencyCode": "MYR",
    "currencySymbol": "RM",
    "appId": "<your-app-id>",
    "timeZone": "Asia/Kuala_Lumpur",
    "deviceTimeZoneRegion": "Asia/Kuala_Lumpur",
    "timezoneOffset": "480",
    "defaultLatitude": 3.139,
    "defaultLongitude": 101.6869
  }
]
```

Then restart CLI and run:

```text
debug region list
debug region set MY
```

### Ordering Workflows

#### Quickstart (2 Minutes)

1. `status`
2. `stores` (default sort is distance)
3. `use <storeNo>`
4. `menu search "jasmine"`
5. `add <skuId> qty=1 spuId=<spuId>`
6. `cart`
7. `pay`

At this point the CLI creates order + payment intent and opens payment URL in browser.

#### Full Ordering Walkthrough

Replace placeholders and run in sequence:

```text
status
login
# if guided login cannot complete automatically:
# login token <token>

stores
use <storeNo>
wait

menu categories
menu search "jasmine"
item <spuId>

add <skuId> qty=1 spuId=<spuId> name="Jasmine Green Milk Tea"
cart

pay
pay status
order
```

#### Guided Login (Default)

Use the default login command:

```text
login
status
```

Optional advanced form:

```text
login timeout=180 cdp=http://127.0.0.1:9222 open=0 phone=+6591234567
```

Flow (`login`):

1. If a valid session already exists, CLI reuses it after profile verification.
2. CLI checks clipboard for a token and verifies it.
3. CLI tries browser-session capture by scanning common local CDP endpoints (`9222/9223/9333`).
4. CLI verifies profile and stores authenticated session.

Notes:

- CLI does not open a separate re-login flow. It reuses your existing browser session.
- If CDP capture fails, use the manual token flow in
  [Important Login Path (Manual Token)](#important-login-path-manual-token).
- Legacy aliases still work: `login web ...`, `login import ...`, `login paste`.

#### Manual Token Import (No CDP)

If CDP/remote-debugging is unavailable, import token manually:

1. Log in at `https://h5.chagee.com.sg/main`.
2. Open DevTools -> Network and select any authenticated CHAGEE API request.
3. Copy the `authorization` header value.
4. Run one of:
   - `login token <token>`
   - `login paste` (legacy, if token is already in clipboard)
   - `login import <token>` (legacy)

`login token` / `login import` both accept copied header lines like `authorization: Bearer ...`.

#### Store Capacity and Wait

Menu visibility:

- Store list and store menus are public and can be loaded without login.
- Login is only required for account actions such as quote/order/payment.

- One-time check: `stores` (default sort is distance)
- Live polling: `watch on interval=10 sort=distance`
- Stop polling: `watch off`
- Selected store refresh: `wait`
- Browser geolocation sync: `locate` (or `locate timeout=90 open=0`)

`stores` columns:

- `dist`: distance from your configured location (`lat`/`lng`)
- `cups`: cups currently preparing
- `wait(min)`: estimated wait
- `status`: store status text

#### How To Find `spuId` and `skuId`

- `menu search "<text>"` for item candidates (`spuId`).
- `item <spuId>` for sellable SKUs (`skuId`).
- Use returned `skuId` in `add`.

### Command and State Reference

#### Usage Command Reference

You can prefix any command with `/` (example: `/status`).

SAFE shell mode (default):

- These shell commands require startup flag `--yolo`:
  `use`, `wait`, `menu`, `item`, `cart`, `add`, `qty`, `rm`, `clear`, `quote`, `live on|off`, `place`, `checkout`, `confirm`, `order cancel`, `pay start`, `pay open` (including legacy `store use|wait`).
- `pay` (guided) is allowed in SAFE shell when cart/order/payment context exists.
- Panel-driven ordering in TUI remains available without `--yolo`.

Simple flow commands:

- `help`
- `status`
- `exit`
- `login [timeout=120] [cdp=auto|http://127.0.0.1:9222] [open=1] [phone=+6591234567]`
- `login token <token> [phone=+6591234567]`
- `otp <code> [phone=<phone>] [phoneCode=<dial-code>]` (legacy OTP verify)
- `logout`
- `locate [timeout=60] [open=1]`
- `stores [sort=distance|wait|cups|name] [lat=1.35] [lng=103.81]`
- `watch on|off [interval=10] [sort=distance|wait|cups|name] [quiet=1]`
- `use <storeNo>`
- `wait`
- `menu [search=<text>]`
- `menu categories`
- `menu list <categoryId>`
- `menu search "<text>"`
- `item <spuId>`
- `add <skuId> [qty=1] [spuId=...] [name=...] [price=...] [specList=<json>] [attributeList=<json>]`
- `qty <item> <n>`
- `rm <item>`
- `clear`
- `cart`
- `quote`
- `live on|off`
- `place [open=1] [channelCode=H5] [payType=1]`
- `order [show|cancel [force=1]]`
- `pay [open=1] [channelCode=H5] [payType=1]` (guided)
- `pay [status|open|start]`

Cancel window notes:

- `order show` displays `cancelByAt` and `cancelRemainingSec` when available from web-app order/payment payloads.
- `order cancel` will block locally after window expiry unless `force=1` is provided.

Advanced/debug commands:

- `debug help`
- `debug last-req`
- `debug last-res`
- `debug events [count=20]`
- `debug region list|show|set|file`
- `debug mode dry-run|live`
- `debug json on|off`
- `debug guest show|set-token|bootstrap|clear`

Legacy commands (still supported):

- `login start ...`, `login verify ...`, `login web ...`, `login import ...`, `login paste`
- `stores list ...`, `store use ...`, `store wait`
- `cart add ...`, `cart set ...`, `cart show`
- `checkout`, `confirm`, `order show`, `order cancel`, `pay start`, `pay open`, `pay status`

#### Session and Prompt States

Session file:

`~/.chagee-cli/session.json`

Prompt format:

`<PHASE>:<mode>`

Phases:

- `UNAUTH`
- `AUTH_NO_STORE`
- `READY`
- `CART_DIRTY`
- `QUOTED`
- `ORDER_CREATED`
- `PAYMENT_PENDING`
- `ORDER_PAID`
- `ORDER_CANCELED`

### Troubleshooting and FAQ

#### Troubleshooting (Usage)

1. OTP flow fails: use guided `login`, or fallback to token import via [Important Login Path (Manual Token)](#important-login-path-manual-token).
2. Slider captcha blocks desktop OTP: use `login` (guided token + browser flow), or manual token flow in [Important Login Path (Manual Token)](#important-login-path-manual-token).
3. Wrong country defaults: run `debug region show` and `debug region set <code>`.
4. Distance/order of stores seems wrong: run `status` to check `location.source`, then run `locate` and `stores`.
5. `pay` did not create/open payment: ensure login + cart + selected store, then retry `pay`.
6. Cart add fails: run `item <spuId>` and use a valid `skuId`.
7. Need reset: delete `~/.chagee-cli/session.json` and restart.
8. Need payloads: run `debug last-req`, `debug last-res`, `debug events`.
9. Browser session login cannot find a debuggable tab: run `login token <token>` after copying `authorization` from DevTools. See [Important Login Path (Manual Token)](#important-login-path-manual-token).

#### FAQ

1. Where do drink customization options (size/ice/sweetness) come from?
   A:
   From API data (`item` / goods detail response). The TUI does not hardcode these options.
2. Why do different drinks show different customization steps?
   A:
   Each product has its own option groups in API payloads. If a drink has fewer groups, fewer stages are shown.
3. What is the staged picker order?
   A:
   The picker prioritizes `Variant/Size` first, then `Ice`, then `Sweetness`, then other groups.
4. How do I use the staged picker quickly?
   A:
   `Up/Down` selects a value, `Enter` moves to next stage (or adds on final stage), `Esc` moves back, `+/-` adjusts quantity.
5. Why are long lines wrapped in the picker?
   A:
   To avoid hiding information. The footer now wraps lines instead of truncating with `...`.
6. Do I need an order number to cancel an order?
   A:
   Not in normal flow. `order cancel` targets the latest order in current session state.
7. Is there a cancellation time limit?
   A:
   Yes. Use `order show` to inspect `cancelByAt` and `cancelRemainingSec` (when returned by API).
8. Do discounts/promo codes/member vouchers work?
   A:
   Not currently. This CLI does not apply or manage discounts right now.
9. Why do you want to do this?
   A:
   Because I am extra.
10. Are you trying to scam me?
   A:
   Nope. I'm using this for my own use. Use it at your own risk but I am not trying to scam you.
11. Is this stable for production usage?
   A:
   No. This project is alpha and highly experimental; use at your own risk.
12. Is this code AI-generated?
   A:
   Yes. Every line of code in this repository is written by AI.

#### Example Session Transcript

Representative run from the TUI console pane:

```text
/login
# optional fallback:
# /login token <token>
/stores
/use SG012
/menu search "jasmine"
/add 30077881 qty=1 spuId=20001123 name="Jasmine Green Milk Tea" price=5.9
/pay
```

#### Non-Interactive Usage

Quick checks via piped input:

```bash
printf 'status\nstores\nexit\n' | npm start
```

## Developing chagee-cli

Use this section if you are changing code.

### Dev Setup

```bash
npm install
```

### Dev Commands

- `npm run dev`: run `src/cli.ts` directly with `tsx`.
- `npm run tui`: run `src/tui/cli.ts` (interactive pane UI).
- `npm run check`: TypeScript typecheck only.
- `npm run build`: compile TypeScript to `dist/`.
- `npm start`: run compiled `dist/cli.js`.

### Distribution (npm)

1. Pick an available package name in `package.json` (for example `chagee-cli` or scoped).
2. Build and validate:

```bash
npm run check
npm run build
npm pack --dry-run
```

3. Login and publish:

```bash
npm login
npm publish --access public
```

After publish, users install globally with:

```bash
npm install -g <your-package-name>
```

Then run:

```bash
chagee
chagee-tui
```

### Project Structure

- `src/cli.ts`: executable CLI entrypoint (`chagee`)
- `src/index.ts`: reusable REPL app engine, command handling, state transitions
- `src/tui/cli.ts`: executable TUI entrypoint (`chagee-tui`)
- `src/tui/index.tsx`: TUI runtime and interaction model (Ink + React)
- `src/config/regions.ts`: built-in region defaults and region registry helpers
- `src/api/client.ts`: API transport and endpoint wrappers
- `src/types.ts`: domain and state types
- `src/lib/region-store.ts`: custom region profile loader (`~/.chagee-cli/regions.json`)
- `src/lib/session-store.ts`: session persistence
- `src/lib/state.ts`: state helpers and phase derivation
- `src/lib/parser.ts`: command token/key-value parsing
- `src/lib/format.ts`: output formatting helpers

### Contributor Notes

- API mapping is reverse-engineered and may break if backend contracts change.
- Keep user-facing safety defaults (`dry-run`) intact.
- Validate with both interactive (`npm run dev`) and non-interactive (`printf ... | npm start`) flows.

## Project Notes

- API payload mapping is reverse-engineered and can change without notice.
- Use live mode at your own risk.
