import { expect, type Page, test } from "@playwright/test";

interface Hooks {
  ready: boolean;
  freeze(): void;
  setTime(t: number): void;
  coverage(): number;
  fingerprint(): number;
  buildingPoint(): { x: number; y: number; index: number } | null;
}

declare global {
  interface Window {
    __gc: Hooks;
  }
}

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(err.message));
  return errors;
}

async function openDemo(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(() => window.__gc?.ready === true, undefined, { timeout: 30_000 });
  await page.evaluate(() => window.__gc.freeze());
}

test("serves the viewer shell", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/^Git-Cinematic/);
});

test("the demo city renders without console errors", async ({ page }) => {
  const errors = collectErrors(page);
  await openDemo(page);
  await expect(page).toHaveTitle("Git-Cinematic · acme-platform (demo)");
  await expect(page.getByTestId("repo-name")).toHaveText("acme-platform (demo)");
  const coverage = await page.evaluate(() => window.__gc.coverage());
  expect(coverage).toBeGreaterThan(0.05);
  expect(errors).toEqual([]);
});

test("scrubbing the timeline changes the rendered pixels", async ({ page }) => {
  await openDemo(page);
  const end = await page.evaluate(() => window.__gc.fingerprint());
  const scrubber = page.getByTestId("scrubber");
  await scrubber.fill("10");
  const early = await page.evaluate(() => window.__gc.fingerprint());
  expect(early).not.toBe(end);
  await expect(page.getByTestId("date")).not.toHaveText("");
  // Same time, same frame: the change comes from the timeline, not from animation.
  await scrubber.fill("10");
  expect(await page.evaluate(() => window.__gc.fingerprint())).toBe(early);
});

test("clicking a building opens the panel with its path", async ({ page }) => {
  await openDemo(page);
  const point = await page.evaluate(() => window.__gc.buildingPoint());
  expect(point).not.toBeNull();
  if (!point) return;
  await page.mouse.click(point.x, point.y);
  const panel = page.getByTestId("panel");
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("panel-path")).toHaveText(/\S+\/\S+/);
  await expect(panel).toContainText("Churn");
  await expect(panel).toContainText("Hotspot rank");
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
});

test("an unknown /gh/ repository shows the friendly error panel", async ({ page }) => {
  await page.route("https://raw.githubusercontent.com/**", (route) =>
    route.fulfill({ status: 404, contentType: "text/plain", body: "404: Not Found" }),
  );
  await page.goto("/gh/does-not/exist");
  const panel = page.getByTestId("error-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("No city found for does-not/exist");
  await expect(panel).toContainText("git-cinematic analyze");
  await expect(panel.getByRole("link", { name: "quickstart" })).toHaveAttribute("href", /#quickstart$/);
  await expect(page.locator("canvas#scene")).toBeVisible();
  await expect(page).toHaveTitle(/^Git-Cinematic/);
});

test("a corrupted city file shows the error panel", async ({ page }) => {
  const garbage = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  await page.route(
    (url) => url.pathname === "/broken.bin",
    (route) => route.fulfill({ status: 200, contentType: "application/octet-stream", body: garbage }),
  );
  await page.goto("/?src=/broken.bin");
  const panel = page.getByTestId("error-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("damaged");
});

test("opening a corrupted file over a loaded city shows the error panel and can go back", async ({ page }) => {
  await openDemo(page);
  await page.locator('input[type="file"]').setInputFiles({
    name: "city.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("definitely not a city"),
  });
  const panel = page.getByTestId("error-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("not a city file");
  await panel.getByRole("button", { name: "Back to the city" }).click();
  await expect(panel).toBeHidden();
});

test("search flies to a file and opens its panel", async ({ page }) => {
  await openDemo(page);
  await page.keyboard.press("/");
  await expect(page.getByRole("combobox", { name: "Search files" })).toBeFocused();
  await page.keyboard.type("billing");
  await expect(page.locator(".search-results li").first()).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("panel-path")).toContainText("billing");
});

test("playback shows era title cards and Space toggles play", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => window.__gc?.ready === true);
  await page.locator("canvas#scene").focus();
  await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
  await expect(page.locator(".title-card")).toBeVisible();
  await expect(page.locator(".title-card h2")).not.toHaveText("");
  await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: "Play" })).toBeVisible();
});

test("the guide explains every colour and highlights the matching buildings", async ({ page }) => {
  const errors = collectErrors(page);
  await openDemo(page);
  const before = await page.evaluate(() => window.__gc.fingerprint());
  await page.keyboard.press("?");
  const drawer = page.getByTestId("drawer");
  await expect(drawer).toBeVisible();
  for (const text of ["Fire", "Lit windows", "Blue rim", "Ambience", "Timeline chapters", "Fix wave"]) {
    await expect(drawer).toContainText(text);
  }
  const show = drawer.locator(".guide-item .chip:not([disabled])", { hasText: /^Show \d/ }).first();
  await show.click();
  await expect(page.locator(".legend")).toContainText("Clear");
  expect(await page.evaluate(() => window.__gc.fingerprint())).not.toBe(before);
  await page.keyboard.press("Escape");
  await expect(page.locator(".legend")).not.toContainText("Clear");
  expect(await page.evaluate(() => window.__gc.fingerprint())).toBe(before);
  expect(errors).toEqual([]);
});

test("lenses recolour the city and the cinematic view comes back unchanged", async ({ page }) => {
  await openDemo(page);
  const cinematic = await page.evaluate(() => window.__gc.fingerprint());
  const seen = new Set([cinematic]);
  for (const key of ["2", "3", "5", "6"]) {
    await page.keyboard.press(key);
    seen.add(await page.evaluate(() => window.__gc.fingerprint()));
  }
  expect(seen.size).toBe(5);
  await expect(page.locator(".lensbar [aria-pressed=true]")).toHaveText("Age");
  await expect(page.locator(".legend")).toContainText("untouched for longest");
  await page.locator(".lensbar button", { hasText: "Cinematic" }).click();
  expect(await page.evaluate(() => window.__gc.fingerprint())).toBe(cinematic);
});

test("insights show a health score and findings that fly to their files", async ({ page }) => {
  await openDemo(page);
  await expect(page.getByTestId("health-pill")).toContainText(/Health \d+/);
  await page.getByTestId("health-pill").click();
  await expect(page.getByTestId("health-score")).toHaveText(/^\d{1,3}$/);
  const findings = page.locator("[data-finding]");
  expect(await findings.count()).toBeGreaterThanOrEqual(3);
  const link = findings.first().locator(".file-link").first();
  const path = await link.getAttribute("title");
  await link.click();
  await expect(page.getByTestId("panel-path")).toHaveText(path ?? "");
  await expect(page.getByTestId("panel")).toContainText("Flags");
  await expect(page.getByTestId("panel")).not.toContainText(/Flags\s*none/);
});

test("the report downloads as Markdown", async ({ page }) => {
  await openDemo(page);
  await page.keyboard.press("i");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download report (.md)" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("acme-platform-demo-report.md");
  const path = await download.path();
  const { readFileSync } = await import("node:fs");
  const text = readFileSync(path, "utf8");
  expect(text).toMatch(/^# acme-platform \(demo\): codebase report/);
  expect(text).toMatch(/## Health: \d+\/100 \(grade [A-E]\)/);
  expect(text).toContain("## Findings");
});
