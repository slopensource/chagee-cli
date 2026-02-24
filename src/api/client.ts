import type { RegionProfile } from "../config/regions.js";
import type { ApiEnvelope, RequestEvent, ResponseEvent } from "../types.js";

const STATIC_BASE_HEADERS: Record<string, string> = {
  ua: "Dart/2.12 (dart:io)",
  debug: "1",
  os: "web",
  devicelanguage: "en",
  screenwidth: "1280",
  screenheight: "720",
  devicebrand: "Web",
  devicemodel: "Browser",
  uuid: "null",
  cid: "null",
  avc: "320",
  clientip: "",
  colordepth: "",
  browserinfo:
    '{"javaenabled":false,"javascriptenabled":true,"language":"en","useragent":"Mozilla/5.0"}',
  "accept-language": "en-US"
};

const REQUEST_TIMEOUT_MS = 12_000;
const MAX_RETRY_ATTEMPTS = 3;
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
const RETRYABLE_POST_PATH_PREFIXES = [
  "/api/navigation/store/list",
  "/api/navigation/store/getStoreWaitInfo",
  "/api/navigation/goods/storeGoodsMenu",
  "/api/navigation/goods/detail",
  "/api/navigation/goods/shoppingCart/get",
  "/api/navigation/payment/payResultList",
  "/api/navigation/order/price"
];

export interface ApiHooks {
  onRequest?: (event: RequestEvent) => void;
  onResponse?: (event: ResponseEvent) => void;
}

export interface RequestOptions {
  baseUrl?: string;
}

export class ChageeClient {
  constructor(
    private readonly getToken: () => string | undefined,
    private readonly getRegion: () => RegionProfile,
    private readonly hooks?: ApiHooks
  ) {}

  async sendVerifyCode(phone: string, sendType = 1): Promise<ApiEnvelope> {
    return this.post("/api/user-client/customer/sendVerifyCode", {
      sendType,
      sendObj: phone
    });
  }

  async loginOrRegister(params: {
    phone: string;
    code: string;
    phoneCode?: string;
  }): Promise<ApiEnvelope> {
    const region = this.getRegion();
    return this.post("/api/user-client/customer/loginOrRegister", {
      mobile: params.phone,
      phoneCode: params.phoneCode ?? region.defaultPhoneCode,
      code: params.code
    });
  }

  async commonLoginSg(params: {
    sourceCode: string;
    token: string;
  }): Promise<ApiEnvelope> {
    return this.post("/api/user-client/common/login/sg", {
      sourceCode: params.sourceCode,
      token: params.token
    });
  }

  async getCustomerInfo(): Promise<ApiEnvelope> {
    return this.get("/api/user-client/customer/info");
  }

  async getCustomerDetails(): Promise<ApiEnvelope> {
    return this.get("/api/user-client/customer/details");
  }

  async listStores(params: {
    latitude: number;
    longitude: number;
    userId?: string;
    pageNum?: number;
    pageSize?: number;
    isTakeaway?: boolean;
    channelCode?: string;
  }): Promise<ApiEnvelope> {
    const region = this.getRegion();
    return this.post("/api/navigation/store/list", {
      latitude: params.latitude,
      longitude: params.longitude,
      pageNum: params.pageNum ?? 1,
      pageSize: params.pageSize ?? 20,
      channelCode: params.channelCode ?? region.channelCode,
      userId: params.userId ?? "",
      isTakeaway: params.isTakeaway ?? region.isTakeaway
    });
  }

  async getStoreWaitInfo(params: {
    storeNo: string;
    isTakeaway?: boolean;
  }): Promise<ApiEnvelope> {
    const region = this.getRegion();
    return this.post("/api/navigation/store/getStoreWaitInfo", {
      storeNo: params.storeNo,
      isTakeaway: params.isTakeaway ?? region.isTakeaway
    });
  }

  async getStoreMenu(params: {
    storeNo: string;
    saleType?: number;
    saleChannel?: number;
  }): Promise<ApiEnvelope> {
    const region = this.getRegion();
    return this.post("/api/navigation/goods/storeGoodsMenu", {
      storeNo: params.storeNo,
      saleType: String(params.saleType ?? region.saleType),
      saleChannel: String(params.saleChannel ?? region.saleChannel)
    });
  }

  async getGoodsDetail(params: {
    spuId: string;
    storeNo: string;
    saleType?: number;
    saleChannel?: number;
  }): Promise<ApiEnvelope> {
    const region = this.getRegion();
    return this.post("/api/navigation/goods/detail", {
      spuId: params.spuId,
      storeNo: params.storeNo,
      saleType: String(params.saleType ?? region.saleType),
      saleChannel: String(params.saleChannel ?? region.saleChannel)
    });
  }

  async cartGet(params: {
    storeNo: string;
    userId: string;
    saleType?: number;
    saleChannel?: number;
    tradeChannel?: string;
  }): Promise<ApiEnvelope> {
    const region = this.getRegion();
    return this.post("/api/navigation/goods/shoppingCart/get", {
      storeNo: params.storeNo,
      userId: params.userId,
      saleType: String(params.saleType ?? region.saleType),
      saleChannel: String(params.saleChannel ?? region.saleChannel),
      tradeChannel: params.tradeChannel ?? region.tradeChannel,
      inAppDeliveryGray: false
    });
  }

  async cartChange(params: {
    userId: string;
    skuList: unknown[];
    saleType?: number;
    saleChannel?: number;
    inAppDeliveryGray?: boolean;
  }): Promise<ApiEnvelope> {
    const region = this.getRegion();
    return this.post("/api/navigation/goods/shoppingCart/change", {
      userId: params.userId,
      skuList: params.skuList,
      saleType: params.saleType ?? region.saleType,
      saleChannel: params.saleChannel ?? region.saleChannel,
      inAppDeliveryGray: params.inAppDeliveryGray ?? false
    });
  }

  async orderPrice(payload: Record<string, unknown>): Promise<ApiEnvelope> {
    return this.post("/api/navigation/order/price", payload);
  }

  async orderCreate(payload: Record<string, unknown>): Promise<ApiEnvelope> {
    return this.post("/api/navigation/order/create", payload);
  }

  async orderCancel(userId: string, orderNo: string): Promise<ApiEnvelope> {
    return this.post("/api/navigation/order/cancel", {
      userId,
      orderNo
    });
  }

  async continuePay(payload: Record<string, unknown>): Promise<ApiEnvelope> {
    return this.post("/api/navigation/order/continuePay", payload);
  }

  async payResultList(params: {
    userId: string;
    storeNo: string;
    orderNo: string;
  }): Promise<ApiEnvelope> {
    return this.post("/api/navigation/payment/payResultList", {
      userId: params.userId,
      storeNo: params.storeNo,
      orderNo: params.orderNo
    });
  }

  async post(
    path: string,
    body?: unknown,
    options?: RequestOptions
  ): Promise<ApiEnvelope> {
    return this.request("POST", path, body, options);
  }

  async get(path: string, options?: RequestOptions): Promise<ApiEnvelope> {
    return this.request("GET", path, undefined, options);
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    options?: RequestOptions
  ): Promise<ApiEnvelope> {
    const region = this.getRegion();
    const baseUrl = options?.baseUrl ?? region.apiBase;
    const url = path.startsWith("http") ? path : `${baseUrl}${path}`;
    const token = this.getToken();

    const headers = buildHeaders(region, token);

    if (method === "POST") {
      headers["content-type"] = "application/json";
    }

    this.hooks?.onRequest?.({
      ts: new Date().toISOString(),
      method,
      url,
      payload: body
    });

    const requestInit: RequestInit = { method, headers };
    if (method === "POST" && body !== undefined) {
      requestInit.body = JSON.stringify(body);
    }

    const retryable = isRetryableRequest(method, path);
    const maxAttempts = retryable ? MAX_RETRY_ATTEMPTS : 1;
    let lastFailure: ApiEnvelope | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const start = Date.now();
      try {
        const response = await fetchWithTimeout(url, requestInit, REQUEST_TIMEOUT_MS);
        const elapsedMs = Date.now() - start;
        const parsed = await parseResponseBody(response);

        this.hooks?.onResponse?.({
          ts: new Date().toISOString(),
          method,
          url,
          status: response.status,
          elapsedMs,
          body: parsed
        });

        const envelope = normalizeEnvelope(parsed, response.status);
        if (
          retryable &&
          attempt < maxAttempts &&
          RETRYABLE_STATUS_CODES.has(response.status)
        ) {
          lastFailure = envelope;
          await sleepWithJitter(attempt);
          continue;
        }
        return envelope;
      } catch (error) {
        const elapsedMs = Date.now() - start;
        const failure = buildTransportErrorEnvelope(error);
        lastFailure = failure;

        this.hooks?.onResponse?.({
          ts: new Date().toISOString(),
          method,
          url,
          status: 0,
          elapsedMs,
          body: failure
        });

        if (retryable && attempt < maxAttempts && isRetryableNetworkError(error)) {
          await sleepWithJitter(attempt);
          continue;
        }
        return failure;
      }
    }

    return (
      lastFailure ?? {
        errcode: "NETWORK_ERROR",
        errmsg: "Request failed after retries."
      }
    );
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) {
    return "";
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { errcode: String(response.status), errmsg: text };
  }
}

function normalizeEnvelope(parsed: unknown, statusCode: number): ApiEnvelope {
  if (typeof parsed === "object" && parsed !== null) {
    const envelope = parsed as ApiEnvelope;
    if (envelope.errcode === undefined) {
      envelope.errcode = String(statusCode);
    }
    return envelope;
  }
  return {
    errcode: String(statusCode),
    errmsg: typeof parsed === "string" ? parsed : "Unexpected response",
    data: parsed
  };
}

function isRetryableRequest(method: "GET" | "POST", path: string): boolean {
  if (method === "GET") {
    return true;
  }
  return RETRYABLE_POST_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function isRetryableNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name === "AbortError") {
    return true;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes("network") ||
    message.includes("fetch") ||
    message.includes("timeout") ||
    message.includes("socket")
  );
}

function buildTransportErrorEnvelope(error: unknown): ApiEnvelope {
  if (error instanceof Error && error.name === "AbortError") {
    return {
      errcode: "NETWORK_TIMEOUT",
      errmsg: `Request timed out after ${REQUEST_TIMEOUT_MS}ms.`
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    errcode: "NETWORK_ERROR",
    errmsg: message || "Network request failed."
  };
}

async function sleepWithJitter(attempt: number): Promise<void> {
  const baseMs = 220 * 2 ** Math.max(0, attempt - 1);
  const jitterMs = Math.floor(Math.random() * 120);
  const delayMs = Math.min(2000, baseMs + jitterMs);
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function buildHeaders(region: RegionProfile, token?: string): Record<string, string> {
  return {
    ...STATIC_BASE_HEADERS,
    language: region.language,
    region: region.code,
    channel: region.channelCode,
    apv: region.apv,
    aid: region.aid,
    timezoneoffset: region.timezoneOffset,
    devicetimezoneregion: region.deviceTimeZoneRegion,
    "accept-language": region.acceptLanguage,
    authorization: token ?? "null"
  };
}

export function isApiOk(envelope: ApiEnvelope): boolean {
  return String(envelope.errcode ?? "") === "0";
}

export function envelopeData<T = unknown>(envelope: ApiEnvelope): T | undefined {
  return envelope.data as T | undefined;
}

export function extractToken(envelope: ApiEnvelope): string | undefined {
  const data = envelope.data as Record<string, unknown> | undefined;
  if (!data || typeof data !== "object") {
    return undefined;
  }

  const candidates = [data.token, data.accessToken, data.authToken];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }

  return undefined;
}

export function extractUserId(envelope: ApiEnvelope): string | undefined {
  const data = envelope.data as Record<string, unknown> | undefined;
  if (!data || typeof data !== "object") {
    return undefined;
  }

  const candidates = [data.userId, data.uid, data.id];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
    if (typeof candidate === "number") {
      return String(candidate);
    }
  }

  return undefined;
}
