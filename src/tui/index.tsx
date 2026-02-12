#!/usr/bin/env node

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput, useStdin, useStdout } from "ink";

import { App } from "../index.js";
import { derivePhase } from "../lib/state.js";
import type {
  AppPhase,
  AppState,
  CartLine,
  ItemSkuOption,
  MenuCategory,
  MenuItem,
  StoreState
} from "../types.js";

type FocusPane = "stores" | "menu" | "cart" | "console";

interface MenuRow {
  categoryId: string;
  categoryName: string;
  item: MenuItem;
}

interface MenuVariantPickerState {
  row: MenuRow;
  options: ItemSkuOption[];
  parsedOptions: MenuVariantParsedOption[];
  dimensions: MenuVariantDimension[];
  stageIndex: number;
  choiceIndex: number;
  selectedValues: Array<string | undefined>;
  qty: number;
}

interface MenuVariantDimension {
  key: string;
  label: string;
}

interface MenuVariantParsedOption {
  option: ItemSkuOption;
  summary: string;
  valuesByDimension: string[];
}

interface MenuVariantStageChoice {
  value: string;
  priceText: string;
  previewOption?: ItemSkuOption;
  combos: number;
}

interface LayoutMetrics {
  cols: number;
  rows: number;
  headerHeight: number;
  paneHeight: number;
  consoleHeight: number;
  paneStart: number;
  paneEnd: number;
  consoleStart: number;
  consoleEnd: number;
}

interface ParsedMouseEvent {
  x: number;
  y: number;
  type: "press" | "release" | "wheel_up" | "wheel_down";
}

interface MouseContext {
  layout: LayoutMetrics;
  terminalCols: number;
  focusPane: FocusPane;
  storesLen: number;
  menuLen: number;
  menuVariantFooterRows: number;
  cartLen: number;
  cartVisibleRows: number;
  storeIndex: number;
  menuIndex: number;
  cartIndex: number;
  menuVariantOpen: boolean;
}

interface MouseRowSelection {
  pane: "stores" | "menu" | "cart";
  index: number;
  menuVariantOpen: boolean;
}

interface LastMouseClick {
  atMs: number;
  selection: MouseRowSelection;
}
interface SlashCommandHint {
  command: string;
  description: string;
  insert?: string;
}

type TuiCommandSource = "shell" | "panel" | "system";

const MAX_LOG_LINES = 500;
const ENTER_ALT_SCREEN = "\u001b[?1049h";
const LEAVE_ALT_SCREEN = "\u001b[?1049l";
const HIDE_CURSOR = "\u001b[?25l";
const SHOW_CURSOR = "\u001b[?25h";
const ENABLE_MOUSE = "\u001b[?1000h\u001b[?1006h";
const DISABLE_MOUSE = "\u001b[?1000l\u001b[?1006l";
const LINE_ACTIVE = "\u0001";
const LINE_SELECTED = "\u0002";
const LINE_FOOTER_SPLIT = "\u0003";
const DOUBLE_CLICK_MS = 350;
const MENU_VARIANT_FOOTER_ROWS = 4;
const CART_HEADER_ROWS = 3;
const CART_FOOTER_ROWS = 2;
const CART_DETAIL_ROWS = 7;
const STORE_PANE_RATIO = 0.38;
const MENU_PANE_RATIO = 0.34;
const ALL_SLASH_COMMANDS: SlashCommandHint[] = [
  { command: "help", description: "show command help" },
  { command: "status", description: "show current session status" },
  {
    command: "login",
    description: "guided login (reuse session, clipboard token, then browser capture)"
  },
  {
    command: "login token <token>",
    description: "import explicit auth token from browser/devtools",
    insert: "login token "
  },
  { command: "otp <code>", description: "legacy OTP verify for login", insert: "otp " },
  { command: "logout", description: "clear authenticated session" },
  { command: "locate", description: "precise browser geolocation for distance sorting" },
  { command: "stores", description: "list stores by distance/wait/cups/name" },
  { command: "mouse on", description: "enable mouse click selection" },
  { command: "mouse off", description: "disable mouse capture" },
  { command: "watch on", description: "auto-refresh stores every few seconds" },
  { command: "watch off", description: "stop live store auto-refresh" },
  { command: "use <storeNo>", description: "choose active pickup store", insert: "use " },
  { command: "wait", description: "refresh wait/cup info for selected store" },
  { command: "menu", description: "fetch store menu" },
  { command: "item <spuId>", description: "show SKU options for an item", insert: "item " },
  { command: "add <skuId>", description: "add SKU into cart", insert: "add " },
  { command: "qty <item> <n>", description: "change cart item quantity", insert: "qty " },
  { command: "rm <item>", description: "remove cart item", insert: "rm " },
  { command: "clear", description: "clear cart contents" },
  { command: "cart", description: "show cart lines and totals" },
  { command: "quote", description: "request price quote" },
  { command: "live on", description: "enable real order creation mode" },
  { command: "live off", description: "switch back to dry-run mode" },
  { command: "place", description: "create order from quote/cart" },
  { command: "order", description: "show latest order state" },
  { command: "order cancel", description: "cancel latest order (if allowed)" },
  { command: "pay", description: "guided payment (create/open payment link)" },
  { command: "pay status", description: "check payment status for latest order" },
  { command: "region list", description: "show configured region profiles" },
  { command: "region set <code>", description: "switch region and reset session", insert: "region set " },
  { command: "exit", description: "quit TUI session" }
];

const SHELL_ORDERING_ROOTS = new Set([
  "use",
  "wait",
  "menu",
  "item",
  "cart",
  "add",
  "qty",
  "rm",
  "clear",
  "quote",
  "place",
  "checkout",
  "confirm",
  "live"
]);

interface RunTuiOptions {
  yolo?: boolean;
}

export async function runTui(options: RunTuiOptions = {}): Promise<void> {
  const yolo = options.yolo === true;
  const restoreTerminal = enterInteractiveSession(process.stdout);
  const instance = render(<TuiRoot yolo={yolo} />, { exitOnCtrlC: false });
  const teardown = (): void => {
    instance.unmount();
  };

  process.once("SIGINT", teardown);
  process.once("SIGTERM", teardown);

  try {
    await instance.waitUntilExit();
  } finally {
    process.off("SIGINT", teardown);
    process.off("SIGTERM", teardown);
    instance.clear();
    restoreTerminal();
  }
}

interface TuiRootProps {
  yolo: boolean;
}

function TuiRoot(props: TuiRootProps): React.JSX.Element {
  const appRef = useRef(new App({ yolo: props.yolo }));
  const queueRef = useRef(Promise.resolve());
  const stoppingRef = useRef(false);
  const autoWatchStartedRef = useRef(false);
  const lastMouseClickRef = useRef<LastMouseClick | undefined>(undefined);

  const prevOrderNoRef = useRef<string | undefined>(undefined);
  const prevPaymentStatusRef = useRef<string | undefined>(undefined);
  const prevQuoteTotalRef = useRef<string | undefined>(undefined);
  const prevPhaseRef = useRef<AppPhase | undefined>(undefined);

  const { exit } = useApp();
  const { stdout } = useStdout();
  const { stdin, isRawModeSupported, setRawMode } = useStdin();

  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [appState, setAppState] = useState<AppState>();
  const [focusPane, setFocusPane] = useState<FocusPane>("console");
  const [commandInput, setCommandInput] = useState("");
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const [historyCursor, setHistoryCursor] = useState<number | null>(null);
  const [slashHintIndex, setSlashHintIndex] = useState(0);
  const [showHelpPanel, setShowHelpPanel] = useState(false);
  const [helpScrollOffset, setHelpScrollOffset] = useState(0);
  const [watchEnabled, setWatchEnabled] = useState(false);
  const [mouseEnabled, setMouseEnabled] = useState(true);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [consoleScrollOffset, setConsoleScrollOffset] = useState(0);
  const [storeIndex, setStoreIndex] = useState(0);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuVariantPicker, setMenuVariantPicker] = useState<MenuVariantPickerState | undefined>(
    undefined
  );
  const [cartIndex, setCartIndex] = useState(0);

  const terminalCols = stdout.columns ?? 120;
  const terminalRows = stdout.rows ?? 40;
  const layout = useMemo(
    () => buildLayoutMetrics(terminalCols, terminalRows),
    [terminalCols, terminalRows]
  );
  const paneWidths = useMemo(() => computePaneWidths(terminalCols), [terminalCols]);
  const storePaneTextWidth = Math.max(26, paneWidths.store - 4);
  const menuPaneTextWidth = Math.max(18, paneWidths.menu - 4);
  const cartPaneTextWidth = Math.max(16, paneWidths.cart - 4);
  const consoleTextWidth = Math.max(24, terminalCols - 6);
  const consoleRows = Math.max(2, layout.consoleHeight - 1);
  const consoleLogsCapacity = Math.max(1, consoleRows - 1);
  const consoleMaxScrollOffset = Math.max(0, logLines.length - consoleLogsCapacity);
  const helpRowsCapacity = Math.max(1, consoleRows - 2);
  const slashCommands = useMemo(() => filterShellSlashCommands(props.yolo), [props.yolo]);
  const helpMaxScrollOffset = Math.max(0, slashCommands.length - helpRowsCapacity);

  const stores = appState?.storesCache ?? [];
  const menuRows = useMemo(() => flattenMenuRows(appState?.menuCache ?? []), [appState?.menuCache]);
  const cartLines = appState?.cart ?? [];
  const phase: AppPhase = appState ? derivePhase(appState) : "UNAUTH";
  const slashHints = useMemo(
    () => getSlashHints(commandInput, slashCommands),
    [commandInput, slashCommands]
  );
  const slashPaletteVisible =
    focusPane === "console" && commandInput.trimStart().startsWith("/") && slashHints.length > 0;
  const selectedSlashHint = slashHints[clampIndex(slashHintIndex, slashHints.length)];

  const mouseContextRef = useRef<MouseContext>({
    layout,
    terminalCols,
    focusPane,
    storesLen: stores.length,
    menuLen: menuRows.length,
    menuVariantFooterRows: 0,
    cartLen: cartLines.length,
    cartVisibleRows: 0,
    storeIndex,
    menuIndex,
    cartIndex,
    menuVariantOpen: false
  });

  const pushLog = useCallback((message: string): void => {
    setLogLines((prev) => {
      const stamped = `${timeStamp()} ${message}`;
      const next = [...prev, stamped];
      if (next.length > MAX_LOG_LINES) {
        return next.slice(-MAX_LOG_LINES);
      }
      return next;
    });
  }, []);

  const refreshSnapshot = useCallback((): void => {
    setAppState(appRef.current.stateSnapshot());
  }, []);

  const stopApp = useCallback(async (): Promise<void> => {
    if (stoppingRef.current) {
      return;
    }
    stoppingRef.current = true;
    try {
      await appRef.current.shutdown();
    } finally {
      exit();
    }
  }, [exit]);

  const enqueue = useCallback(
    (task: () => Promise<void>): void => {
      queueRef.current = queueRef.current
        .then(task)
        .catch((error: unknown) => {
          pushLog(`error ${formatArg(error)}`);
        });
    },
    [pushLog]
  );

  const executeCommand = useCallback(
    (raw: string, source: TuiCommandSource = "shell"): void => {
      enqueue(async () => {
        const command = normalizeSlashCommand(raw);
        if (!command) {
          return;
        }

        if (source === "shell") {
          setHistoryCursor(null);
          setCommandHistory((prev) => {
            if (prev[prev.length - 1] === command) {
              return prev;
            }
            const next = [...prev, command];
            if (next.length > 200) {
              return next.slice(-200);
            }
            return next;
          });
        }

        if (command === "help") {
          setShowHelpPanel(true);
          setHelpScrollOffset(0);
          setConsoleScrollOffset(0);
          return;
        }

        setShowHelpPanel(false);
        setHelpScrollOffset(0);

        if (command === "mouse on") {
          setMouseEnabled(true);
          pushLog("mouse capture ON (click navigation enabled; text selection may be limited)");
          return;
        }
        if (command === "mouse off") {
          setMouseEnabled(false);
          pushLog("mouse capture OFF (native text selection/copy enabled)");
          return;
        }
        if (command === "mouse") {
          pushLog(`mouse capture ${mouseEnabled ? "ON" : "OFF"}`);
          return;
        }

        const commandRoot = (command.split(/\s+/, 1)[0] ?? "").toLowerCase();
        if (commandRoot === "pay" && mouseEnabled) {
          setMouseEnabled(false);
          pushLog(
            "mouse capture AUTO-OFF for /pay (native text selection/copy enabled; run /mouse on to re-enable click navigation)"
          );
        }

        setBusy(true);
        pushLog(`${source === "shell" ? "cmd" : source} > /${command}`);
        try {
          const shouldExit = await appRef.current.execute(`/${command}`, { source });

          if (command.startsWith("watch on") || command.startsWith("stores watch on")) {
            setWatchEnabled(true);
          } else if (
            command.startsWith("watch off") ||
            command.startsWith("stores watch off")
          ) {
            setWatchEnabled(false);
          } else if (
            command.startsWith("region set ") ||
            command.startsWith("debug region set ")
          ) {
            setWatchEnabled(false);
          }

          refreshSnapshot();

          if (shouldExit) {
            await stopApp();
          }
        } finally {
          setBusy(false);
        }
      });
    },
    [enqueue, mouseEnabled, pushLog, refreshSnapshot, stopApp]
  );

  const focusCycle = useCallback(
    (direction: 1 | -1): void => {
      const panes: FocusPane[] = ["stores", "menu", "cart", "console"];
      const idx = panes.indexOf(focusPane);
      const next = (idx + direction + panes.length) % panes.length;
      const pane = panes[next];
      if (pane) {
        setFocusPane(pane);
      }
    },
    [focusPane]
  );

  const moveSelection = useCallback(
    (delta: number): void => {
      if (focusPane === "stores") {
        setStoreIndex((prev) => clampIndex(prev + delta, stores.length));
        return;
      }
      if (focusPane === "menu") {
        if (menuVariantPicker) {
          setMenuVariantPicker((prev) => {
            if (!prev) {
              return prev;
            }
            const choiceCount = getMenuVariantStageChoices(prev).length;
            return {
              ...prev,
              choiceIndex: clampIndex(prev.choiceIndex + delta, choiceCount)
            };
          });
          return;
        }
        setMenuIndex((prev) => clampIndex(prev + delta, menuRows.length));
        return;
      }
      if (focusPane === "cart") {
        setCartIndex((prev) => clampIndex(prev + delta, cartLines.length));
      }
    },
    [cartLines.length, focusPane, menuRows.length, menuVariantPicker, stores.length]
  );

  const applySlashHint = useCallback((hint: SlashCommandHint | undefined): void => {
    if (!hint) {
      return;
    }
    const insertText = slashInsertText(hint);
    setCommandInput(`/${insertText}`);
    setHistoryCursor(null);
  }, []);

  const openMenuVariantPicker = useCallback(
    (row: MenuRow): void => {
      enqueue(async () => {
        setBusy(true);
        try {
          const options = await appRef.current.getItemSkuOptions(row.item.spuId);
          if (options.length === 0) {
            pushLog(`No sellable variants for ${row.item.name}`);
            return;
          }
          setMenuVariantPicker(createMenuVariantPickerState(row, options));
        } finally {
          setBusy(false);
        }
      });
    },
    [enqueue, pushLog]
  );

  const activateMouseSelection = useCallback(
    (selection: MouseRowSelection): void => {
      if (selection.pane === "stores") {
        const selected = stores[selection.index];
        if (selected?.storeNo) {
          executeCommand(`/use ${selected.storeNo}`, "panel");
        }
        return;
      }

      if (selection.pane === "menu") {
        if (selection.menuVariantOpen && menuVariantPicker) {
          const transition = commitMenuVariantChoice(menuVariantPicker, selection.index);
          if (transition.mode === "none") {
            return;
          }
          if (transition.mode === "advance") {
            setMenuVariantPicker(transition.picker);
            return;
          }
          executeCommand(
            buildAddCommandForVariant(
              menuVariantPicker.row.item,
              transition.option,
              menuVariantPicker.qty
            ),
            "panel"
          );
          setMenuVariantPicker(undefined);
          return;
        }

        const selected = menuRows[selection.index];
        if (!selected) {
          return;
        }
        openMenuVariantPicker(selected);
        return;
      }

      if (selection.pane === "cart") {
        const selected = cartLines[selection.index];
        if (!selected) {
          return;
        }
        executeCommand(`/qty ${selection.index + 1} ${Math.max(1, selected.qty + 1)}`, "panel");
      }
    },
    [cartLines, executeCommand, menuRows, menuVariantPicker, openMenuVariantPicker, stores]
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await appRef.current.init();
      if (cancelled) {
        return;
      }
      refreshSnapshot();
      setReady(true);
      pushLog("Ready. Type /help.");
      if (!props.yolo) {
        pushLog("SAFE shell mode: ordering slash commands are disabled. Use panels or restart with --yolo.");
      }
      pushLog("mouse capture ON (click navigation enabled; run /mouse off for text selection)");
    })();
    return () => {
      cancelled = true;
    };
  }, [props.yolo, pushLog, refreshSnapshot]);

  useEffect(() => {
    if (!ready || autoWatchStartedRef.current) {
      return;
    }
    autoWatchStartedRef.current = true;
    enqueue(async () => {
      setBusy(true);
      try {
        await appRef.current.execute("/watch on interval=10 sort=distance quiet=1", {
          source: "system"
        });
        setWatchEnabled(true);
        refreshSnapshot();
        pushLog("Live store updates ON (10s, sorted by distance).");
      } finally {
        setBusy(false);
      }
    });
  }, [enqueue, pushLog, ready, refreshSnapshot]);

  useEffect(() => {
    if (!ready) {
      return;
    }
    const id = setInterval(() => {
      refreshSnapshot();
    }, 900);
    return () => {
      clearInterval(id);
    };
  }, [ready, refreshSnapshot]);

  useEffect(() => {
    const original = {
      log: console.log,
      warn: console.warn,
      error: console.error,
      info: console.info
    };

    const sink = (level: string, args: unknown[]): void => {
      const rendered = args.map((arg) => formatArg(arg)).join(" ");
      for (const line of rendered.split("\n")) {
        const clean = stripAnsi(line).trimEnd();
        if (clean.length > 0) {
          if (level === "log") {
            pushLog(clean);
          } else {
            pushLog(`${level}: ${clean}`);
          }
        }
      }
    };

    console.log = (...args: unknown[]): void => sink("log", args);
    console.warn = (...args: unknown[]): void => sink("warn", args);
    console.error = (...args: unknown[]): void => sink("error", args);
    console.info = (...args: unknown[]): void => sink("info", args);

    return () => {
      console.log = original.log;
      console.warn = original.warn;
      console.error = original.error;
      console.info = original.info;
    };
  }, [pushLog]);

  useEffect(() => {
    if (!ready || !appState) {
      return;
    }

    const nextPhase = derivePhase(appState);
    if (prevPhaseRef.current && prevPhaseRef.current !== nextPhase) {
      pushLog(`notice phase ${prevPhaseRef.current} -> ${nextPhase}`);
    }
    prevPhaseRef.current = nextPhase;

    const orderNo = appState.order?.orderNo;
    if (orderNo && orderNo !== prevOrderNoRef.current) {
      pushLog(`notice order created ${orderNo}`);
    } else if (!orderNo && prevOrderNoRef.current) {
      pushLog("notice order cleared");
    }
    prevOrderNoRef.current = orderNo;

    const paymentStatus = appState.payment?.status;
    if (paymentStatus && paymentStatus !== prevPaymentStatusRef.current) {
      pushLog(`notice payment ${paymentStatus}`);
    }
    prevPaymentStatusRef.current = paymentStatus;

    const quoteTotal = appState.quote?.total;
    if (quoteTotal && quoteTotal !== prevQuoteTotalRef.current) {
      pushLog(`notice quote total ${quoteTotal}`);
    }
    prevQuoteTotalRef.current = quoteTotal;
  }, [appState, pushLog, ready]);

  useEffect(() => {
    if (!ready) {
      return;
    }
    setStoreIndex((prev) => clampIndex(prev, stores.length));
  }, [ready, stores.length]);

  useEffect(() => {
    if (!ready || stores.length === 0) {
      return;
    }
    const selectedNo = appState?.selectedStore?.storeNo;
    if (!selectedNo) {
      return;
    }
    const idx = stores.findIndex((store) => store.storeNo === selectedNo);
    if (idx >= 0) {
      setStoreIndex(idx);
    }
  }, [appState?.selectedStore?.storeNo, ready]);

  useEffect(() => {
    if (!ready) {
      return;
    }
    setMenuIndex((prev) => clampIndex(prev, menuRows.length));
  }, [ready, menuRows.length]);

  useEffect(() => {
    setMenuVariantPicker((prev) => {
      if (!prev) {
        return prev;
      }
      const stillVisible = menuRows.some((row) => row.item.spuId === prev.row.item.spuId);
      return stillVisible ? prev : undefined;
    });
  }, [menuRows]);

  useEffect(() => {
    if (!ready) {
      return;
    }
    setCartIndex((prev) => clampIndex(prev, cartLines.length));
  }, [ready, cartLines.length]);

  useEffect(() => {
    setSlashHintIndex(0);
  }, [commandInput]);

  useEffect(() => {
    setConsoleScrollOffset((prev) => Math.min(prev, consoleMaxScrollOffset));
  }, [consoleMaxScrollOffset]);

  useEffect(() => {
    setHelpScrollOffset((prev) => Math.min(prev, helpMaxScrollOffset));
  }, [helpMaxScrollOffset]);

  useEffect(() => {
    const activeMenuLen = menuVariantPicker
      ? getMenuVariantStageChoices(menuVariantPicker).length
      : menuRows.length;
    const menuVariantFooterRows = menuVariantPicker
      ? buildMenuVariantFooterLines(menuVariantPicker, menuPaneTextWidth).length + 1
      : 0;
    const paneBodyLines = Math.max(1, layout.paneHeight - 2);
    const cartAvailableBody = Math.max(0, paneBodyLines - CART_FOOTER_ROWS - CART_HEADER_ROWS);
    const cartVisibleRows = Math.max(0, cartAvailableBody - CART_DETAIL_ROWS);
    mouseContextRef.current = {
      layout,
      terminalCols,
      focusPane,
      storesLen: stores.length,
      menuLen: activeMenuLen,
      menuVariantFooterRows,
      cartLen: cartLines.length,
      cartVisibleRows,
      storeIndex,
      menuIndex: menuVariantPicker ? menuVariantPicker.choiceIndex : menuIndex,
      cartIndex,
      menuVariantOpen: Boolean(menuVariantPicker)
    };
  }, [
    cartIndex,
    cartLines.length,
    focusPane,
    layout,
    menuIndex,
    menuRows.length,
    menuVariantPicker,
    cartPaneTextWidth,
    menuPaneTextWidth,
    storeIndex,
    stores.length,
    terminalCols
  ]);

  useEffect(() => {
    if (!stdin || !stdout || !ready) {
      return;
    }

    if (!mouseEnabled) {
      stdout.write(DISABLE_MOUSE);
      return;
    }

    if (isRawModeSupported) {
      setRawMode(true);
    }
    stdout.write(ENABLE_MOUSE);

    const onData = (chunk: Buffer | string): void => {
      const data = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const event of parseMouseEvents(data)) {
        handleMouseEvent(
          event,
          mouseContextRef.current,
          setFocusPane,
          setStoreIndex,
          setMenuIndex,
          setCartIndex,
          setMenuVariantPicker,
          lastMouseClickRef,
          activateMouseSelection
        );
      }
    };

    stdin.on("data", onData);
    return () => {
      stdin.off("data", onData);
      stdout.write(DISABLE_MOUSE);
    };
  }, [activateMouseSelection, isRawModeSupported, mouseEnabled, ready, setRawMode, stdin, stdout]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      enqueue(stopApp);
      return;
    }

    if (!ready) {
      return;
    }

    if (key.tab && key.shift) {
      focusCycle(-1);
      return;
    }

    if (key.tab) {
      if (slashPaletteVisible) {
        applySlashHint(selectedSlashHint);
        return;
      }
      focusCycle(1);
      return;
    }

    if (focusPane === "console" && key.ctrl && !key.meta) {
      const lowered = input.toLowerCase();
      if (lowered === "p" && commandHistory.length > 0) {
        setHistoryCursor((prev) => {
          const next = prev === null ? commandHistory.length - 1 : Math.max(0, prev - 1);
          const cmd = commandHistory[next];
          if (cmd) {
            setCommandInput(cmd);
          }
          return next;
        });
        return;
      }
      if (lowered === "n" && commandHistory.length > 0) {
        setHistoryCursor((prev) => {
          if (prev === null) {
            return null;
          }
          const next = prev + 1;
          if (next >= commandHistory.length) {
            setCommandInput("");
            return null;
          }
          const cmd = commandHistory[next];
          if (cmd) {
            setCommandInput(cmd);
          }
          return next;
        });
        return;
      }
    }

    if (focusPane === "menu" && menuVariantPicker) {
      if (key.leftArrow || input === "-") {
        setMenuVariantPicker((prev) => {
          if (!prev) {
            return prev;
          }
          return { ...prev, qty: Math.max(1, prev.qty - 1) };
        });
        return;
      }
      if (key.rightArrow || input === "+") {
        setMenuVariantPicker((prev) => {
          if (!prev) {
            return prev;
          }
          return { ...prev, qty: Math.min(99, prev.qty + 1) };
        });
        return;
      }
    }

    if (focusPane === "cart") {
      const selected = cartLines[cartIndex];
      if (selected && (key.delete || key.backspace || input.toLowerCase() === "x")) {
        executeCommand(`/rm ${cartIndex + 1}`, "panel");
        return;
      }
      if (selected && (key.leftArrow || input === "-")) {
        const nextQty = selected.qty - 1;
        if (nextQty <= 0) {
          executeCommand(`/rm ${cartIndex + 1}`, "panel");
        } else {
          executeCommand(`/qty ${cartIndex + 1} ${nextQty}`, "panel");
        }
        return;
      }
      if (selected && (key.rightArrow || input === "+")) {
        executeCommand(`/qty ${cartIndex + 1} ${Math.max(1, selected.qty + 1)}`, "panel");
        return;
      }
    }

    if (key.upArrow) {
      if (focusPane === "console") {
        if (slashPaletteVisible) {
          setSlashHintIndex((prev) => cycleIndex(prev, slashHints.length, -1));
          return;
        }
        if (showHelpPanel && commandInput.length === 0) {
          setHelpScrollOffset((prev) => Math.min(helpMaxScrollOffset, prev + 1));
          return;
        }
        setConsoleScrollOffset((prev) => Math.min(consoleMaxScrollOffset, prev + 1));
        return;
      }
      moveSelection(-1);
      return;
    }
    if (key.downArrow) {
      if (focusPane === "console") {
        if (slashPaletteVisible) {
          setSlashHintIndex((prev) => cycleIndex(prev, slashHints.length, 1));
          return;
        }
        if (showHelpPanel && commandInput.length === 0) {
          setHelpScrollOffset((prev) => Math.max(0, prev - 1));
          return;
        }
        setConsoleScrollOffset((prev) => Math.max(0, prev - 1));
        return;
      }
      moveSelection(1);
      return;
    }

    if (key.return) {
      if (focusPane === "console") {
        if (slashPaletteVisible && selectedSlashHint) {
          const normalized = normalizeSlashCommand(commandInput);
          const insertText = slashInsertText(selectedSlashHint).trim();
          const alreadyApplied =
            normalized === insertText || normalized.startsWith(`${insertText} `);
          if (!alreadyApplied) {
            applySlashHint(selectedSlashHint);
            return;
          }
        }
        executeCommand(commandInput);
        setCommandInput("");
        setHistoryCursor(null);
        setConsoleScrollOffset(0);
        return;
      }
      if (focusPane === "stores") {
        const selected = stores[storeIndex];
        if (selected?.storeNo) {
          executeCommand(`/use ${selected.storeNo}`, "panel");
        }
        return;
      }
      if (focusPane === "menu") {
        if (menuVariantPicker) {
          const transition = commitMenuVariantChoice(menuVariantPicker);
          if (transition.mode === "none") {
            return;
          }
          if (transition.mode === "advance") {
            setMenuVariantPicker(transition.picker);
            return;
          }
          executeCommand(
            buildAddCommandForVariant(
              menuVariantPicker.row.item,
              transition.option,
              menuVariantPicker.qty
            ),
            "panel"
          );
          setMenuVariantPicker(undefined);
          return;
        }
        const selected = menuRows[menuIndex];
        if (!selected) {
          return;
        }
        openMenuVariantPicker(selected);
        return;
      }
      if (focusPane === "cart") {
        const selected = cartLines[cartIndex];
        if (selected) {
          executeCommand(`/qty ${cartIndex + 1} ${Math.max(1, selected.qty + 1)}`, "panel");
        }
      }
      return;
    }

    if (key.escape) {
      if (focusPane === "menu" && menuVariantPicker) {
        setMenuVariantPicker((prev) => {
          if (!prev) {
            return prev;
          }
          if (prev.stageIndex <= 0) {
            return undefined;
          }
          return syncMenuVariantPicker({
            ...prev,
            stageIndex: prev.stageIndex - 1
          });
        });
      } else if (focusPane === "console" && commandInput.length > 0) {
        setCommandInput("");
      } else if (focusPane === "console" && showHelpPanel) {
        setShowHelpPanel(false);
        setHelpScrollOffset(0);
      } else if (focusPane === "console" && consoleScrollOffset > 0) {
        setConsoleScrollOffset(0);
      } else {
        setFocusPane("console");
      }
      return;
    }

    if (focusPane !== "console") {
      if (input === "/") {
        setFocusPane("console");
        setCommandInput("/");
        return;
      }
      return;
    }

    if (key.backspace || key.delete) {
      setCommandInput((prev) => (prev.length <= 1 ? "" : prev.slice(0, -1)));
      setHistoryCursor(null);
      return;
    }

    if (input.length > 0 && !key.ctrl && !key.meta) {
      const normalized = normalizeTextInput(input);
      const printable = [...normalized].filter((char) => isPrintable(char)).join("");
      if (printable.length === 0) {
        return;
      }
      setCommandInput((prev) => `${prev}${printable}`);
      setHistoryCursor(null);
    }
  });

  useEffect(() => {
    return () => {
      void appRef.current.shutdown();
    };
  }, []);

  const storePaneLines = buildStorePaneLines(
    stores,
    storeIndex,
    focusPane === "stores",
    storePaneTextWidth,
    Math.max(1, layout.paneHeight - 2),
    appState?.selectedStore?.storeNo
  );
  const menuPaneLines = menuVariantPicker
    ? buildMenuVariantPaneLines(
        menuVariantPicker,
        focusPane === "menu",
        menuPaneTextWidth,
        Math.max(1, layout.paneHeight - 2)
      )
    : buildMenuPaneLines(
        menuRows,
        menuIndex,
        focusPane === "menu",
        menuPaneTextWidth,
        Math.max(1, layout.paneHeight - 2)
      );
  const cartPaneLines = buildCartPaneLines(
    cartLines,
    cartIndex,
    focusPane === "cart",
    cartPaneTextWidth,
    Math.max(1, layout.paneHeight - 2),
    appState?.quote?.total
  );

  return (
    <Box flexDirection="column" width={terminalCols}>
      <Box justifyContent="space-between">
        <Text color="cyanBright" bold>
          CHAGEE CLI
        </Text>
        <Text color={busy ? "yellowBright" : "gray"}>
          {busy ? "busy" : "idle"}
        </Text>
      </Box>
      <Box justifyContent="space-between">
        <Text color="white">
          Phase:{phase} Mode:{appState?.session.mode ?? "dry-run"} Region:
          {appState?.session.region ?? "-"} Shell:{props.yolo ? "YOLO" : "SAFE"} Watch:
          {watchEnabled ? "ON" : "OFF"} Mouse:
          {mouseEnabled ? "ON" : "OFF"} Loc:
          {formatCoord(appState?.session.latitude)},{formatCoord(appState?.session.longitude)}
        </Text>
        <Text color="magentaBright">
          Store:{truncate(appState?.selectedStore?.storeName ?? "-", 30)}
        </Text>
      </Box>
      <Text color="gray">
        {mouseEnabled
          ? "Slash shell: type `/` to focus input, Enter to run, Tab to cycle panes, click to select."
          : "Slash shell: type `/` to focus input, Enter to run, Tab to cycle panes. Run `/mouse on` for click pane navigation."}
      </Text>

      <Box height={layout.paneHeight}>
        <Pane
          title="Stores"
          focused={focusPane === "stores"}
          color="cyan"
          lines={storePaneLines}
          width={paneWidths.store}
          height={layout.paneHeight}
        />
        <Pane
          title="Menu"
          focused={focusPane === "menu"}
          color="green"
          lines={menuPaneLines}
          width={paneWidths.menu}
          height={layout.paneHeight}
        />
        <Pane
          title="Cart"
          focused={focusPane === "cart"}
          color="magenta"
          lines={cartPaneLines}
          width={paneWidths.cart}
          height={layout.paneHeight}
        />
      </Box>

      <ConsolePane
        focused={focusPane === "console"}
        logLines={logLines}
        commandInput={commandInput}
        hints={slashHints}
        slashCommands={slashCommands}
        selectedHintIndex={slashHintIndex}
        showHelpPanel={showHelpPanel}
        helpScrollOffset={helpScrollOffset}
        scrollOffset={consoleScrollOffset}
        width={consoleTextWidth}
        height={layout.consoleHeight}
      />
    </Box>
  );
}

interface PaneProps {
  title: string;
  focused: boolean;
  color: "cyan" | "green" | "magenta" | "blue";
  lines: string[];
  height: number;
  width?: number;
}

function Pane(props: PaneProps): React.JSX.Element {
  const borderColor = props.focused ? props.color : "gray";
  const accentColor =
    props.color === "cyan"
      ? "cyanBright"
      : props.color === "green"
        ? "greenBright"
        : props.color === "magenta"
          ? "magentaBright"
          : "blueBright";
  const maxLines = Math.max(1, props.height - 2);
  const splitIndex = props.lines.indexOf(LINE_FOOTER_SPLIT);
  const content: string[] = [];

  if (splitIndex >= 0) {
    const rawBody = props.lines.slice(0, splitIndex);
    const rawFooter = props.lines.slice(splitIndex + 1);
    const footerCount = Math.min(maxLines, rawFooter.length);
    const bodyCount = Math.max(0, maxLines - footerCount);
    const body = rawBody.slice(0, bodyCount);
    while (body.length < bodyCount) {
      body.push("");
    }
    content.push(...body, ...rawFooter.slice(0, footerCount));
  } else {
    content.push(...props.lines.slice(0, maxLines));
    while (content.length < maxLines) {
      content.push("");
    }
  }

  return (
    <Box
      flexDirection="column"
      borderStyle={props.focused ? "double" : "round"}
      borderColor={borderColor}
      paddingX={1}
      flexGrow={props.width ? 0 : 1}
      width={props.width}
      height={props.height}
      marginRight={0}
    >
      {content.map((rawLine, idx) => {
        let line = rawLine;
        let isActive = false;
        let isSelected = false;
        while (line.startsWith(LINE_ACTIVE) || line.startsWith(LINE_SELECTED)) {
          if (line.startsWith(LINE_ACTIVE)) {
            isActive = true;
            line = line.slice(1);
            continue;
          }
          if (line.startsWith(LINE_SELECTED)) {
            isSelected = true;
            line = line.slice(1);
            continue;
          }
        }

        const isSectionTitle = line.startsWith("›");
        const trimmed = line.trim();
        const isPaneTitle = idx === 0;
        const isColumnHeader = idx === 1;
        const isDivider = idx === 2 && /^-+$/.test(trimmed);
        const color = isActive
          ? "black"
          : isPaneTitle
            ? accentColor
            : isColumnHeader
              ? "whiteBright"
              : isDivider
                ? "gray"
                : isSectionTitle || isSelected
                  ? props.color
                  : "white";
        const activeStyle = isActive ? { backgroundColor: props.color } : {};
        const renderedLine = line.length === 0 ? " " : line;

        return (
          <Text key={`${props.title}-${idx}`} color={color} bold={isPaneTitle || isColumnHeader} {...activeStyle}>
            {renderedLine}
          </Text>
        );
      })}
    </Box>
  );
}

interface ConsolePaneProps {
  focused: boolean;
  logLines: string[];
  commandInput: string;
  hints: SlashCommandHint[];
  slashCommands: SlashCommandHint[];
  selectedHintIndex: number;
  showHelpPanel: boolean;
  helpScrollOffset: number;
  scrollOffset: number;
  width: number;
  height: number;
}

function ConsolePane(props: ConsolePaneProps): React.JSX.Element {
  const maxLines = Math.max(2, props.height - 1);
  const promptLine = truncate(`${props.focused ? "›" : " "} ${props.commandInput}`, props.width);
  const showHints =
    props.focused && props.commandInput.trimStart().startsWith("/") && props.hints.length > 0;
  const showHelp = props.showHelpPanel && !showHints && props.commandInput.trim().length === 0;
  const hintRows = showHints ? Math.min(props.hints.length, Math.max(1, maxLines - 1)) : 0;
  const hintSet = showHints ? props.hints.slice(0, hintRows) : [];
  const activeHintIndex = clampIndex(props.selectedHintIndex, hintSet.length);
  const logsCapacity = showHints || showHelp ? 0 : Math.max(1, maxLines - 1);
  const maxScrollOffset = Math.max(0, props.logLines.length - logsCapacity);
  const clampedOffset = Math.min(Math.max(0, props.scrollOffset), maxScrollOffset);
  const logEnd = props.logLines.length - clampedOffset;
  const logStart = Math.max(0, logEnd - logsCapacity);
  const logWindow = logsCapacity > 0 ? props.logLines.slice(logStart, logEnd) : [];
  const logTail = logWindow.map((line) => truncate(line, props.width));
  const textRows = showHints ? [] : [...logTail, promptLine];
  while (textRows.length < maxLines) {
    textRows.unshift("");
  }
  const hintCommandWidth = Math.max(
    10,
    ...hintSet.map((hint) => `/${hint.command}`.length)
  );
  const hintDescWidth = Math.max(8, props.width - hintCommandWidth - 2);
  const fillerRows = showHints ? Math.max(0, maxLines - (1 + hintSet.length)) : 0;
  const helpCommandWidth = Math.max(
    12,
    "Command".length,
    ...props.slashCommands.map((hint) => `/${hint.command}`.length)
  );
  const helpDescWidth = Math.max(8, props.width - helpCommandWidth - 2);
  const helpCapacity = Math.max(1, maxLines - 2);
  const helpMaxOffset = Math.max(0, props.slashCommands.length - helpCapacity);
  const helpOffset = Math.min(Math.max(0, props.helpScrollOffset), helpMaxOffset);
  const visibleHelp = showHelp
    ? props.slashCommands.slice(helpOffset, helpOffset + helpCapacity)
    : [];
  const helpRowsUsed = showHelp ? Math.min(maxLines, 2 + visibleHelp.length) : 0;
  const helpFillerRows = showHelp ? Math.max(0, maxLines - helpRowsUsed) : 0;

  return (
    <Box flexDirection="column" height={props.height} paddingX={1}>
      <Text color={props.focused ? "blueBright" : "gray"}>
        {props.focused ? "shell (active)" : "shell"}
      </Text>
      {showHints ? (
        <>
          <Text color="blueBright">{promptLine}</Text>
          {hintSet.map((hint, idx) => {
            const cmd = fit(`/${hint.command}`, hintCommandWidth);
            const desc = truncate(hint.description, hintDescWidth);
            const isActive = idx === activeHintIndex;
            return (
              <Box key={`hint-${idx}`} flexDirection="row">
                <Text color={isActive ? "cyanBright" : "white"}>{cmd}</Text>
                <Text color={isActive ? "cyan" : "gray"}> {desc}</Text>
              </Box>
            );
          })}
          {Array.from({ length: fillerRows }).map((_, idx) => (
            <Text key={`hint-filler-${idx}`}> </Text>
          ))}
        </>
      ) : showHelp ? (
        <>
          <Text color="blueBright">
            {`› help (${Math.min(props.slashCommands.length, helpOffset + 1)}-${Math.min(
              props.slashCommands.length,
              helpOffset + visibleHelp.length
            )}/${props.slashCommands.length})`}
          </Text>
          <Box flexDirection="row">
            <Text color="cyanBright">{fit("Command", helpCommandWidth)}</Text>
            <Text color="cyanBright"> {truncate("What it does", helpDescWidth)}</Text>
          </Box>
          {visibleHelp.map((hint, idx) => (
            <Box key={`help-${idx}`} flexDirection="row">
              <Text color="white">{fit(`/${hint.command}`, helpCommandWidth)}</Text>
              <Text color="gray"> {truncate(hint.description, helpDescWidth)}</Text>
            </Box>
          ))}
          {Array.from({ length: helpFillerRows }).map((_, idx) => (
            <Text key={`help-filler-${idx}`}> </Text>
          ))}
        </>
      ) : (
        textRows.map((line, idx) => (
          <Text key={`console-${idx}`} color={consoleLineColor(line)}>
            {line}
          </Text>
        ))
      )}
    </Box>
  );
}

function buildStorePaneLines(
  stores: StoreState[],
  storeIndex: number,
  focused: boolean,
  width: number,
  maxLines: number,
  selectedStoreNo?: string
): string[] {
  const noWidth = Math.max(
    5,
    "ID".length,
    ...stores.map((store) => (store.storeNo ?? "").length)
  );
  const distWidth = 6;
  const cupsWidth = 4;
  const waitWidth = 4;
  const nameWidth = Math.max(8, width - (noWidth + distWidth + cupsWidth + waitWidth + 7));
  const visibleRows = Math.max(0, maxLines - 3);
  const start = windowStart(storeIndex, stores.length, visibleRows);
  const end = Math.min(stores.length, start + visibleRows);
  const divider = "-".repeat(Math.max(1, width - 2));

  const lines = [
    `${focused ? "›" : " "} STORES (${stores.length})`,
    `  ${fit("ID", noWidth)} ${fit("Dist", distWidth)} ${fit("Cups", cupsWidth)} ${fit(
      "Wait",
      waitWidth
    )} ${fit("Name", nameWidth)}`,
    `  ${divider}`
  ];
  for (let i = start; i < end; i += 1) {
    const store = stores[i];
    if (!store) {
      continue;
    }
    const isActive = focused && i === storeIndex;
    const isSelected = selectedStoreNo === store.storeNo;
    const cups = store.waitingCups !== undefined ? String(store.waitingCups) : "-";
    const wait = store.waitingTime !== undefined ? `${store.waitingTime}m` : "-";
    const dist = formatDistanceKm(store.distanceMeters);
    const name = fit(truncate(store.storeName, nameWidth), nameWidth);
    const flags = `${isActive ? LINE_ACTIVE : ""}${isSelected ? LINE_SELECTED : ""}`;
    lines.push(
      `${flags}  ${fit(store.storeNo, noWidth)} ${fit(dist, distWidth)} ${fit(cups, cupsWidth)} ${fit(
        wait,
        waitWidth
      )} ${name}`
    );
  }
  if (start > 0 && lines.length > 1) {
    const header = lines[1];
    if (header) {
      lines[1] = `↑ ${header.slice(2)}`;
    }
  }
  if (end < stores.length && lines.length > 0) {
    const last = lines[lines.length - 1];
    if (last) {
      lines[lines.length - 1] = `↓${last.slice(1)}`;
    }
  }
  return lines;
}

function buildMenuPaneLines(
  menuRows: MenuRow[],
  menuIndex: number,
  focused: boolean,
  width: number,
  maxLines: number
): string[] {
  const sectionWidth = Math.max(12, Math.min(28, Math.floor(width * 0.38)));
  const itemWidth = Math.max(8, width - sectionWidth - 3);
  const visibleRows = Math.max(0, maxLines - 3);
  const start = windowStart(menuIndex, menuRows.length, visibleRows);
  const end = Math.min(menuRows.length, start + visibleRows);
  const divider = "-".repeat(Math.max(1, width - 2));
  const uniqueSections = new Set(
    menuRows.map((row) => row.categoryName.trim().toLowerCase()).filter((name) => name.length > 0)
  ).size;
  const lines = [
    `${focused ? "›" : " "} MENU (${menuRows.length}/${uniqueSections})`,
    `  ${fit("Section", sectionWidth)} ${fit("Item", itemWidth)}`,
    `  ${divider}`
  ];
  for (let i = start; i < end; i += 1) {
    const row = menuRows[i];
    if (!row) {
      continue;
    }
    const isActive = focused && i === menuIndex;
    const categoryName = fit(row.categoryName || "-", sectionWidth);
    const itemName = fit(row.item.name, itemWidth);
    const flags = isActive ? LINE_ACTIVE : "";
    lines.push(`${flags}  ${categoryName} ${itemName}`);
  }
  if (start > 0 && lines.length > 1) {
    const header = lines[1];
    if (header) {
      lines[1] = `↑ ${header.slice(2)}`;
    }
  }
  if (end < menuRows.length && lines.length > 0) {
    const last = lines[lines.length - 1];
    if (last) {
      lines[lines.length - 1] = `↓${last.slice(1)}`;
    }
  }
  return lines;
}

function buildMenuVariantPaneLines(
  picker: MenuVariantPickerState,
  focused: boolean,
  width: number,
  maxLines: number
): string[] {
  const stageChoices = getMenuVariantStageChoices(picker);
  const footerLines = buildMenuVariantFooterLines(picker, width);
  const footerBlock = ["", ...footerLines];
  const bodyCapacity = Math.max(0, maxLines - footerBlock.length);
  const priceWidth = 7;
  const combosWidth = 6;
  const choiceWidth = Math.max(8, width - (priceWidth + combosWidth + 6));
  const visibleRows = Math.max(0, bodyCapacity - 3);
  const start = windowStart(picker.choiceIndex, stageChoices.length, visibleRows);
  const end = Math.min(stageChoices.length, start + visibleRows);
  const divider = "-".repeat(Math.max(1, width - 2));

  const bodyLines = [
    `${focused ? "›" : " "} ITEM ${truncate(picker.row.item.name, Math.max(8, width - 7))}`,
    `  ${fit("Choice", choiceWidth)} ${fit("Price", priceWidth)} ${fit("Combos", combosWidth)}`,
    `  ${divider}`
  ];

  for (let i = start; i < end; i += 1) {
    const choice = stageChoices[i];
    if (!choice) {
      continue;
    }
    const isActive = focused && i === picker.choiceIndex;
    const flags = isActive ? LINE_ACTIVE : "";
    bodyLines.push(
      `${flags}  ${fit(choice.value, choiceWidth)} ${fit(
        choice.priceText,
        priceWidth
      )} ${fit(String(choice.combos), combosWidth)}`
    );
  }
  return [...bodyLines, LINE_FOOTER_SPLIT, ...footerBlock];
}

function buildCartPaneLines(
  cart: CartLine[],
  cartIndex: number,
  focused: boolean,
  width: number,
  maxLines: number,
  quoteTotal?: string
): string[] {
  const itemWidth = Math.max(4, "Item".length, String(Math.max(1, cart.length)).length);
  const qtyWidth = Math.max(3, "Qty".length);
  const nameWidth = Math.max(8, width - (itemWidth + qtyWidth + 6));
  const detailLinesAll = buildCartDetailLinesAll(cart, cartIndex, width);
  const bodyCapacity = Math.max(0, maxLines - CART_FOOTER_ROWS);
  const availableBody = Math.max(0, bodyCapacity - CART_HEADER_ROWS);
  const visibleRows = Math.max(0, availableBody - CART_DETAIL_ROWS);
  const start = windowStart(cartIndex, cart.length, visibleRows);
  const end = Math.min(cart.length, start + visibleRows);
  const divider = "-".repeat(Math.max(1, width - 2));
  const bodyLines = [
    `${focused ? "›" : " "} CART (${cart.length})`,
    `  ${fit("Item", itemWidth)} ${fit("Qty", qtyWidth)} ${fit("Name", nameWidth)}`,
    `  ${divider}`
  ];
  for (let i = start; i < end; i += 1) {
    const line = cart[i];
    if (!line) {
      continue;
    }
    const isActive = focused && i === cartIndex;
    const name = fit(line.name ?? line.skuId, nameWidth);
    const flags = isActive ? LINE_ACTIVE : "";
    bodyLines.push(
      `${flags}  ${fit(String(i + 1), itemWidth)} ${fit(String(line.qty), qtyWidth)} ${name}`
    );
  }
  if (start > 0 && bodyLines.length > 1) {
    const header = bodyLines[1];
    if (header) {
      bodyLines[1] = `↑ ${header.slice(2)}`;
    }
  }
  if (end < cart.length && bodyLines.length > 0) {
    const last = bodyLines[bodyLines.length - 1];
    if (last) {
      bodyLines[bodyLines.length - 1] = `↓${last.slice(1)}`;
    }
  }

  const adjustHintRows = cart.length > 0 ? 1 : 0;
  const detailContentRows = Math.min(detailLinesAll.length, Math.max(0, CART_DETAIL_ROWS - adjustHintRows));
  const detailBlock: string[] = [...detailLinesAll.slice(0, detailContentRows)];
  if (cart.length > 0) {
    detailBlock.push("←→ qty  Del rm");
  }

  // Keep the options/detail area visually anchored above totals.
  const spacerRows = Math.max(0, bodyCapacity - (bodyLines.length + detailBlock.length));
  for (let i = 0; i < spacerRows; i += 1) {
    bodyLines.push("");
  }
  bodyLines.push(...detailBlock);

  const subtotal = cart.reduce((acc, line) => {
    if (line.price === undefined) {
      return acc;
    }
    return acc + line.price * line.qty;
  }, 0);

  const footerBlock = [
    `Subtotal: ${subtotal > 0 ? subtotal.toFixed(2) : "-"}`,
    `Quote total: ${quoteTotal ?? "(run /quote)"}`
  ];
  return [...bodyLines, LINE_FOOTER_SPLIT, ...footerBlock];
}

function buildCartDetailLinesAll(
  cart: CartLine[],
  cartIndex: number,
  width: number
): string[] {
  const selected = cart[cartIndex];
  const contentWidth = Math.max(8, width - 4);
  const lines: string[] = [];

  if (!selected) {
    lines.push(...wrapPaneLine("Options: -", contentWidth));
  } else {
    const rawSegments = (selected.variantText ?? "")
      .split("|")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);

    lines.push(...wrapPaneLine(`Options (Item ${cartIndex + 1}):`, contentWidth));

    if (rawSegments.length === 0) {
      if ((selected.specList?.length ?? 0) > 0 || (selected.attributeList?.length ?? 0) > 0) {
        const specCount = selected.specList?.length ?? 0;
        const attrCount = selected.attributeList?.length ?? 0;
        lines.push(...wrapPaneLine(`  - ${specCount} spec(s), ${attrCount} attr(s)`, contentWidth));
      } else {
        lines.push(...wrapPaneLine("  - none", contentWidth));
      }
    } else {
      for (const segment of rawSegments) {
        lines.push(...wrapPaneLine(`  - ${segment}`, contentWidth));
      }
    }
  }
  return lines;
}

function getSlashHints(input: string, slashCommands: SlashCommandHint[]): SlashCommandHint[] {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return [];
  }
  const query = trimmed.slice(1).trim().toLowerCase();
  if (query.length === 0) {
    return slashCommands.slice(0, 8);
  }

  const token = query.split(/\s+/)[0] ?? "";
  const prefix = slashCommands.filter((hint) => hint.command.toLowerCase().startsWith(token));
  const contains = slashCommands.filter(
    (hint) =>
      !prefix.includes(hint) &&
      (hint.command.toLowerCase().includes(token) || hint.description.toLowerCase().includes(query))
  );
  return [...prefix, ...contains].slice(0, 8);
}

function filterShellSlashCommands(yolo: boolean): SlashCommandHint[] {
  if (yolo) {
    return ALL_SLASH_COMMANDS;
  }
  return ALL_SLASH_COMMANDS.filter((hint) => !isShellOrderingHint(hint.command));
}

function isShellOrderingHint(command: string): boolean {
  const normalized = command.trim().toLowerCase();
  const [root, sub] = normalized.split(/\s+/, 2);
  if (!root) {
    return false;
  }
  if (SHELL_ORDERING_ROOTS.has(root)) {
    return true;
  }
  if (root === "order") {
    return sub === "cancel";
  }
  if (root === "pay") {
    return sub === "start" || sub === "open";
  }
  if (root === "store") {
    return sub === "use" || sub === "wait";
  }
  return false;
}

function slashInsertText(hint: SlashCommandHint): string {
  return hint.insert ?? hint.command;
}

function flattenMenuRows(categories: MenuCategory[]): MenuRow[] {
  const rows: MenuRow[] = [];
  for (const category of categories) {
    for (const item of category.items) {
      rows.push({
        categoryId: category.id,
        categoryName: category.name,
        item
      });
    }
  }
  return rows;
}

type PickerCommitResult =
  | { mode: "none" }
  | { mode: "advance"; picker: MenuVariantPickerState }
  | { mode: "add"; option: ItemSkuOption };

function createMenuVariantPickerState(
  row: MenuRow,
  options: ItemSkuOption[]
): MenuVariantPickerState {
  const parsedSegmentsByOption = options.map((option) => {
    const summary = option.specText ?? option.name ?? option.skuId;
    return {
      option,
      summary,
      segments: parseVariantSummarySegments(summary)
    };
  });

  const dimensions: MenuVariantDimension[] = [];
  const dimensionIndex = new Map<string, number>();

  for (const parsed of parsedSegmentsByOption) {
    for (const segment of parsed.segments) {
      if (dimensionIndex.has(segment.key)) {
        continue;
      }
      const idx = dimensions.length;
      dimensionIndex.set(segment.key, idx);
      dimensions.push({ key: segment.key, label: segment.label });
    }
  }

  if (dimensions.length === 0) {
    dimensions.push({ key: "variant", label: "Variant" });
    dimensionIndex.set("variant", 0);
  }

  const orderedDimensions = orderMenuVariantDimensions(dimensions);
  const parsedOptions: MenuVariantParsedOption[] = parsedSegmentsByOption.map((parsed) => {
    const valueByKey = new Map<string, string>();
    for (const segment of parsed.segments) {
      if (!valueByKey.has(segment.key)) {
        valueByKey.set(segment.key, segment.value);
      }
    }
    const valuesByDimension = orderedDimensions.map(
      (dimension) => valueByKey.get(dimension.key) ?? "-"
    );
    return {
      option: parsed.option,
      summary: parsed.summary,
      valuesByDimension
    };
  });

  const matchedIndex = options.findIndex((option) => option.skuId === row.item.skuId);
  const defaultIndex = matchedIndex >= 0 ? matchedIndex : 0;
  const defaultParsed = parsedOptions[defaultIndex] ?? parsedOptions[0];
  const selectedValues = orderedDimensions.map(
    (_, idx) => defaultParsed?.valuesByDimension[idx] ?? undefined
  );

  return syncMenuVariantPicker({
    row,
    options,
    parsedOptions,
    dimensions: orderedDimensions,
    stageIndex: 0,
    choiceIndex: 0,
    selectedValues,
    qty: 1
  });
}

function parseVariantSummarySegments(summary: string): Array<{
  key: string;
  label: string;
  value: string;
}> {
  const segments: Array<{ key: string; label: string; value: string }> = [];
  const parts = summary
    .split("|")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  let unnamedIndex = 0;
  for (const part of parts) {
    const separator = part.indexOf(":");
    if (separator > 0) {
      const label = part.slice(0, separator).trim();
      const value = part.slice(separator + 1).trim();
      const key = normalizeDimensionKey(label || `option_${segments.length + 1}`);
      segments.push({
        key,
        label: label || `Option ${segments.length + 1}`,
        value: value || "-"
      });
      continue;
    }
    unnamedIndex += 1;
    const label = unnamedIndex === 1 ? "Variant" : `Variant ${unnamedIndex}`;
    segments.push({
      key: normalizeDimensionKey(label),
      label,
      value: part
    });
  }

  if (segments.length === 0) {
    segments.push({
      key: "variant",
      label: "Variant",
      value: summary || "-"
    });
  }
  return segments;
}

function normalizeDimensionKey(raw: string): string {
  const normalized = raw.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized || "option";
}

function orderMenuVariantDimensions(dimensions: MenuVariantDimension[]): MenuVariantDimension[] {
  return dimensions
    .map((dimension, index) => ({ dimension, index }))
    .sort((left, right) => {
      const leftPriority = menuVariantDimensionPriority(left.dimension);
      const rightPriority = menuVariantDimensionPriority(right.dimension);
      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority;
      }
      return left.index - right.index;
    })
    .map((entry) => entry.dimension);
}

function menuVariantDimensionPriority(dimension: MenuVariantDimension): number {
  const normalized = `${dimension.key} ${dimension.label}`.toLowerCase();
  if (
    dimension.key === "variant" ||
    normalized.includes("size") ||
    normalized.includes("milk") ||
    normalized.includes("cup")
  ) {
    return 0;
  }
  if (normalized.includes("ice")) {
    return 1;
  }
  if (normalized.includes("sweet") || normalized.includes("sugar")) {
    return 2;
  }
  return 10;
}

function getMenuVariantStageChoices(picker: MenuVariantPickerState): MenuVariantStageChoice[] {
  if (picker.dimensions.length === 0) {
    return [];
  }
  const stageIndex = clampIndex(picker.stageIndex, picker.dimensions.length);
  const filtered = picker.parsedOptions.filter((parsed) =>
    matchesVariantSelections(parsed, picker.selectedValues, stageIndex)
  );
  const grouped = new Map<
    string,
    {
      prices: number[];
      combos: number;
      previewOption: ItemSkuOption;
    }
  >();

  for (const parsed of filtered) {
    const value = parsed.valuesByDimension[stageIndex] ?? "-";
    const existing = grouped.get(value);
    if (existing) {
      existing.combos += 1;
      if (parsed.option.price !== undefined) {
        existing.prices.push(parsed.option.price);
      }
      continue;
    }
    grouped.set(value, {
      prices: parsed.option.price !== undefined ? [parsed.option.price] : [],
      combos: 1,
      previewOption: parsed.option
    });
  }

  const choices: MenuVariantStageChoice[] = [];
  for (const [value, info] of grouped.entries()) {
    choices.push({
      value,
      combos: info.combos,
      previewOption: info.previewOption,
      priceText: renderPriceRange(info.prices)
    });
  }

  return choices;
}

function matchesVariantSelections(
  parsed: MenuVariantParsedOption,
  selectedValues: Array<string | undefined>,
  untilStageExclusive: number
): boolean {
  for (let i = 0; i < untilStageExclusive; i += 1) {
    const selected = selectedValues[i];
    if (!selected) {
      continue;
    }
    if ((parsed.valuesByDimension[i] ?? "-") !== selected) {
      return false;
    }
  }
  return true;
}

function renderPriceRange(prices: number[]): string {
  if (prices.length === 0) {
    return "-";
  }
  const finite = prices.filter((price) => Number.isFinite(price));
  if (finite.length === 0) {
    return "-";
  }
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  if (min === max) {
    return min.toFixed(2);
  }
  return `${min.toFixed(2)}-${max.toFixed(2)}`;
}

function syncMenuVariantPicker(picker: MenuVariantPickerState): MenuVariantPickerState {
  if (picker.dimensions.length === 0) {
    return picker;
  }

  const stageIndex = clampIndex(picker.stageIndex, picker.dimensions.length);
  const nextSelected = [...picker.selectedValues];
  const choices = getMenuVariantStageChoices({ ...picker, stageIndex, selectedValues: nextSelected });

  if (choices.length === 0) {
    return {
      ...picker,
      stageIndex,
      choiceIndex: 0,
      selectedValues: nextSelected
    };
  }

  const selectedValue = nextSelected[stageIndex];
  const selectedChoiceIndex =
    selectedValue !== undefined ? choices.findIndex((choice) => choice.value === selectedValue) : -1;
  const choiceIndex =
    selectedChoiceIndex >= 0
      ? selectedChoiceIndex
      : clampIndex(picker.choiceIndex, choices.length);

  if (nextSelected[stageIndex] === undefined && choices[choiceIndex]) {
    nextSelected[stageIndex] = choices[choiceIndex].value;
  }

  return {
    ...picker,
    stageIndex,
    choiceIndex,
    selectedValues: nextSelected
  };
}

function commitMenuVariantChoice(
  picker: MenuVariantPickerState,
  nextChoiceIndex?: number
): PickerCommitResult {
  const stageChoices = getMenuVariantStageChoices(picker);
  const choiceIndex = clampIndex(nextChoiceIndex ?? picker.choiceIndex, stageChoices.length);
  const chosen = stageChoices[choiceIndex];
  if (!chosen) {
    return { mode: "none" };
  }

  const selectedValues = [...picker.selectedValues];
  selectedValues[picker.stageIndex] = chosen.value;
  for (let i = picker.stageIndex + 1; i < selectedValues.length; i += 1) {
    selectedValues[i] = undefined;
  }

  if (picker.stageIndex + 1 < picker.dimensions.length) {
    return {
      mode: "advance",
      picker: syncMenuVariantPicker({
        ...picker,
        selectedValues,
        stageIndex: picker.stageIndex + 1,
        choiceIndex: 0
      })
    };
  }

  const completedPicker = syncMenuVariantPicker({
    ...picker,
    selectedValues,
    choiceIndex
  });
  const option = resolveMenuVariantOption(completedPicker);
  if (!option) {
    return {
      mode: "advance",
      picker: completedPicker
    };
  }
  return {
    mode: "add",
    option
  };
}

function resolveMenuVariantOption(picker: MenuVariantPickerState): ItemSkuOption | undefined {
  if (picker.parsedOptions.length === 0 || picker.dimensions.length === 0) {
    return undefined;
  }
  const selectedValues = picker.selectedValues;
  const fullyMatched = picker.parsedOptions.filter((parsed) =>
    parsed.valuesByDimension.every((value, idx) => {
      const selected = selectedValues[idx];
      return selected !== undefined && value === selected;
    })
  );
  if (fullyMatched.length > 0) {
    return fullyMatched[0]?.option;
  }

  const partialMatched = picker.parsedOptions.find((parsed) =>
    parsed.valuesByDimension.every((value, idx) => {
      const selected = selectedValues[idx];
      return selected === undefined || value === selected;
    })
  );
  return partialMatched?.option;
}

function buildMenuVariantFooterLines(picker: MenuVariantPickerState, width: number): string[] {
  const currentDimension = picker.dimensions[picker.stageIndex];
  const stepLabel = `Step ${picker.stageIndex + 1}/${picker.dimensions.length}: ${currentDimension?.label ?? "Option"}`;
  const actionVerb = picker.stageIndex + 1 >= picker.dimensions.length ? "add" : "next";
  const escAction = picker.stageIndex > 0 ? "back" : "close";
  const lines: string[] = [];

  const dividerPrefix = `── ${stepLabel} `;
  const fill = Math.max(0, width - dividerPrefix.length);
  lines.push(`${dividerPrefix}${"─".repeat(fill)}`);

  for (let i = 0; i < picker.dimensions.length; i += 1) {
    const dimension = picker.dimensions[i];
    if (!dimension) {
      continue;
    }
    const marker = i === picker.stageIndex ? "  ←" : "";
    lines.push(` ${dimension.label}: ${picker.selectedValues[i] ?? "?"}${marker}`);
  }

  lines.push(`↑↓ select  ↵ ${actionVerb}  Esc ${escAction}  ±qty: ${picker.qty}`);

  return lines.flatMap((line) => wrapPaneLine(line, width));
}

function wrapPaneLine(line: string, width: number): string[] {
  const safeWidth = Math.max(8, width);
  if (line.length <= safeWidth) {
    return [line];
  }
  const indent = line.match(/^\s*/)?.[0] ?? "";
  const continuationPrefix = indent.length > 0 ? indent : "  ";
  const out: string[] = [];
  let remaining = line;

  while (remaining.length > safeWidth) {
    let breakAt = remaining.lastIndexOf(" ", safeWidth);
    if (breakAt <= 0) {
      breakAt = safeWidth;
    }
    out.push(remaining.slice(0, breakAt).trimEnd());
    remaining = `${continuationPrefix}${remaining.slice(breakAt).trimStart()}`;
  }
  if (remaining.length > 0) {
    out.push(remaining);
  }
  return out.length > 0 ? out : [""];
}

function buildAddCommandForVariant(item: MenuItem, option: ItemSkuOption, qty: number): string {
  const args: string[] = [
    `/add ${option.skuId}`,
    `qty=${Math.max(1, qty)}`,
    `spuId=${item.spuId}`
  ];

  const displayName = option.name || item.name;
  if (displayName) {
    args.push(`name="${displayName.replace(/"/g, '\\"')}"`);
  }
  if (option.specText) {
    args.push(`variant="${option.specText.replace(/"/g, '\\"')}"`);
  }
  if (option.price !== undefined) {
    args.push(`price=${option.price}`);
  }
  if (option.specList && option.specList.length > 0) {
    args.push(`specList='${JSON.stringify(option.specList)}'`);
  }
  if (option.attributeList && option.attributeList.length > 0) {
    args.push(`attributeList='${JSON.stringify(option.attributeList)}'`);
  }
  return args.join(" ");
}

function buildLayoutMetrics(cols: number, rows: number): LayoutMetrics {
  const safeCols = Math.max(80, cols);
  const safeRows = Math.max(24, rows);
  const headerHeight = 3;
  const available = safeRows - headerHeight;
  const paneHeight = Math.max(8, Math.floor(available * 0.68));
  const consoleHeight = Math.max(6, available - paneHeight);

  const paneStart = headerHeight + 1;
  const paneEnd = paneStart + paneHeight - 1;
  const consoleStart = paneEnd + 1;
  const consoleEnd = consoleStart + consoleHeight - 1;

  return {
    cols: safeCols,
    rows: safeRows,
    headerHeight,
    paneHeight,
    consoleHeight,
    paneStart,
    paneEnd,
    consoleStart,
    consoleEnd
  };
}

function handleMouseEvent(
  event: ParsedMouseEvent,
  context: MouseContext,
  setFocusPane: (pane: FocusPane) => void,
  setStoreIndex: (updater: (prev: number) => number) => void,
  setMenuIndex: (updater: (prev: number) => number) => void,
  setCartIndex: (updater: (prev: number) => number) => void,
  setMenuVariantPicker: React.Dispatch<React.SetStateAction<MenuVariantPickerState | undefined>>,
  lastMouseClickRef: React.MutableRefObject<LastMouseClick | undefined>,
  onDoubleClickSelection: (selection: MouseRowSelection) => void
): void {
  const {
    layout,
    terminalCols,
    storesLen,
    menuLen,
    menuVariantFooterRows,
    cartLen,
    cartVisibleRows,
    storeIndex,
    menuIndex,
    cartIndex,
    menuVariantOpen
  } = context;
  const paneBodyLines = Math.max(1, layout.paneHeight - 2);
  const dataStartY = layout.paneStart + 4;

  if (event.type === "wheel_up" || event.type === "wheel_down") {
    // Keep wheel neutral; only clicks should affect panel/item selection.
    return;
  }
  if (event.type !== "press") {
    return;
  }

  const boundaries = computePaneBoundaries(terminalCols);

  if (event.y >= layout.paneStart && event.y <= layout.paneEnd) {
    if (event.x <= boundaries.firstEnd) {
      setFocusPane("stores");
      const visibleRows = Math.max(0, paneBodyLines - 3);
      const idx = resolveClickedIndex(
        event.y,
        dataStartY,
        storeIndex,
        storesLen,
        visibleRows
      );
      if (idx !== undefined) {
        setStoreIndex(() => idx);
        trackMouseSelectionClick(
          lastMouseClickRef,
          { pane: "stores", index: idx, menuVariantOpen: false },
          onDoubleClickSelection
        );
      }
      return;
    }
    if (event.x <= boundaries.secondEnd) {
      setFocusPane("menu");
      const variantFooterRows =
        menuVariantFooterRows > 0 ? menuVariantFooterRows : MENU_VARIANT_FOOTER_ROWS;
      const visibleRows = menuVariantOpen
        ? Math.max(0, paneBodyLines - (3 + variantFooterRows))
        : Math.max(0, paneBodyLines - 3);
      const idx = resolveClickedIndex(event.y, dataStartY, menuIndex, menuLen, visibleRows);
      if (idx !== undefined) {
        if (menuVariantOpen) {
          setMenuVariantPicker((prev) => {
            if (!prev) {
              return prev;
            }
            return syncMenuVariantPicker({ ...prev, choiceIndex: idx });
          });
        } else {
          setMenuIndex(() => idx);
        }
        trackMouseSelectionClick(
          lastMouseClickRef,
          { pane: "menu", index: idx, menuVariantOpen },
          onDoubleClickSelection
        );
      }
      return;
    }
    setFocusPane("cart");
    const idx = resolveClickedIndex(event.y, dataStartY, cartIndex, cartLen, cartVisibleRows);
    if (idx !== undefined) {
      setCartIndex(() => idx);
      trackMouseSelectionClick(
        lastMouseClickRef,
        { pane: "cart", index: idx, menuVariantOpen: false },
        onDoubleClickSelection
      );
    }
    return;
  }

  if (event.y >= layout.consoleStart && event.y <= layout.consoleEnd) {
    setFocusPane("console");
  }
}

function resolveClickedIndex(
  clickY: number,
  dataStartY: number,
  selectedIndex: number,
  totalRows: number,
  visibleRows: number
): number | undefined {
  if (totalRows <= 0 || visibleRows <= 0) {
    return undefined;
  }
  const rowOffset = clickY - dataStartY;
  if (rowOffset < 0 || rowOffset >= visibleRows) {
    return undefined;
  }
  const start = windowStart(selectedIndex, totalRows, visibleRows);
  const visibleDataRows = Math.min(visibleRows, Math.max(0, totalRows - start));
  if (rowOffset >= visibleDataRows) {
    return undefined;
  }
  return start + rowOffset;
}

function trackMouseSelectionClick(
  lastMouseClickRef: React.MutableRefObject<LastMouseClick | undefined>,
  selection: MouseRowSelection,
  onDoubleClickSelection: (selection: MouseRowSelection) => void
): void {
  const now = Date.now();
  const previous = lastMouseClickRef.current;
  const isDoubleClick =
    previous !== undefined &&
    now - previous.atMs <= DOUBLE_CLICK_MS &&
    previous.selection.pane === selection.pane &&
    previous.selection.index === selection.index &&
    previous.selection.menuVariantOpen === selection.menuVariantOpen;

  if (isDoubleClick) {
    lastMouseClickRef.current = undefined;
    onDoubleClickSelection(selection);
    return;
  }

  lastMouseClickRef.current = {
    atMs: now,
    selection
  };
}

function computePaneBoundaries(cols: number): { firstEnd: number; secondEnd: number } {
  const panes = computePaneWidths(cols);
  return {
    firstEnd: panes.store,
    secondEnd: panes.store + panes.menu
  };
}

function computePaneWidths(cols: number): { store: number; menu: number; cart: number } {
  const safe = Math.max(80, cols);
  const minStore = 22;
  const minMenu = 24;
  const minCart = 14;

  let store = Math.max(minStore, Math.floor(safe * STORE_PANE_RATIO));
  let menu = Math.max(minMenu, Math.floor(safe * MENU_PANE_RATIO));
  let cart = safe - store - menu;

  if (cart < minCart) {
    let deficit = minCart - cart;
    const reducibleStore = Math.max(0, store - minStore);
    const reduceStore = Math.min(reducibleStore, deficit);
    store -= reduceStore;
    deficit -= reduceStore;

    if (deficit > 0) {
      const reducibleMenu = Math.max(0, menu - minMenu);
      const reduceMenu = Math.min(reducibleMenu, deficit);
      menu -= reduceMenu;
      deficit -= reduceMenu;
    }

    cart = safe - store - menu;
  }

  return { store, menu, cart };
}

function windowStart(selected: number, total: number, visible: number): number {
  if (total <= 0 || visible <= 0 || total <= visible) {
    return 0;
  }
  const clampedSelected = clampIndex(selected, total);
  const centered = clampedSelected - Math.floor(visible / 2);
  return Math.max(0, Math.min(total - visible, centered));
}

function cycleIndex(index: number, len: number, delta: number): number {
  if (len <= 0) {
    return 0;
  }
  const normalized = ((index + delta) % len + len) % len;
  return normalized;
}

function parseMouseEvents(data: string): ParsedMouseEvent[] {
  const out: ParsedMouseEvent[] = [];
  const regex = /\u001b\[<(\d+);(\d+);(\d+)([mM])/g;
  for (const match of data.matchAll(regex)) {
    const code = Number(match[1]);
    const x = Number(match[2]);
    const y = Number(match[3]);
    const terminator = match[4];

    if (!Number.isFinite(code) || !Number.isFinite(x) || !Number.isFinite(y)) {
      continue;
    }

    if (code === 64) {
      out.push({ x, y, type: "wheel_up" });
      continue;
    }
    if (code === 65) {
      out.push({ x, y, type: "wheel_down" });
      continue;
    }

    out.push({
      x,
      y,
      type: terminator === "M" ? "press" : "release"
    });
  }
  return out;
}

function normalizeSlashCommand(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("/")) {
    return trimmed.slice(1).trim();
  }
  return trimmed;
}

function fit(value: string, width: number): string {
  if (value.length >= width) {
    return value.slice(0, width);
  }
  return `${value}${" ".repeat(width - value.length)}`;
}

function truncate(value: string, width: number): string {
  if (value.length <= width) {
    return value;
  }
  if (width <= 1) {
    return value.slice(0, width);
  }
  return `${value.slice(0, width - 1)}…`;
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

function formatCoord(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "-";
  }
  return value.toFixed(4);
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function consoleLineColor(line: string): string {
  const message = line.replace(/^\d{2}:\d{2}:\d{2}\s+/, "");
  if (line.startsWith("›")) {
    return "blueBright";
  }
  if (/\bcmd > \//.test(message)) {
    return "cyanBright";
  }
  if (/^API errcode=(?!0\b)/i.test(message)) {
    return "redBright";
  }
  if (/\berror:/i.test(message)) {
    return "redBright";
  }
  if (/\bwarn:/i.test(message) || /\bwarning\b/i.test(message)) {
    return "yellowBright";
  }
  if (/\bnotice\b/i.test(message)) {
    return "magentaBright";
  }
  if (/\busage:/i.test(message)) {
    return "yellow";
  }
  if (
    /\b(API errcode=0|Added item|Updated item|Removed item|Cart cleared|Quoted total|Order created|Logged in|Selected store|Mode set|Region set|Ready\.)\b/i.test(
      message
    )
  ) {
    return "greenBright";
  }
  if (/^\d{2}:\d{2}:\d{2}\s+/.test(line)) {
    return "gray";
  }
  return "whiteBright";
}

function formatArg(arg: unknown): string {
  if (typeof arg === "string") {
    return arg;
  }
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function clampIndex(index: number, len: number): number {
  if (len <= 0) {
    return 0;
  }
  if (index < 0) {
    return 0;
  }
  if (index >= len) {
    return len - 1;
  }
  return index;
}

function timeStamp(): string {
  return new Date().toISOString().slice(11, 19);
}

function isPrintable(value: string): boolean {
  return /^[\x20-\x7E]$/.test(value);
}

function normalizeTextInput(value: string): string {
  return value
    .replace(/\u001b\[200~/g, "")
    .replace(/\u001b\[201~/g, "")
    // Filter SGR mouse events so clicks/wheel never leak into the shell prompt.
    .replace(/\u001b?\[<\d+;\d+;\d+[mM]/g, "")
    .replace(/\r/g, "")
    .replace(/\n/g, "");
}

function enterInteractiveSession(stream: NodeJS.WriteStream): () => void {
  if (!stream.isTTY) {
    return () => {};
  }

  stream.write(ENTER_ALT_SCREEN);
  stream.write(HIDE_CURSOR);

  return () => {
    stream.write(DISABLE_MOUSE);
    stream.write(SHOW_CURSOR);
    stream.write(LEAVE_ALT_SCREEN);
  };
}
