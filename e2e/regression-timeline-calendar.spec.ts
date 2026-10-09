import type { Page } from "@playwright/test";
import { civilDate, uniq, type Api, type JobRow } from "./api";
import { UI_TEST_TIMEOUT, expect, expectNoHorizontalOverflow, gotoReady, test } from "./fixtures";

/**
 * Regressions (audit batch E, timeline + calendar layout): timeline job labels
 * stay inside their rows, stage bars are visible beside the sticky label
 * column at 390px, and calendar legend labels are unique.
 */
test.beforeEach(() => test.setTimeout(UI_TEST_TIMEOUT));

/** A job with several stages (assigned → accepted → in progress) so its row has several bars. */
async function timelineJob(api: Api): Promise<JobRow> {
  const editor = await api.inviteUser("editor", "Reg timeline");
  const job = await api.createJob({ name: uniq("Reg timeline"), editorId: editor.user.id, dueDate: civilDate(5) });
  await api.action(job.id, "accept");
  await api.action(job.id, "start");
  return job;
}

type Box = { x: number; y: number; width: number; height: number };

async function openTimeline(page: Page, job: Pick<JobRow, "jobNumber" | "name">) {
  const label = page.locator(`a[title^="${job.jobNumber} · "]`);
  await gotoReady(page, `/workspace/timeline?q=${encodeURIComponent(job.name)}&group=job`, label);
  const row = label.locator("xpath=../..");
  const labelCell = label.locator("xpath=..");
  const bars = page.locator(`a[aria-label^="${job.jobNumber}: "]`);
  await expect(bars.first()).toBeAttached();
  return { label, row, labelCell, bars };
}

function within(inner: Box, outer: Box, axis: "x" | "y"): boolean {
  const [a, al, b, bl] = axis === "y" ? [inner.y, inner.height, outer.y, outer.height] : [inner.x, inner.width, outer.x, outer.width];
  return a >= b - 1 && a + al <= b + bl + 1;
}

for (const width of [1440, 390]) {
  test(`timeline job labels sit inside their rows at ${width}px`, async ({ page, api }) => {
    await page.setViewportSize({ width, height: 860 });
    const job = await timelineJob(api);
    const { label, row, labelCell } = await openTimeline(page, job);
    const [l, r, c] = [await label.boundingBox(), await row.boundingBox(), await labelCell.boundingBox()];
    expect(l && r && c, "label/row boxes").toBeTruthy();
    expect(within(l!, r!, "y"), `label ${JSON.stringify(l)} spills out of row ${JSON.stringify(r)}`).toBe(true);
    expect(within(l!, c!, "x"), `label ${JSON.stringify(l)} spills out of its column ${JSON.stringify(c)}`).toBe(true);
    await expectNoHorizontalOverflow(page);
  });
}

test.describe("at 390px", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("timeline stage bars are visible beside the sticky labels", async ({ page, api }) => {
    const job = await timelineJob(api);
    const { row, labelCell, bars } = await openTimeline(page, job);
    expect(await bars.count()).toBeGreaterThanOrEqual(3);

    // The current stage ("so far") runs to now, which the board scrolls into view.
    const bar = page.locator(`a[aria-label^="${job.jobNumber}: "][aria-label*="so far"]`).first();
    await expect(bar).toBeAttached();
    // After hydration the board scrolls "now" into view (server HTML starts at scrollLeft 0).
    await expect
      .poll(async () => {
        const [b, c] = [await bar.boundingBox(), await labelCell.boundingBox()];
        if (!b || !c) return "no box";
        if (b.x + b.width <= c.x + c.width) return `covered by the label column (bar ${Math.round(b.x)}–${Math.round(b.x + b.width)}, labels end ${Math.round(c.x + c.width)})`;
        if (b.x >= 390) return `off-screen right (bar starts at ${Math.round(b.x)})`;
        return "visible";
      }, { timeout: 60_000 })
      .toBe("visible");
    const [b, r] = [await bar.boundingBox(), await row.boundingBox()];
    expect(b!.width).toBeGreaterThanOrEqual(4);
    expect(within(b!, r!, "y"), "bar is vertically inside its row").toBe(true);
    await expect(bar).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});

// Batch E: colour=status used to list "Ready for Assignment", "In Progress" and "Submitted for Review"
// twice (one legend entry per workflow's status, keyed by id but labelled by name).
test("calendar legend labels are unique in every colour mode", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const colour of ["status", "priority", "overdue", "editor"]) {
    for (const view of ["month", "agenda"]) {
      const legend = page.getByRole("list", { name: /^Colours:/ });
      await gotoReady(page, `/workspace/calendar?view=${view}&colour=${colour}`, legend);
      const labels = (await legend.getByRole("listitem").allInnerTexts()).map((t) => t.trim()).filter((t) => !/^\+\d+ more$/.test(t));
      const dupes = labels.filter((t, i) => labels.indexOf(t) !== i);
      expect(dupes, `${view}/${colour} legend: ${labels.join(" | ")}`).toEqual([]);
    }
  }
});
