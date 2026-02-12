# chagee-cli

MVP TypeScript CLI for CHAGEE ordering (region-aware, pickup-first).

> Warning: This project is alpha and highly experimental. Use at your own risk.
> Attribution: Every line of code in this repository is written by AI.

This README is split into two tracks:

- `Using the CLI` for ordering usage.
- `Developing chagee-cli` for contributors.

## Table of Contents

- [Scope](#scope)
- [Using the CLI](#using-the-cli)
- [Prerequisites](#prerequisites)
- [Install and Start](#install-and-start)
- [CLI Flags](#cli-flags)
- [Install as Global Command](#install-as-global-command)
- [TUI Mode](#tui-mode)
- [TUI Status Header](#tui-status-header)
- [TUI Keybindings](#tui-keybindings)
- [Safety Model](#safety-model)
- [Region Profiles](#region-profiles)
- [Quickstart (2 Minutes)](#quickstart-2-minutes)
- [Full Ordering Walkthrough](#full-ordering-walkthrough)
- [Store Capacity and Wait](#store-capacity-and-wait)
- [Usage Command Reference](#usage-command-reference)
- [Session and Prompt States](#session-and-prompt-states)
- [Troubleshooting (Usage)](#troubleshooting-usage)
- [FAQ](#faq)
- [Example Session Transcript](#example-session-transcript)
- [Non-Interactive Usage](#non-interactive-usage)
- [Developing chagee-cli](#developing-chagee-cli)
- [Dev Commands](#dev-commands)
- [Distribution (npm)](#distribution-npm)
- [Project Structure](#project-structure)
- [Contributor Notes](#contributor-notes)
- [Contributing Guide](./CONTRIBUTING.md)
- [License](./LICENSE)
- [Notes](#notes)

## Scope

- Status: alpha, highly experimental. Use at your own risk.
- Default region: Singapore (`SG`)
- Extensible regions: yes (via custom region profiles)
- Fulfillment: pickup only
- Delivery: not implemented
- Discounts/promotions: not implemented yet
- Default mode: `dry-run` (safe; `place` will not submit real order)

## Using the CLI

Use this section if your goal is to run the tool and place orders.

### Prerequisites

- Node.js 20+
- npm 10+

### Install and Start

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

### CLI Flags

`chagee` supports startup flags:

```bash
chagee --help
chagee --version
chagee --tui
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
- `--json`
- `--mode <dry-run|live>`
- `--region <CODE>`
- `-c, --command "<command>"` (repeatable)

`chagee-tui` also supports:

- `-h, --help`
- `-v, --version`

### Install as Global Command

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

### TUI Mode

Start the pane-based TUI:

```bash
npm start
# or
npm run tui
```

The TUI is built with Ink + React and uses the same command engine and APIs as line mode.

### TUI Status Header

Example:

`Phase:UNAUTH Mode:live Region:SG Watch:ON Mouse:OFF Loc:1.3498,103.8489`

Meaning:

- `Phase`: current session phase (`UNAUTH`, `READY`, `ORDER_CREATED`, etc.).
- `Mode`: command safety mode (`dry-run` or `live`).
- `Region`: active region profile code (default `SG`).
- `Watch`: whether auto-refresh store polling is active.
- `Mouse`: whether TUI mouse handling is enabled.
- `Loc`: current latitude/longitude used for store distance sorting and queries.

Notes:

- `UNAUTH` + `live` can happen: login state and mode are independent.
- Changing `mode`, `region`, `watch`, or `locate` updates this header.

### TUI Keybindings

- `Tab`: cycle focus forward (`stores -> menu -> cart -> console -> stores`)
- `Shift+Tab`: cycle focus backward
- `Up` / `Down` in `stores/menu/cart`: move selected row
- `Up` / `Down` in `console`: scroll logs when input is empty, history when typing
- `Enter (console pane)`: run typed slash command
- `Enter (stores pane)`: run `use <storeNo>`
- `Enter (menu pane)`: open staged variant/customization picker; `Enter` advances stage and adds on final stage
- `Left` / `Right` (menu variant picker): adjust quantity before add
- `Esc` (menu variant picker): go back one stage; closes picker from first stage
- `Enter (cart pane)`: increment selected line qty (`qty`)
- `Left` / `-` (cart pane): decrease selected line qty
- `Right` / `+` (cart pane): increase selected line qty
- `/`: jump to console input
- `/mouse`: reports that mouse selection is disabled (text highlight/copy stays available)
- `Ctrl+C`: quit TUI

Layout:

- Top: three panes (`Stores`, `Menu`, `Cart`)
- Bottom: one `Console` pane for command input, updates, and order/payment notifications.

Console notes:

- Slash commands are supported (`/login`, `/otp`, `/stores`, `/use`, `/add`, `/place`, etc.).
- Mouse selection is disabled by default to keep terminal text highlight/copy accurate.
- Store capacity auto-refresh starts on launch (`/watch on interval=10 sort=distance quiet=1`).
- Location is auto-resolved on startup via IP geolocation (backend-side).
- For higher precision, run `/locate` (browser geolocation) or set manually with:
  `stores lat=<your-lat> lng=<your-lng>`

Mouse support:

- terminal text highlight/copy is preserved (no pane click selection)

### Safety Model

- `dry-run` is default: `place` will not create a real order.
- `live` mode enables real order creation.
- Use `live on` before placing a real order, then `live off` after.
- Sensitive values (for example `appId`) must be supplied via environment/config, not hardcoded in repo.

### Region Profiles

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

### Quickstart (2 Minutes)

1. `status`
2. `stores` (default sort is distance)
3. `use <storeNo>`
4. `menu search "jasmine"`
5. `add <skuId> qty=1 spuId=<spuId>`
6. `cart`
7. `quote`
8. `live on`
9. `place`

At this point the CLI creates order + payment intent and opens payment URL in browser.

### Full Ordering Walkthrough

Replace placeholders and run in sequence:

```text
status
login +6591234567
# enter OTP from WhatsApp/SMS
otp 123456

stores
use <storeNo>
wait

menu categories
menu search "jasmine"
item <spuId>

add <skuId> qty=1 spuId=<spuId> name="Jasmine Green Milk Tea"
cart

quote
live on
place
pay status
order
```

### Browser OAuth Auto Login

For accounts where desktop OTP hits slider captcha, reuse your existing logged-in browser session:

```text
login web auto timeout=120 cdp=http://127.0.0.1:9222 phone=+6591234567
status
```

Flow:

1. You keep your own browser session already logged in at `https://h5.chagee.com.sg/main`.
2. Start that browser with remote debugging enabled (example: `--remote-debugging-port=9222`).
3. CLI attaches to the existing tab and captures `authorization` token from CHAGEE API traffic.
4. CLI verifies profile and stores authenticated session.

Notes:

- CLI does not open a new login browser flow for this mode.
- If no CHAGEE tab is found, open `https://h5.chagee.com.sg/main` in your existing browser and retry.
- Manual fallback remains:
  `login import <token> [phone=+6591234567]`

### Store Capacity and Wait

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

### How To Find `spuId` and `skuId`

- `menu search "<text>"` for item candidates (`spuId`).
- `item <spuId>` for sellable SKUs (`skuId`).
- Use returned `skuId` in `add`.

### Usage Command Reference

You can prefix any command with `/` (example: `/status`).

Simple flow commands:

- `help`
- `status`
- `exit`
- `login <phone-with-country-code>` (example: `+6591234567`)
- `login web [open=1]`
- `login web auto [timeout=120] [cdp=http://127.0.0.1:9222] [phone=+6591234567]`
- `login import <token> [phone=+6591234567]`
- `otp <code> [phone=<phone>] [phoneCode=<dial-code>]`
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
- `pay [start|open|status]`

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

- `login start ...`, `login verify ...`
- `stores list ...`, `store use ...`, `store wait`
- `cart add ...`, `cart set ...`, `cart show`
- `checkout`, `confirm`, `order show`, `order cancel`, `pay start`, `pay open`, `pay status`

### Session and Prompt States

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

### Troubleshooting (Usage)

1. OTP flow fails: confirm phone format for your region and retry `login +6591234567`.
2. Slider captcha blocks desktop OTP: use `login web auto [timeout=120] [cdp=http://127.0.0.1:9222] [phone=+6591234567]` with your existing logged-in browser session.
3. Wrong country defaults: run `debug region show` and `debug region set <code>`.
4. Distance/order of stores seems wrong: run `status` to check `location.source`, then run `locate` and `stores`.
5. `place` does not submit: switch to live with `live on`.
6. Cart add fails: run `item <spuId>` and use a valid `skuId`.
7. Need reset: delete `~/.chagee-cli/session.json` and restart.
8. Need payloads: run `debug last-req`, `debug last-res`, `debug events`.
9. Browser auto-login cannot find a debuggable tab: ensure browser is started with remote debugging and `h5.chagee.com.sg` is open.

### FAQ

1. Where do drink customization options (size/ice/sweetness) come from?
   From API data (`item` / goods detail response). The TUI does not hardcode these options.
2. Why do different drinks show different customization steps?
   Each product has its own option groups in API payloads. If a drink has fewer groups, fewer stages are shown.
3. What is the staged picker order?
   The picker prioritizes `Variant/Size` first, then `Ice`, then `Sweetness`, then other groups.
4. How do I use the staged picker quickly?
   `Up/Down` selects a value, `Enter` moves to next stage (or adds on final stage), `Esc` moves back, `+/-` adjusts quantity.
5. Why are long lines wrapped in the picker?
   To avoid hiding information. The footer now wraps lines instead of truncating with `...`.
6. Do I need an order number to cancel an order?
   Not in normal flow. `order cancel` targets the latest order in current session state.
7. Is there a cancellation time limit?
   Yes. Use `order show` to inspect `cancelByAt` and `cancelRemainingSec` (when returned by API).
8. Do discounts/promo codes/member vouchers work?
   Not currently. This CLI does not apply or manage discounts right now.
9. Why do you want to do this?
   Because I am extra.
10. Are you trying to scam me?
   Nope. I'm using this for my own use. Use it at your own risk but I am not trying to scam you.
11. Is this stable for production usage?
   No. This project is alpha and highly experimental; use at your own risk.
12. Is this code AI-generated?
   Yes. Every line of code in this repository is written by AI.

### Example Session Transcript

Representative run from the TUI console pane:

```text
/login +6591234567
/otp 123456
/stores
/use SG012
/menu search "jasmine"
/add 30077881 qty=1 spuId=20001123 name="Jasmine Green Milk Tea" price=5.9
/quote
/live on
/place
```

### Non-Interactive Usage

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

## Notes

- API payload mapping is reverse-engineered and can change without notice.
- Use live mode at your own risk.
