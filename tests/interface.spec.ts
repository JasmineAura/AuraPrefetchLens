import { test, expect } from "@playwright/test";
test("split workspace, themes and desktop notice", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("MFT");
  await expect(page.locator(".sidebar")).toHaveCount(0);
  await expect(page.locator("table")).toHaveCount(0);
  await expect(page.getByText(/example|样例/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "导入并解析" })).toBeDisabled();
  await page.getByRole("button", { name: "外观与动效" }).click();
  for (const [name, id] of [
    ["午夜蓝", "blue"],
    ["绯红黑", "red"],
    ["瓷白紫", "light"],
    ["曜石紫", "violet"],
  ]) {
    await page.getByRole("button", { name: new RegExp(name) }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", id);
  }
  await page.getByRole("switch", { name: "环境动效" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-motion", "off");
  await page.getByRole("button", { name: "关闭设置" }).click();
  await page
    .getByRole("textbox", { name: "证据路径" })
    .fill("C:\\Evidence\\$MFT");
  await page.getByRole("button", { name: "导入并解析" }).click();
  await expect(page.getByRole("alert")).toContainText("桌面端");
  await page.getByRole("button", { name: "关闭错误" }).click();
  await page.screenshot({
    path: "artifacts/workspace-violet.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
test("light theme persists, restores dark choice and syncs windows", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "外观与动效" }).click();
  await page.getByRole("button", { name: /午夜蓝/ }).click();
  await page.getByRole("button", { name: "关闭设置" }).click();
  await page.getByRole("button", { name: "切换亮色主题" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  const other = await context.newPage();
  await other.goto("/?view=results");
  await expect(other.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "切换深色主题" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "blue");
  await expect(other.locator("html")).toHaveAttribute("data-theme", "blue");
  await other.getByRole("button", { name: "切换亮色主题" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.screenshot({
    path: "artifacts/light-workspace.png",
    fullPage: true,
  });
  await other.screenshot({
    path: "artifacts/light-results.png",
    fullPage: true,
  });
});
test("minimum window has no horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 740 });
  await page.goto("/");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await expect(
    page.getByRole("button", { name: "导入并解析" }),
  ).toBeInViewport();
  await page.screenshot({
    path: "artifacts/workspace-compact.png",
    fullPage: true,
  });
});
test("result view contains all six category tabs", async ({ page }) => {
  await page.goto("/?view=results");
  await expect(
    page.getByRole("tablist", { name: "记录分类" }).getByRole("tab"),
  ).toHaveCount(6);
  await expect(page.locator(".sidebar")).toHaveCount(0);
  await page.getByRole("tab", { name: /驻留数据/ }).click();
  await expect(page.getByRole("tab", { name: /驻留数据/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("textbox", { name: "搜索记录" })).toBeFocused();
});
test("journal source selection and journal category window", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("textbox", { name: "证据路径" })
    .fill("C:\\Evidence\\MFT.bin");
  await page
    .getByRole("button", { name: "$J / USN Journal", exact: true })
    .click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("USN");
  await expect(page.getByRole("textbox", { name: "证据路径" })).toHaveValue("");
  await expect(page.getByRole("button", { name: "导入并解析" })).toBeDisabled();
  await page
    .getByRole("textbox", { name: "证据路径" })
    .fill("C:\\Evidence\\$J");
  await page
    .getByRole("button", { name: "$MFT / 文件记录", exact: true })
    .click();
  await expect(page.getByRole("textbox", { name: "证据路径" })).toHaveValue(
    "C:\\Evidence\\MFT.bin",
  );
  await page
    .getByRole("button", { name: "$J / USN Journal", exact: true })
    .click();
  await expect(page.getByRole("textbox", { name: "证据路径" })).toHaveValue(
    "C:\\Evidence\\$J",
  );
  await page.goto("/?view=usn");
  await expect(
    page.getByRole("tablist", { name: "日志事件分类" }).getByRole("tab"),
  ).toHaveCount(6);
  await page.getByRole("tab", { name: /重命名/ }).click();
  await expect(page.getByRole("tab", { name: /重命名/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("textbox", { name: "搜索日志" })).toBeFocused();
  await page.getByRole("button", { name: "切换亮色主题" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});
