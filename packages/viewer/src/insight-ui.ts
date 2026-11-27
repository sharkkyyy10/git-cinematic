import { ERA_KIND_NAMES } from "@git-cinematic/core/format";
import { type Finding, health, LENSES, type LensId, renderReport } from "@git-cinematic/core/insights";
import type { App } from "./app.js";
import { ERA_COLORS } from "./timeline.js";
import { el, fmtInt, showToast } from "./ui.js";

type View = "cinematic" | LensId;

interface Highlight {
  label: string;
  values: Float32Array;
}

const SEVERITY_LABEL = { high: "High", medium: "Medium", low: "Note" } as const;

/** Lenses, the guide, insights with a health score, and the downloadable report. */
export function installInsights(app: App): void {
  const s = app.shell;
  let view: View = "cinematic";
  let highlight: Highlight | null = null;
  const legendDefault = [...s.legend.childNodes];

  // ---- top bar: health pill and the guide button ----
  const healthPill = el("button", {
    type: "button",
    class: "health-pill",
    "data-testid": "health-pill",
    title: "Codebase health and findings (I)",
    hidden: "",
  });
  const guideButton = el("button", { type: "button", text: "Guide", title: "What every colour means (?)" });
  s.openButton.before(healthPill, guideButton);

  // ---- lens bar ----
  const lensButtons = new Map<View, HTMLButtonElement>();
  const lensbar = el("div", { class: "lensbar", role: "toolbar", "aria-label": "Lenses" });
  (["cinematic", ...LENSES.map((l) => l.id)] as View[]).forEach((id, k) => {
    const info = LENSES.find((l) => l.id === id);
    const b = el("button", {
      type: "button",
      text: info ? info.label : "Cinematic",
      title: `${info ? info.question : "The film: fire, windows and calm cores"} (${k + 1})`,
      "aria-pressed": "false",
      "data-lens": id,
    });
    b.addEventListener("click", () => setView(id));
    lensButtons.set(id, b);
    lensbar.append(b);
  });
  s.root.append(lensbar);

  // ---- drawer with Insights and Guide tabs ----
  const tabInsights = el("button", { type: "button", role: "tab", text: "Insights", "aria-selected": "true" });
  const tabGuide = el("button", { type: "button", role: "tab", text: "Guide", "aria-selected": "false" });
  const close = el("button", { type: "button", class: "close", "aria-label": "Close", text: "×" });
  const body = el("div", { class: "drawer-body" });
  const drawer = el(
    "aside",
    { class: "drawer", "aria-label": "Insights and guide", "data-testid": "drawer", hidden: "" },
    [
      el("div", { class: "drawer-head" }, [
        el("div", { class: "tabs", role: "tablist" }, [tabInsights, tabGuide]),
        close,
      ]),
      body,
    ],
  );
  s.root.append(drawer);
  let tab: "insights" | "guide" = "insights";

  const openDrawer = (t: typeof tab) => {
    tab = t;
    tabInsights.setAttribute("aria-selected", String(t === "insights"));
    tabGuide.setAttribute("aria-selected", String(t === "guide"));
    body.textContent = "";
    body.append(t === "insights" ? renderInsights() : renderGuide());
    body.scrollTop = 0;
    drawer.hidden = false;
  };
  const toggleDrawer = (t: typeof tab) => {
    if (!drawer.hidden && tab === t) drawer.hidden = true;
    else openDrawer(t);
  };
  healthPill.addEventListener("click", () => toggleDrawer("insights"));
  guideButton.addEventListener("click", () => toggleDrawer("guide"));
  tabInsights.addEventListener("click", () => openDrawer("insights"));
  tabGuide.addEventListener("click", () => openDrawer("guide"));
  close.addEventListener("click", () => {
    drawer.hidden = true;
  });

  window.addEventListener("keydown", (e) => {
    const target = e.target as HTMLElement | null;
    if (target?.closest("input, select, textarea, [contenteditable]") || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "Escape") {
      if (highlight) setView(view);
      else if (!drawer.hidden) drawer.hidden = true;
      return;
    }
    if (!app.city) return;
    if (e.key === "?") toggleDrawer("guide");
    else if (e.key === "i" || e.key === "I") toggleDrawer("insights");
    else if (/^[1-6]$/.test(e.key)) {
      const ids = ["cinematic", ...LENSES.map((l) => l.id)] as View[];
      setView(ids[Number(e.key) - 1] as View);
    } else return;
    e.preventDefault();
  });

  app.onCity((a) => {
    const city = a.city;
    if (!city) return;
    const h = health(city, a.signals ?? undefined);
    healthPill.textContent = "";
    healthPill.append(
      el("span", { class: `grade grade-${h.grade}`, text: h.grade }),
      el("span", { text: `Health ${h.score}` }),
    );
    healthPill.hidden = false;
    highlight = null;
    setView("cinematic");
    if (!drawer.hidden) openDrawer(tab);
  });

  // ---- lenses and highlights ----
  function setView(id: View): void {
    view = id;
    highlight = null;
    for (const [k, b] of lensButtons) b.setAttribute("aria-pressed", String(k === id));
    const sig = app.signals;
    if (id === "cinematic" || !sig) app.view?.setLens(null);
    else app.view?.setLens(sig[id], "ramp");
    renderLegend();
  }

  function showHighlight(label: string, files: readonly number[]): void {
    const n = app.city?.files.length ?? 0;
    const values = new Float32Array(n);
    for (const i of files) values[i] = 1;
    highlight = { label, values };
    app.view?.setLens(values, "mask");
    renderLegend();
  }

  function renderLegend(): void {
    const lg = s.legend;
    lg.textContent = "";
    lg.classList.toggle("lens-legend", view !== "cinematic" || highlight !== null);
    if (highlight) {
      const clear = el("button", { type: "button", class: "chip", text: "Clear  Esc" });
      clear.addEventListener("click", () => setView(view));
      lg.append(el("span", { class: "swatch highlight" }), el("span", { text: highlight.label }), clear);
      return;
    }
    const info = LENSES.find((l) => l.id === view);
    if (!info) {
      lg.append(...legendDefault);
      return;
    }
    lg.append(
      el("strong", { text: info.label }),
      el("span", { class: "lens-q", text: info.question }),
      el("span", { class: "ramp-label", text: info.low }),
      el("span", { class: "ramp" }),
      el("span", { class: "ramp-label", text: info.high }),
    );
  }

  // ---- insights tab ----
  function renderInsights(): HTMLElement {
    const city = app.city;
    const root = el("div", { class: "insights" });
    if (!city) return root;
    const h = health(city, app.signals ?? undefined);
    const parts = el("div", { class: "parts" });
    for (const p of h.parts) {
      const bar = el("div", { class: "bar" }, [el("span")]);
      (bar.firstChild as HTMLElement).style.width = `${Math.round(p.score * 100)}%`;
      parts.append(
        el("div", { class: "part" }, [
          el("div", { class: "part-head" }, [
            el("span", { text: p.label }),
            el("span", { class: "num", text: String(Math.round(p.score * 100)) }),
          ]),
          bar,
          el("div", { class: "muted", text: p.detail }),
        ]),
      );
    }
    root.append(
      el("section", { class: "score-card" }, [
        el("div", { class: "score-main" }, [
          el("div", { class: `grade big grade-${h.grade}`, text: h.grade }),
          el("div", {}, [
            el("div", { class: "score", "data-testid": "health-score", text: `${h.score}` }),
            el("div", { class: "muted", text: "health out of 100" }),
          ]),
        ]),
        parts,
        el("p", {
          class: "muted small",
          text: "A heuristic. Compare this repository with itself over time, not with other teams.",
        }),
      ]),
    );

    const list = el("section", { class: "findings" }, [el("h3", { text: "Findings" })]);
    if (app.found.length === 0) list.append(el("p", { class: "muted", text: "Nothing stands out yet." }));
    for (const f of app.found) list.append(findingCard(f));
    root.append(list);

    const report = el("button", { type: "button", class: "primary wide", text: "Download report (.md)" });
    report.addEventListener("click", downloadReport);
    root.append(
      el("section", { class: "report" }, [
        report,
        el("p", {
          class: "muted small",
          text: "A Markdown summary for your team or your client. From a terminal: git-cinematic report",
        }),
      ]),
    );
    return root;
  }

  function findingCard(f: Finding): HTMLElement {
    const files = el("ul", { class: "finding-files" });
    for (const i of f.files) {
      const file = app.city?.files[i];
      if (!file) continue;
      const b = el("button", { type: "button", class: "file-link", title: file.path }, [
        el("span", { class: "path", text: file.path }),
        el("span", {
          class: "meta",
          text: `${fmtInt(file.loc)} lines · ${fmtInt(file.churn)} commits · ${fmtInt(file.fixes)} fixes`,
        }),
      ]);
      b.addEventListener("click", () => {
        app.select(i);
        void app.flyTo(i);
      });
      files.append(el("li", {}, [b]));
    }
    const actions = el("div", { class: "finding-actions" });
    if (f.matches.length) {
      const show = el("button", { type: "button", text: `Show all ${fmtInt(f.matches.length)} on the map` });
      show.addEventListener("click", () => showHighlight(f.title, f.matches));
      actions.append(show);
    }
    if (f.lens) {
      const lens = LENSES.find((l) => l.id === f.lens);
      const b = el("button", { type: "button", text: `${lens?.label ?? ""} lens` });
      b.addEventListener("click", () => setView(f.lens as LensId));
      actions.append(b);
    }
    return el("article", { class: `finding sev-${f.severity}`, "data-finding": f.id }, [
      el("div", { class: "finding-head" }, [
        el("span", { class: "sev", text: SEVERITY_LABEL[f.severity] }),
        el("h4", { text: f.title }),
      ]),
      el("p", { text: f.why }),
      el("p", { class: "action" }, [el("strong", { text: "Do: " }), f.action]),
      files,
      actions,
    ]);
  }

  function downloadReport(): void {
    const city = app.city;
    if (!city) return;
    const text = renderReport(city);
    const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
    const a = el("a", { href: URL.createObjectURL(blob), download: `${slug(city.repoName)}-report.md` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    showToast(s, "Report downloaded");
  }

  // ---- guide tab ----
  function liveSet(test: (i: number) => boolean): number[] {
    const v = app.view;
    if (!v) return [];
    const out: number[] = [];
    for (let i = 0; i < v.city.files.length; i++) if (v.locAt(i) >= 0.5 && test(i)) out.push(i);
    return out;
  }

  function renderGuide(): HTMLElement {
    const root = el("div", { class: "guide" });
    const v = app.view;
    const files = app.city?.files ?? [];
    const row = (swatch: string, title: string, text: string, set?: () => number[], label?: string) => {
      const item = el("div", { class: "guide-item" }, [
        el("span", { class: `swatch ${swatch}` }),
        el("div", {}, [el("strong", { text: title }), el("p", { text })]),
      ]);
      if (set && v) {
        const matches = set();
        const b = el("button", { type: "button", class: "chip", text: `Show ${fmtInt(matches.length)}` });
        b.disabled = matches.length === 0;
        b.addEventListener("click", () => showHighlight(label ?? title, matches));
        item.append(b);
      }
      return item;
    };

    root.append(
      el("p", {
        class: "muted",
        text: "Every building is a file and every plate is a folder. Counts below are for the moment shown on the timeline.",
      }),
      el("h3", { text: "Shape" }),
      row(
        "shape-h",
        "Height",
        "Lines in the file at that moment, on a log scale. Watch it grow and shrink as you replay.",
      ),
      row("shape-w", "Footprint", "The largest the file ever grew, so buildings never move during the replay."),
      row("shape-d", "Plates and streets", "Folders, nested by depth. Boulevards separate top-level folders."),
      el("h3", { text: "Colour and light" }),
      row(
        "fire",
        "Fire",
        "Recent bug fixes. Purple is a warning, orange is hot, yellow is burning; it flickers above 60%. It cools down when the fixes stop.",
        () => liveSet((i) => (v?.heatAt(i) ?? 0) >= 0.15),
        "Files with fix heat right now",
      ),
      row(
        "embers",
        "Embers",
        "Rise from the hottest files: several fixes in a short time.",
        () => liveSet((i) => (v?.heatAt(i) ?? 0) >= 0.5),
        "Files throwing embers",
      ),
      row(
        "window",
        "Lit windows",
        "Coupling. The more often a file changes together with others, the more windows are lit and the brighter they are.",
        () => liveSet((i) => (files[i]?.centrality ?? 0) >= 0.5),
        "Strongly coupled files",
      ),
      row(
        "rim",
        "Blue rim",
        "A calm core: central to the codebase but not on fire. Usually the stable foundations.",
        () => liveSet((i) => (files[i]?.centrality ?? 0) > 0.7 && (v?.heatAt(i) ?? 0) < 0.1),
        "Calm cores",
      ),
      row("beacon", "Red beacons", "Blink on top of the tallest files at this moment in history."),
      row("selected", "Blue glow", "The file you hovered or selected. Click a building for its numbers and flags."),
      row(
        "ambience",
        "Ambience",
        "Traffic, street lamps, neon, the outskirts and the sky make it a city. They carry no data.",
      ),
      el("h3", { text: "Lenses" }),
      el("p", {
        class: "muted",
        text: "Press 1–6 or use the bar on the left. A lens recolours every building to answer one question, from slate (low) through teal and amber to red (high). Grey buildings score zero.",
      }),
    );
    for (const l of LENSES) {
      const item = row("ramp-swatch", `${l.label}: ${l.question}`, l.explain);
      const b = el("button", { type: "button", class: "chip", text: "Try it" });
      b.addEventListener("click", () => setView(l.id));
      item.append(b);
      root.append(item);
    }
    root.append(el("h3", { text: "Timeline chapters" }));
    const eraText = [
      "Normal, steady work.",
      "A burst of new code: the codebase grows fast.",
      "Many bug fixes in a short time. Look at what changed just before.",
      "More lines deleted than added: refactors and removals.",
    ];
    ERA_KIND_NAMES.forEach((name, k) => {
      const item = row("era", name, eraText[k] ?? "");
      (item.firstChild as HTMLElement).style.background = ERA_COLORS[k] ?? "#888";
      root.append(item);
    });
    root.append(
      el("h3", { text: "Controls" }),
      el("dl", { class: "controls" }, [
        ...[
          ["Space", "play or pause the replay"],
          ["← →", "step through time"],
          ["W A S D", "fly; Q E to turn, Shift to go faster"],
          ["/", "search for a file"],
          ["T", "tour the top hotspots"],
          ["1–6", "switch lens"],
          ["I  ?", "insights, this guide"],
          ["Esc", "clear a highlight, close panels"],
        ].flatMap(([k, d]) => [el("dt", {}, [el("kbd", { text: k as string })]), el("dd", { text: d as string })]),
      ]),
    );
    return root;
  }
}

export function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "city"
  );
}
