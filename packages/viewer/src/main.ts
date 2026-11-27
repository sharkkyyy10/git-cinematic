import "./style.css";
import { App } from "./app.js";
import { LoadError, loadCity, resolveSource } from "./load.js";
import { Stage } from "./scene.js";
import { installTestHooks } from "./testing.js";
import { createShell, showError } from "./ui.js";

async function boot(): Promise<void> {
  const root = document.getElementById("app");
  if (!root) return;
  const shell = createShell(root);
  let stage: Stage;
  try {
    stage = new Stage(shell.canvas);
  } catch {
    showError(
      shell,
      "This browser cannot show the city",
      "Git-Cinematic needs WebGL2. Try a current version of Chrome, Edge, Firefox or Safari.",
    );
    return;
  }
  let source: ReturnType<typeof resolveSource>;
  try {
    source = resolveSource(window.location);
  } catch (e) {
    const err = e instanceof LoadError ? e : new LoadError("Could not load the city", String(e));
    showError(shell, err.title, err.detail);
    return;
  }
  // Sharing, recording, the tour and search arrive with the cinematic layer.
  for (const node of [shell.shareButton, shell.recordButton, shell.tourButton, shell.searchInput.parentElement]) {
    if (node) node.hidden = true;
  }
  const app = new App(shell, stage, source);
  const hooks = installTestHooks(app);
  shell.loading.textContent = `Loading ${source.label}…`;
  try {
    app.setCity(await loadCity(source));
    hooks.ready = true;
  } catch (e) {
    app.fail(e);
  }
}

void boot();
