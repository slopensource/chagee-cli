import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface OrderHistoryLine {
  skuId: string;
  spuId?: string | undefined;
  name?: string | undefined;
  variantText?: string | undefined;
  qty: number;
  price?: number | undefined;
  specList?: Array<{ specId: string; specOptionId: string }> | undefined;
  attributeList?: Array<{ attributeOptionId: string }> | undefined;
}

export interface OrderHistoryEntry {
  id: string;
  at: string;
  orderNo: string;
  region: string;
  storeNo?: string | undefined;
  storeName?: string | undefined;
  total?: string | undefined;
  items: OrderHistoryLine[];
}

const ORDER_HISTORY_DIR_ENV_VAR = "CHAGEE_CLI_HOME";
const ORDER_HISTORY_SCHEMA_VERSION = 1;
const ORDER_HISTORY_MAX_ITEMS = 50;

export function orderHistoryFilePath(): string {
  return resolveOrderHistoryFile();
}

export async function loadOrderHistory(): Promise<OrderHistoryEntry[]> {
  const file = resolveOrderHistoryFile();
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return normalizeHistoryPayload(parsed);
  } catch {
    return [];
  }
}

export async function appendOrderHistory(entry: OrderHistoryEntry): Promise<OrderHistoryEntry[]> {
  const existing = await loadOrderHistory();
  const deduped = existing.filter((candidate) => candidate.orderNo !== entry.orderNo);
  const next = [entry, ...deduped].slice(0, ORDER_HISTORY_MAX_ITEMS);
  await saveOrderHistory(next);
  return next;
}

export async function clearOrderHistory(): Promise<void> {
  await saveOrderHistory([]);
}

async function saveOrderHistory(entries: OrderHistoryEntry[]): Promise<void> {
  const file = resolveOrderHistoryFile();
  await mkdir(dirname(file), { recursive: true });
  const payload = {
    schemaVersion: ORDER_HISTORY_SCHEMA_VERSION,
    entries
  };
  const tempFile = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempFile, JSON.stringify(payload, null, 2), {
    encoding: "utf8",
    mode: 0o600
  });
  await rename(tempFile, file);
}

function normalizeHistoryPayload(parsed: unknown): OrderHistoryEntry[] {
  if (!parsed || typeof parsed !== "object") {
    return [];
  }
  const root = parsed as Record<string, unknown>;
  const rawEntries =
    Array.isArray(root.entries) ? root.entries : Array.isArray(parsed) ? parsed : [];
  const out: OrderHistoryEntry[] = [];
  for (const rawEntry of rawEntries) {
    const entry = normalizeHistoryEntry(rawEntry);
    if (entry) {
      out.push(entry);
    }
  }
  return out.slice(0, ORDER_HISTORY_MAX_ITEMS);
}

function normalizeHistoryEntry(value: unknown): OrderHistoryEntry | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const obj = value as Record<string, unknown>;
  const id = asString(obj.id);
  const at = asString(obj.at);
  const orderNo = asString(obj.orderNo);
  const region = asString(obj.region);
  const rawItems = Array.isArray(obj.items) ? obj.items : [];

  if (!id || !at || !orderNo || !region) {
    return undefined;
  }

  const items: OrderHistoryLine[] = [];
  for (const rawItem of rawItems) {
    const item = normalizeHistoryItem(rawItem);
    if (item) {
      items.push(item);
    }
  }
  if (items.length === 0) {
    return undefined;
  }

  return {
    id,
    at,
    orderNo,
    region,
    storeNo: asString(obj.storeNo),
    storeName: asString(obj.storeName),
    total: asString(obj.total),
    items
  };
}

function normalizeHistoryItem(value: unknown): OrderHistoryLine | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const obj = value as Record<string, unknown>;
  const skuId = asString(obj.skuId);
  const qty = asNumber(obj.qty);
  if (!skuId || qty === undefined || qty <= 0) {
    return undefined;
  }
  const specList = parseSpecSelectionList(obj.specList);
  const attributeList = parseAttributeSelectionList(obj.attributeList);
  return {
    skuId,
    qty: Math.floor(qty),
    spuId: asString(obj.spuId),
    name: asString(obj.name),
    variantText: asString(obj.variantText),
    price: asNumber(obj.price),
    specList,
    attributeList
  };
}

function resolveOrderHistoryFile(): string {
  const configuredDir = process.env[ORDER_HISTORY_DIR_ENV_VAR]?.trim();
  if (configuredDir) {
    return join(configuredDir, "order-history.json");
  }
  return join(homedir(), ".chagee-cli", "order-history.json");
}

function parseSpecSelectionList(
  raw: unknown
): Array<{ specId: string; specOptionId: string }> | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const out: Array<{ specId: string; specOptionId: string }> = [];
  for (const item of raw) {
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
  raw: unknown
): Array<{ attributeOptionId: string }> | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const out: Array<{ attributeOptionId: string }> = [];
  for (const item of raw) {
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

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  return undefined;
}
