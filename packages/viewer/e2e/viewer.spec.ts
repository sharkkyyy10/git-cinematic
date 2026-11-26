import { expect, test } from "@playwright/test";

test("serves the viewer shell", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/^Git-Cinematic/);
});
