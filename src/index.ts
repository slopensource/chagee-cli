#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { inspect } from "node:util";

import {
  APP_ID_ENV_VAR,
  DEFAULT_REGION_CODE,
  buildRegionRegistry,
  getBuiltInRegionProfiles,
  getDefaultRegionProfile,
  normalizeRegionCode
} from "./config/regions.js";
import type { RegionProfile } from "./config/regions.js";
import {
  ChageeClient,
  envelopeData,
  extractToken,
  extractUserId,
  isApiOk
} from "./api/client.js";
import { maskPhone, printTable, toNum } from "./lib/format.js";
import { parseBool, parseKeyValueTokens, parseNum, tokenize } from "./lib/parser.js";
import {
  evaluateSmartStartupLocationDecision,
  normalizeLocationPolicy
} from "./lib/location-policy.js";
import type {
  StartupLocationDecision,
  StartupLocationRecommendation
} from "./lib/location-policy.js";
import { loadCustomRegionProfiles, regionFilePath } from "./lib/region-store.js";
import { loadSession, saveSession, sessionFilePath } from "./lib/session-store.js";
import { clearAuthToken } from "./lib/token-store.js";
import {
  createInitialState,
  derivePhase,
  nextCartVersion,
  resetForStoreSwitch
} from "./lib/state.js";
import type {
  ApiEnvelope,
  AppState,
  CartLine,
  ItemSkuOption,
  LocationPolicy,
  LocationSource,
  MenuCategory,
  MenuItem,
  OrderState,
  RequestEvent,
  ResponseEvent,
  StoreState
} from "./types.js";

const HELP = `CHAGEE CLI (simple mode)
  Tip: slash prefix is accepted (example: /status)
  Warning: alpha + highly experimental; use at your own risk.
  Safe shell mode blocks most ordering commands unless launched with --yolo.

  help
  status
  exit

  login [timeout=120] [cdp=auto|http://127.0.0.1:9222] [open=1] [phone=+6591234567]
  login token <token> [phone=+6591234567]
  otp <code> [phone=<phone>] [phoneCode=<dial-code>]  (legacy OTP verify)
  logout

  locate [timeout=60] [open=1]  (recommended for highest location accuracy)
  stores [sort=distance|wait|cups|name] [lat=1.35] [lng=103.81]
  watch on|off [interval=10] [sort=distance|wait|cups|name] [quiet=1]
  use <storeNo>
  wait

  menu [search=<text>]
  menu categories
  menu list <categoryId>
  menu search "<text>"
  item <spuId>

  add <skuId> [qty=1] [spuId=...] [name=...] [price=...] [specList=<json>] [attributeList=<json>]
  qty <item> <n>
  rm <item>
  clear
  cart

  quote
  live on|off
  place [open=1] [channelCode=H5] [payType=1]
  order [show|cancel]
  pay [open=1] [channelCode=H5] [payType=1]  (guided)
  pay [status|await|open|start]
  payment status auto-polls every 5s while pending.

  debug help`;

const SAFE_HELP = `CHAGEE CLI (simple mode)
  Tip: slash prefix is accepted (example: /status)
  Warning: alpha + highly experimental; use at your own risk.
  Shell mode: SAFE (ordering flow commands hidden; launch with --yolo to enable).

  help
  status
  exit

  login [timeout=120] [cdp=auto|http://127.0.0.1:9222] [open=1] [phone=+6591234567]
  login token <token> [phone=+6591234567]
  otp <code> [phone=<phone>] [phoneCode=<dial-code>]  (legacy OTP verify)
  logout

  locate [timeout=60] [open=1]  (recommended for highest location accuracy)
  stores [sort=distance|wait|cups|name] [lat=1.35] [lng=103.81]
  watch on|off [interval=10] [sort=distance|wait|cups|name] [quiet=1]

  quote  (requires login + cart context)
  order [show]
  pay [open=1] [channelCode=H5] [payType=1]  (guided; requires cart/order context)
  pay [status|await]
  payment status auto-polls every 5s while pending.

  debug help`;

type StoreSort = "distance" | "wait" | "cups" | "name";
type CommandSource = "shell" | "panel" | "system";

interface AppOptions {
  yolo?: boolean;
  locationPolicy?: LocationPolicy;
}

interface ExecuteOptions {
  source?: CommandSource;
}

type PaymentStatusSource = "manual" | "auto" | "await";
type PaymentStatusResolution = "success" | "pending" | "failed" | "unknown" | "api_error" | "not_ready";

interface PaymentStatusOutcome {
  resolution: PaymentStatusResolution;
  numericStatuses: number[];
  textStatuses: string[];
  apiErrcode?: string;
  apiErrmsg?: string;
}

interface BrowserLocation {
  latitude: number;
  longitude: number;
  accuracyMeters?: number;
}

type BrowserCaptureStatus =
  | "success"
  | "connect_error"
  | "no_tabs"
  | "no_chagee_tab"
  | "no_debug_ws"
  | "token_not_seen";

interface BrowserTokenCaptureAttempt {
  endpoint: string;
  status: BrowserCaptureStatus;
  reason?: string;
  targetUrl?: string;
  sampleTargets?: string[];
  token?: string;
}

interface BrowserTokenCaptureResult {
  token?: string;
  endpoint?: string;
  attempts: BrowserTokenCaptureAttempt[];
}

const LOCATION_SOURCES: readonly LocationSource[] = ["default", "ip", "browser", "manual"];
const LOCATION_HEARTBEAT_MS = 60 * 1000;
const LOCATION_CHANGE_EPSILON = 0.000001;
const PAYMENT_STATUS_POLL_MS = 5 * 1000;
const PAYMENT_STATUS_ERROR_LOG_THROTTLE_MS = 30 * 1000;
const PAYMENT_AWAIT_DEFAULT_TIMEOUT_SEC = 180;
const PAYMENT_AWAIT_DEFAULT_INTERVAL_SEC = 3;
const PAYMENT_AWAIT_MIN_TIMEOUT_SEC = 5;
const PAYMENT_AWAIT_MAX_TIMEOUT_SEC = 1800;
const PAYMENT_AWAIT_MIN_INTERVAL_SEC = 1;
const PAYMENT_AWAIT_MAX_INTERVAL_SEC = 30;
const PAYMENT_AWAIT_PROGRESS_LOG_MS = 10 * 1000;
const PAYMENT_AWAIT_API_ERROR_LOG_MS = 5 * 1000;
const ITEM_OPTION_PRINT_LIMIT = 24;

export class App {
  private state: AppState = createInitialState();
  private regionRegistry = buildRegionRegistry([]);
  private builtInRegionCodes = new Set(
    getBuiltInRegionProfiles().map((r) => normalizeRegionCode(r.code))
  );
  private events: Array<RequestEvent | ResponseEvent> = [];
  private lastReq?: RequestEvent;
  private lastRes?: ResponseEvent;
  private storesWatchTimer: NodeJS.Timeout | undefined;
  private storesWatchBusy = false;
  private storesWatchSilent = false;
  private storesWatchSort: StoreSort = "distance";
  private paymentStatusPollTimer: NodeJS.Timeout | undefined;
  private paymentStatusPollBusy = false;
  private lastPaymentStatusPollErrorAtMs = 0;
  private itemSkuOptionsCacheByStore: Record<string, Record<string, ItemSkuOption[]>> = {};
  private lastLocationHeartbeatAttemptAtMs = 0;
  private readonly locationPolicy: LocationPolicy;
  private startupLocationRecommendation: StartupLocationRecommendation = {
    shouldRunBrowserLocate: false
  };
  private readonly yoloMode: boolean;

  private readonly client = new ChageeClient(
    () => this.state.auth?.token ?? this.state.session.guestToken,
    () => this.activeRegion(),
    {
      onRequest: (event) => {
        this.lastReq = event;
        this.events.push(event);
        this.trimEvents();
      },
      onResponse: (event) => {
        this.lastRes = event;
        this.events.push(event);
        this.trimEvents();
      }
    }
  );

  constructor(options: AppOptions = {}) {
    this.yoloMode = options.yolo === true;
    this.locationPolicy = normalizeLocationPolicy(options.locationPolicy, "smart");
  }

  async init(): Promise<void> {
    const customRegions = await loadCustomRegionProfiles();
    this.regionRegistry = buildRegionRegistry(customRegions);

    const loaded = await loadSession();
    for (const warning of loaded.warnings) {
      console.warn(`Session warning: ${warning}`);
    }
    const saved = loaded.state;
    if (saved) {
      this.state = {
        ...this.state,
        ...saved,
        session: { ...this.state.session, ...(saved.session ?? {}) },
        storesCache: saved.storesCache ?? this.state.storesCache,
        menuCache: saved.menuCache ?? this.state.menuCache,
        menuCacheByStore: saved.menuCacheByStore ?? this.state.menuCacheByStore,
        cart: saved.cart ?? this.state.cart,
        cartVersion: saved.cartVersion ?? this.state.cartVersion
      };
    }

    this.migrateLegacyMenuCache();
    this.syncMenuCacheForSelectedStore();

    const normalized = normalizeRegionCode(this.state.session.region || DEFAULT_REGION_CODE);
    if (!this.regionRegistry.has(normalized)) {
      this.state.session.region = DEFAULT_REGION_CODE;
    } else {
      this.state.session.region = normalized;
    }

    const active = this.activeRegion();
    if (!Number.isFinite(this.state.session.latitude)) {
      this.state.session.latitude = active.defaultLatitude;
    }
    if (!Number.isFinite(this.state.session.longitude)) {
      this.state.session.longitude = active.defaultLongitude;
    }
    if (!isLocationSource(this.state.session.locationSource)) {
      this.state.session.locationSource = "default";
    }

    await this.applyStartupLocationPolicy();
    this.syncMenuCacheForSelectedStore();
    if (this.state.selectedStore?.storeNo && !this.hasMenuCacheForStore(this.state.selectedStore.storeNo)) {
      try {
        await this.ensureMenuForSelectedStore(true);
      } catch {
        // Keep startup resilient if menu prefetch fails.
      }
    }
    this.reconcilePaymentStatusPolling();
  }

  async run(): Promise<void> {
    const interactive = Boolean(input.isTTY && output.isTTY);
    const colorsEnabled = interactive && supportsCliColors(output);
    const restoreOutputColors = interactive ? installInteractiveOutputColors(colorsEnabled) : () => {};
    if (interactive) {
      this.banner(colorsEnabled);
    }
    const rl = createInterface({ input, output, terminal: interactive });

    try {
      if (!interactive) {
        for await (const line of rl) {
          const trimmed = line.trim();
          if (trimmed.length === 0) {
            continue;
          }
          const shouldExit = await this.dispatch(trimmed, "shell");
          if (shouldExit) {
            break;
          }
        }
        return;
      }

      while (true) {
        let line = "";
        try {
          line = await rl.question(this.renderPrompt(colorsEnabled));
        } catch {
          break;
        }

        const trimmed = line.trim();
        if (trimmed.length === 0) {
          continue;
        }

        this.echoShellCommand(trimmed, colorsEnabled);
        const shouldExit = await this.dispatch(trimmed, "shell");
        if (shouldExit) {
          break;
        }
      }
    } finally {
      this.stopStoreWatch();
      this.stopPaymentStatusPolling();
      rl.close();
      restoreOutputColors();
    }
  }

  private banner(colorsEnabled: boolean): void {
    console.log(colorText("chagee shell (`help` for commands, `exit` to quit)", ANSI_BRIGHT_CYAN, colorsEnabled));
    console.log(colorText("warning: alpha + highly experimental; use at your own risk.", ANSI_BRIGHT_YELLOW, colorsEnabled));
    if (this.yoloMode) {
      console.log(colorText("shell mode: YOLO (ordering commands enabled)", ANSI_BRIGHT_MAGENTA, colorsEnabled));
    } else {
      console.log(
        colorText(
          "shell mode: SAFE (most ordering commands disabled; relaunch with --yolo)",
          ANSI_BRIGHT_MAGENTA,
          colorsEnabled
        )
      );
    }
    console.log(colorText(`session: ${sessionFilePath()}`, ANSI_DIM, colorsEnabled));
    console.log(colorText(`regions: ${regionFilePath()}`, ANSI_DIM, colorsEnabled));
  }

  private renderPrompt(colorsEnabled: boolean): string {
    const phase = colorText(derivePhase(this.state), ANSI_BRIGHT_CYAN, colorsEnabled);
    const modeColor = this.state.session.mode === "live" ? ANSI_BRIGHT_YELLOW : ANSI_BRIGHT_GREEN;
    const mode = colorText(this.state.session.mode, modeColor, colorsEnabled);
    return `${phase}:${mode}> `;
  }

  private echoShellCommand(command: string, colorsEnabled: boolean): void {
    console.log(colorText(`› ${command}`, ANSI_BRIGHT_BLUE, colorsEnabled));
  }

  private async handle(raw: string, source: CommandSource = "shell"): Promise<boolean> {
    const normalizedRaw = raw.trim().startsWith("/") ? raw.trim().slice(1) : raw;
    const tokens = tokenize(normalizedRaw);
    const [root, ...rest] = tokens;
    if (!root) {
      return false;
    }

    if (source === "shell" && !this.yoloMode && this.isShellOrderingCommand(root, rest)) {
      if (root.toLowerCase() === "pay") {
        console.log(
          "Shell /pay in SAFE mode is allowed only when cart has items or an existing order/payment is present."
        );
      } else {
        console.log("Shell ordering commands are disabled in SAFE mode.");
        console.log("Use panel navigation in TUI, or relaunch with --yolo.");
      }
      return false;
    }

    try {
      switch (root) {
        case "help":
          console.log(this.yoloMode ? HELP : SAFE_HELP);
          return false;
        case "exit":
        case "quit":
          return true;
        case "status":
          this.printStatus();
          return false;
        case "otp":
          await this.cmdLogin(["verify", ...rest]);
          return false;
        case "watch":
          await this.cmdStores(["watch", ...rest]);
          return false;
        case "use":
          await this.cmdStore(["use", ...rest]);
          return false;
        case "wait":
          await this.cmdStore(["wait", ...rest]);
          return false;
        case "add":
          await this.cmdCart(["add", ...rest]);
          return false;
        case "qty": {
          const itemRef = rest[0];
          const qtyToken = rest[1];
          const qtyArg =
            qtyToken && qtyToken.includes("=") ? qtyToken : qtyToken ? `qty=${qtyToken}` : "";
          await this.cmdCart(["set", ...(itemRef ? [itemRef] : []), ...(qtyArg ? [qtyArg] : [])]);
          return false;
        }
        case "rm":
          await this.cmdCart(["rm", ...rest]);
          return false;
        case "clear":
          await this.cmdCart(["clear"]);
          return false;
        case "place":
          await this.cmdPlace(rest);
          return false;
        case "region":
          await this.cmdRegion(rest);
          return false;
        case "mode":
          await this.cmdMode(rest);
          return false;
        case "json":
          await this.cmdJson(rest);
          return false;
        case "guest":
          await this.cmdGuest(rest);
          return false;
        case "login":
          await this.cmdLogin(rest);
          return false;
        case "logout":
          await this.cmdLogout();
          return false;
        case "locate":
          await this.cmdLocate(rest);
          return false;
        case "stores":
          if (rest.length === 0 || (rest[0] !== "list" && rest[0] !== "watch")) {
            await this.cmdStores(["list", ...rest]);
          } else {
            await this.cmdStores(rest);
          }
          return false;
        case "store":
          await this.cmdStore(rest);
          return false;
        case "menu":
          await this.cmdMenu(rest);
          return false;
        case "item":
          if (rest.length > 0 && rest[0] !== "show") {
            await this.cmdItem(["show", ...rest]);
          } else {
            await this.cmdItem(rest);
          }
          return false;
        case "cart":
          if (rest.length === 0) {
            await this.cmdCart(["show"]);
          } else {
            await this.cmdCart(rest);
          }
          return false;
        case "quote":
          await this.cmdQuote();
          return false;
        case "live":
          if (rest[0] === "on") {
            await this.cmdMode(["live"]);
          } else if (rest[0] === "off") {
            await this.cmdMode(["dry-run"]);
          } else {
            console.log("Usage: live on|off");
          }
          return false;
        case "checkout":
          await this.cmdCheckout();
          return false;
        case "confirm":
          await this.cmdConfirm();
          return false;
        case "order":
          if (rest.length === 0) {
            await this.cmdOrder(["show"]);
          } else {
            await this.cmdOrder(rest);
          }
          return false;
        case "pay":
          await this.cmdPay(rest);
          return false;
        case "event":
        case "events":
          await this.cmdEvent(rest);
          return false;
        case "debug":
          await this.cmdDebug(rest);
          return false;
        default:
          console.log(`Unknown command: ${root}`);
          return false;
      }
    } catch (error) {
      console.error("Command failed:", error instanceof Error ? error.message : error);
      return false;
    }
  }

  private printStatus(): void {
    const phase = derivePhase(this.state);
    const region = this.activeRegion();
    const locationHint = locationAccuracyHint(this.state.session.locationSource);
    const summary = {
      phase,
      mode: this.state.session.mode,
      locationPolicy: this.locationPolicy,
      region: {
        code: this.state.session.region,
        name: region.name,
        apiBase: region.apiBase,
        phoneCode: region.defaultPhoneCode,
        currencyCode: region.currencyCode,
        timeZone: region.timeZone
      },
      auth: this.state.auth
        ? {
            userId: this.state.auth.userId,
            phone: this.state.auth.phoneMasked ?? this.state.auth.phoneRaw
          }
        : null,
      guest: this.state.session.guestToken
        ? {
            enabled: true,
            tokenPreview: `${this.state.session.guestToken.slice(0, 8)}...`
          }
        : null,
      store: this.state.selectedStore
        ? {
            storeNo: this.state.selectedStore.storeNo,
            storeName: this.state.selectedStore.storeName,
            distanceKm: formatDistanceKm(this.state.selectedStore.distanceMeters),
            waitingCups: this.state.selectedStore.waitingCups,
            waitingTime: this.state.selectedStore.waitingTime
          }
        : null,
      location: {
        latitude: this.state.session.latitude,
        longitude: this.state.session.longitude,
        source: this.state.session.locationSource,
        updatedAt: this.state.session.locationUpdatedAt,
        accuracyMeters: this.state.session.locationAccuracyMeters,
        storePinned: this.state.session.storePinned,
        ...(locationHint ? { hint: locationHint } : {})
      },
      cartItems: this.state.cart.length,
      cartVersion: this.state.cartVersion,
      quoteAt: this.state.quote?.at,
      orderNo: this.state.order?.orderNo,
      paymentStatus: this.state.payment?.status,
      paymentPolling: this.paymentStatusPollTimer ? "on" : "off"
    };

    this.printData(summary);
  }

  private activeRegion(): RegionProfile {
    const code = normalizeRegionCode(this.state.session.region || DEFAULT_REGION_CODE);
    return (
      this.regionRegistry.get(code) ??
      this.regionRegistry.get(DEFAULT_REGION_CODE) ??
      getDefaultRegionProfile()
    );
  }

  private hasMenuCacheForStore(storeNo: string): boolean {
    const cached = this.state.menuCacheByStore[storeNo];
    return Array.isArray(cached) && cached.length > 0;
  }

  private setMenuCacheForStore(storeNo: string, categories: MenuCategory[]): void {
    this.state.menuCacheByStore[storeNo] = categories;
    if (this.state.selectedStore?.storeNo === storeNo) {
      this.state.menuCache = categories;
    }
  }

  private syncMenuCacheForSelectedStore(): void {
    const storeNo = this.state.selectedStore?.storeNo;
    if (!storeNo) {
      this.state.menuCache = [];
      return;
    }
    this.state.menuCache = this.state.menuCacheByStore[storeNo] ?? [];
  }

  private migrateLegacyMenuCache(): void {
    const storeNo = this.state.selectedStore?.storeNo;
    if (!storeNo) {
      return;
    }
    if (this.hasMenuCacheForStore(storeNo)) {
      return;
    }
    if (this.state.menuCache.length === 0) {
      return;
    }
    this.state.menuCacheByStore[storeNo] = this.state.menuCache;
  }

  private async ensureMenuForSelectedStore(silent: boolean): Promise<void> {
    const storeNo = this.state.selectedStore?.storeNo;
    if (!storeNo) {
      this.state.menuCache = [];
      return;
    }
    if (this.hasMenuCacheForStore(storeNo)) {
      this.syncMenuCacheForSelectedStore();
      return;
    }
    await this.fetchMenu(silent);
  }

  async getItemSkuOptions(spuId: string): Promise<ItemSkuOption[]> {
    const storeNo = this.state.selectedStore?.storeNo;
    if (!storeNo) {
      return [];
    }

    const perStore = (this.itemSkuOptionsCacheByStore[storeNo] ??= {});
    const cached = perStore[spuId];
    if (cached && cached.length > 0) {
      return cached;
    }

    const region = this.activeRegion();
    const res = await this.client.getGoodsDetail({
      spuId,
      storeNo,
      saleType: region.saleType,
      saleChannel: region.saleChannel
    });
    if (!isApiOk(res)) {
      return [];
    }
    const options = extractItemSkuOptions(envelopeData(res));
    perStore[spuId] = options;
    return options;
  }

  private async cmdRegion(rest: string[]): Promise<void> {
    const sub = rest[0];

    if (sub === "list" || sub === undefined) {
      const rows = [...this.regionRegistry.values()]
        .sort((a, b) => a.code.localeCompare(b.code))
        .map((r) => [
          r.code,
          r.name,
          r.country,
          r.defaultPhoneCode,
          r.currencyCode,
          r.apiBase,
          this.isBuiltInRegion(r.code) ? "builtin" : "custom"
        ]);
      printTable(
        ["code", "name", "country", "phoneCode", "currency", "apiBase", "source"],
        rows
      );
      return;
    }

    if (sub === "show") {
      const code = normalizeRegionCode(rest[1] ?? this.state.session.region);
      const profile = this.regionRegistry.get(code);
      if (!profile) {
        console.log(`Unknown region code: ${code}`);
        return;
      }
      this.printData(profile);
      return;
    }

    if (sub === "set") {
      const rawCode = rest[1];
      if (!rawCode) {
        console.log("Usage: region set <code>");
        return;
      }
      const code = normalizeRegionCode(rawCode);
      const profile = this.regionRegistry.get(code);
      if (!profile) {
        console.log(`Unknown region code: ${code}`);
        console.log(`See configured regions with: region list`);
        console.log(`Add custom regions in: ${regionFilePath()}`);
        return;
      }
      const previous = this.state.session.region;
      if (previous === code) {
        console.log(`Region already set to ${code}`);
        return;
      }

      const previousUserId = this.state.auth?.userId;
      this.applyRegionSwitch(profile);
      if (previousUserId) {
        await clearAuthToken(previousUserId);
      }
      await this.persist();
      console.log(`Region set to ${profile.code} (${profile.name})`);
      console.log("Session reset: auth/store/cart/order/payment cleared.");
      return;
    }

    if (sub === "file") {
      console.log(regionFilePath());
      return;
    }

    console.log("Usage: region list | region show [code] | region set <code> | region file");
  }

  private isBuiltInRegion(code: string): boolean {
    return this.builtInRegionCodes.has(normalizeRegionCode(code));
  }

  private applyRegionSwitch(region: RegionProfile): void {
    this.stopStoreWatch();
    this.state.session.region = region.code;
    this.state.session.latitude = region.defaultLatitude;
    this.state.session.longitude = region.defaultLongitude;
    this.state.session.locationSource = "default";
    this.state.session.locationUpdatedAt = undefined;
    this.state.session.locationAccuracyMeters = undefined;
    this.state.session.storePinned = false;
    this.state.session.guestToken = undefined;
    this.state.auth = undefined;
    this.state.pendingLoginPhone = undefined;
    this.state.selectedStore = undefined;
    this.state.storesCache = [];
    this.state.menuCache = [];
    this.state.menuCacheByStore = {};
    this.itemSkuOptionsCacheByStore = {};
    this.state.cart = [];
    this.state.cartVersion = 0;
    this.state.quote = undefined;
    this.state.pendingCreatePayload = undefined;
    this.state.order = undefined;
    this.state.payment = undefined;
  }

  private async cmdMode(rest: string[]): Promise<void> {
    const mode = rest[0];
    if (mode !== "dry-run" && mode !== "live") {
      console.log("Usage: mode dry-run|live");
      return;
    }
    this.state.session.mode = mode;
    await this.persist();
    console.log(`Mode set to ${mode}`);
  }

  private async cmdJson(rest: string[]): Promise<void> {
    const val = rest[0];
    if (val !== "on" && val !== "off") {
      console.log("Usage: json on|off");
      return;
    }
    this.state.session.jsonOutput = val === "on";
    await this.persist();
    console.log(`jsonOutput=${this.state.session.jsonOutput}`);
  }

  private async cmdGuest(rest: string[]): Promise<void> {
    const sub = rest[0];

    if (sub === "show" || sub === undefined) {
      const token = this.state.session.guestToken;
      this.printData(
        token
          ? { enabled: true, tokenPreview: `${token.slice(0, 8)}...` }
          : { enabled: false }
      );
      return;
    }

    if (sub === "set-token") {
      const token = rest[1]?.trim();
      if (!token) {
        console.log("Usage: guest set-token <token>");
        return;
      }
      this.state.session.guestToken = token;
      await this.persist();
      console.log("Guest token set.");
      return;
    }

    if (sub === "bootstrap") {
      const countryTk = rest[1]?.trim();
      const parsed = parseKeyValueTokens(rest.slice(2));
      const sourceCode = (parsed.opts.sourceCode ?? this.state.session.region).toUpperCase();

      if (!countryTk) {
        console.log("Usage: guest bootstrap <countryTk> [sourceCode=SG]");
        return;
      }

      const res = await this.client.commonLoginSg({
        sourceCode,
        token: countryTk
      });
      this.printEnvelope(res);

      if (!isApiOk(res)) {
        return;
      }

      const token = extractToken(res);
      if (!token) {
        console.log("Bootstrap succeeded but token was missing in response.");
        return;
      }

      this.state.session.guestToken = token;
      await this.persist();
      console.log(`Guest token bootstrapped for sourceCode=${sourceCode}.`);
      return;
    }

    if (sub === "clear") {
      this.state.session.guestToken = undefined;
      await this.persist();
      console.log("Guest token cleared.");
      return;
    }

    console.log("Usage: guest show | guest set-token <token> | guest bootstrap <countryTk> [sourceCode=SG] | guest clear");
  }

  private async cmdLogin(rest: string[]): Promise<void> {
    const subRaw = rest[0];
    const sub = (subRaw ?? "").toLowerCase();
    const region = this.activeRegion();
    if (rest.length === 0 || isKeyValueToken(subRaw) || sub === "guided") {
      const parsed = parseKeyValueTokens(sub === "guided" ? rest.slice(1) : rest);
      await this.cmdLoginGuided(parsed.opts);
      return;
    }

    if (sub === "token") {
      const parsed = parseKeyValueTokens(rest.slice(1));
      const inputToken = parsed.opts.token ?? (parsed.args.length > 0 ? parsed.args.join(" ") : undefined);
      const token = normalizeImportedAuthToken(inputToken);
      if (!token) {
        console.log("Usage: login token <token> [phone=+6591234567]");
        this.printManualImportHelp();
        return;
      }
      const ok = await this.loginWithToken(token, parsed.opts.phone, "token");
      if (!ok) {
        console.log("Token login failed. Retry with a valid token or run `login` for guided flow.");
      }
      return;
    }

    if (sub === "web" || sub === "oauth") {
      console.log("Legacy alias: `login web ...` detected. Prefer `login`.");
      const parsed = parseKeyValueTokens(rest.slice(1));
      const action = (parsed.args[0] ?? "auto").toLowerCase();
      const forwardOpts = { ...parsed.opts };

      if (action === "open") {
        this.openUrl("https://h5.chagee.com.sg/main");
        console.log("Use your existing logged-in browser session, then run `login`.");
        return;
      }
      if (action !== "auto" && action !== "guided") {
        console.log(
          "Usage: login [timeout=120] [cdp=auto|http://127.0.0.1:9222] [open=1] [phone=+6591234567]"
        );
        return;
      }
      if (action === "auto") {
        delete forwardOpts.auto;
      }
      await this.cmdLoginGuided(forwardOpts, { openByDefault: false });
      return;
    }

    if (sub === "import" || sub === "paste") {
      console.log("Legacy alias: use `login token <token>` or `login`.");
      const parsed = parseKeyValueTokens(rest.slice(1));
      const inputToken = parsed.opts.token ?? (parsed.args.length > 0 ? parsed.args.join(" ") : undefined);
      let token = normalizeImportedAuthToken(inputToken);
      if (!token) {
        token = this.readAuthTokenFromClipboard();
        if (token) {
          console.log("Using auth token from clipboard.");
        }
      }
      if (!token) {
        console.log("Usage: login token <token> [phone=+6591234567]");
        this.printManualImportHelp();
        return;
      }
      const ok = await this.loginWithToken(token, parsed.opts.phone, "imported token");
      if (!ok) {
        console.log("Imported token could not be verified.");
      }
      return;
    }

    if (sub === "start") {
      const phone = rest[1];
      const parsed = parseKeyValueTokens(rest.slice(2));
      const sendType = parseNum(parsed.opts.sendType, 1);
      if (!phone) {
        console.log(
          `Usage: login <phone-with-country-code> (or login start <phone-with-country-code>) [sendType=1] (example: +6591234567, default dial code ${region.defaultPhoneCode})`
        );
        return;
      }

      const res = await this.client.sendVerifyCode(phone, sendType);
      this.printEnvelope(res);
      if (isApiOk(res)) {
        this.state.pendingLoginPhone = phone;
        await this.persist();
      }
      return;
    }

    if (sub === "verify") {
      const code = rest[1];
      const parsed = parseKeyValueTokens(rest.slice(2));
      const phone = parsed.opts.phone ?? this.state.pendingLoginPhone;
      const phoneCode = parsed.opts.phoneCode ?? region.defaultPhoneCode;

      if (!code || !phone) {
        console.log(
          "Usage: otp <code> [phone=<phone>] [phoneCode=<dial-code>] (or login verify ...)"
        );
        return;
      }

      const res = await this.client.loginOrRegister({ phone, code, phoneCode });
      this.printEnvelope(res);

      const token = extractToken(res);
      const userId = extractUserId(res);
      if (isApiOk(res) && token && userId) {
        const profileCheck = await this.ensureLoginProfile(token, userId);
        if (!profileCheck.ok) {
          console.log(`Login blocked: ${profileCheck.reason}`);
          console.log("Profile verification failed. Please retry login.");
          return;
        }

        const verifiedUserId = profileCheck.userId ?? userId;
        this.state.auth = {
          token,
          userId: verifiedUserId,
          phoneRaw: phone,
          phoneMasked: maskPhone(phone)
        };
        this.state.pendingLoginPhone = undefined;
        await this.persist();
        console.log(`Logged in as userId=${verifiedUserId}`);
        console.log(`Profile verified via ${profileCheck.endpoint}`);
      } else if (isApiOk(res)) {
        console.log("Login succeeded but token/userId not found in response.");
      }
      return;
    }

    if (isLikelyPhoneToken(subRaw)) {
      console.log("Legacy OTP flow detected. Prefer `login` guided flow.");
      await this.cmdLogin(["start", ...rest]);
      return;
    }

    console.log(
      "Usage: login [timeout=120] [cdp=auto|http://127.0.0.1:9222] [open=1] [phone=+6591234567] | login token <token> [phone=+6591234567] | logout"
    );
    console.log("Legacy aliases still supported: login web|import|paste|start|verify, otp <code>.");
  }

  private async cmdLoginGuided(
    opts: Record<string, string>,
    behavior: { openByDefault?: boolean } = {}
  ): Promise<void> {
    const url = "https://h5.chagee.com.sg/main";
    const phone = opts.phone;
    const timeoutSec = Math.max(30, Math.min(600, Math.floor(parseNum(opts.timeout, 120))));
    const refresh = parseBool(opts.refresh, true);
    const explicitCdp = opts.cdp;
    const shouldOpen = parseBool(opts.open, behavior.openByDefault ?? true);

    if (this.state.auth?.token) {
      const existing = this.state.auth;
      const profileCheck = await this.ensureLoginProfile(existing.token, existing.userId);
      if (profileCheck.ok) {
        this.state.auth = {
          token: existing.token,
          userId: profileCheck.userId,
          phoneRaw: phone ?? existing.phoneRaw,
          phoneMasked: phone ? maskPhone(phone) : existing.phoneMasked
        };
        await this.persist();
        console.log(`Already logged in as userId=${profileCheck.userId}`);
        console.log(`Profile verified via ${profileCheck.endpoint}`);
        return;
      }
      console.log(`Stored session is invalid (${profileCheck.reason}). Trying fresh login...`);
    }

    const clipboardToken = this.readAuthTokenFromClipboard();
    if (clipboardToken) {
      console.log("Found token in clipboard. Verifying...");
      const ok = await this.loginWithToken(clipboardToken, phone, "clipboard token");
      if (ok) {
        return;
      }
      console.log("Clipboard token could not be verified. Trying browser session capture...");
    }

    if (shouldOpen) {
      this.openUrl(url);
    }
    console.log(`Using existing browser session at ${url}`);
    console.log("No separate browser login flow is launched by the CLI.");

    const autoDetectCdp = parseCdpCandidateInput(explicitCdp).length === 0;
    const cdpCandidates = buildCdpCandidateUrls(explicitCdp);
    if (autoDetectCdp) {
      console.log(`Scanning ${cdpCandidates.length} local CDP endpoint(s) for an active CHAGEE tab...`);
    } else {
      console.log(`Using CDP endpoint(s): ${cdpCandidates.join(", ")}`);
    }
    console.log(`Waiting up to ${timeoutSec}s for CHAGEE API auth headers...`);

    const capture = await this.captureBrowserTokenFromExistingSession(
      cdpCandidates,
      url,
      timeoutSec,
      refresh
    );
    if (!capture.token) {
      this.printBrowserLoginCaptureFailure(capture.attempts, url, timeoutSec, autoDetectCdp);
      this.printManualImportHelp();
      return;
    }

    console.log(`Captured auth token via ${capture.endpoint ?? "CDP"}`);
    const ok = await this.loginWithToken(capture.token, phone, "browser OAuth");
    if (!ok) {
      console.log("Browser session token was captured but profile verification failed.");
    }
  }

  private async loginWithToken(
    token: string,
    phone: string | undefined,
    sourceLabel: string
  ): Promise<boolean> {
    const profileCheck = await this.ensureLoginProfile(token);
    if (!profileCheck.ok) {
      console.log(`Login via ${sourceLabel} blocked: ${profileCheck.reason}`);
      return false;
    }

    this.state.auth = {
      token,
      userId: profileCheck.userId,
      phoneRaw: phone,
      phoneMasked: phone ? maskPhone(phone) : undefined
    };
    this.state.pendingLoginPhone = undefined;
    await this.persist();
    console.log(`Logged in via ${sourceLabel} as userId=${profileCheck.userId}`);
    console.log(`Profile verified via ${profileCheck.endpoint}`);
    return true;
  }

  private async captureBrowserTokenFromExistingSession(
    cdpBaseUrls: string[],
    loginUrl: string,
    timeoutSec: number,
    refresh: boolean
  ): Promise<BrowserTokenCaptureResult> {
    const attempts: BrowserTokenCaptureAttempt[] = [];
    for (const cdpBaseUrl of cdpBaseUrls) {
      const attempt = await this.captureBrowserTokenFromCdpEndpoint(
        cdpBaseUrl,
        loginUrl,
        timeoutSec,
        refresh
      );
      attempts.push(attempt);
      if (attempt.status === "success" && attempt.token) {
        return {
          token: attempt.token,
          endpoint: attempt.endpoint,
          attempts
        };
      }
    }
    return { attempts };
  }

  private async captureBrowserTokenFromCdpEndpoint(
    cdpBaseUrl: string,
    loginUrl: string,
    timeoutSec: number,
    refresh: boolean
  ): Promise<BrowserTokenCaptureAttempt> {
    const cdpUrl = normalizeCdpBaseUrl(cdpBaseUrl);
    let targets: CdpTarget[];
    try {
      targets = await listCdpTargets(cdpUrl);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        endpoint: cdpUrl,
        status: "connect_error",
        reason
      };
    }

    if (targets.length === 0) {
      return {
        endpoint: cdpUrl,
        status: "no_tabs"
      };
    }

    const target = pickCdpTargetFromTargets(targets, loginUrl);
    if (!target) {
      return {
        endpoint: cdpUrl,
        status: "no_chagee_tab",
        sampleTargets: targets
          .slice(0, 5)
          .map((entry) => `${entry.type ?? "unknown"}:${entry.url ?? entry.title ?? "(blank)"}`)
      };
    }

    if (!target.webSocketDebuggerUrl) {
      return {
        endpoint: cdpUrl,
        status: "no_debug_ws",
        ...(target.url ? { targetUrl: target.url } : {})
      };
    }

    const token = await waitForCdpAuthToken({
      wsDebuggerUrl: target.webSocketDebuggerUrl,
      apiBase: this.activeRegion().apiBase,
      timeoutSec,
      refresh
    });
    if (!token) {
      return {
        endpoint: cdpUrl,
        status: "token_not_seen",
        ...(target.url ? { targetUrl: target.url } : {})
      };
    }
    return {
      endpoint: cdpUrl,
      status: "success",
      ...(target.url ? { targetUrl: target.url } : {}),
      token
    };
  }

  private printBrowserLoginCaptureFailure(
    attempts: BrowserTokenCaptureAttempt[],
    loginUrl: string,
    timeoutSec: number,
    autoDetectCdp: boolean
  ): void {
    console.log("Unable to capture auth token from existing browser session.");
    if (attempts.length === 0) {
      console.log("No CDP endpoints were available to scan.");
      return;
    }

    for (const attempt of attempts) {
      console.log(`- ${attempt.endpoint}: ${describeBrowserCaptureAttempt(attempt, timeoutSec)}`);
      if (attempt.status === "no_chagee_tab" && (attempt.sampleTargets?.length ?? 0) > 0) {
        console.log(`  tabs: ${attempt.sampleTargets?.join(" | ")}`);
      }
    }

    console.log(`Open ${loginUrl} in your already logged-in browser, then retry.`);
    if (!attempts.some((attempt) => attempt.status !== "connect_error")) {
      console.log("No endpoint was reachable.");
      console.log("Start Chrome once with remote debugging enabled, then retry:");
      console.log("  Google Chrome --remote-debugging-port=9222");
    } else if (attempts.some((attempt) => attempt.status === "token_not_seen")) {
      console.log("CHAGEE tab was found but no auth token was observed in time.");
      console.log("Interact with the page (or increase timeout), then retry.");
    }

    if (autoDetectCdp) {
      console.log("Optional: pass an explicit endpoint, e.g. `login cdp=http://127.0.0.1:9222`");
    }
    console.log("Fallback: login token <token> [phone=+6591234567] (or legacy: login paste / login import)");
  }

  private readAuthTokenFromClipboard(): string | undefined {
    const attempts = clipboardReadCommands(process.platform);
    for (const attempt of attempts) {
      try {
        const res = spawnSync(attempt.command, attempt.args, {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"]
        });
        if (res.error || res.status !== 0) {
          continue;
        }
        const token = normalizeImportedAuthToken(res.stdout);
        if (token) {
          return token;
        }
      } catch {
        // Ignore and try next clipboard command.
      }
    }
    return undefined;
  }

  private printManualImportHelp(): void {
    console.log("Manual import quick guide:");
    console.log("1) Log in at https://h5.chagee.com.sg/main");
    console.log("2) Browser DevTools -> Network -> open any CHAGEE API request");
    console.log("3) Copy request header `authorization` value");
    console.log("4) Run `login token <token>` (or legacy: `login paste` / `login import <token>`)");
  }

  private async ensureLoginProfile(
    token: string,
    expectedUserId?: string
  ): Promise<
    | {
        ok: true;
        endpoint: "customer/info" | "customer/details";
        userId: string;
      }
    | {
        ok: false;
        reason: string;
      }
  > {
    const previousAuth = this.state.auth;
    this.state.auth = {
      token,
      userId: expectedUserId ?? "profile-check"
    };

    const attempts: Array<{
      endpoint: "customer/info" | "customer/details";
      run: () => Promise<ApiEnvelope>;
    }> = [
      {
        endpoint: "customer/info",
        run: () => this.client.getCustomerInfo()
      },
      {
        endpoint: "customer/details",
        run: () => this.client.getCustomerDetails()
      }
    ];

    try {
      for (const attempt of attempts) {
        let res: ApiEnvelope;
        try {
          res = await attempt.run();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            ok: false,
            reason: `${attempt.endpoint} request failed (${message})`
          };
        }

        if (!isApiOk(res)) {
          continue;
        }

        const profile = envelopeData(res);
        if (!hasProfilePayload(profile)) {
          continue;
        }

        const profileUserId = extractProfileUserId(profile);
        if (expectedUserId && profileUserId && profileUserId !== expectedUserId) {
          return {
            ok: false,
            reason: `${attempt.endpoint} userId mismatch (login=${expectedUserId}, profile=${profileUserId})`
          };
        }

        const resolvedUserId = profileUserId ?? expectedUserId;
        if (!resolvedUserId) {
          continue;
        }

        return {
          ok: true,
          endpoint: attempt.endpoint,
          userId: resolvedUserId
        };
      }

      return {
        ok: false,
        reason: "no verified profile found from customer/info or customer/details"
      };
    } finally {
      this.state.auth = previousAuth;
    }
  }

  private async cmdLogout(): Promise<void> {
    const previousUserId = this.state.auth?.userId;
    this.state.auth = undefined;
    this.state.pendingLoginPhone = undefined;
    this.state.session.storePinned = false;
    this.state.quote = undefined;
    this.state.order = undefined;
    this.state.payment = undefined;
    this.itemSkuOptionsCacheByStore = {};
    if (previousUserId) {
      await clearAuthToken(previousUserId);
    }
    await this.persist();
    console.log("Logged out");
  }

  private async cmdLocate(rest: string[]): Promise<void> {
    const parsed = parseKeyValueTokens(rest);
    const sub = parsed.args[0];
    if (sub === "help") {
      console.log("Usage: locate [timeout=60] [open=1]");
      console.log("Opens a browser page to request geolocation permission.");
      return;
    }

    const timeoutSec = Math.max(15, Math.min(180, Math.floor(parseNum(parsed.opts.timeout, 60))));
    const shouldOpenBrowser = parseBool(parsed.opts.open, true);
    const location = await this.captureBrowserLocation(timeoutSec, shouldOpenBrowser);

    this.state.session.latitude = location.latitude;
    this.state.session.longitude = location.longitude;
    this.state.session.locationSource = "browser";
    this.state.session.locationUpdatedAt = new Date().toISOString();
    this.state.session.locationAccuracyMeters = location.accuracyMeters;
    this.state.session.storePinned = false;
    await this.persist();

    const accuracy =
      location.accuracyMeters !== undefined && Number.isFinite(location.accuracyMeters)
        ? ` (accuracy +/-${Math.round(location.accuracyMeters)}m)`
        : "";
    console.log(
      `Location set: ${location.latitude.toFixed(6)},${location.longitude.toFixed(6)}${accuracy}`
    );
    await this.refreshStores("distance", false);
    await this.persist();
  }

  private async cmdStores(rest: string[]): Promise<void> {
    const sub = rest[0];

    if (sub === "watch") {
      const mode = rest[1];
      const parsed = parseKeyValueTokens(rest.slice(2));
      const intervalSec = Math.max(3, parseNum(parsed.opts.interval, 10));
      const silent = parseBool(parsed.opts.quiet ?? parsed.opts.silent, false);
      const sortBy = parseStoreSort(parsed.opts.sort, "distance");
      if (mode === "on") {
        await this.startStoreWatch(intervalSec, silent, sortBy);
      } else if (mode === "off") {
        this.stopStoreWatch();
        console.log("watch off");
      } else {
        console.log("Usage: watch on|off [interval=10] [sort=distance|wait|cups|name] [quiet=1]");
      }
      return;
    }

    if (sub === "list" || sub === undefined) {
      const parsed = parseKeyValueTokens(sub === "list" ? rest.slice(1) : rest);
      const sortBy = parseStoreSort(parsed.opts.sort, "distance");
      const hasExplicitLocation = parsed.opts.lat !== undefined || parsed.opts.lng !== undefined;
      const latitude = parseNum(parsed.opts.lat, this.state.session.latitude);
      const longitude = parseNum(parsed.opts.lng, this.state.session.longitude);
      this.state.session.latitude = latitude;
      this.state.session.longitude = longitude;
      if (hasExplicitLocation) {
        this.state.session.locationSource = "manual";
        this.state.session.locationUpdatedAt = new Date().toISOString();
        this.state.session.locationAccuracyMeters = undefined;
        this.state.session.storePinned = false;
      }
      await this.refreshStores(sortBy, false);
      await this.persist();
      return;
    }

    console.log(
      "Usage: stores [sort=distance|wait|cups|name] [lat=1.35] [lng=103.81] | watch on|off"
    );
  }

  private async cmdStore(rest: string[]): Promise<void> {
    const sub = rest[0];
    if (sub === "use") {
      const storeNo = rest[1];
      if (!storeNo) {
        console.log("Usage: use <storeNo>");
        return;
      }

      const previousStoreNo = this.state.selectedStore?.storeNo;
      const cached = this.state.storesCache.find((s) => s.storeNo === storeNo);
      if (!cached) {
        this.state.selectedStore = {
          storeNo,
          storeName: "(unknown store)"
        };
      } else {
        this.state.selectedStore = { ...cached };
      }

      const changedStore = previousStoreNo !== this.state.selectedStore.storeNo;
      if (changedStore) {
        resetForStoreSwitch(this.state);
      }
      this.state.session.storePinned = true;
      this.syncMenuCacheForSelectedStore();
      await this.ensureMenuForSelectedStore(true);

      await this.persist();
      console.log(`Selected store ${this.state.selectedStore.storeNo}`);
      return;
    }

    if (sub === "wait") {
      if (!this.state.selectedStore) {
        console.log("Select a store first: use <storeNo>");
        return;
      }

      const res = await this.client.getStoreWaitInfo({
        storeNo: this.state.selectedStore.storeNo,
        isTakeaway: this.activeRegion().isTakeaway
      });
      this.printEnvelope(res);

      if (isApiOk(res)) {
        const wait = parseWaitInfo(envelopeData(res));
        this.state.selectedStore = {
          ...this.state.selectedStore,
          ...wait
        };
        await this.persist();
        console.log(
          `Store ${this.state.selectedStore.storeNo}: waitingCups=${
            this.state.selectedStore.waitingCups ?? "-"
          }, waitingTime=${this.state.selectedStore.waitingTime ?? "-"}min`
        );
      }
      return;
    }

    console.log("Usage: use <storeNo> | wait");
  }

  private async cmdMenu(rest: string[]): Promise<void> {
    let sub = rest[0];
    if (!this.state.selectedStore) {
      console.log("Select a store first: use <storeNo>");
      return;
    }
    this.syncMenuCacheForSelectedStore();

    if (sub === undefined) {
      const parsed = parseKeyValueTokens(rest);
      const search = parsed.opts.search;
      if (search) {
        sub = "search";
        rest = [sub, search];
      } else {
        sub = "categories";
      }
    } else if (sub.startsWith("search=")) {
      const value = sub.slice("search=".length);
      sub = "search";
      rest = [sub, value, ...rest.slice(1)];
    }

    if (sub === "categories") {
      await this.fetchMenu();
      this.warnIfAnonymousMenuEmpty();
      const rows = this.state.menuCache.map((c) => [c.id, c.name, String(c.items.length)]);
      printTable(["categoryId", "name", "items"], rows);
      return;
    }

    if (sub === "list") {
      const categoryId = rest[1];
      if (!categoryId) {
        console.log("Usage: menu list <categoryId>");
        return;
      }
      if (this.state.menuCache.length === 0) {
        await this.fetchMenu();
        this.warnIfAnonymousMenuEmpty();
      }
      const category = this.state.menuCache.find((c) => c.id === categoryId);
      if (!category) {
        console.log(`Category not found: ${categoryId}`);
        return;
      }
      const rows = category.items.map((item) => [
        item.spuId,
        item.skuId ?? "-",
        item.name,
        item.price !== undefined ? String(item.price) : "-"
      ]);
      printTable(["spuId", "skuId", "name", "price"], rows);
      return;
    }

    if (sub === "search") {
      const keyword = rest.slice(1).join(" ").toLowerCase();
      if (!keyword) {
        console.log('Usage: menu search "<text>"');
        return;
      }
      if (this.state.menuCache.length === 0) {
        await this.fetchMenu();
        this.warnIfAnonymousMenuEmpty();
      }
      const hits: Array<{ category: string; item: MenuItem }> = [];
      for (const cat of this.state.menuCache) {
        for (const item of cat.items) {
          if (item.name.toLowerCase().includes(keyword)) {
            hits.push({ category: cat.name, item });
          }
        }
      }
      const rows = hits.map((h) => [
        h.item.spuId,
        h.item.skuId ?? "-",
        h.item.name,
        h.category
      ]);
      printTable(["spuId", "skuId", "name", "category"], rows);
      return;
    }

    console.log("Usage: menu categories | menu list <categoryId> | menu search <text>");
  }

  private async ensureSelectedStoreForOrder(trigger: string): Promise<void> {
    if (this.state.storesCache.length === 0) {
      await this.refreshStores("distance", true);
    }

    const closest = pickClosestStore(this.state.storesCache);
    if (!closest) {
      return;
    }

    const selected = this.state.selectedStore;
    if (!selected || !this.state.session.storePinned) {
      const changed = !selected || selected.storeNo !== closest.storeNo;
      this.state.selectedStore = closest;
      this.state.session.storePinned = false;
      this.syncMenuCacheForSelectedStore();
      await this.ensureMenuForSelectedStore(true);
      if (changed) {
        await this.persist();
        console.log(
          `Auto-selected closest store for ${trigger}: ${closest.storeNo} (${closest.storeName}, ${formatDistanceKm(
            closest.distanceMeters
          )})`
        );
      }
    }
  }

  private warnIfAnonymousMenuEmpty(): void {
    if (this.state.menuCache.length > 0) {
      return;
    }
    if (this.state.auth) {
      return;
    }
    console.log(
      "Menu returned empty for anonymous session. Try another store, or login for account-specific availability."
    );
  }

  private async cmdItem(rest: string[]): Promise<void> {
    const sub = rest[0];
    if (sub !== "show") {
      console.log("Usage: item <spuId>");
      return;
    }
    if (!this.state.selectedStore) {
      console.log("Select a store first: use <storeNo>");
      return;
    }
    const spuId = rest[1];
    if (!spuId) {
      console.log("Usage: item <spuId>");
      return;
    }
    const region = this.activeRegion();
    const res = await this.client.getGoodsDetail({
      spuId,
      storeNo: this.state.selectedStore.storeNo,
      saleType: region.saleType,
      saleChannel: region.saleChannel
    });
    this.printEnvelope(res);
    if (!isApiOk(res)) {
      return;
    }
    const options = extractItemSkuOptions(envelopeData(res));
    const storeNo = this.state.selectedStore.storeNo;
    const perStore = (this.itemSkuOptionsCacheByStore[storeNo] ??= {});
    perStore[spuId] = options;
    if (options.length === 0) {
      this.printData(envelopeData(res));
      return;
    }
    const rows = options.slice(0, ITEM_OPTION_PRINT_LIMIT).map((option) => [
      option.skuId,
      option.price !== undefined ? option.price.toFixed(2) : "-",
      option.specText ?? "-",
      option.name
    ]);
    printTable(["skuId", "price", "variant", "name"], rows);
    if (options.length > ITEM_OPTION_PRINT_LIMIT) {
      console.log(
        `... ${options.length - ITEM_OPTION_PRINT_LIMIT} more option(s). Use the TUI variant picker to browse all.`
      );
    }
  }

  private async cmdCart(rest: string[]): Promise<void> {
    const sub = rest[0];
    if (!sub) {
      console.log("Usage: add <skuId> | qty <item> <n> | rm <item> | clear | cart");
      return;
    }

    if (sub === "add") {
      const skuId = rest[1];
      const parsed = parseKeyValueTokens(rest.slice(2));
      if (!skuId) {
        console.log(
          "Usage: add <skuId> [qty=1] [spuId=...] [name=...] [price=...] [specList=<json>] [attributeList=<json>]"
        );
        return;
      }
      const qty = Math.max(1, Math.floor(parseNum(parsed.opts.qty, 1)));
      const specList = parseSpecSelectionList(parsed.opts.specList);
      const attributeList = parseAttributeSelectionList(parsed.opts.attributeList);
      const line: CartLine = {
        lineId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        skuId,
        spuId: parsed.opts.spuId,
        name: parsed.opts.name,
        variantText: parsed.opts.variant,
        qty,
        price: parsed.opts.price ? parseNum(parsed.opts.price, 0) : undefined,
        specList,
        attributeList
      };
      this.state.cart.push(line);
      nextCartVersion(this.state);
      await this.persist();
      console.log(`Added item ${this.state.cart.length}`);
      return;
    }

    if (sub === "set") {
      const itemRef = rest[1];
      const parsed = parseKeyValueTokens(rest.slice(2));
      const qty = Math.max(0, Math.floor(parseNum(parsed.opts.qty, -1)));
      if (!itemRef || qty < 0) {
        console.log("Usage: qty <item> <n>");
        return;
      }
      const resolved = this.resolveCartItemRef(itemRef);
      if (!resolved) {
        console.log(`item not found: ${itemRef}`);
        return;
      }
      const line = this.state.cart.find((l) => l.lineId === resolved.lineId);
      if (!line) {
        console.log(`item not found: ${itemRef}`);
        return;
      }
      if (qty === 0) {
        this.state.cart = this.state.cart.filter((l) => l.lineId !== resolved.lineId);
        console.log(`Removed item ${resolved.itemNo}`);
      } else {
        line.qty = qty;
        console.log(`Updated item ${resolved.itemNo} qty=${qty}`);
      }
      nextCartVersion(this.state);
      await this.persist();
      return;
    }

    if (sub === "rm") {
      const itemRef = rest[1];
      if (!itemRef) {
        console.log("Usage: rm <item>");
        return;
      }
      const resolved = this.resolveCartItemRef(itemRef);
      if (!resolved) {
        console.log(`item not found: ${itemRef}`);
        return;
      }
      this.state.cart = this.state.cart.filter((l) => l.lineId !== resolved.lineId);
      nextCartVersion(this.state);
      await this.persist();
      console.log(`Removed item ${resolved.itemNo}`);
      return;
    }

    if (sub === "clear") {
      this.state.cart = [];
      nextCartVersion(this.state);
      await this.persist();
      console.log("Cart cleared");
      return;
    }

    if (sub === "show") {
      if (this.state.cart.length === 0) {
        console.log("Cart is empty");
        return;
      }
      const rows = this.state.cart.map((l, idx) => [
        String(idx + 1),
        l.skuId,
        l.name ?? "-",
        String(l.qty),
        l.price !== undefined ? String(l.price) : "-"
      ]);
      printTable(["item", "skuId", "name", "qty", "price"], rows);
      return;
    }

    if (sub === "sync") {
      if (!this.state.auth || !this.state.selectedStore) {
        console.log("cart sync needs auth + selected store");
        return;
      }
      const region = this.activeRegion();
      const skuList = this.buildSkuList();
      const changed = await this.client.cartChange({
        userId: this.state.auth.userId,
        skuList,
        saleType: region.saleType,
        saleChannel: region.saleChannel,
        inAppDeliveryGray: false
      });
      this.printEnvelope(changed);
      if (isApiOk(changed)) {
        const got = await this.client.cartGet({
          userId: this.state.auth.userId,
          storeNo: this.state.selectedStore.storeNo,
          saleType: region.saleType,
          saleChannel: region.saleChannel,
          tradeChannel: region.tradeChannel
        });
        this.printEnvelope(got);
        this.printData(envelopeData(got));
      }
      return;
    }

    console.log("Usage: add|qty|rm|clear|cart");
  }

  private resolveCartItemRef(itemRef: string): { lineId: string; itemNo: number } | undefined {
    const asNumber = Number.parseInt(itemRef, 10);
    if (/^\d+$/.test(itemRef) && Number.isFinite(asNumber)) {
      const itemNo = Math.max(1, asNumber);
      const line = this.state.cart[itemNo - 1];
      if (!line) {
        return undefined;
      }
      return { lineId: line.lineId, itemNo };
    }

    const index = this.state.cart.findIndex((line) => line.lineId === itemRef);
    if (index < 0) {
      return undefined;
    }
    const line = this.state.cart[index];
    if (!line) {
      return undefined;
    }
    return { lineId: line.lineId, itemNo: index + 1 };
  }

  private async cmdQuote(): Promise<void> {
    if (!this.state.auth) {
      console.log("Login required");
      return;
    }
    await this.ensureSelectedStoreForOrder("quote");
    if (!this.state.selectedStore) {
      console.log("Select a store first");
      return;
    }
    if (this.state.cart.length === 0) {
      console.log("Cart is empty");
      return;
    }

    const payload = this.buildQuotePayload();
    const res = await this.client.orderPrice(payload);
    this.printEnvelope(res);

    if (isApiOk(res)) {
      const data = envelopeData<Record<string, unknown>>(res) ?? {};
      const quoteRespVO =
        (data.priceQuoteRespVO as Record<string, unknown> | undefined) ?? undefined;
      const totalCandidates = [
        quoteRespVO?.payAmount,
        quoteRespVO?.amount,
        data.payAmount,
        data.totalAmount
      ];
      let total: string | undefined;
      for (const c of totalCandidates) {
        if (typeof c === "string" || typeof c === "number") {
          total = String(c);
          break;
        }
      }

      this.state.quote = {
        at: new Date().toISOString(),
        total,
        priceQuoteRespVO: quoteRespVO,
        raw: data
      };
      await this.persist();
      console.log(`Quoted total: ${total ?? "(unknown)"}`);
    }
  }

  private async cmdPlace(rest: string[]): Promise<void> {
    if (!this.state.auth) {
      console.log("Login required");
      return;
    }
    await this.ensureSelectedStoreForOrder("place");
    if (!this.state.selectedStore) {
      console.log("Select a store first");
      return;
    }
    if (this.state.cart.length === 0) {
      console.log("Cart is empty");
      return;
    }

    const parsed = parseKeyValueTokens(rest);
    const open = parsed.opts.open !== "0";
    const region = this.activeRegion();
    const channelCode = parsed.opts.channelCode ?? region.channelCode;
    const payType = parsed.opts.payType ?? "1";

    if (!this.state.quote) {
      console.log("No quote in session, running quote...");
      await this.cmdQuote();
      if (!this.state.quote) {
        return;
      }
    }

    const payload = this.buildCreatePayload();
    this.state.pendingCreatePayload = payload;
    await this.persist();

    if (this.state.session.mode !== "live") {
      console.log("Dry-run mode: order not submitted.");
      console.log("Run `live on` and retry `place` to create a real order.");
      return;
    }

    const createRes = await this.client.orderCreate(payload);
    this.printEnvelope(createRes);

    if (!isApiOk(createRes)) {
      return;
    }

    const created = envelopeData<Record<string, unknown>>(createRes) ?? {};
    const orderNo =
      asString(created.orderNo) ?? asString(created.orderId) ?? asString(created.no) ?? "";
    if (!orderNo) {
      console.log("Create succeeded but orderNo not found in response.");
      return;
    }

    this.state.order = {
      orderNo,
      status: "created",
      amount: this.state.quote?.total,
      createdAt: new Date().toISOString(),
      raw: created
    };
    this.applyOrderCancelWindow(created);
    this.state.pendingCreatePayload = undefined;
    this.state.payment = undefined;
    await this.persist();
    console.log(`Order created: ${orderNo}`);

    const payPayload = {
      userId: this.state.auth.userId,
      orderNo,
      storeNo: this.state.selectedStore.storeNo,
      source: region.source,
      channelCode,
      payType,
      extInfo: {}
    };

    const payRes = await this.client.continuePay(payPayload);
    this.printEnvelope(payRes);
    if (!isApiOk(payRes)) {
      return;
    }

    const payData = envelopeData<Record<string, unknown>>(payRes) ?? {};
    const payNo = asString(payData.payNo);
    const payUrl = extractPayUrl(payData);
    this.state.payment = {
      payNo,
      payUrl,
      status: "pending",
      method: payType,
      raw: payData
    };
    this.applyOrderCancelWindow(payData);
    await this.persist();

    console.log(`payNo=${payNo ?? "-"}`);
    if (!payUrl) {
      console.log("No payment URL returned.");
      return;
    }

    console.log(`payUrl=${payUrl}`);
    if (open) {
      this.openUrl(payUrl);
    } else {
      console.log("Run `pay open` to open payment in your browser.");
    }
  }

  private async cmdCheckout(): Promise<void> {
    if (!this.state.auth) {
      console.log("Login required");
      return;
    }
    await this.ensureSelectedStoreForOrder("checkout");
    if (!this.state.selectedStore) {
      console.log("Select a store first");
      return;
    }
    if (!this.state.quote) {
      console.log("Run `quote` first");
      return;
    }

    const payload = this.buildCreatePayload();
    this.state.pendingCreatePayload = payload;
    await this.persist();

    console.log("Create-order payload staged. Review with `debug last-req` after confirm.");
    console.log(`Mode=${this.state.session.mode}. Use 'confirm' to submit create order.`);
    this.printData(payload);
  }

  private async cmdConfirm(): Promise<void> {
    if (this.state.session.mode !== "live") {
      console.log("confirm is disabled in dry-run mode. Run: live on");
      return;
    }
    if (!this.state.pendingCreatePayload) {
      console.log("No staged checkout payload. Run `checkout` first.");
      return;
    }

    const res = await this.client.orderCreate(this.state.pendingCreatePayload);
    this.printEnvelope(res);

    if (isApiOk(res)) {
      const data = envelopeData<Record<string, unknown>>(res) ?? {};
      const orderNo =
        asString(data.orderNo) ?? asString(data.orderId) ?? asString(data.no) ?? "";
      if (!orderNo) {
        console.log("Create succeeded but orderNo not found in response.");
      }
      this.state.order = {
        orderNo,
        status: "created",
        amount: this.state.quote?.total,
        createdAt: new Date().toISOString(),
        raw: data
      };
      this.applyOrderCancelWindow(data);
      this.state.pendingCreatePayload = undefined;
      this.state.payment = undefined;
      await this.persist();
      console.log(`Order created: ${orderNo || "(unknown)"}`);
    }
  }

  private async cmdOrder(rest: string[]): Promise<void> {
    const sub = rest[0];
    if (sub === "show" || sub === undefined) {
      if (!this.state.order) {
        this.printData(null);
        return;
      }
      this.printData(buildOrderView(this.state.order));
      return;
    }

    if (sub === "cancel") {
      if (!this.state.auth || !this.state.order?.orderNo) {
        console.log("order cancel needs auth + existing order");
        return;
      }
      const parsed = parseKeyValueTokens(rest.slice(1));
      const force = parsed.opts.force === "1";
      const remainingSec = estimateCancelRemainingSec(this.state.order);
      if (remainingSec !== undefined && remainingSec <= 0 && !force) {
        console.log(
          `Local check: cancel window appears expired at ${this.state.order.cancelByAt ?? "(unknown)"}`
        );
        console.log("Use `order cancel force=1` to still send API request.");
        return;
      }
      const res = await this.client.orderCancel(
        this.state.auth.userId,
        this.state.order.orderNo
      );
      this.printEnvelope(res);
      if (isApiOk(res)) {
        this.state.order.status = "canceled";
        await this.persist();
      }
      return;
    }

    console.log("Usage: order | order show | order cancel [force=1]");
  }

  private async cmdPay(rest: string[]): Promise<void> {
    const raw = rest[0];
    const action = (raw ?? "go").toLowerCase();

    if (!raw || isKeyValueToken(raw) || action === "go" || action === "now") {
      const tokens = !raw || isKeyValueToken(raw) ? rest : rest.slice(1);
      await this.cmdPayGuided(tokens);
      return;
    }

    if (action === "start") {
      if (!this.state.auth || !this.state.selectedStore || !this.state.order?.orderNo) {
        console.log("pay start needs auth + selected store + existing order.");
        console.log("Run `pay` to perform guided payment.");
        return;
      }
      const region = this.activeRegion();
      const parsed = parseKeyValueTokens(rest.slice(1));
      const channelCode = parsed.opts.channelCode ?? region.channelCode;
      const payType = parsed.opts.payType ?? "1";
      const extInfo = parsed.opts.extInfo ? safeJson(parsed.opts.extInfo) : {};

      const payload = {
        userId: this.state.auth.userId,
        orderNo: this.state.order.orderNo,
        storeNo: this.state.selectedStore.storeNo,
        source: region.source,
        channelCode,
        payType,
        extInfo
      };

      const res = await this.client.continuePay(payload);
      this.printEnvelope(res);
      if (isApiOk(res)) {
        const data = envelopeData<Record<string, unknown>>(res) ?? {};
        const payNo = asString(data.payNo);
        const payUrl = extractPayUrl(data);
        this.state.payment = {
          payNo,
          payUrl,
          status: "pending",
          method: payType,
          raw: data
        };
        this.applyOrderCancelWindow(data);
        await this.persist();
        console.log(`payNo=${payNo ?? "-"}`);
        if (payUrl) {
          console.log(`payUrl=${payUrl}`);
        }
      }
      return;
    }

    if (action === "open") {
      const url = this.state.payment?.payUrl;
      if (!url) {
        console.log("No payUrl in state. Run `pay` (guided) or `pay start` first.");
        return;
      }
      this.openUrl(url);
      return;
    }

    if (action === "status") {
      await this.refreshPaymentStatus("manual");
      return;
    }

    if (action === "await") {
      await this.cmdPayAwait(rest.slice(1));
      return;
    }

    console.log("Usage: pay [open=1] [channelCode=H5] [payType=1] | pay [status|await|open|start]");
  }

  private async refreshPaymentStatus(source: PaymentStatusSource): Promise<PaymentStatusOutcome> {
    const emptyOutcome: PaymentStatusOutcome = {
      resolution: "not_ready",
      numericStatuses: [],
      textStatuses: []
    };
    if (!this.state.auth) {
      if (source !== "auto") {
        console.log("Login required. Run `login` first.");
      }
      return emptyOutcome;
    }
    if (!this.state.selectedStore) {
      if (source !== "auto") {
        console.log("Select a store first.");
      }
      return emptyOutcome;
    }
    if (!this.state.order?.orderNo) {
      if (source !== "auto") {
        console.log("No order found in session.");
        console.log("Run `pay` to create/open payment, then `pay status` or `pay await`.");
      }
      return emptyOutcome;
    }

    const res = await this.client.payResultList({
      userId: this.state.auth.userId,
      storeNo: this.state.selectedStore.storeNo,
      orderNo: this.state.order.orderNo
    });
    if (source === "manual") {
      this.printEnvelope(res);
    }
    if (!isApiOk(res)) {
      return {
        resolution: "api_error",
        numericStatuses: [],
        textStatuses: [],
        apiErrcode: asString(res.errcode) ?? String(res.errcode ?? ""),
        apiErrmsg: asString(res.errmsg) ?? String(res.errmsg ?? "")
      };
    }

    const data = envelopeData(res);
    this.applyOrderCancelWindow(data);
    const evaluated = evaluatePaymentStatus(data);
    if (evaluated.resolution === "success") {
      const previousOrderStatus = this.state.order?.status;
      const previousPaymentStatus = this.state.payment?.status;
      if (this.state.order) {
        this.state.order.status = "paid";
      }
      if (!this.state.payment) {
        this.state.payment = { status: "success" };
      } else {
        this.state.payment.status = "success";
      }
      const changed =
        previousOrderStatus !== this.state.order?.status ||
        previousPaymentStatus !== this.state.payment?.status;
      if (changed) {
        await this.persist();
      }
      if (source === "manual" || changed) {
        console.log(`Payment status: SUCCESS${source === "auto" ? " (auto)" : ""}`);
      }
      return evaluated;
    }

    if (evaluated.resolution === "pending") {
      let changed = false;
      if (!this.state.payment) {
        this.state.payment = { status: "pending" };
        changed = true;
      } else if (this.state.payment.status !== "pending") {
        this.state.payment.status = "pending";
        changed = true;
      }
      if (changed) {
        await this.persist();
      }
      if (source === "manual") {
        console.log("Payment status: PENDING");
      }
      return evaluated;
    }

    if (evaluated.resolution === "failed") {
      let changed = false;
      if (!this.state.payment) {
        this.state.payment = { status: "failed" };
        changed = true;
      } else if (this.state.payment.status !== "failed") {
        this.state.payment.status = "failed";
        changed = true;
      }
      if (changed) {
        await this.persist();
      }
      if (source === "manual" || changed) {
        console.log(`Payment status: FAILED${source === "auto" ? " (auto)" : ""}`);
      }
      return evaluated;
    }

    if (source === "manual") {
      const detail = describePaymentStatusSignals(evaluated.numericStatuses, evaluated.textStatuses);
      if (detail) {
        console.log(`Payment status: UNKNOWN (${detail})`);
      } else {
        console.log("Payment status: UNKNOWN");
      }
    }
    return evaluated;
  }

  private async cmdPayAwait(rest: string[]): Promise<void> {
    const parsed = parseKeyValueTokens(rest);
    const timeoutSec = clampInt(
      parseNum(parsed.opts.timeout, PAYMENT_AWAIT_DEFAULT_TIMEOUT_SEC),
      PAYMENT_AWAIT_MIN_TIMEOUT_SEC,
      PAYMENT_AWAIT_MAX_TIMEOUT_SEC
    );
    const intervalSec = clampInt(
      parseNum(parsed.opts.interval, PAYMENT_AWAIT_DEFAULT_INTERVAL_SEC),
      PAYMENT_AWAIT_MIN_INTERVAL_SEC,
      PAYMENT_AWAIT_MAX_INTERVAL_SEC
    );
    const open = parseBool(parsed.opts.open, false);

    if (!this.state.auth) {
      console.log("Login required. Run `login` first.");
      return;
    }
    if (!this.state.selectedStore) {
      console.log("Select a store first.");
      return;
    }
    if (!this.state.order?.orderNo) {
      console.log("No order found in session.");
      console.log("Run `pay` to create/open payment, then `pay await`.");
      return;
    }

    if (open) {
      const url = this.state.payment?.payUrl;
      if (url) {
        this.openUrl(url);
      } else {
        console.log("No payUrl in state, so nothing to open.");
      }
    }

    const startedAtMs = Date.now();
    const deadlineMs = startedAtMs + timeoutSec * 1000;
    let checks = 0;
    let lastProgressLogAtMs = 0;
    let lastApiErrorLogAtMs = 0;

    this.stopPaymentStatusPolling();
    console.log(
      `Awaiting payment result for ${this.state.order.orderNo} (timeout=${timeoutSec}s interval=${intervalSec}s)...`
    );

    try {
      while (Date.now() <= deadlineMs) {
        checks += 1;
        const outcome = await this.refreshPaymentStatus("await");
        if (outcome.resolution === "success") {
          const elapsedSec = Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));
          console.log(`Payment confirmed in ${elapsedSec}s after ${checks} check(s).`);
          return;
        }
        if (outcome.resolution === "failed") {
          const detail = describePaymentStatusSignals(
            outcome.numericStatuses,
            outcome.textStatuses
          );
          if (detail) {
            console.log(`Payment status: FAILED (${detail})`);
          } else {
            console.log("Payment status: FAILED");
          }
          return;
        }
        if (outcome.resolution === "not_ready") {
          return;
        }

        const now = Date.now();
        if (outcome.resolution === "api_error") {
          if (now - lastApiErrorLogAtMs >= PAYMENT_AWAIT_API_ERROR_LOG_MS) {
            lastApiErrorLogAtMs = now;
            const code = outcome.apiErrcode ?? "";
            const msg = outcome.apiErrmsg ?? "";
            console.log(`Payment status check API error (errcode=${code} errmsg=${msg}). Retrying...`);
          }
        } else if (outcome.resolution === "unknown") {
          const detail = describePaymentStatusSignals(
            outcome.numericStatuses,
            outcome.textStatuses
          );
          if (detail) {
            console.log(`Payment status: UNKNOWN (${detail}). Retrying...`);
          } else {
            console.log("Payment status: UNKNOWN. Retrying...");
          }
        } else if (
          outcome.resolution === "pending" &&
          (checks === 1 || now - lastProgressLogAtMs >= PAYMENT_AWAIT_PROGRESS_LOG_MS)
        ) {
          lastProgressLogAtMs = now;
          const elapsedSec = Math.max(0, Math.floor((now - startedAtMs) / 1000));
          console.log(`Payment status: PENDING (${elapsedSec}s elapsed).`);
        }

        const remainingMs = deadlineMs - Date.now();
        if (remainingMs <= 0) {
          break;
        }
        await sleepMs(Math.min(intervalSec * 1000, remainingMs));
      }
    } finally {
      this.reconcilePaymentStatusPolling();
    }

    console.log(`Timed out after ${timeoutSec}s waiting for payment confirmation.`);
    await this.refreshPaymentStatus("manual");
    console.log("If payment just completed, re-run `pay await` or `pay status`.");
  }

  private async cmdPayGuided(rest: string[]): Promise<void> {
    const parsed = parseKeyValueTokens(rest);
    const open = parsed.opts.open !== "0";

    if (!this.state.auth) {
      console.log("Login required. Run `login` first.");
      return;
    }
    await this.ensureSelectedStoreForOrder("pay");
    if (!this.state.selectedStore) {
      console.log("Select a store first.");
      return;
    }

    if (this.state.order?.status === "paid") {
      console.log(`Order ${this.state.order.orderNo} is already marked as paid.`);
      await this.cmdPay(["status"]);
      return;
    }

    if (this.state.order?.orderNo) {
      if (!this.state.payment?.payUrl) {
        const startArgs = ["start"];
        if (parsed.opts.channelCode) {
          startArgs.push(`channelCode=${parsed.opts.channelCode}`);
        }
        if (parsed.opts.payType) {
          startArgs.push(`payType=${parsed.opts.payType}`);
        }
        if (parsed.opts.extInfo) {
          startArgs.push(`extInfo=${parsed.opts.extInfo}`);
        }
        await this.cmdPay(startArgs);
      }

      if (open) {
        await this.cmdPay(["open"]);
      }
      await this.cmdPay(["status"]);
      return;
    }

    if (this.state.cart.length === 0) {
      console.log("Cart is empty.");
      return;
    }

    if (this.state.session.mode !== "live") {
      this.state.session.mode = "live";
      await this.persist();
      console.log("Switched mode to live for payment.");
    }

    const placeArgs: string[] = [];
    if (!open) {
      placeArgs.push("open=0");
    }
    if (parsed.opts.channelCode) {
      placeArgs.push(`channelCode=${parsed.opts.channelCode}`);
    }
    if (parsed.opts.payType) {
      placeArgs.push(`payType=${parsed.opts.payType}`);
    }
    await this.cmdPlace(placeArgs);
    if (this.state.order?.orderNo) {
      await this.cmdPay(["status"]);
    }
  }

  private applyOrderCancelWindow(source: unknown): void {
    if (!this.state.order) {
      return;
    }
    const parsed = extractCancelWindow(source);
    if (!parsed.cancelByAt && parsed.cancelRemainingSec === undefined) {
      return;
    }
    const now = new Date();
    if (parsed.cancelByAt) {
      this.state.order.cancelByAt = parsed.cancelByAt;
    }
    if (parsed.cancelRemainingSec !== undefined) {
      this.state.order.cancelRemainingSec = parsed.cancelRemainingSec;
    }
    const remainingSec = estimateCancelRemainingSec(this.state.order, now);
    if (remainingSec !== undefined) {
      this.state.order.cancelRemainingSec = remainingSec;
      if (!this.state.order.cancelByAt) {
        this.state.order.cancelByAt = new Date(now.getTime() + remainingSec * 1000).toISOString();
      }
    }
    this.state.order.cancelCheckedAt = now.toISOString();
  }

  private async cmdDebug(rest: string[]): Promise<void> {
    const sub = rest[0];
    if (!sub || sub === "help") {
      console.log(`debug commands
  debug help
  debug last-req
  debug last-res
  debug events [count=20]
  debug region list|show|set|file
  debug mode dry-run|live
  debug json on|off
  debug guest show|set-token|bootstrap|clear`);
      return;
    }
    if (sub === "region") {
      await this.cmdRegion(rest.slice(1));
      return;
    }
    if (sub === "mode") {
      await this.cmdMode(rest.slice(1));
      return;
    }
    if (sub === "json") {
      await this.cmdJson(rest.slice(1));
      return;
    }
    if (sub === "guest") {
      await this.cmdGuest(rest.slice(1));
      return;
    }
    if (sub === "last-req") {
      this.printData(this.lastReq ?? null);
      return;
    }
    if (sub === "last-res") {
      this.printData(this.lastRes ?? null);
      return;
    }
    if (sub === "events") {
      await this.cmdEvent(rest.slice(1));
      return;
    }
    console.log("Usage: debug help | debug last-req | debug last-res | debug events");
  }

  private async cmdEvent(rest: string[]): Promise<void> {
    const count = Math.max(1, Math.min(200, Math.floor(parseNum(rest[0], 20))));
    if (this.events.length === 0) {
      console.log("No transport events captured yet.");
      return;
    }
    this.printData(this.events.slice(-count));
  }

  private async startStoreWatch(
    intervalSec: number,
    silent: boolean,
    sortBy: StoreSort
  ): Promise<void> {
    this.stopStoreWatch();
    this.storesWatchSilent = silent;
    this.storesWatchSort = sortBy;
    if (!silent) {
      console.log(`watch on (interval ${intervalSec}s, sort=${sortBy})`);
    }
    await this.refreshStores(sortBy, silent);
    this.storesWatchTimer = setInterval(() => {
      void this.pollStoresWatch();
    }, intervalSec * 1000);
  }

  private stopStoreWatch(): void {
    if (this.storesWatchTimer) {
      clearInterval(this.storesWatchTimer);
      this.storesWatchTimer = undefined;
    }
    this.storesWatchSilent = false;
    this.storesWatchSort = "distance";
  }

  private shouldPollPaymentStatus(): boolean {
    if (!this.state.auth || !this.state.selectedStore || !this.state.order?.orderNo) {
      return false;
    }
    if (this.state.order.status === "paid" || this.state.order.status === "canceled") {
      return false;
    }
    return this.state.payment?.status === "pending";
  }

  private reconcilePaymentStatusPolling(): void {
    if (this.shouldPollPaymentStatus()) {
      this.startPaymentStatusPolling();
      return;
    }
    this.stopPaymentStatusPolling();
  }

  private startPaymentStatusPolling(): void {
    if (this.paymentStatusPollTimer) {
      return;
    }
    this.paymentStatusPollTimer = setInterval(() => {
      void this.pollPaymentStatus();
    }, PAYMENT_STATUS_POLL_MS);
    void this.pollPaymentStatus();
  }

  private stopPaymentStatusPolling(): void {
    if (this.paymentStatusPollTimer) {
      clearInterval(this.paymentStatusPollTimer);
      this.paymentStatusPollTimer = undefined;
    }
    this.paymentStatusPollBusy = false;
  }

  private async pollPaymentStatus(): Promise<void> {
    if (!this.shouldPollPaymentStatus()) {
      this.stopPaymentStatusPolling();
      return;
    }
    if (this.paymentStatusPollBusy) {
      return;
    }

    this.paymentStatusPollBusy = true;
    try {
      await this.refreshPaymentStatus("auto");
    } catch (error) {
      const now = Date.now();
      if (now - this.lastPaymentStatusPollErrorAtMs >= PAYMENT_STATUS_ERROR_LOG_THROTTLE_MS) {
        this.lastPaymentStatusPollErrorAtMs = now;
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`Payment poll warning: ${message}`);
      }
    } finally {
      this.paymentStatusPollBusy = false;
      if (!this.shouldPollPaymentStatus()) {
        this.stopPaymentStatusPolling();
      }
    }
  }

  private async pollStoresWatch(): Promise<void> {
    if (this.storesWatchBusy) {
      return;
    }
    this.storesWatchBusy = true;
    try {
      await this.refreshStores(this.storesWatchSort, this.storesWatchSilent);
    } finally {
      this.storesWatchBusy = false;
    }
  }

  private async refreshStores(sortBy: StoreSort, silent: boolean): Promise<StoreState[]> {
    await this.maybeRefreshLocationHeartbeat(silent);
    const region = this.activeRegion();
    const pageSize = 20;
    const params: {
      latitude: number;
      longitude: number;
      pageNum: number;
      pageSize: number;
      isTakeaway: boolean;
      channelCode: string;
    } = {
      latitude: this.state.session.latitude,
      longitude: this.state.session.longitude,
      pageNum: 1,
      pageSize,
      isTakeaway: region.isTakeaway,
      channelCode: region.channelCode
    };
    const res = await this.client.listStores(params);

    if (!silent) {
      this.printEnvelope(res);
    }

    const firstPageData = envelopeData(res);
    const stores = extractStores(firstPageData);
    const total = extractStoresTotal(firstPageData, stores.length);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    if (totalPages > 1) {
      for (let pageNum = 2; pageNum <= totalPages; pageNum += 1) {
        const pageRes = await this.client.listStores({ ...params, pageNum });
        const pageStores = extractStores(envelopeData(pageRes));
        if (pageStores.length === 0) {
          break;
        }
        stores.push(...pageStores);
      }
    }

    const mergedStores = dedupeStores(stores);
    const sorted = sortStores(mergedStores, sortBy);
    this.state.storesCache = sorted;

    const previousStoreNo = this.state.selectedStore?.storeNo;
    const closest = pickClosestStore(sorted);
    if (this.state.session.storePinned) {
      if (this.state.selectedStore) {
        const matched = sorted.find((s) => s.storeNo === this.state.selectedStore?.storeNo);
        if (matched) {
          this.state.selectedStore = matched;
        }
      } else if (closest) {
        this.state.selectedStore = closest;
      }
    } else if (closest) {
      this.state.selectedStore = closest;
    }
    this.syncMenuCacheForSelectedStore();
    const selectedStoreNo = this.state.selectedStore?.storeNo;
    if (
      selectedStoreNo &&
      (selectedStoreNo !== previousStoreNo || !this.hasMenuCacheForStore(selectedStoreNo))
    ) {
      await this.ensureMenuForSelectedStore(true);
    }

    if (!silent) {
      const rows = sorted.map((s) => [
        s.storeNo,
        formatDistanceKm(s.distanceMeters),
        s.storeName,
        s.waitingCups !== undefined ? String(s.waitingCups) : "-",
        s.waitingTime !== undefined ? String(s.waitingTime) : "-",
        s.runningStatusDesc ?? "-"
      ]);
      printTable(["storeNo", "dist", "storeName", "cups", "wait(min)", "status"], rows);
    }

    return sorted;
  }

  private async fetchMenu(silent = false): Promise<void> {
    if (!this.state.selectedStore) {
      return;
    }
    const storeNo = this.state.selectedStore.storeNo;
    const region = this.activeRegion();
    const res = await this.client.getStoreMenu({
      storeNo,
      saleType: region.saleType,
      saleChannel: region.saleChannel
    });
    if (!silent) {
      this.printEnvelope(res);
    }
    const categories = extractMenuCategories(envelopeData(res));
    this.setMenuCacheForStore(storeNo, categories);
    await this.persist();
  }

  private buildSkuList(): Record<string, unknown>[] {
    return this.state.cart.map((line) => ({
      spuId: line.spuId ?? "",
      spuType: "single",
      skuId: line.skuId,
      num: line.qty,
      selected: true,
      specList: line.specList ?? [],
      attributeList: line.attributeList ?? [],
      extraList: [],
      isGift: 0
    }));
  }

  private buildQuotePayload(): Record<string, unknown> {
    if (!this.state.auth || !this.state.selectedStore) {
      throw new Error("Missing auth or selected store");
    }
    const region = this.activeRegion();

    return {
      userId: this.state.auth.userId,
      storeNo: this.state.selectedStore.storeNo,
      channel: region.saleChannel,
      tradeChannel: region.tradeChannel,
      deliveryType: region.deliveryType,
      enableRecommend: true,
      skuList: this.buildSkuList(),
      promotionList: [],
      storeChannel: region.storeChannel,
      feeInfoList: [],
      marketingActivityInfoList: [],
      tradeSource: 2,
      businessType: region.businessType,
      userAddress: null
    };
  }

  private buildCreatePayload(): Record<string, unknown> {
    if (!this.state.auth || !this.state.selectedStore) {
      throw new Error("Missing auth or selected store");
    }
    const region = this.activeRegion();
    if (!region.appId || region.appId === "REQUIRED_SET_CHAGEE_APP_ID") {
      throw new Error(
        `Missing region appId. Set ${APP_ID_ENV_VAR} or provide appId in ~/.chagee-cli/regions.json`
      );
    }

    const now = new Date();

    return {
      confirmOrderKey: `cli-${now.getTime()}`,
      orderType: 0,
      businessType: region.businessType,
      channelCode: region.channelCode,
      source: region.source,
      storeNo: this.state.selectedStore.storeNo,
      storeName: this.state.selectedStore.storeName,
      userId: this.state.auth.userId,
      userType: region.userType,
      visitorId: this.state.auth.userId,
      payerId: this.state.auth.userId,
      openId: this.state.auth.userId,
      payType: 0,
      mobile: this.state.auth.phoneRaw ?? "",
      currency: region.currencySymbol,
      currencyCode: region.currencyCode,
      buyerRemark: "",
      payAmount: this.state.quote?.total ?? "0.00",
      appId: region.appId,
      timeZone: region.timeZone,
      country: region.country,
      reservationTime: null,
      saleChannel: region.saleChannel,
      contact: 1,
      storeChannel: region.storeChannel,
      receiveAddress: null,
      assetDeduction: null,
      orderItems: this.buildSkuList(),
      discountInfos: [],
      marketingActivityInfoList: [],
      feeInfos: [],
      extInfo: {},
      priceQuoteRespVO: this.state.quote?.priceQuoteRespVO,
      userAddress: null
    };
  }

  private printEnvelope(envelope: ApiEnvelope): void {
    const code = String(envelope.errcode ?? "");
    const msg = String(envelope.errmsg ?? "");
    console.log(`API errcode=${code} errmsg=${msg}`);
  }

  private printData(data: unknown): void {
    if (this.state.session.jsonOutput) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    console.log(inspect(data, { depth: 6, colors: true, compact: false }));
  }

  private trimEvents(): void {
    if (this.events.length > 200) {
      this.events = this.events.slice(-200);
    }
  }

  private openUrl(url: string): void {
    const opener = process.platform === "darwin" ? "open" : "xdg-open";
    spawn(opener, [url], {
      detached: true,
      stdio: "ignore"
    }).unref();
    console.log(`Opened ${url}`);
  }

  private async applyStartupLocationPolicy(): Promise<void> {
    this.startupLocationRecommendation = { shouldRunBrowserLocate: false };

    if (this.locationPolicy === "manual-only") {
      return;
    }

    const resolved = await this.resolveLocationFromIp();
    if (this.locationPolicy === "ip-only") {
      if (resolved) {
        await this.applyResolvedIpLocationAtStartup(resolved, "policy");
      }
      return;
    }

    const decisionInput: {
      source: LocationSource;
      updatedAt?: string;
      latitude: number;
      longitude: number;
      resolvedLatitude?: number;
      resolvedLongitude?: number;
    } = {
      source: this.state.session.locationSource,
      latitude: this.state.session.latitude,
      longitude: this.state.session.longitude
    };
    if (this.state.session.locationUpdatedAt !== undefined) {
      decisionInput.updatedAt = this.state.session.locationUpdatedAt;
    }
    if (resolved?.latitude !== undefined) {
      decisionInput.resolvedLatitude = resolved.latitude;
    }
    if (resolved?.longitude !== undefined) {
      decisionInput.resolvedLongitude = resolved.longitude;
    }

    const decision: StartupLocationDecision = evaluateSmartStartupLocationDecision(decisionInput);
    const recommendation: StartupLocationRecommendation = {
      shouldRunBrowserLocate: decision.shouldRunBrowserLocate
    };
    if (decision.reason !== undefined) {
      recommendation.reason = decision.reason;
    }
    if (decision.driftKm !== undefined) {
      recommendation.driftKm = decision.driftKm;
    }
    this.startupLocationRecommendation = recommendation;

    if (!decision.shouldRefreshWithIp || !resolved) {
      return;
    }

    await this.applyResolvedIpLocationAtStartup(resolved, decision.reason ?? "startup");
  }

  private async applyResolvedIpLocationAtStartup(
    resolved: BrowserLocation,
    reason: string
  ): Promise<void> {
    const previous = {
      latitude: this.state.session.latitude,
      longitude: this.state.session.longitude,
      source: this.state.session.locationSource
    };

    const now = Date.now();
    const checkedAt = new Date(now).toISOString();
    this.lastLocationHeartbeatAttemptAtMs = now;

    const latitudeChanged =
      Math.abs(this.state.session.latitude - resolved.latitude) > LOCATION_CHANGE_EPSILON;
    const longitudeChanged =
      Math.abs(this.state.session.longitude - resolved.longitude) > LOCATION_CHANGE_EPSILON;
    const sourceChanged = this.state.session.locationSource !== "ip";
    if (!latitudeChanged && !longitudeChanged && !sourceChanged) {
      this.state.session.locationUpdatedAt = checkedAt;
      this.state.session.locationAccuracyMeters = resolved.accuracyMeters;
      await this.persist();
      return;
    }

    this.state.session.latitude = resolved.latitude;
    this.state.session.longitude = resolved.longitude;
    this.state.session.locationSource = "ip";
    this.state.session.locationUpdatedAt = checkedAt;
    this.state.session.locationAccuracyMeters = resolved.accuracyMeters;
    this.state.session.storePinned = false;
    if (this.state.storesCache.length > 0 || this.state.selectedStore) {
      try {
        await this.refreshStores("distance", true);
      } catch {
        // Keep startup resilient if store refresh fails.
      }
    }
    await this.persist();

    console.log(
      `Location refresh: method=ip reason=${reason} old=${previous.latitude.toFixed(6)},${previous.longitude.toFixed(6)}(${previous.source}) new=${resolved.latitude.toFixed(6)},${resolved.longitude.toFixed(6)}(ip)`
    );
  }

  private async maybeRefreshLocationHeartbeat(silent: boolean): Promise<void> {
    const source = this.state.session.locationSource;
    if (source === "manual" || source === "browser") {
      return;
    }

    const now = Date.now();
    if (now - this.lastLocationHeartbeatAttemptAtMs < LOCATION_HEARTBEAT_MS) {
      return;
    }
    this.lastLocationHeartbeatAttemptAtMs = now;

    const resolved = await this.resolveLocationFromIp();
    if (!resolved) {
      return;
    }

    const latitudeChanged =
      Math.abs(this.state.session.latitude - resolved.latitude) > LOCATION_CHANGE_EPSILON;
    const longitudeChanged =
      Math.abs(this.state.session.longitude - resolved.longitude) > LOCATION_CHANGE_EPSILON;
    const sourceChanged = this.state.session.locationSource !== "ip";

    if (!latitudeChanged && !longitudeChanged && !sourceChanged) {
      return;
    }

    this.state.session.latitude = resolved.latitude;
    this.state.session.longitude = resolved.longitude;
    this.state.session.locationSource = "ip";
    this.state.session.locationUpdatedAt = new Date(now).toISOString();
    this.state.session.locationAccuracyMeters = resolved.accuracyMeters;

    if (!silent) {
      console.log(
        `Location heartbeat: ${resolved.latitude.toFixed(6)},${resolved.longitude.toFixed(6)}`
      );
    }

    await this.persist();
  }

  private async resolveLocationFromIp(): Promise<BrowserLocation | undefined> {
    const providers: Array<() => Promise<BrowserLocation | undefined>> = [
      async () => {
        const payload = await this.fetchJsonWithTimeout("https://ipapi.co/json/", 2200);
        if (!payload || typeof payload !== "object") {
          return undefined;
        }
        const obj = payload as Record<string, unknown>;
        if (obj.error === true) {
          return undefined;
        }
        const latitude = toNum(obj.latitude);
        const longitude = toNum(obj.longitude);
        if (latitude === undefined || longitude === undefined) {
          return undefined;
        }
        return { latitude, longitude };
      },
      async () => {
        const payload = await this.fetchJsonWithTimeout("https://ipwho.is/", 2200);
        if (!payload || typeof payload !== "object") {
          return undefined;
        }
        const obj = payload as Record<string, unknown>;
        if (obj.success === false) {
          return undefined;
        }
        const latitude = toNum(obj.latitude);
        const longitude = toNum(obj.longitude);
        if (latitude === undefined || longitude === undefined) {
          return undefined;
        }
        return { latitude, longitude };
      },
      async () => {
        const payload = await this.fetchJsonWithTimeout("https://ipinfo.io/json", 2200);
        if (!payload || typeof payload !== "object") {
          return undefined;
        }
        const obj = payload as Record<string, unknown>;
        const locRaw = typeof obj.loc === "string" ? obj.loc : undefined;
        if (!locRaw) {
          return undefined;
        }
        const [latRaw, lngRaw] = locRaw.split(",");
        const latitude = toNum(latRaw);
        const longitude = toNum(lngRaw);
        if (latitude === undefined || longitude === undefined) {
          return undefined;
        }
        return { latitude, longitude };
      }
    ];

    for (const provider of providers) {
      try {
        const resolved = await provider();
        if (
          resolved &&
          Number.isFinite(resolved.latitude) &&
          Number.isFinite(resolved.longitude) &&
          resolved.latitude >= -90 &&
          resolved.latitude <= 90 &&
          resolved.longitude >= -180 &&
          resolved.longitude <= 180
        ) {
          return resolved;
        }
      } catch {
        // Ignore provider failure and continue with fallback provider.
      }
    }

    return undefined;
  }

  private async fetchJsonWithTimeout(
    url: string,
    timeoutMs: number
  ): Promise<unknown | undefined> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "GET",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          "user-agent": "chagee-cli"
        }
      });
      if (!res.ok) {
        return undefined;
      }
      return (await res.json()) as unknown;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async captureBrowserLocation(
    timeoutSec: number,
    shouldOpenBrowser: boolean
  ): Promise<BrowserLocation> {
    const host = "127.0.0.1";
    const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>CHAGEE CLI Location</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; padding: 24px; }
      h1 { margin: 0 0 8px 0; font-size: 20px; }
      p { margin: 0; color: #333; }
    </style>
  </head>
  <body>
    <h1>CHAGEE CLI Location</h1>
    <p id="status">Requesting location permission...</p>
    <script>
      const statusEl = document.getElementById("status");
      function go(path) { window.location.replace(path); }
      if (!navigator.geolocation) {
        go("/error?message=" + encodeURIComponent("Geolocation is not available in this browser."));
      } else {
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            const c = pos.coords || {};
            const lat = encodeURIComponent(String(c.latitude ?? ""));
            const lng = encodeURIComponent(String(c.longitude ?? ""));
            const accuracy = encodeURIComponent(String(c.accuracy ?? ""));
            go("/set?lat=" + lat + "&lng=" + lng + "&accuracy=" + accuracy);
          },
          (err) => {
            const message = encodeURIComponent((err && err.message) || "Permission denied.");
            go("/error?message=" + message);
          },
          { enableHighAccuracy: true, timeout: 45000, maximumAge: 0 }
        );
      }
      statusEl.textContent = "Waiting for browser geolocation...";
    </script>
  </body>
</html>`;

    return await new Promise<BrowserLocation>((resolve, reject) => {
      let settled = false;
      let timeout: NodeJS.Timeout | undefined;
      const finish = (error?: Error, location?: BrowserLocation): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeout) {
          clearTimeout(timeout);
        }
        server.close();
        if (error) {
          reject(error);
          return;
        }
        if (!location) {
          reject(new Error("Location capture failed."));
          return;
        }
        resolve(location);
      };

      const server = createServer((req, res) => {
        const requestUrl = new URL(req.url ?? "/", `http://${host}`);

        if (requestUrl.pathname === "/" || requestUrl.pathname === "/index.html") {
          res.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store"
          });
          res.end(html);
          return;
        }

        if (requestUrl.pathname === "/favicon.ico") {
          res.writeHead(204);
          res.end();
          return;
        }

        if (requestUrl.pathname === "/set") {
          const lat = Number(requestUrl.searchParams.get("lat"));
          const lng = Number(requestUrl.searchParams.get("lng"));
          const accuracyRaw = Number(requestUrl.searchParams.get("accuracy"));
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
            res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
            res.end("Invalid coordinates.");
            finish(new Error("Browser returned invalid coordinates."));
            return;
          }
          if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
            res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
            res.end("Coordinates are out of range.");
            finish(new Error("Browser coordinates are out of range."));
            return;
          }
          const location: BrowserLocation = {
            latitude: lat,
            longitude: lng
          };
          if (Number.isFinite(accuracyRaw) && accuracyRaw >= 0) {
            location.accuracyMeters = accuracyRaw;
          }
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(
            "<!doctype html><meta charset=\"utf-8\"><p>Location captured. You can close this tab and return to the terminal.</p>"
          );
          finish(undefined, location);
          return;
        }

        if (requestUrl.pathname === "/error") {
          const message = requestUrl.searchParams.get("message") ?? "Permission denied.";
          res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
          res.end(`Error: ${message}`);
          finish(new Error(`Browser geolocation failed: ${message}`));
          return;
        }

        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("Not found");
      });

      server.on("error", (error) => {
        const err = error instanceof Error ? error : new Error(String(error));
        finish(err);
      });

      server.listen(0, host, () => {
        const address = server.address();
        if (!address || typeof address !== "object") {
          finish(new Error("Failed to allocate local callback port."));
          return;
        }

        const url = `http://${host}:${address.port}/`;
        if (shouldOpenBrowser) {
          this.openUrl(url);
        } else {
          console.log(`Open this URL in your browser to share location: ${url}`);
        }
        console.log(`Waiting up to ${timeoutSec}s for browser geolocation...`);
      });

      timeout = setTimeout(() => {
        finish(new Error(`Timed out after ${timeoutSec}s waiting for geolocation.`));
      }, timeoutSec * 1000);
    });
  }

  private async persist(): Promise<void> {
    await saveSession(this.state);
  }

  private async dispatch(raw: string, source: CommandSource): Promise<boolean> {
    const shouldExit = await this.handle(raw, source);
    this.reconcilePaymentStatusPolling();
    return shouldExit;
  }

  async execute(raw: string, options: ExecuteOptions = {}): Promise<boolean> {
    return this.dispatch(raw, options.source ?? "shell");
  }

  startupLocationRecommendationSnapshot(): StartupLocationRecommendation {
    return { ...this.startupLocationRecommendation };
  }

  stateSnapshot(): AppState {
    return structuredClone(this.state) as AppState;
  }

  transportEventsSnapshot(): Array<RequestEvent | ResponseEvent> {
    return [...this.events];
  }

  async shutdown(): Promise<void> {
    this.stopStoreWatch();
    this.stopPaymentStatusPolling();
    if (this.state.cart.length > 0 || this.state.quote || this.state.pendingCreatePayload) {
      this.state.cart = [];
      nextCartVersion(this.state);
    }
    await this.persist();
  }

  private isShellOrderingCommand(root: string, rest: string[]): boolean {
    const cmd = root.toLowerCase();
    const sub = (rest[0] ?? "").toLowerCase();

    if (
      [
        "use",
        "wait",
        "menu",
        "item",
        "add",
        "qty",
        "rm",
        "clear",
        "cart",
        "place",
        "checkout",
        "confirm",
        "live"
      ].includes(cmd)
    ) {
      return true;
    }

    if (cmd === "store") {
      return sub === "use" || sub === "wait";
    }

    if (cmd === "order") {
      return sub === "cancel";
    }

    if (cmd === "pay") {
      if (sub === "status" || sub === "await") {
        return false;
      }
      if (sub === "start" || sub === "open") {
        return true;
      }

      const isGuidedPay = sub === "" || sub === "go" || sub === "now" || isKeyValueToken(rest[0]);
      if (isGuidedPay) {
        return !this.canRunGuidedPayInSafeShell();
      }
      return true;
    }

    return false;
  }

  private canRunGuidedPayInSafeShell(): boolean {
    if (this.state.cart.length > 0) {
      return true;
    }
    if (Boolean(this.state.order?.orderNo)) {
      return true;
    }
    if (Boolean(this.state.payment?.payUrl)) {
      return true;
    }
    return false;
  }
}

function hasProfilePayload(data: unknown): boolean {
  if (data === null || data === undefined) {
    return false;
  }
  if (Array.isArray(data)) {
    return data.length > 0;
  }
  if (typeof data === "object") {
    return Object.keys(data as Record<string, unknown>).length > 0;
  }
  if (typeof data === "string") {
    return data.trim().length > 0;
  }
  return true;
}

function extractProfileUserId(data: unknown, depth = 0): string | undefined {
  if (depth > 4 || !data || typeof data !== "object") {
    return undefined;
  }

  const obj = data as Record<string, unknown>;
  const direct =
    asString(obj.userId) ??
    asString(obj.uid) ??
    asString(obj.id) ??
    asString(obj.customerId) ??
    asString(obj.memberId);
  if (direct) {
    return direct;
  }

  const nestedKeys = [
    "customer",
    "customerInfo",
    "customerVO",
    "user",
    "userInfo",
    "member",
    "memberInfo",
    "data"
  ];

  for (const key of nestedKeys) {
    const nested = obj[key];
    const nestedId = extractProfileUserId(nested, depth + 1);
    if (nestedId) {
      return nestedId;
    }
  }

  return undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function extractStores(data: unknown): StoreState[] {
  const arr =
    asArray(data) ??
    asArray((data as Record<string, unknown> | undefined)?.pageList) ??
    asArray((data as Record<string, unknown> | undefined)?.list) ??
    asArray((data as Record<string, unknown> | undefined)?.data) ??
    [];

  const stores: StoreState[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const storeNo =
      asString((raw as Record<string, unknown>).storeNo) ??
      asString((raw as Record<string, unknown>).id);
    const storeName =
      asString((raw as Record<string, unknown>).storeName) ??
      asString((raw as Record<string, unknown>).name) ??
      "";
    if (!storeNo) {
      continue;
    }

    const waitingCups = toNum((raw as Record<string, unknown>).waitingCups);
    const waitingTime = toNum((raw as Record<string, unknown>).waitingTime);
    const deliveryTime = asString((raw as Record<string, unknown>).deliveryTime);
    const distanceMeters =
      toNum((raw as Record<string, unknown>).distance) ??
      toNum((raw as Record<string, unknown>).distanceMeter);
    const runningStatusDesc = asString(
      (raw as Record<string, unknown>).runningStatusDesc
    );
    const latitude = toNum((raw as Record<string, unknown>).latitude);
    const longitude = toNum((raw as Record<string, unknown>).longitude);

    stores.push({
      storeNo,
      storeName,
      distanceMeters,
      latitude,
      longitude,
      waitingCups,
      waitingTime,
      deliveryTime,
      runningStatusDesc
    });
  }

  return stores;
}

function extractStoresTotal(data: unknown, fallback: number): number {
  if (!data || typeof data !== "object") {
    return fallback;
  }
  const obj = data as Record<string, unknown>;
  const total = toNum(obj.total) ?? toNum(obj.runningCount);
  if (total === undefined || !Number.isFinite(total) || total <= 0) {
    return fallback;
  }
  return Math.floor(total);
}

function dedupeStores(stores: StoreState[]): StoreState[] {
  const seen = new Set<string>();
  const out: StoreState[] = [];
  for (const store of stores) {
    if (seen.has(store.storeNo)) {
      continue;
    }
    seen.add(store.storeNo);
    out.push(store);
  }
  return out;
}

function parseWaitInfo(data: unknown): Partial<StoreState> {
  if (!data || typeof data !== "object") {
    return {};
  }
  const obj = data as Record<string, unknown>;
  return {
    waitingCups: toNum(obj.waitingCups),
    waitingTime: toNum(obj.waitingTime),
    deliveryTime: asString(obj.deliveryTime)
  };
}

function sortStores(
  stores: StoreState[],
  sortBy: StoreSort
): StoreState[] {
  const cloned = [...stores];

  if (sortBy === "distance") {
    cloned.sort((a, b) => {
      const da = a.distanceMeters ?? Number.POSITIVE_INFINITY;
      const db = b.distanceMeters ?? Number.POSITIVE_INFINITY;
      if (da !== db) {
        return da - db;
      }
      return a.storeName.localeCompare(b.storeName);
    });
    return cloned;
  }

  if (sortBy === "name") {
    cloned.sort((a, b) => a.storeName.localeCompare(b.storeName));
    return cloned;
  }

  if (sortBy === "cups") {
    cloned.sort((a, b) => (a.waitingCups ?? 10_000) - (b.waitingCups ?? 10_000));
    return cloned;
  }

  cloned.sort((a, b) => {
    const wa = a.waitingTime ?? 10_000;
    const wb = b.waitingTime ?? 10_000;
    if (wa !== wb) {
      return wa - wb;
    }
    return (a.waitingCups ?? 10_000) - (b.waitingCups ?? 10_000);
  });
  return cloned;
}

function parseStoreSort(input: string | undefined, fallback: StoreSort): StoreSort {
  if (!input) {
    return fallback;
  }
  if (input === "distance" || input === "wait" || input === "cups" || input === "name") {
    return input;
  }
  return fallback;
}

function formatDistanceKm(distanceMeters: number | undefined): string {
  if (distanceMeters === undefined || !Number.isFinite(distanceMeters)) {
    return "-";
  }
  if (distanceMeters < 1000) {
    return `${Math.round(distanceMeters)}m`;
  }
  return `${(distanceMeters / 1000).toFixed(1)}km`;
}

function pickClosestStore(stores: StoreState[]): StoreState | undefined {
  if (stores.length === 0) {
    return undefined;
  }
  let best = stores[0];
  if (!best) {
    return undefined;
  }
  for (const store of stores) {
    const dStore = store.distanceMeters ?? Number.POSITIVE_INFINITY;
    const dBest = best.distanceMeters ?? Number.POSITIVE_INFINITY;
    if (dStore < dBest) {
      best = store;
    }
  }
  return best;
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

const MENU_CATEGORY_ARRAY_KEYS = [
  "menuList",
  "classifyList",
  "categoryList",
  "goodsClassifyList",
  "goodsCategoryList",
  "menuCategoryList",
  "classificationList",
  "classList",
  "leftClassifyList",
  "list"
] as const;

const MENU_CATEGORY_ID_KEYS = [
  "categoryId",
  "menuCategoryId",
  "classifyId",
  "classificationId",
  "goodsClassifyId",
  "goodsCategoryId",
  "id"
] as const;

const MENU_CATEGORY_NAME_KEYS = [
  "categoryName",
  "menuCategoryName",
  "classifyName",
  "classificationName",
  "goodsClassifyName",
  "goodsCategoryName",
  "title",
  "name"
] as const;

const MENU_ITEM_ARRAY_KEYS = [
  "goodsList",
  "spuList",
  "goodsSpuList",
  "productList",
  "itemList",
  "items",
  "menuGoodsList",
  "list"
] as const;

const MENU_GROUP_ARRAY_KEYS = [
  "goodsGroupList",
  "groupList",
  "subClassifyList",
  "children",
  "tabs"
] as const;

function extractMenuCategories(data: unknown): MenuCategory[] {
  const root = data && typeof data === "object" ? (data as Record<string, unknown>) : undefined;
  const nestedRoot =
    root?.data && typeof root.data === "object"
      ? (root.data as Record<string, unknown>)
      : undefined;
  const categoryCandidates: unknown[] = [data];

  if (root) {
    for (const key of MENU_CATEGORY_ARRAY_KEYS) {
      categoryCandidates.push(root[key]);
    }
  }
  if (nestedRoot) {
    for (const key of MENU_CATEGORY_ARRAY_KEYS) {
      categoryCandidates.push(nestedRoot[key]);
    }
  }

  for (const candidate of categoryCandidates) {
    const categories = mapMenuCategoryArray(candidate);
    if (categories.length > 0) {
      return categories;
    }
  }

  return [];
}

function mapMenuCategoryArray(raw: unknown): MenuCategory[] {
  const arr = asArray(raw);
  if (!arr || arr.length === 0) {
    return [];
  }
  const categories = arr
    .map((entry) => mapCategory(entry))
    .filter((category): category is MenuCategory => category !== undefined);
  if (categories.length === 0) {
    return [];
  }
  return dedupeMenuCategories(categories);
}

function dedupeMenuCategories(categories: MenuCategory[]): MenuCategory[] {
  const deduped: MenuCategory[] = [];
  const indexByKey = new Map<string, number>();

  for (const category of categories) {
    if (category.items.length === 0) {
      continue;
    }
    const key = `${category.id || category.name}`.trim().toLowerCase();
    const existingIdx = indexByKey.get(key);
    if (existingIdx === undefined) {
      deduped.push({
        id: category.id,
        name: category.name,
        items: dedupeMenuItems(category.items)
      });
      indexByKey.set(key, deduped.length - 1);
      continue;
    }

    const existing = deduped[existingIdx];
    if (!existing) {
      continue;
    }
    existing.items = dedupeMenuItems([...existing.items, ...category.items]);
  }

  return deduped.filter((category) => category.items.length > 0);
}

function dedupeMenuItems(items: MenuItem[]): MenuItem[] {
  const seen = new Set<string>();
  const out: MenuItem[] = [];
  for (const item of items) {
    const key = `${item.spuId}:${item.skuId ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(item);
  }
  return out;
}

function firstString(obj: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = asString(obj[key]);
    if (value) {
      return value;
    }
  }
  return "";
}

function mapItemsFromArray(raw: unknown): MenuItem[] {
  const arr = asArray(raw);
  if (!arr || arr.length === 0) {
    return [];
  }
  return arr.map((entry) => mapItem(entry)).filter((item): item is MenuItem => item !== undefined);
}

function extractCategoryItems(obj: Record<string, unknown>): MenuItem[] {
  for (const key of MENU_ITEM_ARRAY_KEYS) {
    const items = mapItemsFromArray(obj[key]);
    if (items.length > 0) {
      return dedupeMenuItems(items);
    }
  }

  const groupedItems: MenuItem[] = [];
  for (const groupKey of MENU_GROUP_ARRAY_KEYS) {
    const groups = asArray(obj[groupKey]);
    if (!groups || groups.length === 0) {
      continue;
    }
    for (const rawGroup of groups) {
      if (!rawGroup || typeof rawGroup !== "object") {
        continue;
      }
      const groupObj = rawGroup as Record<string, unknown>;
      for (const itemKey of MENU_ITEM_ARRAY_KEYS) {
        const items = mapItemsFromArray(groupObj[itemKey]);
        if (items.length > 0) {
          groupedItems.push(...items);
        }
      }
    }
  }
  return groupedItems.length > 0 ? dedupeMenuItems(groupedItems) : [];
}

function mapCategory(raw: unknown): MenuCategory | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const id = firstString(obj, MENU_CATEGORY_ID_KEYS);
  const name = firstString(obj, MENU_CATEGORY_NAME_KEYS);
  const items = extractCategoryItems(obj);

  if (!id && !name) {
    return undefined;
  }
  if (items.length === 0) {
    return undefined;
  }

  return {
    id: id || name,
    name: name || id,
    items
  };
}

function mapItem(raw: unknown): MenuItem | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const spuId = asString(obj.spuId) ?? asString(obj.goodsId) ?? asString(obj.id) ?? "";
  const skuId = asString(obj.skuId) ?? asString(obj.defaultSkuId);
  const name =
    asString(obj.spuName) ??
    asString(obj.goodsName) ??
    asString(obj.name) ??
    asString(obj.title) ??
    "";
  const price =
    toNum(obj.salePrice) ??
    toNum(obj.unitTradePrice) ??
    toNum(obj.price) ??
    toNum(obj.minPrice) ??
    undefined;

  if (!spuId || !name) {
    return undefined;
  }
  if (isMenuItemOutOfStock(obj)) {
    return undefined;
  }
  if (isComboMenuItemUnavailable(obj)) {
    return undefined;
  }

  return {
    spuId,
    skuId,
    name,
    price,
    raw
  };
}

function extractItemSkuOptions(data: unknown): ItemSkuOption[] {
  const detailRoot = normalizeItemDetailRoot(data);
  if (!detailRoot) {
    return [];
  }
  if (isMenuItemOutOfStock(detailRoot)) {
    return [];
  }

  const rootSpuType = (asString(detailRoot.spuType) ?? "").trim().toLowerCase();
  const rootIsCombo = rootSpuType === "combo";

  const rootName = asString(detailRoot.name) ?? asString(detailRoot.spuName) ?? "";
  const comboOptions = extractComboItemSkuOptions(detailRoot, rootName);
  if (comboOptions.length > 0) {
    return dedupeItemSkuOptions(comboOptions);
  }

  const skuList =
    asArray(detailRoot.skuList) ??
    asArray(detailRoot.goodsSkuList) ??
    asArray(detailRoot.saleSkuList) ??
    [];

  const options: ItemSkuOption[] = [];
  for (const rawSku of skuList) {
    if (!rawSku || typeof rawSku !== "object") {
      continue;
    }
    const sku = rawSku as Record<string, unknown>;
    const normalizedSku = rootIsCombo ? { ...sku, spuType: "combo" } : sku;
    if (isMenuItemOutOfStock(normalizedSku)) {
      continue;
    }

    const skuId = asString(sku.skuId);
    if (!skuId) {
      continue;
    }

    const specPairs = parseSpecPairs(sku.specList);
    const attributePairs = parseAttributePairs(sku.attributeList);
    const specNames = parseOptionNames(sku.specList);
    const attributeNames = parseOptionNames(sku.attributeList);
    const variantParts = [...specNames, ...attributeNames];
    const specText = variantParts.length > 0 ? variantParts.join(" + ") : undefined;
    const optionName = (asString(sku.name) ?? asString(sku.skuName) ?? rootName) || skuId;
    const price =
      toNum(sku.salePrice) ?? toNum(sku.unitTradePrice) ?? toNum(sku.price) ?? undefined;

    options.push({
      skuId,
      name: optionName,
      price,
      specText,
      specList: specPairs.length > 0 ? specPairs : undefined,
      attributeList: attributePairs.length > 0 ? attributePairs : undefined
    });
  }

  if (options.length > 0) {
    return dedupeItemSkuOptions(expandSkuOptionsWithSpuAttributes(options, detailRoot));
  }

  const fallbackSkuId = asString(detailRoot.skuId);
  if (!fallbackSkuId) {
    return [];
  }
  return [
    {
      skuId: fallbackSkuId,
      name: rootName || fallbackSkuId,
      price:
        toNum(detailRoot.salePrice) ??
        toNum(detailRoot.unitTradePrice) ??
      toNum(detailRoot.price) ??
      undefined
    }
  ];
}

const MAX_COMBO_VARIANT_OPTIONS = 128;

interface ComboComponentSelection {
  groupName: string;
  quantity: number;
  component: Record<string, unknown>;
}

function extractComboItemSkuOptions(
  detailRoot: Record<string, unknown>,
  rootName: string
): ItemSkuOption[] {
  const rootSpuType = (asString(detailRoot.spuType) ?? "").trim().toLowerCase();
  const rootIsCombo = rootSpuType === "combo";
  if (rootIsCombo) {
    const skuList =
      asArray(detailRoot.skuList) ??
      asArray(detailRoot.goodsSkuList) ??
      asArray(detailRoot.saleSkuList) ??
      [];
    if (skuList.length > 0) {
      const hasAvailableBundleSku = skuList.some((rawSku) => {
        if (!rawSku || typeof rawSku !== "object") {
          return false;
        }
        const sku = rawSku as Record<string, unknown>;
        return !isMenuItemOutOfStock({ ...sku, spuType: "combo" });
      });
      if (!hasAvailableBundleSku) {
        return [];
      }
    }
  }

  const primarySku = pickPrimarySkuRecord(detailRoot);
  const bundleSkuId = asString(primarySku?.skuId) ?? asString(detailRoot.skuId);
  if (!bundleSkuId) {
    return [];
  }

  const basePrice =
    toNum(primarySku?.salePrice) ??
    toNum(primarySku?.unitTradePrice) ??
    toNum(primarySku?.price) ??
    toNum(detailRoot.defaultSalePrice) ??
    toNum(detailRoot.salePrice) ??
    toNum(detailRoot.unitTradePrice) ??
    toNum(detailRoot.price) ??
    undefined;

  const selections = buildComboSelections(detailRoot);
  if (selections.length === 0) {
    return [];
  }

  const out: ItemSkuOption[] = [];
  for (const selection of selections) {
    const built = buildComboOptionsForSelection(selection, bundleSkuId, rootName || bundleSkuId, basePrice);
    if (built.length > 0) {
      out.push(...built);
    }
    if (out.length >= MAX_COMBO_VARIANT_OPTIONS) {
      break;
    }
  }
  return dedupeItemSkuOptions(out).slice(0, MAX_COMBO_VARIANT_OPTIONS);
}

function pickPrimarySkuRecord(detailRoot: Record<string, unknown>): Record<string, unknown> | undefined {
  const skuList =
    asArray(detailRoot.skuList) ??
    asArray(detailRoot.goodsSkuList) ??
    asArray(detailRoot.saleSkuList) ??
    [];
  for (const rawSku of skuList) {
    if (!rawSku || typeof rawSku !== "object") {
      continue;
    }
    const sku = rawSku as Record<string, unknown>;
    if (!isMenuItemOutOfStock(sku)) {
      return sku;
    }
  }
  for (const rawSku of skuList) {
    if (rawSku && typeof rawSku === "object") {
      return rawSku as Record<string, unknown>;
    }
  }
  return undefined;
}

function buildComboSelections(detailRoot: Record<string, unknown>): ComboComponentSelection[][] {
  const rawGroups = asArray(detailRoot.comboGroupList) ?? [];
  if (rawGroups.length > 0) {
    return buildComboSelectionsFromGroups(rawGroups);
  }

  const rawFixed = asArray(detailRoot.comboSkuList) ?? [];
  if (rawFixed.length === 0) {
    return [];
  }
  const availableFixed = rawFixed
    .filter((raw): raw is Record<string, unknown> => raw !== null && typeof raw === "object")
    .filter((component) => !isMenuItemOutOfStock(component));

  if (availableFixed.length === 0) {
    return [];
  }
  // Fixed bundles require all listed components to be available.
  if (availableFixed.length < rawFixed.length) {
    return [];
  }
  return [
    availableFixed.map((component) => ({
      groupName: "Bundle",
      quantity: Math.max(1, Math.floor(toNum(component.num) ?? 1)),
      component
    }))
  ];
}

function buildComboSelectionsFromGroups(rawGroups: unknown[]): ComboComponentSelection[][] {
  const groups: Array<{
    name: string;
    required: boolean;
    quantity: number;
    choices: Record<string, unknown>[];
  }> = [];

  for (const rawGroup of rawGroups) {
    if (!rawGroup || typeof rawGroup !== "object") {
      continue;
    }
    const groupObj = rawGroup as Record<string, unknown>;
    const groupName =
      asString(groupObj.comboGroupName) ??
      asString(groupObj.groupName) ??
      asString(groupObj.name) ??
      "Combo";
    const groupType = (asString(groupObj.groupType) ?? "").toLowerCase();
    const quantityRaw = toNum(groupObj.quantity);
    const quantity =
      quantityRaw !== undefined && Number.isFinite(quantityRaw)
        ? Math.max(1, Math.floor(quantityRaw))
        : 1;
    const required = toBool(groupObj.required) === true || groupType === "must" || quantity > 0;
    const rawChoices =
      asArray(groupObj.comboSkuList) ?? asArray(groupObj.comboGroupSkuList) ?? asArray(groupObj.skuList) ?? [];
    const choices = rawChoices
      .filter((raw): raw is Record<string, unknown> => raw !== null && typeof raw === "object")
      .filter((choice) => !isMenuItemOutOfStock(choice));
    if (choices.length === 0) {
      if (required && rawChoices.length > 0) {
        return [];
      }
      continue;
    }
    groups.push({
      name: groupName,
      required,
      quantity,
      choices
    });
  }

  if (groups.length === 0) {
    return [];
  }

  let selections: ComboComponentSelection[][] = [[]];
  for (const group of groups) {
    const groupSelections = buildSelectionsForGroup(group);
    if (groupSelections.length === 0) {
      if (group.required) {
        return [];
      }
      continue;
    }
    const next: ComboComponentSelection[][] = [];
    for (const existing of selections) {
      for (const groupSelection of groupSelections) {
        next.push([...existing, ...groupSelection]);
        if (next.length >= MAX_COMBO_VARIANT_OPTIONS) {
          break;
        }
      }
      if (next.length >= MAX_COMBO_VARIANT_OPTIONS) {
        break;
      }
    }
    selections = next;
    if (selections.length === 0) {
      return [];
    }
  }

  return selections
    .filter((selection) => selection.length > 0)
    .slice(0, MAX_COMBO_VARIANT_OPTIONS);
}

function buildSelectionsForGroup(group: {
  name: string;
  quantity: number;
  choices: Record<string, unknown>[];
}): ComboComponentSelection[][] {
  if (group.quantity <= 1) {
    return group.choices.map((choice) => [
      {
        groupName: group.name,
        quantity: Math.max(1, Math.floor(toNum(choice.num) ?? 1)),
        component: choice
      }
    ]);
  }
  if (group.choices.length < group.quantity) {
    return [];
  }
  const picked = group.choices.slice(0, group.quantity);
  return [
    picked.map((choice) => ({
      groupName: group.name,
      quantity: Math.max(1, Math.floor(toNum(choice.num) ?? 1)),
      component: choice
    }))
  ];
}

function buildComboOptionsForSelection(
  selection: ComboComponentSelection[],
  bundleSkuId: string,
  rootName: string,
  basePrice: number | undefined
): ItemSkuOption[] {
  if (selection.length === 0) {
    return [];
  }

  const primaryComponent =
    selection.find((entry) => {
      const specCount = asArray(entry.component.specList)?.length ?? 0;
      if (specCount > 0) {
        return true;
      }
      const attrGroups = extractSpuAttributeGroups(entry.component);
      return attrGroups.length > 0;
    }) ?? selection[0];
  if (!primaryComponent) {
    return [];
  }

  const componentLabels = selection.map((entry) => {
    const name =
      asString(entry.component.name) ??
      asString(entry.component.spuName) ??
      asString(entry.component.skuName) ??
      asString(entry.component.skuId) ??
      "Item";
    const qtySuffix = entry.quantity > 1 ? ` x${entry.quantity}` : "";
    return `${entry.groupName}: ${name}${qtySuffix}`;
  });

  const specNames = parseOptionNames(primaryComponent.component.specList);
  const specTextParts = [...componentLabels];
  if (specNames.length > 0) {
    specTextParts.push(`Variant: ${specNames.join(" + ")}`);
  }

  const optionPrice = resolveComboSelectionPrice(selection, basePrice);
  const baseOption: ItemSkuOption = {
    skuId: bundleSkuId,
    name: rootName,
    price: optionPrice,
    specText: specTextParts.join(" | "),
    specList: parseSpecPairs(primaryComponent.component.specList),
    attributeList: parseAttributePairs(primaryComponent.component.attributeList)
  };

  return expandSkuOptionsWithSpuAttributes([baseOption], primaryComponent.component);
}

function resolveComboSelectionPrice(
  selection: ComboComponentSelection[],
  basePrice: number | undefined
): number | undefined {
  let comboPriceSum = 0;
  let hasComboPrice = false;
  for (const entry of selection) {
    const comboPrice = toNum(entry.component.comboPrice);
    if (comboPrice === undefined) {
      continue;
    }
    hasComboPrice = true;
    comboPriceSum += comboPrice;
  }
  if (hasComboPrice && (comboPriceSum > 0 || basePrice === undefined)) {
    return comboPriceSum;
  }
  return basePrice;
}

function dedupeItemSkuOptions(options: ItemSkuOption[]): ItemSkuOption[] {
  const seen = new Set<string>();
  const out: ItemSkuOption[] = [];
  for (const option of options) {
    if (!option.skuId) {
      continue;
    }
    const key = [
      option.skuId,
      option.specText ?? "",
      option.price !== undefined ? option.price.toFixed(2) : "",
      normalizedPairKey(option.specList),
      normalizedAttributeKey(option.attributeList)
    ].join("|");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(option);
  }
  return out;
}

function isComboMenuItemUnavailable(obj: Record<string, unknown>): boolean {
  const spuType = (asString(obj.spuType) ?? "").toLowerCase();
  if (spuType !== "combo") {
    return false;
  }

  const rawGroups = asArray(obj.comboGroupList) ?? [];
  if (rawGroups.length > 0) {
    for (const rawGroup of rawGroups) {
      if (!rawGroup || typeof rawGroup !== "object") {
        continue;
      }
      const groupObj = rawGroup as Record<string, unknown>;
      const rawChoices =
        asArray(groupObj.comboGroupSkuList) ?? asArray(groupObj.comboSkuList) ?? asArray(groupObj.skuList) ?? [];
      if (rawChoices.length === 0) {
        continue;
      }
      const availableCount = rawChoices.reduce<number>((acc, rawChoice) => {
        if (!rawChoice || typeof rawChoice !== "object") {
          return acc;
        }
        return isMenuItemOutOfStock(rawChoice as Record<string, unknown>) ? acc : acc + 1;
      }, 0);
      const quantity = Math.max(0, Math.floor(toNum(groupObj.quantity) ?? 1));
      const required =
        toBool(groupObj.required) === true ||
        (asString(groupObj.groupType) ?? "").toLowerCase() === "must" ||
        quantity > 0;
      if (required && availableCount === 0) {
        return true;
      }
    }
    return false;
  }

  const rawFixed = asArray(obj.comboSkuList) ?? [];
  if (rawFixed.length === 0) {
    return false;
  }
  const availableCount = rawFixed.reduce<number>((acc, rawComponent) => {
    if (!rawComponent || typeof rawComponent !== "object") {
      return acc;
    }
    return isMenuItemOutOfStock(rawComponent as Record<string, unknown>) ? acc : acc + 1;
  }, 0);
  if (availableCount === 0) {
    return true;
  }
  return availableCount < rawFixed.length;
}

interface SpuAttributeOptionChoice {
  attributeOptionId: string;
  name: string;
  defaulted: boolean;
}

interface SpuAttributeGroup {
  name: string;
  options: SpuAttributeOptionChoice[];
}

interface AttributeSelectionCombo {
  optionIds: string[];
  labels: string[];
}

const MAX_ATTRIBUTE_COMBINATIONS = 512;

function expandSkuOptionsWithSpuAttributes(
  options: ItemSkuOption[],
  detailRoot: Record<string, unknown>
): ItemSkuOption[] {
  const groups = extractSpuAttributeGroups(detailRoot);
  if (groups.length === 0) {
    return options;
  }
  const combos = enumerateAttributeSelectionCombos(groups, MAX_ATTRIBUTE_COMBINATIONS);
  if (combos.length === 0) {
    return options;
  }

  const out: ItemSkuOption[] = [];
  const seen = new Set<string>();

  for (const option of options) {
    for (const combo of combos) {
      const mergedAttributeList = mergeAttributeOptionIds(option.attributeList, combo.optionIds);
      const variantParts: string[] = [];
      const baseVariantText = option.specText ?? option.name;
      if (baseVariantText) {
        variantParts.push(baseVariantText);
      }
      if (combo.labels.length > 0) {
        variantParts.push(combo.labels.join(" | "));
      }
      const mergedSpecText = variantParts.join(" | ");
      const key = `${option.skuId}|${normalizedPairKey(option.specList)}|${normalizedAttributeKey(
        mergedAttributeList
      )}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push({
        ...option,
        specText: mergedSpecText || option.specText,
        attributeList: mergedAttributeList
      });
    }
  }

  return out.length > 0 ? out : options;
}

function extractSpuAttributeGroups(detailRoot: Record<string, unknown>): SpuAttributeGroup[] {
  const rawGroups =
    asArray(detailRoot.spuAttributeList) ??
    asArray(detailRoot.attributeList) ??
    asArray(detailRoot.spuAttributeGroups) ??
    [];
  const groups: SpuAttributeGroup[] = [];

  for (const rawGroup of rawGroups) {
    if (!rawGroup || typeof rawGroup !== "object") {
      continue;
    }
    const groupObj = rawGroup as Record<string, unknown>;
    const groupName =
      asString(groupObj.name) ??
      asString(groupObj.attributeName) ??
      asString(groupObj.attrName) ??
      "";
    const rawItems =
      asArray(groupObj.items) ??
      asArray(groupObj.optionList) ??
      asArray(groupObj.attributeOptions) ??
      [];
    const options: SpuAttributeOptionChoice[] = [];

    for (const rawItem of rawItems) {
      if (!rawItem || typeof rawItem !== "object") {
        continue;
      }
      const itemObj = rawItem as Record<string, unknown>;
      const attributeOptionId =
        asString(itemObj.attributeOptionId) ??
        asString(itemObj.optionId) ??
        asString(itemObj.id);
      const optionName =
        asString(itemObj.name) ??
        asString(itemObj.attributeOptionName) ??
        asString(itemObj.optionName);
      if (!attributeOptionId || !optionName) {
        continue;
      }
      options.push({
        attributeOptionId,
        name: optionName,
        defaulted: toBool(itemObj.defaulted) === true
      });
    }

    if (options.length === 0) {
      continue;
    }

    // Prefer default option first for a more intuitive starting row.
    options.sort((a, b) => Number(b.defaulted) - Number(a.defaulted));
    groups.push({
      name: groupName || "Option",
      options
    });
  }

  return groups;
}

function enumerateAttributeSelectionCombos(
  groups: SpuAttributeGroup[],
  maxCombos: number
): AttributeSelectionCombo[] {
  if (groups.length === 0) {
    return [{ optionIds: [], labels: [] }];
  }
  const estimatedCombos = groups.reduce(
    (acc, group) => acc * Math.max(1, group.options.length),
    1
  );
  if (estimatedCombos > maxCombos) {
    const fallbackOptionIds: string[] = [];
    const fallbackLabels: string[] = [];
    for (const group of groups) {
      const chosen = group.options.find((option) => option.defaulted) ?? group.options[0];
      if (!chosen) {
        continue;
      }
      fallbackOptionIds.push(chosen.attributeOptionId);
      fallbackLabels.push(`${group.name}: ${chosen.name}`);
    }
    return [{ optionIds: fallbackOptionIds, labels: fallbackLabels }];
  }

  const out: AttributeSelectionCombo[] = [];
  const walk = (groupIndex: number, optionIds: string[], labels: string[]): void => {
    if (out.length >= maxCombos) {
      return;
    }
    if (groupIndex >= groups.length) {
      out.push({
        optionIds: [...optionIds],
        labels: [...labels]
      });
      return;
    }
    const group = groups[groupIndex];
    if (!group || group.options.length === 0) {
      walk(groupIndex + 1, optionIds, labels);
      return;
    }
    for (const option of group.options) {
      optionIds.push(option.attributeOptionId);
      labels.push(`${group.name}: ${option.name}`);
      walk(groupIndex + 1, optionIds, labels);
      optionIds.pop();
      labels.pop();
      if (out.length >= maxCombos) {
        break;
      }
    }
  };

  walk(0, [], []);
  return out.length > 0 ? out : [{ optionIds: [], labels: [] }];
}

function mergeAttributeOptionIds(
  base:
    | Array<{
        attributeOptionId: string;
      }>
    | undefined,
  extraOptionIds: string[]
): Array<{ attributeOptionId: string }> | undefined {
  const merged: Array<{ attributeOptionId: string }> = [];
  const seen = new Set<string>();
  for (const item of base ?? []) {
    const id = asString(item.attributeOptionId);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    merged.push({ attributeOptionId: id });
  }
  for (const id of extraOptionIds) {
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    merged.push({ attributeOptionId: id });
  }
  return merged.length > 0 ? merged : undefined;
}

function normalizedPairKey(
  pairs:
    | Array<{
        specId: string;
        specOptionId: string;
      }>
    | undefined
): string {
  return (pairs ?? [])
    .map((pair) => `${pair.specId}:${pair.specOptionId}`)
    .sort()
    .join("|");
}

function normalizedAttributeKey(
  pairs:
    | Array<{
        attributeOptionId: string;
      }>
    | undefined
): string {
  return (pairs ?? [])
    .map((pair) => pair.attributeOptionId)
    .sort()
    .join("|");
}

function normalizeItemDetailRoot(data: unknown): Record<string, unknown> | undefined {
  if (!data || typeof data !== "object") {
    return undefined;
  }
  const obj = data as Record<string, unknown>;
  const nested =
    (obj.goodsDetail as Record<string, unknown> | undefined) ??
    (obj.spuDetail as Record<string, unknown> | undefined) ??
    (obj.data as Record<string, unknown> | undefined);
  if (nested && typeof nested === "object") {
    return nested;
  }
  return obj;
}

function parseSpecPairs(
  rawSpecList: unknown
): Array<{ specId: string; specOptionId: string }> {
  const out: Array<{ specId: string; specOptionId: string }> = [];
  const list = asArray(rawSpecList) ?? [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const obj = raw as Record<string, unknown>;
    const specId = asString(obj.specId);
    const specOptionId =
      asString(obj.specOptionId) ?? asString(obj.optionId) ?? asString(obj.attributeOptionId);
    if (!specId || !specOptionId) {
      continue;
    }
    out.push({ specId, specOptionId });
  }
  return out;
}

function parseAttributePairs(
  rawAttributeList: unknown
): Array<{ attributeOptionId: string }> {
  const out: Array<{ attributeOptionId: string }> = [];
  const list = asArray(rawAttributeList) ?? [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const obj = raw as Record<string, unknown>;
    const attributeOptionId =
      asString(obj.attributeOptionId) ??
      asString(obj.specOptionId) ??
      asString(obj.optionId);
    if (!attributeOptionId) {
      continue;
    }
    out.push({ attributeOptionId });
  }
  return out;
}

function parseOptionNames(rawList: unknown): string[] {
  const out: string[] = [];
  const list = asArray(rawList) ?? [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const obj = raw as Record<string, unknown>;
    const name =
      asString(obj.specOptionName) ??
      asString(obj.attributeOptionName) ??
      asString(obj.optionName) ??
      asString(obj.name);
    if (name) {
      out.push(name);
    }
  }
  return out;
}

function isMenuItemOutOfStock(obj: Record<string, unknown>): boolean {
  const spuType = (asString(obj.spuType) ?? "").trim().toLowerCase();
  const isCombo = spuType === "combo";
  const stockLimited = toBool(obj.stockLimit) === true;

  const explicitSaleOut = toBool(obj.saleOut);
  if (explicitSaleOut === true) {
    return true;
  }

  const explicitSoldOut =
    toBool(obj.soldOut) ?? toBool(obj.isSoldOut) ?? toBool(obj.outOfStock);
  if (explicitSoldOut === true) {
    return true;
  }

  const canSale = toBool(obj.canSale) ?? toBool(obj.available) ?? toBool(obj.isAvailable);
  if (canSale === false) {
    return true;
  }

  const status = toNum(obj.status) ?? toNum(obj.goodsStatus) ?? toNum(obj.saleStatus);
  if (status !== undefined && status <= 0) {
    return true;
  }

  const stock =
    toNum(obj.stock) ??
    toNum(obj.stockNum) ??
    toNum(obj.availableNum) ??
    toNum(obj.remainNum) ??
    toNum(obj.inventory);
  if ((isCombo || stockLimited) && stock !== undefined && stock <= 0) {
    return true;
  }

  return false;
}

function toBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (
      normalized === "1" ||
      normalized === "true" ||
      normalized === "yes" ||
      normalized === "y" ||
      normalized === "on"
    ) {
      return true;
    }
    if (
      normalized === "0" ||
      normalized === "false" ||
      normalized === "no" ||
      normalized === "n" ||
      normalized === "off"
    ) {
      return false;
    }
  }
  return undefined;
}

function parseSpecSelectionList(
  raw: string | undefined
): Array<{ specId: string; specOptionId: string }> | undefined {
  if (!raw) {
    return undefined;
  }
  const parsed = safeJson(raw);
  if (!Array.isArray(parsed)) {
    return undefined;
  }
  const out: Array<{ specId: string; specOptionId: string }> = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const obj = item as Record<string, unknown>;
    const specId = asString(obj.specId);
    const specOptionId = asString(obj.specOptionId);
    if (!specId || !specOptionId) {
      continue;
    }
    out.push({ specId, specOptionId });
  }
  return out.length > 0 ? out : undefined;
}

function parseAttributeSelectionList(
  raw: string | undefined
): Array<{ attributeOptionId: string }> | undefined {
  if (!raw) {
    return undefined;
  }
  const parsed = safeJson(raw);
  if (!Array.isArray(parsed)) {
    return undefined;
  }
  const out: Array<{ attributeOptionId: string }> = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const obj = item as Record<string, unknown>;
    const attributeOptionId = asString(obj.attributeOptionId);
    if (!attributeOptionId) {
      continue;
    }
    out.push({ attributeOptionId });
  }
  return out.length > 0 ? out : undefined;
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function extractPayUrl(data: Record<string, unknown>): string | undefined {
  const direct = asString(data.url) ?? asString(data.payUrl);
  if (direct) {
    return direct;
  }

  const payUrlObj = data.payUrl;
  if (payUrlObj && typeof payUrlObj === "object") {
    const url = asString((payUrlObj as Record<string, unknown>).url);
    if (url) {
      return url;
    }
  }

  return undefined;
}

const PAYMENT_STATUS_NUMERIC_KEYS = new Set([
  "status",
  "paystatus",
  "paymentstatus",
  "resultstatus",
  "tradestatus",
  "payresultstatus",
  "orderstatus"
]);

const PAYMENT_STATUS_TEXT_KEYS = new Set([
  "statusdesc",
  "statustext",
  "statusname",
  "paystatusdesc",
  "paymentstatusdesc",
  "resultstatusdesc",
  "tradestatusdesc",
  "paystatusname",
  "state"
]);

const PAYMENT_SUCCESS_NUMERIC = new Set([2]);
const PAYMENT_PENDING_NUMERIC = new Set([0, 1]);
const PAYMENT_FAILED_NUMERIC = new Set([3, 4, 5, 6, 7, 8, 9, -1]);

const PAYMENT_SUCCESS_TEXT_TOKENS = ["success", "succeeded", "paid", "completed"] as const;
const PAYMENT_PENDING_TEXT_TOKENS = ["pending", "processing", "paying", "awaiting", "created"] as const;
const PAYMENT_FAILED_TEXT_TOKENS = [
  "fail",
  "failed",
  "cancel",
  "canceled",
  "cancelled",
  "closed",
  "expired",
  "timeout",
  "timed_out",
  "error",
  "rejected",
  "declined"
] as const;

function evaluatePaymentStatus(data: unknown): PaymentStatusOutcome {
  const signals = extractPaymentStatusSignals(data);
  const normalizedTexts = signals.textStatuses
    .map(normalizePaymentStatusText)
    .filter((value) => value.length > 0);

  const hasSuccessSignal =
    signals.numericStatuses.some((value) => PAYMENT_SUCCESS_NUMERIC.has(value)) ||
    hasAnyStatusToken(normalizedTexts, PAYMENT_SUCCESS_TEXT_TOKENS);
  if (hasSuccessSignal) {
    return {
      resolution: "success",
      numericStatuses: signals.numericStatuses,
      textStatuses: signals.textStatuses
    };
  }

  const hasPendingSignal =
    signals.numericStatuses.some((value) => PAYMENT_PENDING_NUMERIC.has(value)) ||
    hasAnyStatusToken(normalizedTexts, PAYMENT_PENDING_TEXT_TOKENS);
  if (hasPendingSignal) {
    return {
      resolution: "pending",
      numericStatuses: signals.numericStatuses,
      textStatuses: signals.textStatuses
    };
  }

  const hasFailedSignal =
    signals.numericStatuses.some((value) => PAYMENT_FAILED_NUMERIC.has(value)) ||
    hasAnyStatusToken(normalizedTexts, PAYMENT_FAILED_TEXT_TOKENS);
  if (hasFailedSignal) {
    return {
      resolution: "failed",
      numericStatuses: signals.numericStatuses,
      textStatuses: signals.textStatuses
    };
  }

  return {
    resolution: "unknown",
    numericStatuses: signals.numericStatuses,
    textStatuses: signals.textStatuses
  };
}

function extractPaymentStatusSignals(data: unknown): { numericStatuses: number[]; textStatuses: string[] } {
  const numericStatuses: number[] = [];
  const textStatuses: string[] = [];
  const stack: unknown[] = [data];
  const seen = new Set<unknown>();
  let visitedObjects = 0;

  while (stack.length > 0 && visitedObjects < 2000) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    if (Array.isArray(current)) {
      for (let i = current.length - 1; i >= 0; i -= 1) {
        stack.push(current[i]);
      }
      continue;
    }
    if (typeof current !== "object") {
      continue;
    }
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);
    visitedObjects += 1;

    const obj = current as Record<string, unknown>;
    for (const [rawKey, rawValue] of Object.entries(obj)) {
      const key = normalizeKey(rawKey);
      if (PAYMENT_STATUS_NUMERIC_KEYS.has(key)) {
        const numeric = toNum(rawValue);
        if (numeric !== undefined) {
          numericStatuses.push(numeric);
        } else {
          const text = asString(rawValue);
          if (text) {
            textStatuses.push(text);
          }
        }
      } else if (PAYMENT_STATUS_TEXT_KEYS.has(key)) {
        const text = asString(rawValue);
        if (text) {
          textStatuses.push(text);
        }
        const numeric = toNum(rawValue);
        if (numeric !== undefined) {
          numericStatuses.push(numeric);
        }
      }

      if (rawValue && typeof rawValue === "object") {
        stack.push(rawValue);
      }
    }
  }

  return {
    numericStatuses: uniqueNumericStatuses(numericStatuses),
    textStatuses: uniqueTextStatuses(textStatuses)
  };
}

function describePaymentStatusSignals(numericStatuses: number[], textStatuses: string[]): string {
  const parts: string[] = [];
  if (numericStatuses.length > 0) {
    parts.push(`codes=[${numericStatuses.join(", ")}]`);
  }
  if (textStatuses.length > 0) {
    const limited = textStatuses.slice(0, 4);
    parts.push(`text=[${limited.join(", ")}${textStatuses.length > limited.length ? ", ..." : ""}]`);
  }
  return parts.join(" ");
}

function uniqueNumericStatuses(values: number[]): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const value of values) {
    if (!Number.isFinite(value) || seen.has(value)) {
      continue;
    }
    seen.add(value);
    out.push(value);
  }
  return out;
}

function uniqueTextStatuses(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function normalizePaymentStatusText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function hasAnyStatusToken(values: string[], tokens: readonly string[]): boolean {
  return values.some((value) => tokens.some((token) => statusTokenMatches(value, token)));
}

function statusTokenMatches(value: string, token: string): boolean {
  if (value === token) {
    return true;
  }
  if (value.startsWith(`${token}_`) || value.endsWith(`_${token}`)) {
    return true;
  }
  return value.includes(`_${token}_`);
}

interface PrimitiveEntry {
  normalizedKey: string;
  value: unknown;
}

const CANCEL_DEADLINE_KEYS = [
  "cancelbyat",
  "canceldeadline",
  "cancelendtime",
  "cancelexpiretime",
  "cancelexpireat",
  "latestcanceltime",
  "autocanceltime",
  "orderclosetime",
  "closetime",
  "payexpiretime",
  "payendtime",
  "lastpaytime",
  "expiretime",
  "expireat"
] as const;

const CANCEL_REMAINING_KEYS = [
  "cancelremainingsec",
  "cancelremainingsecs",
  "cancelremainingsecond",
  "cancelremainingseconds",
  "cancelcountdown",
  "countdown",
  "remainingsec",
  "remainingsecs",
  "remainingsecond",
  "remainingseconds",
  "lefttime",
  "surplustime",
  "remainpaytime",
  "paycountdown",
  "payremainingseconds"
] as const;

function buildOrderView(order: OrderState): Record<string, unknown> {
  const view: Record<string, unknown> = { ...order };
  const remainingSec = estimateCancelRemainingSec(order);
  if (remainingSec !== undefined) {
    view.cancelRemainingSec = remainingSec;
    view.cancelWindowStatus = remainingSec > 0 ? "open" : "expired";
  }
  return view;
}

function estimateCancelRemainingSec(order: OrderState, now = new Date()): number | undefined {
  const deadlineMs = parseAbsoluteTime(order.cancelByAt);
  if (deadlineMs !== undefined) {
    return Math.max(0, Math.floor((deadlineMs - now.getTime()) / 1000));
  }
  const rawRemaining = toNum(order.cancelRemainingSec);
  if (rawRemaining === undefined) {
    return undefined;
  }
  const base = Math.max(0, Math.floor(rawRemaining));
  const checkedMs = parseAbsoluteTime(order.cancelCheckedAt);
  if (checkedMs === undefined) {
    return base;
  }
  const elapsedSec = Math.max(0, Math.floor((now.getTime() - checkedMs) / 1000));
  return Math.max(0, base - elapsedSec);
}

function extractCancelWindow(source: unknown, now = new Date()): {
  cancelByAt?: string;
  cancelRemainingSec?: number;
} {
  const entries = collectPrimitiveEntries(source);
  if (entries.length === 0) {
    return {};
  }

  let cancelDeadlineMs = pickParsedValue(entries, CANCEL_DEADLINE_KEYS, parseAbsoluteTime);
  let cancelRemainingSec = pickParsedValue(entries, CANCEL_REMAINING_KEYS, parseDurationSeconds);

  if (cancelDeadlineMs === undefined) {
    for (const entry of entries) {
      const key = entry.normalizedKey;
      if (
        /(cancel|close|expire|pay)/.test(key) &&
        /(time|at|deadline|end)/.test(key)
      ) {
        const parsed = parseAbsoluteTime(entry.value);
        if (parsed !== undefined) {
          cancelDeadlineMs = parsed;
          break;
        }
      }
    }
  }

  if (cancelRemainingSec === undefined) {
    for (const entry of entries) {
      const key = entry.normalizedKey;
      if (
        /(cancel|close|expire|pay)/.test(key) &&
        /(countdown|remain|remaining|left|surplus)/.test(key)
      ) {
        const parsed = parseDurationSeconds(entry.value);
        if (parsed !== undefined) {
          cancelRemainingSec = parsed;
          break;
        }
      }
    }
  }

  if (cancelDeadlineMs === undefined && cancelRemainingSec !== undefined) {
    cancelDeadlineMs = now.getTime() + cancelRemainingSec * 1000;
  }

  if (cancelRemainingSec === undefined && cancelDeadlineMs !== undefined) {
    cancelRemainingSec = Math.max(0, Math.floor((cancelDeadlineMs - now.getTime()) / 1000));
  }

  const out: { cancelByAt?: string; cancelRemainingSec?: number } = {};
  if (cancelDeadlineMs !== undefined) {
    out.cancelByAt = new Date(cancelDeadlineMs).toISOString();
  }
  if (cancelRemainingSec !== undefined) {
    out.cancelRemainingSec = cancelRemainingSec;
  }
  return out;
}

function pickParsedValue<T>(
  entries: PrimitiveEntry[],
  keys: readonly string[],
  parser: (value: unknown) => T | undefined
): T | undefined {
  for (const key of keys) {
    for (const entry of entries) {
      if (entry.normalizedKey !== key) {
        continue;
      }
      const parsed = parser(entry.value);
      if (parsed !== undefined) {
        return parsed;
      }
    }
  }
  return undefined;
}

function collectPrimitiveEntries(source: unknown): PrimitiveEntry[] {
  const out: PrimitiveEntry[] = [];
  const seen = new WeakSet<object>();
  const walk = (value: unknown, depth: number): void => {
    if (depth > 5 || value === null || value === undefined) {
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item, depth + 1);
      }
      return;
    }
    if (typeof value !== "object") {
      return;
    }
    if (seen.has(value)) {
      return;
    }
    seen.add(value);
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (
        child === null ||
        typeof child === "string" ||
        typeof child === "number" ||
        typeof child === "boolean"
      ) {
        out.push({ normalizedKey: normalizeKey(key), value: child });
        continue;
      }
      walk(child, depth + 1);
    }
  };
  walk(source, 0);
  return out;
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseAbsoluteTime(value: unknown): number | undefined {
  const numeric = toNum(value);
  if (numeric !== undefined && Number.isFinite(numeric)) {
    if (numeric > 1e12) {
      return Math.floor(numeric);
    }
    if (numeric > 1e9) {
      return Math.floor(numeric * 1000);
    }
  }
  const text = asString(value);
  if (!text) {
    return undefined;
  }
  const parsed = Date.parse(text);
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  return undefined;
}

function parseDurationSeconds(value: unknown): number | undefined {
  const numeric = toNum(value);
  if (numeric === undefined || !Number.isFinite(numeric)) {
    return undefined;
  }
  if (numeric <= 0) {
    return 0;
  }
  const monthInSec = 60 * 60 * 24 * 30;
  if (numeric > monthInSec) {
    return Math.floor(numeric / 1000);
  }
  return Math.floor(numeric);
}

function locationAccuracyHint(source: LocationSource): string | undefined {
  if (source === "default" || source === "ip") {
    return "IP-based location is approximate. Run `locate` for higher accuracy.";
  }
  return undefined;
}

function isLocationSource(value: unknown): value is LocationSource {
  return typeof value === "string" && LOCATION_SOURCES.includes(value as LocationSource);
}

const ANSI_RESET = "\u001b[0m";
const ANSI_BRIGHT_BLUE = "\u001b[94m";
const ANSI_BRIGHT_CYAN = "\u001b[96m";
const ANSI_BRIGHT_GREEN = "\u001b[92m";
const ANSI_BRIGHT_MAGENTA = "\u001b[95m";
const ANSI_BRIGHT_YELLOW = "\u001b[93m";
const ANSI_DIM = "\u001b[2m";
const ANSI_RED = "\u001b[31m";
const ANSI_YELLOW = "\u001b[33m";
const ANSI_CYAN = "\u001b[36m";

function supportsCliColors(stream: NodeJS.WriteStream): boolean {
  if (!stream.isTTY) {
    return false;
  }
  if (process.env.NO_COLOR !== undefined) {
    return false;
  }
  return (process.env.TERM ?? "").toLowerCase() !== "dumb";
}

function colorText(value: string, code: string, enabled: boolean): string {
  if (!enabled) {
    return value;
  }
  return `${code}${value}${ANSI_RESET}`;
}

function installInteractiveOutputColors(enabled: boolean): () => void {
  if (!enabled) {
    return () => {};
  }

  const originalLog = console.log;
  const originalInfo = console.info;
  const originalWarn = console.warn;
  const originalError = console.error;

  console.log = (...args: unknown[]): void => {
    originalLog(...tintConsoleArgs(args, ANSI_BRIGHT_GREEN));
  };
  console.info = (...args: unknown[]): void => {
    originalInfo(...tintConsoleArgs(args, ANSI_CYAN));
  };
  console.warn = (...args: unknown[]): void => {
    originalWarn(...tintConsoleArgs(args, ANSI_YELLOW));
  };
  console.error = (...args: unknown[]): void => {
    originalError(...tintConsoleArgs(args, ANSI_RED));
  };

  return () => {
    console.log = originalLog;
    console.info = originalInfo;
    console.warn = originalWarn;
    console.error = originalError;
  };
}

function tintConsoleArgs(args: unknown[], colorCode: string): unknown[] {
  if (args.length === 0) {
    return args;
  }

  const first = args[0];
  if (typeof first === "string") {
    if (first.length === 0 || /\u001b\[[0-9;]*m/.test(first)) {
      return args;
    }
    return [colorText(first, colorCode, true), ...args.slice(1)];
  }
  if (
    typeof first === "number" ||
    typeof first === "boolean" ||
    typeof first === "bigint" ||
    first === null ||
    first === undefined
  ) {
    return [colorText(String(first), colorCode, true), ...args.slice(1)];
  }
  return args;
}

export async function runCliRepl(options: AppOptions = {}): Promise<void> {
  const app = new App(options);
  await app.init();
  try {
    await app.run();
  } finally {
    await app.shutdown();
  }
}

function safeOrigin(apiBase: string): string | undefined {
  try {
    return new URL(apiBase).origin;
  } catch {
    return undefined;
  }
}

function normalizeCdpBaseUrl(input: string): string {
  const trimmed = input.trim();
  const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withProto.replace(/\/+$/, "");
}

interface ClipboardReadCommand {
  command: string;
  args: string[];
}

function clipboardReadCommands(platform: NodeJS.Platform): ClipboardReadCommand[] {
  if (platform === "darwin") {
    return [{ command: "pbpaste", args: [] }];
  }
  if (platform === "win32") {
    return [
      {
        command: "powershell",
        args: ["-NoProfile", "-Command", "Get-Clipboard -Raw"]
      },
      {
        command: "pwsh",
        args: ["-NoProfile", "-Command", "Get-Clipboard -Raw"]
      }
    ];
  }
  return [
    { command: "wl-paste", args: ["-n"] },
    { command: "xclip", args: ["-selection", "clipboard", "-out"] },
    { command: "xsel", args: ["--clipboard", "--output"] }
  ];
}

function normalizeImportedAuthToken(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return undefined;
  }

  const picked =
    lines.find((line) => /^authorization\s*[:=]\s*/i.test(line)) ??
    lines[0] ??
    "";
  const withoutLabel = picked.replace(/^authorization\s*[:=]\s*/i, "").trim();
  const token = withoutLabel.replace(/^["']|["']$/g, "").trim();
  if (!token) {
    return undefined;
  }

  const lower = token.toLowerCase();
  if (lower === "null" || lower === "bearer null") {
    return undefined;
  }
  return token;
}

function isKeyValueToken(raw: string | undefined): boolean {
  if (!raw) {
    return false;
  }
  return raw.includes("=");
}

function isLikelyPhoneToken(raw: string | undefined): boolean {
  if (!raw) {
    return false;
  }
  return /^\+?\d[\d\s-]{5,}$/.test(raw.trim());
}

const DEFAULT_CDP_ENDPOINTS = [
  "http://127.0.0.1:9222",
  "http://localhost:9222",
  "http://127.0.0.1:9223",
  "http://localhost:9223",
  "http://127.0.0.1:9333",
  "http://localhost:9333"
];

function parseCdpCandidateInput(input: string | undefined): string[] {
  if (!input) {
    return [];
  }
  return input
    .split(/[\s,;]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && entry.toLowerCase() !== "auto")
    .map(normalizeCdpBaseUrl);
}

function buildCdpCandidateUrls(explicitInput: string | undefined): string[] {
  const explicit = parseCdpCandidateInput(explicitInput);
  const envCandidates = parseCdpCandidateInput(process.env.CHAGEE_CDP_URL);
  const queue = explicit.length > 0 ? explicit : [...envCandidates, ...DEFAULT_CDP_ENDPOINTS];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of queue) {
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    out.push(candidate);
  }
  return out;
}

interface CdpTarget {
  id: string;
  type?: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

async function listCdpTargets(cdpBaseUrl: string): Promise<CdpTarget[]> {
  const endpoints = ["/json/list", "/json"];
  let lastError: Error | undefined;

  for (const endpoint of endpoints) {
    try {
      const payload = await fetchCdpTargetsFromEndpoint(`${cdpBaseUrl}${endpoint}`);
      if (payload.length > 0) {
        return payload;
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  if (lastError) {
    throw lastError;
  }
  return [];
}

async function fetchCdpTargetsFromEndpoint(url: string): Promise<CdpTarget[]> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`CDP ${url} failed (${res.status})`);
  }
  const payload = (await res.json()) as unknown;
  if (!Array.isArray(payload)) {
    return [];
  }
  return payload.filter((entry) => entry && typeof entry === "object") as CdpTarget[];
}

function pickCdpTargetFromTargets(
  targets: CdpTarget[],
  loginUrl: string
): CdpTarget | undefined {
  const loginOrigin = safeOrigin(loginUrl);
  const candidates = targets.filter((target) => {
    if (!target.webSocketDebuggerUrl) {
      return false;
    }
    const type = (target.type ?? "").toLowerCase();
    return type === "page" || type === "webview" || type === "background_page" || type === "";
  });
  if (candidates.length === 0) {
    return undefined;
  }

  const byOrigin = candidates.find((target) => {
    const url = target.url ?? "";
    if (!loginOrigin) {
      return false;
    }
    return url.startsWith(loginOrigin);
  });
  if (byOrigin) {
    return byOrigin;
  }

  const byChageeUrl = candidates.find((target) => {
    const url = (target.url ?? "").toLowerCase();
    return (
      url.includes("h5.chagee.com") ||
      url.includes("chagee.com.sg") ||
      url.includes("chagee.com")
    );
  });
  if (byChageeUrl) {
    return byChageeUrl;
  }

  const byTitle = candidates.find((target) =>
    (target.title ?? "").toLowerCase().includes("chagee")
  );
  if (byTitle) {
    return byTitle;
  }

  return candidates[0];
}

function describeBrowserCaptureAttempt(
  attempt: BrowserTokenCaptureAttempt,
  timeoutSec: number
): string {
  switch (attempt.status) {
    case "success":
      return "token captured";
    case "connect_error":
      return `endpoint unreachable (${attempt.reason ?? "unknown error"})`;
    case "no_tabs":
      return "reachable, but no debuggable tabs";
    case "no_chagee_tab":
      return "reachable, but no CHAGEE tab";
    case "no_debug_ws":
      return "CHAGEE tab found without debugger websocket";
    case "token_not_seen":
      return `CHAGEE tab found, but no auth token observed within ${timeoutSec}s`;
    default:
      return "unknown capture state";
  }
}

interface WaitForCdpAuthTokenOptions {
  wsDebuggerUrl: string;
  apiBase: string;
  timeoutSec: number;
  refresh: boolean;
}

function waitForCdpAuthToken(options: WaitForCdpAuthTokenOptions): Promise<string | undefined> {
  const timeoutMs = Math.max(1, options.timeoutSec) * 1000;
  const origin = safeOrigin(options.apiBase);

  return new Promise((resolve) => {
    const ws = new WebSocket(options.wsDebuggerUrl);
    let finished = false;
    let commandId = 1;

    const done = (token: string | undefined): void => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // Ignore close errors.
      }
      resolve(token);
    };

    const send = (method: string, params?: Record<string, unknown>): void => {
      const payload = {
        id: commandId++,
        method,
        params: params ?? {}
      };
      ws.send(JSON.stringify(payload));
    };

    const extractHeadersToken = (headers: unknown): string | undefined => {
      if (!headers || typeof headers !== "object") {
        return undefined;
      }
      const obj = headers as Record<string, unknown>;
      const rawAuth = asString(obj.authorization) ?? asString(obj.Authorization);
      if (!rawAuth) {
        return undefined;
      }
      const token = rawAuth.trim();
      if (!token || token === "null" || token.toLowerCase() === "bearer null") {
        return undefined;
      }
      return token;
    };

    const onMessage = (event: MessageEvent): void => {
      const raw = typeof event.data === "string" ? event.data : undefined;
      if (!raw) {
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(raw) as unknown;
      } catch {
        return;
      }
      if (!message || typeof message !== "object") {
        return;
      }
      const obj = message as Record<string, unknown>;
      const method = asString(obj.method);
      if (!method) {
        return;
      }
      if (
        method !== "Network.requestWillBeSent" &&
        method !== "Network.requestWillBeSentExtraInfo"
      ) {
        return;
      }
      const params =
        obj.params && typeof obj.params === "object"
          ? (obj.params as Record<string, unknown>)
          : undefined;
      if (!params) {
        return;
      }
      const requestUrl = asString(params.url) ?? asString((params.request as Record<string, unknown> | undefined)?.url);
      if (origin && requestUrl && !requestUrl.startsWith(origin)) {
        return;
      }
      const headers =
        params.headers ??
        ((params.request && typeof params.request === "object"
          ? (params.request as Record<string, unknown>).headers
          : undefined) as unknown);
      const token = extractHeadersToken(headers);
      if (token) {
        done(token);
      }
    };

    const timer = setTimeout(() => {
      done(undefined);
    }, timeoutMs);

    ws.onopen = () => {
      send("Network.enable");
      send("Runtime.enable");
      send("Page.enable");
      send("Page.bringToFront");
      if (options.refresh) {
        send("Page.reload", { ignoreCache: false });
      }
    };
    ws.onmessage = onMessage;
    ws.onerror = () => {
      done(undefined);
    };
    ws.onclose = () => {
      done(undefined);
    };
  });
}
