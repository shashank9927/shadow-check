import { expect, test } from "@playwright/test";

test.skip(!process.env.E2E_BASE_URL, "Set E2E_BASE_URL after starting the demo stack to run dashboard checks.");
test("opens the seeded project and starts a replay", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Demo Commerce API")).toBeVisible();
  await page.getByText("Demo Commerce API").click();
  await expect(page.getByRole("heading", { name: "Demo Commerce API" })).toBeVisible();
  await page.getByRole("button", { name: "Run replay" }).click();
  await expect(page.getByText(/QUEUED|RUNNING|COMPLETED/).first()).toBeVisible();
});
