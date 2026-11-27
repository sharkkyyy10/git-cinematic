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
