import { ERA_KIND_NAMES } from "@git-cinematic/core/format";
import type { App } from "./app.js";
import { browserDownload, type MediaRecorderCtor, Recorder } from "./record.js";
import { searchPaths } from "./search.js";
import { Tour } from "./tour.js";
import { el, fmtDate, showToast } from "./ui.js";

const TITLE_CARD_MS = 2500;

/** Title cards, the hotspot tour, search, share and record. */
export function installCinematic(app: App): void {
  const s = app.shell;
  const tour = new Tour(app);
  let recorder: Recorder | null = null;
  let cardTimer: ReturnType<typeof setTimeout> | undefined;

  // ---- title cards ----
  app.eraListeners.push((i) => {
    const era = app.city?.eras[i];
    const tl = app.timeline;
    if (!era || !tl) return;
    const [kind, where] = [ERA_KIND_NAMES[era.kind], era.title.split(" · ")[1] ?? ""];
    const from = fmtDate(tl.dateAt(era.startBucket));
    const to = fmtDate(tl.dateAt(Math.min(era.endBucket + 1, tl.last)));
    s.titleCard.textContent = "";
    s.titleCard.append(
      el("div", { class: "kind", text: kind }),
      el("h2", { text: where }),
      el("div", { class: "range", text: `${from} – ${to}` }),
    );
    // Restart the animation.
    s.titleCard.hidden = true;
    void s.titleCard.offsetWidth;
    s.titleCard.hidden = false;
    clearTimeout(cardTimer);
    cardTimer = setTimeout(() => {
      s.titleCard.hidden = true;
    }, TITLE_CARD_MS);
  });

  // ---- tour ----
  const runTour = () => {
    if (tour.active) {
      tour.cancel();
      return;
    }
    if (!app.hotspotOrder.length) {
      showToast(s, "No hotspots to tour yet");
      return;
    }
    void tour.start();
  };
  s.tourButton.addEventListener("click", runTour);
  app.endListeners.push(() => {
    if (!recorder && !app.reducedMotion) void tour.start();
  });
  s.canvas.addEventListener("pointerdown", () => tour.cancel());
  app.flyListeners.push(() => tour.cancel());
  s.canvas.addEventListener("wheel", () => tour.cancel(), { passive: true });

  // ---- search ----
  let results: number[] = [];
  let active = 0;
  const closeResults = () => {
    s.searchResults.hidden = true;
    s.searchInput.setAttribute("aria-expanded", "false");
  };
  const renderResults = () => {
    s.searchResults.textContent = "";
    results.forEach((index, k) => {
      const li = el("li", {
        role: "option",
        id: `result-${k}`,
        "aria-selected": String(k === active),
        text: app.city?.files[index]?.path ?? "",
      });
      li.addEventListener("mousedown", (e) => {
        e.preventDefault();
        choose(index);
      });
      s.searchResults.append(li);
    });
    s.searchResults.hidden = results.length === 0;
    s.searchInput.setAttribute("aria-expanded", String(results.length > 0));
    if (results.length) s.searchInput.setAttribute("aria-activedescendant", `result-${active}`);
  };
  const choose = (index: number) => {
    closeResults();
    s.searchInput.blur();
    tour.cancel();
    app.select(index);
    void app.flyTo(index);
  };
  s.searchInput.setAttribute("role", "combobox");
  s.searchInput.setAttribute("aria-controls", "search-results");
  s.searchResults.id = "search-results";
  s.searchInput.addEventListener("input", () => {
    const paths = app.city?.files.map((f) => f.path) ?? [];
    results = searchPaths(s.searchInput.value, paths);
    active = 0;
    renderResults();
  });
  s.searchInput.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!results.length) return;
      active = (active + (e.key === "ArrowDown" ? 1 : results.length - 1)) % results.length;
      renderResults();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const index = results[active];
      if (index !== undefined) choose(index);
    } else if (e.key === "Escape") {
      s.searchInput.value = "";
      results = [];
      closeResults();
      s.searchInput.blur();
    }
  });
  s.searchInput.addEventListener("blur", () => setTimeout(closeResults, 100));

  window.addEventListener("keydown", (e) => {
    const target = e.target as HTMLElement | null;
    if (target?.closest("input, select, textarea, [contenteditable]") || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "/") {
      e.preventDefault();
      s.searchInput.focus();
      s.searchInput.select();
    } else if (e.key === "t" || e.key === "T") {
      runTour();
    } else if (e.key === "Escape") {
      tour.cancel();
    }
  });

  // ---- share ----
  s.shareButton.addEventListener("click", async () => {
    const url = window.location.href;
    const fromFile = app.source.url === "";
    try {
      await navigator.clipboard.writeText(url);
      showToast(s, fromFile ? "Link copied (cities opened from a file are not included)" : "Link copied");
    } catch {
      showToast(s, url);
    }
  });

  // ---- record ----
  const setRecording = (on: boolean) => {
    s.recordButton.textContent = on ? "Stop" : "Record";
    s.recordButton.classList.toggle("rec-stop", on);
    s.root.classList.toggle("recording", on);
  };
  const finishRecording = async () => {
    const rec = recorder;
    recorder = null;
    setRecording(false);
    if (!rec) return;
    try {
      const blob = await rec.stopAndDownload(app.city?.repoName ?? "city");
      showToast(s, `Saved ${(blob.size / 1024 / 1024).toFixed(1)} MB video`);
    } catch (e) {
      showToast(s, e instanceof Error ? e.message : "Recording failed");
    }
  };
  s.recordButton.addEventListener("click", async () => {
    if (recorder) {
      tour.cancel();
      app.timeline?.pause();
      await finishRecording();
      return;
    }
    const tl = app.timeline;
    if (!tl) return;
    try {
      recorder = new Recorder(s.canvas, {
        MediaRecorder: (window as unknown as { MediaRecorder?: MediaRecorderCtor }).MediaRecorder,
        download: browserDownload,
      });
    } catch (e) {
      showToast(s, e instanceof Error ? e.message : "Recording is not supported");
      return;
    }
    const rec = recorder;
    tour.cancel();
    app.select(-1);
    app.stage.home();
    setRecording(true);
    rec.start();
    // A full replay, then the hotspot tour, then download.
    const ended = new Promise<void>((resolve) => {
      const onEnd = () => {
        app.endListeners.splice(app.endListeners.indexOf(onEnd), 1);
        resolve();
      };
      app.endListeners.unshift(onEnd);
    });
    tl.setTime(0);
    tl.play();
    await ended;
    if (recorder !== rec) return;
    await tour.start();
    if (recorder === rec) await finishRecording();
  });

  for (const node of [s.shareButton, s.recordButton, s.tourButton, s.searchInput.parentElement]) {
    if (node) node.hidden = false;
  }
}
