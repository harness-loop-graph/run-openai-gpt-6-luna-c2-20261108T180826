import { expect, test } from "@playwright/test";

test("auth entry displays the sign-in action", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("login-submit")).toBeVisible();
});
