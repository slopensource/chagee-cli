export type SessionMode = "dry-run" | "live";
export type LocationSource = "default" | "ip" | "browser" | "manual";

export type AppPhase =
  | "UNAUTH"
  | "AUTH_NO_STORE"
  | "READY"
  | "CART_DIRTY"
  | "QUOTED"
  | "ORDER_CREATED"
  | "PAYMENT_PENDING"
  | "ORDER_PAID"
  | "ORDER_CANCELED";

export interface AuthState {
  token: string;
  userId: string;
  phoneMasked?: string | undefined;
  phoneRaw?: string | undefined;
  expiresAt?: string | undefined;
}

export interface StoreState {
  storeNo: string;
  storeName: string;
  distanceMeters?: number | undefined;
  latitude?: number | undefined;
  longitude?: number | undefined;
  waitingCups?: number | undefined;
  waitingTime?: number | undefined;
  deliveryTime?: string | undefined;
  runningStatusDesc?: string | undefined;
}

export interface MenuItem {
  spuId: string;
  skuId?: string | undefined;
  name: string;
  price?: number | undefined;
  raw?: unknown;
}

export interface MenuCategory {
  id: string;
  name: string;
  items: MenuItem[];
}

export interface ItemSkuOption {
  skuId: string;
  name: string;
  price?: number | undefined;
  specText?: string | undefined;
  specList?: Array<{ specId: string; specOptionId: string }> | undefined;
  attributeList?: Array<{ attributeOptionId: string }> | undefined;
}

export interface CartLine {
  lineId: string;
  spuId?: string | undefined;
  skuId: string;
  name?: string | undefined;
  variantText?: string | undefined;
  qty: number;
  price?: number | undefined;
  specList?: Array<{ specId: string; specOptionId: string }> | undefined;
  attributeList?: Array<{ attributeOptionId: string }> | undefined;
}

export interface QuoteState {
  at: string;
  total?: string | undefined;
  priceQuoteRespVO?: unknown;
  raw: unknown;
}

export interface OrderState {
  orderNo: string;
  status?: string | undefined;
  amount?: string | undefined;
  createdAt: string;
  cancelByAt?: string | undefined;
  cancelRemainingSec?: number | undefined;
  cancelCheckedAt?: string | undefined;
  raw?: unknown;
}

export interface PaymentState {
  payNo?: string | undefined;
  payUrl?: string | undefined;
  status?: string | undefined;
  method?: string | undefined;
  raw?: unknown;
}

export interface SessionConfig {
  mode: SessionMode;
  jsonOutput: boolean;
  region: string;
  latitude: number;
  longitude: number;
  locationSource: LocationSource;
  locationUpdatedAt?: string | undefined;
  locationAccuracyMeters?: number | undefined;
  storePinned: boolean;
  guestToken?: string | undefined;
}

export interface AppState {
  session: SessionConfig;
  auth?: AuthState | undefined;
  pendingLoginPhone?: string | undefined;
  selectedStore?: StoreState | undefined;
  storesCache: StoreState[];
  menuCache: MenuCategory[];
  menuCacheByStore: Record<string, MenuCategory[]>;
  cart: CartLine[];
  cartVersion: number;
  quote?: QuoteState | undefined;
  pendingCreatePayload?: Record<string, unknown> | undefined;
  order?: OrderState | undefined;
  payment?: PaymentState | undefined;
}

export interface RequestEvent {
  ts: string;
  method: string;
  url: string;
  payload?: unknown;
}

export interface ResponseEvent {
  ts: string;
  method: string;
  url: string;
  status: number;
  elapsedMs: number;
  body: unknown;
}

export interface ApiEnvelope {
  errcode?: string | number;
  errmsg?: string;
  data?: unknown;
  traceId?: string;
  globalTicket?: string;
  [key: string]: unknown;
}
