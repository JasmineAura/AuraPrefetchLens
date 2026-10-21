// Run against a debug desktop app launched with a WebView2 CDP port of 9223.
import { chromium, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
const endpoint = process.env.AURA_CDP_URL || "http://127.0.0.1:9223";
await expect.poll(async () => { try { return (await fetch(`${endpoint}/json/version`)).ok; } catch { return false; } }, { timeout: 15000 }).toBe(true);
const browser = await chromium.connectOverCDP(endpoint);
const main = browser
  .contexts()
  .flatMap((c) => c.pages())
  .find((p) => !p.url().includes("view=results") && p.url() !== "about:blank");
let page = main;
if (!page) throw new Error("Desktop WebView not found");
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const call = (cmd, args = {}) =>
  page.evaluate(
    ({ cmd, args }) => window.__TAURI_INTERNALS__.invoke(cmd, args),
    { cmd, args },
  );
try {
  await main
    .getByRole("textbox", { name: "证据路径" })
    .fill(path.resolve("example/$MFT"));
  await main.getByRole("button", { name: "导入并解析" }).click();
  await expect(main.getByRole("button", { name: /打开分析窗口/ })).toBeVisible({
    timeout: 90000,
  });
  await expect
    .poll(
      () =>
        browser
          .contexts()
          .flatMap((c) => c.pages())
          .some((p) => p.url().includes("view=results")),
      { timeout: 15000 },
    )
    .toBe(true);
  page = browser
    .contexts()
    .flatMap((c) => c.pages())
    .find((p) => p.url().includes("view=results"));
  await page.waitForLoadState("domcontentloaded");
  page.on("pageerror", (e) => errors.push(e.message));
  await expect(page.getByRole("tab", { name: /全部记录/ })).toBeVisible();
  const summary = await call("get_summary");
  const caseId = summary.sha256;
  await main.screenshot({
    path: "artifacts/workspace-ready.png",
    fullPage: true,
  });
  await expect(page.locator(".evidence-info strong")).toHaveText("$MFT", {
    timeout: 90000,
  });
  await expect(page.locator("tbody tr")).toHaveCount(80);
  await page.screenshot({
    path: "artifacts/desktop-loaded.png",
    fullPage: true,
  });
  await page.getByRole("tab", { name: /驻留数据/ }).click();
  await expect(page.getByRole("tab", { name: /驻留数据/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const found = await call("query_records", {
    search: ".txt",
    filter: "resident",
    page: 0,
    caseId,
  });
  const candidate = found.rows.find(
    (e) => !e.directory && !e.extension && e.size > 0,
  );
  if (!candidate) throw new Error("No non-empty resident text file");
  await page
    .getByRole("textbox", { name: "搜索记录" })
    .fill(String(candidate.id));
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await page.locator("tbody tr").first().click();
  await expect(
    page.getByRole("dialog", { name: "记录调查卡片" }),
  ).toBeVisible();
  await page.getByRole("button", { name: /数据流 \(/ }).click();
  await expect(page.locator(".stream-card").first()).toBeVisible();
  const detail = await call("get_detail", { id: candidate.id, caseId });
  const stream = detail.streams.find(
    (s) => s.resident && !(s.flags & 0x4001) && s.size > 0,
  );
  if (!stream) throw new Error("No extractable stream");
  const destination = path.resolve(
    `artifacts/resident-${candidate.id}-${Date.now()}.bin`,
  );
  const result = await call("extract_resident", {
    id: candidate.id,
    attributeId: stream.id,
    path: destination,
    caseId,
  });
  const extracted = await fs.readFile(destination);
  const sha = createHash("sha256").update(extracted).digest("hex");
  expect(extracted.length).toBe(stream.size);
  expect(sha).toBe(stream.sha256);
  expect(result.sha256).toBe(sha);
  // Independent byte check: reconstruct fixups directly from the original sample.
  const input = await fs.open("example/$MFT", "r");
  const record = Buffer.alloc(detail.recordSize);
  await input.read(record, 0, record.length, detail.offset);
  await input.close();
  const usa = record.readUInt16LE(4),
    count = record.readUInt16LE(6),
    sector = record.length / (count - 1);
  for (let i = 1; i < count; i++)
    record.copy(record, i * sector - 2, usa + i * 2, usa + i * 2 + 2);
  const attr = detail.attributes.find((a) => a.id === stream.id);
  const expected = record.subarray(
    attr.offset + attr.valueOffset,
    attr.offset + attr.valueOffset + stream.size,
  );
  expect(extracted.equals(expected)).toBe(true);
  let refused = false;
  try {
    await call("extract_resident", {
      id: candidate.id,
      attributeId: stream.id,
      path: destination,
      caseId,
    });
  } catch {
    refused = true;
  }
  expect(refused).toBe(true);
  await page.screenshot({
    path: "artifacts/desktop-resident.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "原始证据", exact: true }).click();
  await expect(page.locator(".hex-row")).toHaveCount(detail.recordSize / 16);
  await page.getByRole("button", { name: "关闭详情" }).click();
  await page.getByRole("button", { name: "外观与动效" }).click();
  await page.getByRole("button", { name: /午夜蓝/ }).click();
  await expect(main.locator("html")).toHaveAttribute("data-theme", "blue");
  await page.getByRole("button", { name: "关闭设置" }).click();
  await page.screenshot({ path: "artifacts/desktop-blue.png", fullPage: true });
  await page.getByRole("button", { name: "外观与动效" }).click();
  await page.getByRole("button", { name: /曜石紫/ }).click();
  await expect(main.locator("html")).toHaveAttribute("data-theme", "violet");
  await page.getByRole("button", { name: "关闭设置" }).click();
  await page.getByRole("textbox", { name: "搜索记录" }).fill("");
  await main.getByRole("button", { name: "提取驻留文件" }).click();
  await expect(page.getByRole("tab", { name: /驻留数据/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  let staleRefused = false;
  try {
    await call("get_detail", { id: candidate.id, caseId: "wrong-case" });
  } catch {
    staleRefused = true;
  }
  expect(staleRefused).toBe(true);
  expect(errors).toEqual([]);
  console.log(
    JSON.stringify(
      {
        ok: true,
        record: candidate.id,
        name: candidate.name,
        bytes: extracted.length,
        sha256: sha,
        destination,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
