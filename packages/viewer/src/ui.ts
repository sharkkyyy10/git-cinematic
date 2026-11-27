// Plain DOM over the canvas. Strings from city files are only ever set with textContent.

type Attrs = Record<string, string>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

export interface Shell {
  root: HTMLElement;
  canvas: HTMLCanvasElement;
  repo: HTMLElement;
  openButton: HTMLButtonElement;
  fileInput: HTMLInputElement;
  shareButton: HTMLButtonElement;
  recordButton: HTMLButtonElement;
  searchInput: HTMLInputElement;
  searchResults: HTMLUListElement;
  tooltip: HTMLElement;
  panel: HTMLElement;
  panelTitle: HTMLElement;
  panelStats: HTMLElement;
  panelClose: HTMLButtonElement;
  flyButton: HTMLButtonElement;
  timeline: HTMLElement;
  playButton: HTMLButtonElement;
  scrubber: HTMLInputElement;
  markers: HTMLElement;
  date: HTMLElement;
  speed: HTMLSelectElement;
  tourButton: HTMLButtonElement;
  titleCard: HTMLElement;
  loading: HTMLElement;
  error: HTMLElement;
  toast: HTMLElement;
  legend: HTMLElement;
}

export function createShell(root: HTMLElement): Shell {
  root.textContent = "";
  const canvas = el("canvas", { id: "scene", "aria-label": "3D city of the repository history", role: "img" });

  const repo = el("span", { class: "repo", "data-testid": "repo-name" });
  const fileInput = el("input", { type: "file", accept: ".bin,application/octet-stream", hidden: "" });
  const openButton = el("button", { type: "button", text: "Open" });
  const shareButton = el("button", { type: "button", text: "Share" });
  const recordButton = el("button", { type: "button", text: "Record" });
  const searchInput = el("input", {
    type: "search",
    placeholder: "Search files  /",
    "aria-label": "Search files",
    autocomplete: "off",
    spellcheck: "false",
  });
  const searchResults = el("ul", { class: "search-results", role: "listbox", hidden: "" });
  const header = el("header", { class: "topbar" }, [
    el("div", { class: "brand" }, [el("span", { class: "wordmark", text: "Git-Cinematic" }), repo]),
    el("div", { class: "search" }, [searchInput, searchResults]),
    el("nav", { class: "actions", "aria-label": "City actions" }, [openButton, shareButton, recordButton, fileInput]),
  ]);

  const tooltip = el("div", { class: "tooltip", role: "tooltip", hidden: "" });

  const panelTitle = el("h2", { class: "panel-title", "data-testid": "panel-path" });
  const panelStats = el("dl", { class: "stats" });
  const panelClose = el("button", { type: "button", class: "close", "aria-label": "Close details", text: "×" });
  const flyButton = el("button", { type: "button", class: "primary", text: "Fly to" });
  const panel = el("aside", { class: "panel", "aria-label": "File details", "data-testid": "panel", hidden: "" }, [
    el("div", { class: "panel-head" }, [panelTitle, panelClose]),
    panelStats,
    flyButton,
  ]);

  const playButton = el("button", { type: "button", class: "play", "aria-label": "Play", text: "▶" });
  const scrubber = el("input", {
    type: "range",
    min: "0",
    max: "0",
    step: "any",
    value: "0",
    "aria-label": "Timeline",
    "data-testid": "scrubber",
  });
  const markers = el("div", { class: "markers", "aria-hidden": "true" });
  const date = el("span", { class: "date", "data-testid": "date" });
  const speed = el("select", { "aria-label": "Playback speed" }, [
    el("option", { value: "0.5", text: "0.5×" }),
    el("option", { value: "1", text: "1×" }),
    el("option", { value: "2", text: "2×" }),
    el("option", { value: "4", text: "4×" }),
  ]);
  speed.value = "1";
  const tourButton = el("button", { type: "button", text: "Tour", title: "Tour the top hotspots (T)" });
  const timeline = el("footer", { class: "timeline" }, [
    playButton,
    el("div", { class: "track" }, [markers, scrubber]),
    date,
    speed,
    tourButton,
  ]);

  const legend = el("div", { class: "legend", "aria-hidden": "true" }, [
    el("span", { class: "swatch fire" }),
    el("span", { text: "fix heat" }),
    el("span", { class: "swatch window" }),
    el("span", { text: "coupling" }),
    el("span", { class: "swatch rim" }),
    el("span", { text: "calm core" }),
  ]);

  const titleCard = el("div", { class: "title-card", "aria-live": "polite", hidden: "" });
  const loading = el("div", { class: "loading", role: "status", text: "Loading city…" });
  const error = el("div", { class: "error", role: "alert", "data-testid": "error-panel", hidden: "" });
  const toast = el("div", { class: "toast", role: "status", hidden: "" });

  root.append(canvas, header, tooltip, panel, legend, titleCard, timeline, loading, error, toast);
  return {
    root,
    canvas,
    repo,
    openButton,
    fileInput,
    shareButton,
    recordButton,
    searchInput,
    searchResults,
    tooltip,
    panel,
    panelTitle,
    panelStats,
    panelClose,
    flyButton,
    timeline,
    playButton,
    scrubber,
    markers,
    date,
    speed,
    tourButton,
    titleCard,
    loading,
    error,
    toast,
    legend,
  };
}

export function showError(shell: Shell, title: string, detail: string): void {
  shell.loading.hidden = true;
  shell.error.textContent = "";
  shell.error.append(
    el("h2", { text: title }),
    el("p", { text: detail }),
    el("p", { class: "hint" }, [
      "Make a city for any repository with ",
      el("code", { text: "npx git-cinematic analyze" }),
      ", then open the ",
      el("code", { text: ".cinematic/city.bin" }),
      " it writes, or commit it and visit ",
      el("code", { text: "/gh/<owner>/<repo>" }),
      ".",
    ]),
    el("p", {}, [el("a", { href: "/", text: "See the demo city" })]),
  );
  shell.error.hidden = false;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function showToast(shell: Shell, text: string): void {
  shell.toast.textContent = text;
  shell.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    shell.toast.hidden = true;
  }, 2600);
}

export function setStats(shell: Shell, rows: [string, string][]): void {
  shell.panelStats.textContent = "";
  for (const [k, v] of rows) shell.panelStats.append(el("dt", { text: k }), el("dd", { text: v }));
}

export const fmtInt = (n: number) => Math.round(n).toLocaleString("en-US");
export const fmtDate = (unix: number) =>
  new Date(unix * 1000).toLocaleDateString("en-GB", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
