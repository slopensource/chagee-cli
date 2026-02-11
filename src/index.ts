#!/usr/bin/env node

import { spawn } from "node:child_process";
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
import { loadCustomRegionProfiles, regionFilePath } from "./lib/region-store.js";
import { loadSession, saveSession, sessionFilePath } from "./lib/session-store.js";
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

  help
  status
  exit

  login <phone-with-country-code> (example: +6591234567)
  login web [open=1]
  login web auto [timeout=120] [cdp=http://127.0.0.1:9222] [phone=+6591234567]
  login import <token> [phone=+6591234567]
  otp <code> [phone=<phone>] [phoneCode=<dial-code>]
  logout

  locate [timeout=60] [open=1]
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
  pay [start|open|status]

  debug help`;

type StoreSort = "distance" | "wait" | "cups" | "name";
interface BrowserLocation {
  latitude: number;
  longitude: number;
  accuracyMeters?: number;
}
const LOCATION_SOURCES: readonly LocationSource[] = ["default", "ip", "browser", "manual"];

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
  private itemSkuOptionsCacheByStore: Record<string, Record<string, ItemSkuOption[]>> = {};

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

  async init(): Promise<void> {
    const customRegions = await loadCustomRegionProfiles();
    this.regionRegistry = buildRegionRegistry(customRegions);

    const saved = await loadSession();
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

    await this.autoLocateFromIpIfNeeded();
    this.syncMenuCacheForSelectedStore();
    if (this.state.selectedStore?.storeNo && !this.hasMenuCacheForStore(this.state.selectedStore.storeNo)) {
      try {
        await this.ensureMenuForSelectedStore(true);
      } catch {
        // Keep startup resilient if menu prefetch fails.
      }
    }
  }

  async run(): Promise<void> {
    const interactive = Boolean(input.isTTY && output.isTTY);
    if (interactive) {
      this.banner();
    }
    const rl = createInterface({ input, output, terminal: interactive });

    try {
      if (!interactive) {
        for await (const line of rl) {
          const trimmed = line.trim();
          if (trimmed.length === 0) {
            continue;
          }
          const shouldExit = await this.handle(trimmed);
          if (shouldExit) {
            break;
          }
        }
        return;
      }

      while (true) {
        let line = "";
        try {
          line = await rl.question(
            `${derivePhase(this.state)}:${this.state.session.mode}> `
          );
        } catch {
          break;
        }

        const trimmed = line.trim();
        if (trimmed.length === 0) {
          continue;
        }

        const shouldExit = await this.handle(trimmed);
        if (shouldExit) {
          break;
        }
      }
    } finally {
      this.stopStoreWatch();
      rl.close();
    }
  }

  private banner(): void {
    console.log("chagee shell (`help` for commands, `exit` to quit)");
    console.log("warning: alpha + highly experimental; use at your own risk.");
    console.log(`session: ${sessionFilePath()}`);
    console.log(`regions: ${regionFilePath()}`);
  }

  private async handle(raw: string): Promise<boolean> {
    const normalizedRaw = raw.trim().startsWith("/") ? raw.trim().slice(1) : raw;
    const tokens = tokenize(normalizedRaw);
    const [root, ...rest] = tokens;
    if (!root) {
      return false;
    }

    try {
      switch (root) {
        case "help":
          console.log(HELP);
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
          if (
            rest.length > 0 &&
            rest[0] !== "start" &&
            rest[0] !== "verify" &&
            rest[0] !== "web" &&
            rest[0] !== "oauth" &&
            rest[0] !== "import"
          ) {
            await this.cmdLogin(["start", ...rest]);
          } else {
            await this.cmdLogin(rest);
          }
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
          if (rest.length === 0) {
            await this.cmdPay(["status"]);
          } else {
            await this.cmdPay(rest);
          }
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
    const summary = {
      phase,
      mode: this.state.session.mode,
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
        storePinned: this.state.session.storePinned
      },
      cartItems: this.state.cart.length,
      cartVersion: this.state.cartVersion,
      quoteAt: this.state.quote?.at,
      orderNo: this.state.order?.orderNo,
      paymentStatus: this.state.payment?.status
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

      this.applyRegionSwitch(profile);
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
    const sub = rest[0];
    const region = this.activeRegion();
    if (sub === "web" || sub === "oauth") {
      const parsed = parseKeyValueTokens(rest.slice(1));
      const action = parsed.args[0];
      const shouldOpen = parseBool(parsed.opts.open, false);
      const phone = parsed.opts.phone;
      const url = "https://h5.chagee.com.sg/main";
      if (action === "auto") {
        const timeoutSec = Math.max(
          30,
          Math.min(600, Math.floor(parseNum(parsed.opts.timeout, 120)))
        );
        const cdpBaseUrl = parsed.opts.cdp ?? process.env.CHAGEE_CDP_URL ?? "http://127.0.0.1:9222";
        const refresh = parseBool(parsed.opts.refresh, true);
        const token = await this.captureBrowserTokenFromExistingSession(
          cdpBaseUrl,
          url,
          timeoutSec,
          refresh
        );
        if (!token) {
          console.log("Unable to capture auth token from existing browser session.");
          console.log(
            "Ensure Chrome is already running with your logged-in CHAGEE tab and remote debugging enabled."
          );
          console.log("Example: Google Chrome --remote-debugging-port=9222");
          console.log("Fallback: login import <token> [phone=+6591234567]");
          return;
        }

        const profileCheck = await this.ensureLoginProfile(token);
        if (!profileCheck.ok) {
          console.log(`Login web auto blocked: ${profileCheck.reason}`);
          return;
        }

        this.state.auth = {
          token,
          userId: profileCheck.userId,
          phoneRaw: phone,
          phoneMasked: phone ? maskPhone(phone) : undefined
        };
        this.state.pendingLoginPhone = undefined;
        await this.persist();
        console.log(`Logged in via browser OAuth as userId=${profileCheck.userId}`);
        console.log(`Profile verified via ${profileCheck.endpoint}`);
        return;
      }

      if (shouldOpen) {
        this.openUrl(url);
      } else {
        console.log(`Use existing logged-in browser tab at ${url}`);
      }
      console.log("No new browser login is required.");
      console.log("Recommended: run `login web auto` to capture token from existing browser session.");
      console.log("Manual fallback: login import <token> [phone=+6591234567]");
      return;
    }

    if (sub === "import") {
      const parsed = parseKeyValueTokens(rest.slice(1));
      const token = parsed.opts.token ?? parsed.args[0];
      const phone = parsed.opts.phone;
      if (!token) {
        console.log("Usage: login import <token> [phone=+6591234567]");
        return;
      }

      const profileCheck = await this.ensureLoginProfile(token);
      if (!profileCheck.ok) {
        console.log(`Login import blocked: ${profileCheck.reason}`);
        return;
      }

      this.state.auth = {
        token,
        userId: profileCheck.userId,
        phoneRaw: phone,
        phoneMasked: phone ? maskPhone(phone) : undefined
      };
      this.state.pendingLoginPhone = undefined;
      await this.persist();
      console.log(`Logged in via browser token as userId=${profileCheck.userId}`);
      console.log(`Profile verified via ${profileCheck.endpoint}`);
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

    console.log(
      "Usage: login <phone-with-country-code> | login web [open=1] | login web auto [timeout=120] [cdp=http://127.0.0.1:9222] [phone=+6591234567] | login import <token> [phone=+6591234567] | otp <code> [phone=<phone>] [phoneCode=<dial-code>] (example phone: +6591234567)"
    );
  }

  private async captureBrowserTokenFromExistingSession(
    cdpBaseUrl: string,
    loginUrl: string,
    timeoutSec: number,
    refresh: boolean
  ): Promise<string | undefined> {
    const cdpUrl = normalizeCdpBaseUrl(cdpBaseUrl);
    let target = await pickCdpTarget(cdpUrl, loginUrl);
    if (!target) {
      console.log("No CHAGEE tab found in current browser session.");
      console.log(`Open ${loginUrl} in your already logged-in browser, then retry.`);
      return undefined;
    }

    console.log(`Attaching to existing browser tab: ${target.url || "(blank tab)"}`);
    if (!target.webSocketDebuggerUrl) {
      console.log("Selected tab has no debugger websocket URL.");
      return undefined;
    }

    const captured = await waitForCdpAuthToken({
      wsDebuggerUrl: target.webSocketDebuggerUrl,
      apiBase: this.activeRegion().apiBase,
      timeoutSec,
      refresh
    });
    if (captured) {
      console.log("Captured auth token from existing browser session.");
    }
    return captured;
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
    this.state.auth = undefined;
    this.state.pendingLoginPhone = undefined;
    this.state.session.storePinned = false;
    this.state.quote = undefined;
    this.state.order = undefined;
    this.state.payment = undefined;
    this.itemSkuOptionsCacheByStore = {};
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
    const rows = options.map((option) => [
      option.skuId,
      option.price !== undefined ? option.price.toFixed(2) : "-",
      option.specText ?? "-",
      option.name
    ]);
    printTable(["skuId", "price", "variant", "name"], rows);
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
    const sub = rest[0];
    const action = sub ?? "status";

    if (action === "start") {
      if (!this.state.auth || !this.state.selectedStore || !this.state.order?.orderNo) {
        console.log("pay start needs auth + selected store + existing order");
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
        console.log("No payUrl in state. Run `pay start` first.");
        return;
      }
      this.openUrl(url);
      return;
    }

    if (action === "status") {
      if (!this.state.auth || !this.state.selectedStore || !this.state.order?.orderNo) {
        console.log("pay status needs auth + selected store + existing order");
        return;
      }
      const res = await this.client.payResultList({
        userId: this.state.auth.userId,
        storeNo: this.state.selectedStore.storeNo,
        orderNo: this.state.order.orderNo
      });
      this.printEnvelope(res);
      if (isApiOk(res)) {
        const data = envelopeData(res);
        const statuses = extractPayStatuses(data);
        if (statuses.includes(2)) {
          if (this.state.order) {
            this.state.order.status = "paid";
          }
          if (this.state.payment) {
            this.state.payment.status = "success";
          }
          await this.persist();
          console.log("Payment status: SUCCESS");
        } else if (statuses.includes(1) || statuses.includes(0)) {
          console.log("Payment status: PENDING");
        } else {
          console.log(`Payment statuses: [${statuses.join(", ")}]`);
        }
      }
      return;
    }

    console.log("Usage: pay [start|open|status]");
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

  private async autoLocateFromIpIfNeeded(): Promise<void> {
    const source = this.state.session.locationSource;
    if (source === "manual" || source === "browser") {
      return;
    }

    const resolved = await this.resolveLocationFromIp();
    if (!resolved) {
      return;
    }

    const latitudeChanged =
      Math.abs(this.state.session.latitude - resolved.latitude) > 0.000001;
    const longitudeChanged =
      Math.abs(this.state.session.longitude - resolved.longitude) > 0.000001;
    const sourceChanged = this.state.session.locationSource !== "ip";
    if (!latitudeChanged && !longitudeChanged && !sourceChanged) {
      return;
    }

    this.state.session.latitude = resolved.latitude;
    this.state.session.longitude = resolved.longitude;
    this.state.session.locationSource = "ip";
    this.state.session.locationUpdatedAt = new Date().toISOString();
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

  async execute(raw: string): Promise<boolean> {
    return this.handle(raw);
  }

  stateSnapshot(): AppState {
    return structuredClone(this.state) as AppState;
  }

  transportEventsSnapshot(): Array<RequestEvent | ResponseEvent> {
    return [...this.events];
  }

  async shutdown(): Promise<void> {
    this.stopStoreWatch();
    await this.persist();
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

function extractMenuCategories(data: unknown): MenuCategory[] {
  const categoryCandidates = [
    data,
    (data as Record<string, unknown> | undefined)?.menuList,
    (data as Record<string, unknown> | undefined)?.classifyList,
    (data as Record<string, unknown> | undefined)?.categoryList,
    (data as Record<string, unknown> | undefined)?.list
  ];

  for (const candidate of categoryCandidates) {
    const arr = asArray(candidate);
    if (!arr || arr.length === 0) {
      continue;
    }

    const categories = arr
      .map((raw) => mapCategory(raw))
      .filter((c): c is MenuCategory => c !== undefined);
    if (categories.length > 0) {
      return categories;
    }
  }

  return [];
}

function mapCategory(raw: unknown): MenuCategory | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const id =
    asString(obj.categoryId) ??
    asString(obj.menuCategoryId) ??
    asString(obj.classifyId) ??
    asString(obj.id) ??
    "";
  const name =
    asString(obj.categoryName) ??
    asString(obj.menuCategoryName) ??
    asString(obj.classifyName) ??
    asString(obj.name) ??
    "";

  const itemCandidates = [obj.goodsList, obj.spuList, obj.items, obj.list];
  let items: MenuItem[] = [];
  for (const candidate of itemCandidates) {
    const arr = asArray(candidate);
    if (!arr) {
      continue;
    }
    items = arr
      .map((x) => mapItem(x))
      .filter((item): item is MenuItem => item !== undefined);
    if (items.length > 0) {
      break;
    }
  }

  if (!id && !name) {
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
  const spuId = asString(obj.spuId) ?? asString(obj.id) ?? "";
  const skuId = asString(obj.skuId);
  const name = asString(obj.spuName) ?? asString(obj.name) ?? asString(obj.title) ?? "";
  const price =
    toNum(obj.salePrice) ?? toNum(obj.unitTradePrice) ?? toNum(obj.price) ?? undefined;

  if (!spuId || !name) {
    return undefined;
  }
  if (isMenuItemOutOfStock(obj)) {
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

  const rootName = asString(detailRoot.name) ?? asString(detailRoot.spuName) ?? "";
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
    if (isMenuItemOutOfStock(sku)) {
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
    return expandSkuOptionsWithSpuAttributes(options, detailRoot);
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
  const explicitSaleOut = toBool(obj.saleOut);
  if (explicitSaleOut !== undefined) {
    return explicitSaleOut;
  }

  const explicitSoldOut =
    toBool(obj.soldOut) ?? toBool(obj.isSoldOut) ?? toBool(obj.outOfStock);
  if (explicitSoldOut !== undefined) {
    return explicitSoldOut;
  }

  const canSale = toBool(obj.canSale) ?? toBool(obj.available) ?? toBool(obj.isAvailable);
  if (canSale !== undefined) {
    return !canSale;
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
  if (stock !== undefined && stock <= 0) {
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

function extractPayStatuses(data: unknown): number[] {
  if (!Array.isArray(data)) {
    return [];
  }
  const statuses: number[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const status = toNum((item as Record<string, unknown>).status);
    if (status !== undefined) {
      statuses.push(status);
    }
  }
  return statuses;
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

function isLocationSource(value: unknown): value is LocationSource {
  return typeof value === "string" && LOCATION_SOURCES.includes(value as LocationSource);
}

export async function runCliRepl(): Promise<void> {
  const app = new App();
  await app.init();
  await app.run();
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

interface CdpTarget {
  id: string;
  type?: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

async function listCdpTargets(cdpBaseUrl: string): Promise<CdpTarget[]> {
  const res = await fetch(`${cdpBaseUrl}/json/list`);
  if (!res.ok) {
    throw new Error(`CDP /json/list failed (${res.status})`);
  }
  const payload = (await res.json()) as unknown;
  if (!Array.isArray(payload)) {
    return [];
  }
  return payload.filter((entry) => entry && typeof entry === "object") as CdpTarget[];
}

async function pickCdpTarget(
  cdpBaseUrl: string,
  loginUrl: string
): Promise<CdpTarget | undefined> {
  let targets: CdpTarget[];
  try {
    targets = await listCdpTargets(cdpBaseUrl);
  } catch {
    return undefined;
  }
  const loginOrigin = safeOrigin(loginUrl);
  const pages = targets.filter((target) => target.type === "page");
  const preferred = pages.find((target) => {
    const url = target.url ?? "";
    if (!loginOrigin) {
      return url.includes("h5.chagee.com.sg");
    }
    return url.startsWith(loginOrigin);
  });
  if (preferred) {
    return preferred;
  }
  return pages[0];
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
