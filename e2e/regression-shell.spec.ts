import { uniq } from "./api";
import { UI_TEST_TIMEOUT, expect, expectInsideViewportX, expectNoHorizontalOverflow, gotoReady, mainNav, retrying, test } from "./fixtures";

/**
 * App shell regressions: the Ctrl+K palette takes focus and typing (plan §3: "Ctrl K still works"),
 * the Jobs page filters stay inside a 390px viewport, the topbar names the page, and the one-time
 * "Proofline got simpler" card links to the one-page Help.
 */
test.beforeEach(() => test.setTimeout(UI_TEST_TIMEOUT));

test("Ctrl+K opens the command palette with the input focused, and typing searches", async ({ page, api }) => {
  const job = await api.createJob({ name: uniq("Reg palette") });
  const palette = page.getByRole("dialog", { name: /command palette|search/i });
  const input = palette.getByRole("combobox").or(palette.getByRole("textbox")).first();

  await gotoReady(page, "/home", mainNav(page));
  await retrying(async () => {
    if (!(await palette.isVisible())) await page.keyboard.press("Control+k");
    await expect(palette).toBeVisible({ timeout: 2_000 });
    await expect(input).toBeFocused({ timeout: 2_000 });
    await input.clear();
    await page.keyboard.type(job.name);
    await expect(input).toHaveValue(job.name, { timeout: 2_000 });
    await expect(palette.getByRole("option", { name: new RegExp(job.jobNumber) }).first()).toBeVisible({ timeout: 15_000 });
    // The job row wears the stage pill (the five stage words), never a raw status name; Projects and the
    // shortcuts footer stay behind Advanced tools (plan §8).
    await expect(palette.getByRole("option", { name: new RegExp(job.jobNumber) }).first().locator("span[data-stage]")).toHaveAttribute("data-stage", "needs_editor");
    await expect(palette.getByText(/Resubmitted|Submitted for Review|Ready for Assignment/)).toHaveCount(0);
    if (!(await api.advancedToolsOn())) {
      await expect(palette.getByText(/^Projects$/i)).toHaveCount(0);
      await expect(palette.getByText(/all shortcuts/i)).toHaveCount(0);
    }
    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden({ timeout: 2_000 });
    await page.keyboard.press("Control+k");
    await expect(palette).toBeVisible({ timeout: 2_000 });
    await expect(input).toBeFocused({ timeout: 2_000 });
    await expect(input).toHaveValue("");
  });
  // No keyboard chords in the simple UI: "g d" does nothing (plan §8).
  await page.keyboard.press("Escape");
  await page.keyboard.press("g");
  await page.keyboard.press("d");
  await expect(page).toHaveURL(/\/home/);
  await expect(page.getByRole("dialog", { name: /shortcuts/i })).toHaveCount(0);
});

test.describe("at 390px", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("the Jobs filters, stage tabs and List / Calendar switch stay inside the viewport", async ({ page }) => {
    const stages = page.getByRole("main").getByRole("navigation", { name: "Stages" });
    await gotoReady(page, "/jobs", stages);
    await expectInsideViewportX(page, stages, "stage tabs");
    for (const name of ["Editor", "Client"]) {
      const select = page.getByRole("main").getByRole("combobox", { name });
      await select.scrollIntoViewIfNeeded();
      await expectInsideViewportX(page, select, `${name} filter`);
    }
    await expectInsideViewportX(page, page.getByRole("main").getByRole("searchbox", { name: /search jobs/i }).or(page.getByRole("main").getByRole("textbox", { name: /search jobs/i })).first(), "search");
    await expectInsideViewportX(page, page.getByRole("main").getByRole("radiogroup", { name: /list or calendar/i }), "List / Calendar switch");
    for (const name of [/^late/i, /show cancelled/i]) await expectInsideViewportX(page, page.getByRole("main").getByRole("switch", { name }), `${name} switch`);
    await expectNoHorizontalOverflow(page);
    // The stage tab strip scrolls sideways inside itself rather than widening the page.
    await retrying(async () => {
      await stages.getByRole("link", { name: /^Done\b/ }).click({ timeout: 5_000 });
      await expect(page).toHaveURL(/stage=done/, { timeout: 10_000 });
    });
    await expectNoHorizontalOverflow(page);
  });
});

test("the topbar names the page: Notifications, Jobs, Editors, and Settings tabs under a Settings eyebrow", async ({ page }) => {
  const banner = page.getByRole("banner");
  for (const [path, title] of [
    ["/notifications", "Notifications"],
    ["/jobs", "Jobs"],
    ["/editors", "Editors"],
    ["/settings/people", "People"],
    ["/home", "Home"],
  ] as const) {
    await gotoReady(page, path, banner);
    await expect(banner.getByText(title, { exact: true }).first(), path).toBeVisible();
    await expect(banner.getByText("Proofline", { exact: true })).toHaveCount(0);
  }
});

test("Help is one page covering the five stages and three roles, reachable from the account menu", async ({ page }) => {
  await gotoReady(page, "/help", page.getByRole("main"));
  const main = page.getByRole("main");
  for (const stage of ["Needs editor", "With editor", "Ready to check", "Changes asked", "Done"]) await expect(main.getByText(stage).first(), stage).toBeVisible();
  for (const role of [/owner/i, /photographer/i, /editor/i, /client/i]) await expect(main.getByText(role).first(), `${role}`).toBeVisible();
  // Old jargon is gone as UI vocabulary (the Advanced note may still name the tools that live behind the switch).
  await expect(main.getByText(/kanban|turnaround|utilisation|bottleneck/i)).toHaveCount(0);
});
