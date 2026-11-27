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
