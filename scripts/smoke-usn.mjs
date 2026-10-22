// Self-contained desktop integration test. Both evidence fixtures are synthetic.
import { chromium, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
const endpoint = process.env.AURA_CDP_URL || "http://127.0.0.1:9226";
await expect
  .poll(
    async () => {
      try {
        return (await fetch(`${endpoint}/json/version`)).ok;
      } catch {
        return false;
      }
    },
    { timeout: 15000 },
  )
  .toBe(true);
const browser = await chromium.connectOverCDP(endpoint);
const pages = () => browser.contexts().flatMap((c) => c.pages());
const main = pages().find(
  (p) => !p.url().includes("view=") && p.url() !== "about:blank",
);
const directory = path.resolve("artifacts/usn-native-fixture");
await fs.mkdir(directory, { recursive: true });
const reference = (id, sequence) => BigInt(id) | (BigInt(sequence) << 48n);
const stamp = 134370144000000000n;
function v23(major, name, reason, ordinal = 0) {
  const text = Buffer.from(name, "utf16le"),
    minimum = major === 2 ? 60 : 76,
    record = Buffer.alloc((minimum + text.length + 7) & ~7);
  record.writeUInt32LE(record.length);
  record.writeUInt16LE(major, 4);
  record.writeBigUInt64LE(reference(26, 7), 8);
  record.writeBigUInt64LE(
    reference(24, ordinal === 149 ? 2 : 1),
    major === 2 ? 16 : 24,
  );
  if (major === 3) record[23] = 0xab;
  const u = major === 2 ? 24 : 40;
  record.writeBigInt64LE(9007199254740999n + BigInt(ordinal), u);
  record.writeBigUInt64LE(stamp + BigInt(ordinal) * 10000000n, u + 8);
  record.writeUInt32LE(reason >>> 0, u + 16);
  record.writeUInt32LE(0x20, u + 28);
  record.writeUInt16LE(text.length, u + 32);
  record.writeUInt16LE(minimum, u + 34);
  text.copy(record, minimum);
  return record;
}
function resident(kind, id, value) {
  const a = Buffer.alloc((24 + value.length + 7) & ~7);
  a.writeUInt32LE(kind);
  a.writeUInt32LE(a.length, 4);
  a.writeUInt16LE(id, 14);
  a.writeUInt32LE(value.length, 16);
  a.writeUInt16LE(24, 20);
  value.copy(a, 24);
  return a;
}
function mftRecord(id, name, parent, sequence, directory) {
  const b = Buffer.alloc(1024);
  b.write("FILE");
  b.writeUInt16LE(48, 4);
  b.writeUInt16LE(3, 6);
  b.writeUInt16LE(sequence, 16);
  b.writeUInt16LE(1, 18);
  b.writeUInt16LE(56, 20);
  b.writeUInt16LE(directory ? 3 : 1, 22);
  b.writeUInt32LE(1024, 28);
  b.writeUInt32LE(id, 44);
  const si = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) si.writeBigUInt64LE(stamp, i * 8);
  const text = Buffer.from(name, "utf16le"),
    fn = Buffer.alloc(66 + text.length);
  fn.writeBigUInt64LE(reference(parent, 1));
  for (let i = 0; i < 4; i++) fn.writeBigUInt64LE(stamp, 8 + i * 8);
  fn[64] = text.length / 2;
  fn[65] = 1;
  text.copy(fn, 66);
  let offset = 56;
  for (const a of [resident(0x10, 0, si), resident(0x30, 1, fn)]) {
    a.copy(b, offset);
    offset += a.length;
  }
  b.writeUInt32LE(0xffffffff, offset);
  b.writeUInt32LE(offset + 8, 24);
  b.writeUInt16LE(0xaabb, 48);
  for (let sector = 1; sector <= 2; sector++) {
    b.copy(b, 48 + sector * 2, sector * 512 - 2, sector * 512);
    b.writeUInt16LE(0xaabb, sector * 512 - 2);
  }
  return b;
}
const fixture = Buffer.alloc(27 * 1024);
for (const args of [
  [0, "$MFT", 5, 1, false],
  [5, ".", 5, 1, true],
  [24, "Evidence", 5, 1, true],
  [26, "after.txt", 24, 7, false],
])
  mftRecord(...args).copy(fixture, args[0] * 1024);
const mftFile = path.join(directory, "MFT.bin");
await fs.writeFile(mftFile, fixture);
const records = [];
for (let i = 0; i < 150; i++) {
  const reason = [0x100, 0x80000002, 0x1000, 0x2000, 0x200, 0x01000000][i % 6];
  records.push(
    v23(
      2,
      i === 0
        ? "before.txt"
        : i === 1
          ? "after.txt"
          : i === 2
            ? "调查记录🚀.txt"
            : `evidence-${String(i).padStart(3, "0")}.txt`,
      i === 0 ? 0x1000 : i === 1 ? 0x2000 : reason,
      i,
    ),
  );
}
records.push(
  v23(3, "v3-identity.txt", 0x80000100, 150),
  v23(3, "v3-close.txt", 0x80000000, 151),
);
const v4 = Buffer.alloc(80);
v4.writeUInt32LE(80);
v4.writeUInt16LE(4, 4);
v4.writeBigInt64LE(9007199254741999n, 40);
v4.writeUInt32LE(1, 48);
v4.writeUInt32LE(2, 56);
v4.writeUInt16LE(1, 60);
v4.writeUInt16LE(16, 62);
v4.writeBigInt64LE(4096n, 64);
v4.writeBigInt64LE(8192n, 72);
records.push(v4);
const future = Buffer.alloc(16);
future.writeUInt32LE(16);
future.writeUInt16LE(5, 4);
const input = Buffer.concat([
    Buffer.alloc(65528),
    ...records,
    future,
    v23(3, "truncated", 0x100).subarray(0, 32),
  ]),
  journalFile = path.join(directory, "J.bin");
await fs.writeFile(journalFile, input);
const call = (page, command, args = {}) =>
  page.evaluate(
    ({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args),
    { command, args },
  );
const errors = [];
main.on("pageerror", (e) => errors.push(e.message));
try {
  await main
    .getByRole("button", { name: "$J / USN Journal", exact: true })
    .click();
  await main.getByRole("textbox", { name: "证据路径" }).fill(journalFile);
  await main.getByRole("button", { name: "导入并解析" }).click();
  await expect
    .poll(() => pages().some((p) => p.url().includes("view=usn")), {
      timeout: 30000,
    })
    .toBe(true);
  const journal = pages().find((p) => p.url().includes("view=usn"));
  journal.on("pageerror", (e) => errors.push(e.message));
  await expect(journal.locator("tbody tr")).toHaveCount(80);
  const summary = await call(journal, "get_journal_summary");
  expect(summary.records).toBe(153);
  expect(summary.v2).toBe(150);
  expect(summary.v3).toBe(2);
  expect(summary.v4).toBe(1);
  expect(summary.paddingBytes).toBe(65528);
  expect(summary.unsupported).toBe(1);
  expect(summary.truncatedBytes).toBe(32);
  expect(summary.sha256).toBe(createHash("sha256").update(input).digest("hex"));
  expect(summary.linkedMft).toBe("");
  const detail = await call(journal, "get_journal_detail", {
    id: 0,
    sessionId: summary.sessionId,
  });
  expect(detail.row.usn).toBe("9007199254740999");
  expect(detail.row.offset).toBe(65528);
  expect(
    Buffer.from(detail.hex.join(" ").replaceAll(" ", ""), "hex").equals(
      records[0],
    ),
  ).toBe(true);
  await journal.getByRole("tab", { name: /重命名/ }).click();
  await expect(journal.getByRole("tab", { name: /重命名/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await journal.getByRole("textbox", { name: "搜索日志" }).fill("before.txt");
  await expect(journal.locator("tbody tr")).toHaveCount(1);
  await journal.locator("tbody tr").click();
  await expect(
    journal.getByRole("dialog", { name: "USN 记录详情" }),
  ).toContainText("9007199254740999");
  await journal
    .getByRole("button", { name: "原始日志字节", exact: true })
    .click();
  await expect(journal.locator(".hex-row")).toHaveCount(records[0].length / 16);
  await journal.getByRole("button", { name: "关闭日志详情" }).click();
  await main
    .getByRole("button", { name: "$MFT / 文件记录", exact: true })
    .click();
  await main.getByRole("textbox", { name: "证据路径" }).fill(mftFile);
  await main.getByRole("button", { name: "导入并解析" }).click();
  await expect
    .poll(async () => {
      try {
        return (await call(main, "get_summary")).source;
      } catch {
        return "";
      }
    })
    .toBe(mftFile);
  await journal
    .getByRole("button", { name: "关联当前 MFT（同卷）", exact: true })
    .click();
  await expect(journal.locator(".journal-link")).toContainText("已关联 MFT");
  const linked = await call(journal, "get_journal_summary");
  expect(linked.linkedMft).not.toBe("");
  const matching = await call(journal, "query_journal", {
    search: "before.txt",
    filter: "all",
    page: 0,
    sessionId: linked.sessionId,
  });
  expect(matching.rows[0].path).toBe("\\Evidence\\before.txt");
  expect(matching.rows[0].pathStatus).toContain("MFT 快照");
  const stale = await call(journal, "get_journal_detail", {
    id: 149,
    sessionId: linked.sessionId,
  });
  expect(stale.row.path).toBe("");
  expect(stale.row.pathStatus).toContain("序列号失效");
  const wide = await call(journal, "get_journal_detail", {
    id: 150,
    sessionId: linked.sessionId,
  });
  expect(wide.row.fileReference).toMatch(/^0xAB/);
  expect(wide.row.path).toBe("");
  const range = await call(journal, "get_journal_detail", {
    id: 152,
    sessionId: linked.sessionId,
  });
  expect(range.row.timestamp).toBe("");
  expect(range.row.name).toBe("");
  expect(range.extents[0].length).toBe("8192");
  expect(range.remainingExtents).toBe(2);
  let rejected = false;
  try {
    await call(journal, "get_journal_detail", {
      id: 0,
      sessionId: summary.sessionId,
    });
  } catch {
    rejected = true;
  }
  expect(rejected).toBe(true);
  await journal.getByRole("tab", { name: /全部事件/ }).click();
  await journal.getByRole("textbox", { name: "搜索日志" }).fill("");
  await expect(journal.locator("tbody tr")).toHaveCount(80);
  await journal.getByRole("button", { name: "外观与动效" }).click();
  await journal.getByRole("button", { name: /曜石紫/ }).click();
  await journal.getByRole("button", { name: "关闭设置" }).click();
  await journal.screenshot({
    path: "docs/images/usn-journal.png",
    scale: "css",
    animations: "disabled",
  });
  await journal.getByRole("textbox", { name: "搜索日志" }).fill("before.txt");
  await expect(journal.locator("tbody tr")).toHaveCount(1);
  await journal.locator("tbody tr").click();
  await journal
    .locator(".detail-drawer")
    .screenshot({
      path: "docs/images/usn-detail.png",
      scale: "css",
      animations: "disabled",
    });
  await journal.getByRole("button", { name: "关闭日志详情" }).click();
  await journal.getByRole("button", { name: "切换亮色主题" }).click();
  await expect(main.locator("html")).toHaveAttribute("data-theme", "light");
  await journal.screenshot({
    path: "artifacts/usn-light.png",
    scale: "css",
    animations: "disabled",
  });
  await journal.getByRole("button", { name: "解除关联", exact: true }).click();
  await expect(journal.locator(".journal-link")).not.toContainText(
    "已关联 MFT",
  );
  expect((await call(journal, "get_journal_summary")).linkedMft).toBe("");
  expect(errors).toEqual([]);
  console.log(
    JSON.stringify(
      {
        ok: true,
        records: summary.records,
        versions: [summary.v2, summary.v3, summary.v4],
        precision: "exact 64-bit",
        rawBytes: "verified",
        mftCorrelation: "sequence checked",
        detached: "verified",
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
