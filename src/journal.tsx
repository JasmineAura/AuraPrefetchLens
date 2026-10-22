import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Activity,
  ArrowUpRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  File,
  Hexagon,
  Link,
  LoaderCircle,
  Search,
  Unlink,
  X,
  AlertTriangle,
} from "lucide-react";
import type { Summary as MftSummary } from "./types";
import "./journal.css";

export type JournalSummary = {
  source: string;
  sha256: string;
  bytes: number;
  records: number;
  v2: number;
  v3: number;
  v4: number;
  creates: number;
  deletes: number;
  renames: number;
  writes: number;
  closed: number;
  paddingBytes: number;
  skippedBytes: number;
  unsupported: number;
  truncatedBytes: number;
  startTime: string;
  endTime: string;
  diagnostics: string[];
  sessionId: string;
  linkedMft: string;
  linkedMftSource: string;
};
type JournalRow = {
  id: number;
  offset: number;
  length: number;
  major: number;
  minor: number;
  fileReference: string;
  parentReference: string;
  usn: string;
  timestamp: string;
  rawTimestamp: string;
  name: string;
  reason: number;
  reasons: string[];
  sourceInfo: number;
  securityId: number | null;
  attributes: number | null;
  warnings: string[];
  path: string;
  pathStatus: string;
};
type JournalDetail = {
  row: JournalRow;
  hex: string[];
  extents: { offset: string; length: string }[];
  remainingExtents: number | null;
};
const number = (value: number) => value.toLocaleString("en-US");
const bytes = (value: number) =>
  value < 1024
    ? `${value} B`
    : value < 1048576
      ? `${(value / 1024).toFixed(1)} KiB`
      : `${(value / 1048576).toFixed(1)} MiB`;
const utc = (value: string) =>
  value ? value.replace("T", " ").replace(/\.\d+Z$/, " UTC") : "—";
const hex = (value: number) =>
  `0x${value.toString(16).toUpperCase().padStart(8, "0")}`;
const tabs = [
  { id: "all", label: "全部事件", key: "records" },
  { id: "created", label: "创建", key: "creates" },
  { id: "deleted", label: "删除", key: "deletes" },
  { id: "renamed", label: "重命名", key: "renames" },
  { id: "written", label: "数据变化", key: "writes" },
  { id: "closed", label: "关闭", key: "closed" },
] as const;

export function JournalHome({
  summary,
  busy,
  openResults,
}: {
  summary: JournalSummary | null;
  busy: boolean;
  openResults: () => void;
}) {
  if (!summary)
    return (
      <div className="waiting-content">
        <div
          className={`evidence-sculpture ${busy ? "working" : ""}`}
          aria-hidden="true"
        >
          <div className="sculpture-ring ring-a" />
          <div className="sculpture-ring ring-b" />
          <div className="sculpture-ring ring-c" />
          <div className="sculpture-core">
            <Hexagon size={85} strokeWidth={0.65} />
            <Activity size={29} />
          </div>
        </div>
        <div className="waiting-copy">
          <span>FOLLOW THE FILE ACTIVITY</span>
          <h2>{busy ? "变更记录正在展开。" : "从变更，追溯线索。"}</h2>
          <p>
            {busy
              ? "正在解析变长 USN 记录，完成后自动打开日志窗口。"
              : "导入 $UsnJrnl:$J，查看创建、删除、重命名与数据变化。"}
          </p>
        </div>
      </div>
    );
  return (
    <div className="operation-content">
      <div className="ready-indicator">
        <Check size={13} />
        日志已就位 / JOURNAL READY
      </div>
      <h2>
        循着变更，追踪。<span>FILE ACTIVITY JOURNAL</span>
      </h2>
      <div className="case-name">
        <Activity size={21} />
        <div>
          <strong>{summary.source.split(/[\\/]/).pop()}</strong>
          <span title={summary.source}>{summary.source}</span>
        </div>
      </div>
      <div className="operation-stats">
        <div>
          <strong>{number(summary.records)}</strong>
          <span>有效 USN 记录</span>
        </div>
        <div>
          <strong>{number(summary.renames)}</strong>
          <span>重命名相关记录</span>
        </div>
      </div>
      <div className="case-facts">
        <span>{bytes(summary.bytes)}</span>
        <span>V2 / V3 / V4</span>
        <span>{number(summary.paddingBytes)} B 零填充</span>
      </div>
      <button
        className="primary-button view-results"
        disabled={busy}
        onClick={openResults}
      >
        <Activity size={18} />
        <span>
          打开日志窗口<small>EXPLORE FILE ACTIVITY</small>
        </span>
        <ArrowUpRight size={21} />
      </button>
      <p className="hint">
        日志可独立分析；在结果窗口可关联同卷 MFT，以父目录引用推导快照路径。
      </p>
      <p className="case-fingerprint">SHA-256 / {summary.sha256}</p>
    </div>
  );
}

export function JournalResults() {
  const [summary, setSummary] = useState<JournalSummary | null>(null),
    [search, setSearch] = useState(""),
    [needle, setNeedle] = useState(""),
    [filter, setFilter] = useState("all"),
    [page, setPage] = useState(0),
    [rows, setRows] = useState<JournalRow[]>([]),
    [total, setTotal] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [detail, setDetail] = useState<JournalDetail | null>(null),
    [detailBusy, setDetailBusy] = useState(false),
    [tab, setTab] = useState("overview"),
    [linking, setLinking] = useState(false),
    [hexLimit, setHexLimit] = useState(256);
  const queryId = useRef(0),
    detailId = useRef(0),
    input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const timer = setTimeout(() => {
      setNeedle(search);
      setPage(0);
    }, 250);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let off: (() => void) | undefined;
    const accept = (s: JournalSummary) => {
      queryId.current++;
      detailId.current++;
      setSummary(s);
      setPage(0);
      setRows([]);
      setTotal(0);
      setDetail(null);
      setDetailBusy(false);
    };
    const register = async () => {
      const unlisten = await listen<JournalSummary>("journal-changed", (e) =>
        accept(e.payload),
      );
      if (disposed) {
        unlisten();
        return;
      }
      off = unlisten;
      try {
        const s = await invoke<JournalSummary>("get_journal_summary");
        if (!disposed) accept(s);
      } catch {
        /* No journal loaded. */
      }
    };
    void register().catch((e) => {
      if (!disposed) setError(String(e));
    });
    return () => {
      disposed = true;
      off?.();
    };
  }, []);
  useEffect(() => {
    if (!summary) return;
    const id = ++queryId.current;
    setBusy(true);
    invoke<{ rows: JournalRow[]; total: number }>("query_journal", {
      search: needle,
      filter,
      page,
      sessionId: summary.sessionId,
    })
      .then((result) => {
        if (id === queryId.current) {
          setRows(result.rows);
          setTotal(result.total);
        }
      })
      .catch((e) => {
        if (id === queryId.current) setError(String(e));
      })
      .finally(() => {
        if (id === queryId.current) setBusy(false);
      });
  }, [summary, needle, filter, page]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        input.current?.focus();
      }
      if (e.key === "Escape") {
        detailId.current++;
        setDetail(null);
        setDetailBusy(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  async function inspect(row: JournalRow) {
    if (!summary) return;
    const id = ++detailId.current;
    setDetail(null);
    setDetailBusy(true);
    setTab("overview");
    setHexLimit(256);
    try {
      const d = await invoke<JournalDetail>("get_journal_detail", {
        id: row.id,
        sessionId: summary.sessionId,
      });
      if (id === detailId.current) setDetail(d);
    } catch (e) {
      if (id === detailId.current) setError(String(e));
    } finally {
      if (id === detailId.current) setDetailBusy(false);
    }
  }
  async function linkMft(unlink = false) {
    if (!summary) return;
    setLinking(true);
    try {
      const mft = unlink ? null : await invoke<MftSummary>("get_summary");
      const s = await invoke<JournalSummary>("set_journal_mft", {
        sessionId: summary.sessionId,
        mftId: mft?.sha256 || null,
      });
      setSummary(s);
      setDetail(null);
      setPage(0);
    } catch (e) {
      setError(unlink ? String(e) : `请先在主窗口导入同卷 MFT。${String(e)}`);
    } finally {
      setLinking(false);
    }
  }
  function closeDetail() {
    detailId.current++;
    setDetail(null);
    setDetailBusy(false);
  }
  return (
    <main className="results-main journal-results">
      <div className="results-heading">
        <div>
          <span className="micro">FOLLOW THE FILE ACTIVITY</span>
          <h1>
            USN<span>日志</span>
            <sup>↗</sup>
          </h1>
        </div>
        <div className="results-total">
          <strong>{summary ? number(summary.records) : "—"}</strong>
          <span>JOURNAL RECORDS</span>
        </div>
      </div>
      {summary && (
        <>
          <section className="evidence-bar">
            <div className="evidence-icon">
              <Activity size={19} />
            </div>
            <div className="evidence-info">
              <strong>{summary.source.split(/[\\/]/).pop()}</strong>
              <span title={summary.source}>{summary.source}</span>
            </div>
            <div className="evidence-meta">
              <span>SIZE</span>
              <b>{bytes(summary.bytes)}</b>
            </div>
            <div className="evidence-meta">
              <span>VERSIONS</span>
              <b>
                V2 {number(summary.v2)} / V3 {number(summary.v3)} / V4{" "}
                {number(summary.v4)}
              </b>
            </div>
            <button
              className="icon-button"
              title="复制日志 SHA-256"
              onClick={() =>
                navigator.clipboard
                  .writeText(summary.sha256)
                  .catch(() => setError("剪贴板不可用"))
              }
            >
              <Copy size={15} />
            </button>
          </section>
          <section className="journal-link">
            <div>
              <Link size={15} />
              <span title={summary.linkedMftSource}>
                {summary.linkedMft
                  ? `已关联 MFT · ${summary.linkedMft.slice(0, 12)}…`
                  : "可关联当前 MFT，以父引用推导快照路径"}
              </span>
            </div>
            <button disabled={linking} onClick={() => linkMft()}>
              {linking ? (
                <LoaderCircle size={13} className="spin" />
              ) : (
                <Link size={13} />
              )}
              关联当前 MFT（同卷）
            </button>
            {summary.linkedMft && (
              <button onClick={() => linkMft(true)} disabled={linking}>
                <Unlink size={13} />
                解除关联
              </button>
            )}
          </section>
          <p className="journal-caveat">
            仅关联来自同一卷的
            MFT；快照中的目录名称可能与事件发生时不同。日志原因标志可能累计，不代表每次操作都有独立记录。
          </p>
        </>
      )}
      <section className="records-panel">
        <div className="panel-heading">
          <div>
            <span className="section-number">02 /</span>
            <h2>
              变更记录 <small>CHANGE JOURNAL</small>
            </h2>
          </div>
          <span className="panel-count">
            {number(total)} <small>RECORDS</small>
          </span>
        </div>
        <div className="toolbar">
          <div className="filter-tabs" role="tablist" aria-label="日志事件分类">
            {tabs.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={filter === t.id}
                className={filter === t.id ? "chosen" : ""}
                onClick={() => {
                  setFilter(t.id);
                  setPage(0);
                }}
              >
                {t.label}
                <span>{summary ? number(summary[t.key]) : "—"}</span>
              </button>
            ))}
          </div>
          <label className="search">
            <Search size={16} />
            <input
              ref={input}
              aria-label="搜索日志"
              placeholder="文件名、路径、FRN、USN、原因…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <kbd>⌃ K</kbd>
          </label>
        </div>
        <div className={`table-wrap ${busy ? "querying" : ""}`}>
          <table className="journal-table">
            <thead>
              <tr>
                <th className="journal-order">顺序</th>
                <th>文件名 / 关联路径</th>
                <th className="journal-reason">变更原因</th>
                <th className="journal-date">时间 / UTC</th>
                <th className="journal-usn">USN</th>
                <th className="journal-version">版本</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  tabIndex={0}
                  onClick={() => inspect(row)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void inspect(row);
                  }}
                  aria-label={`查看日志 ${row.name || row.usn}`}
                >
                  <td className="mono">
                    {String(row.id + 1).padStart(6, "0")}
                  </td>
                  <td>
                    <div className="file-cell">
                      <span className="file-icon">
                        <File size={17} />
                      </span>
                      <div>
                        <strong>{row.name || "（V4 范围跟踪记录）"}</strong>
                        <span
                          title={`${row.pathStatus} / ${row.path || row.fileReference}`}
                        >
                          {row.path || row.fileReference}
                        </span>
                      </div>
                    </div>
                  </td>
                  <td>
                    <div
                      className="reason-chips"
                      title={`${row.reasons.join(" | ")} / ${hex(row.reason)}`}
                    >
                      {row.reasons.slice(0, 2).map((reason) => (
                        <span
                          key={reason}
                          className={
                            reason.includes("DELETE")
                              ? "deleted"
                              : reason.includes("RENAME")
                                ? "renamed"
                                : ""
                          }
                        >
                          {reason.replace("FILE_", "").replace("RENAME_", "")}
                        </span>
                      ))}
                      {row.reasons.length > 2 && (
                        <small>+{row.reasons.length - 2}</small>
                      )}
                      {!row.reasons.length && <small>{hex(row.reason)}</small>}
                    </div>
                  </td>
                  <td className="date-cell">
                    {row.timestamp
                      ? utc(row.timestamp).replace(" UTC", "")
                      : "V4 无时间戳"}
                  </td>
                  <td className="mono journal-usn-value" title={row.usn}>
                    {row.usn}
                  </td>
                  <td className="mono">
                    V{row.major}.{row.minor}
                  </td>
                  <td>
                    <ChevronRight size={14} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && (
            <div className="empty-state">
              <Activity size={35} strokeWidth={1} />
              <h3>{summary ? "没有匹配的日志记录" : "等待 USN Journal"}</h3>
              <p>
                {summary
                  ? "调整关键词或事件分类。"
                  : "请在主窗口选择 USN Journal 并导入 $J。"}
              </p>
            </div>
          )}
        </div>
        <div className="pagination">
          <span>
            按输入流顺序显示 {total ? page * 80 + 1 : 0}–
            {Math.min((page + 1) * 80, total)} / {number(total)} 条{" "}
            {busy && <LoaderCircle size={13} className="spin" />}
          </span>
          <div>
            <span>80 / 页</span>
            <button
              aria-label="日志上一页"
              disabled={page === 0}
              onClick={() => setPage((p) => p - 1)}
            >
              <ChevronLeft size={16} />
            </button>
            <b>{String(page + 1).padStart(2, "0")}</b>
            <button
              aria-label="日志下一页"
              disabled={(page + 1) * 80 >= total}
              onClick={() => setPage((p) => p + 1)}
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      </section>
      {summary && (
        <div className="parse-notes">
          <Activity size={14} />
          <span>
            零填充 {bytes(summary.paddingBytes)} · 异常跳过{" "}
            {bytes(summary.skippedBytes)} · 不支持版本 {summary.unsupported} 条
            · 截断 {summary.truncatedBytes} B
          </span>
          <span title={`${utc(summary.startTime)} → ${utc(summary.endTime)}`}>
            {summary.startTime
              ? `${summary.startTime.slice(0, 10)} → ${summary.endTime.slice(0, 10)}`
              : "V4 不包含时间范围"}
          </span>
        </div>
      )}
      {summary && summary.diagnostics.length > 0 && (
        <details className="journal-diagnostics">
          <summary>查看解析诊断（最多保留 100 条）</summary>
          {summary.diagnostics.map((d, i) => (
            <p key={i}>{d}</p>
          ))}
        </details>
      )}
      <footer>
        <span>
          AURA <b>/</b> USN JOURNAL
        </span>
        <span>RECORDS ARE EVIDENCE. CONTEXT MATTERS.</span>
      </footer>
      {error && (
        <div className="toast error" role="alert">
          <AlertTriangle size={18} />
          <span>{error}</span>
          <button aria-label="关闭日志错误" onClick={() => setError("")}>
            <X size={16} />
          </button>
        </div>
      )}
      {(detail || detailBusy) && (
        <div className="drawer-backdrop" onClick={closeDetail}>
          <section
            className="detail-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="USN 记录详情"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="drawer-header">
              <span className="micro">USN JOURNAL / RECORD INSPECTOR</span>
              <button
                className="icon-button"
                aria-label="关闭日志详情"
                onClick={closeDetail}
              >
                <X size={20} />
              </button>
            </div>
            {detailBusy ? (
              <div className="detail-loading">
                <LoaderCircle className="spin" />
                读取日志记录…
              </div>
            ) : (
              detail && (
                <>
                  <div className="detail-title">
                    <span>
                      USN {detail.row.usn} / V{detail.row.major}.
                      {detail.row.minor}
                    </span>
                    <h2>{detail.row.name || "V4 范围跟踪记录"}</h2>
                    <p>{detail.row.path || detail.row.fileReference}</p>
                    <span className="status-pill">{detail.row.pathStatus}</span>
                  </div>
                  <div className="detail-tabs">
                    <button
                      className={tab === "overview" ? "chosen" : ""}
                      onClick={() => setTab("overview")}
                    >
                      日志字段
                    </button>
                    <button
                      className={tab === "hex" ? "chosen" : ""}
                      onClick={() => setTab("hex")}
                    >
                      原始日志字节
                    </button>
                  </div>
                  <div className="detail-body">
                    {tab === "overview" ? (
                      <>
                        <div className="detail-grid">
                          <JournalInfo
                            label="输入偏移 / 长度"
                            value={`0x${detail.row.offset.toString(16).toUpperCase()} / ${detail.row.length} B`}
                          />
                          <JournalInfo
                            label="USN（精确保留 64 位值）"
                            value={detail.row.usn}
                          />
                          <JournalInfo
                            label="文件引用 / FRN"
                            value={detail.row.fileReference}
                          />
                          <JournalInfo
                            label="父目录引用 / PFRN"
                            value={detail.row.parentReference}
                          />
                          <JournalInfo
                            label="事件时间 / UTC"
                            value={utc(detail.row.timestamp)}
                          />
                          <JournalInfo
                            label="原始 FILETIME"
                            value={detail.row.rawTimestamp || "V4 不包含"}
                          />
                          <JournalInfo
                            label="Reason 原始位掩码"
                            value={hex(detail.row.reason)}
                          />
                          <JournalInfo
                            label="SourceInfo"
                            value={hex(detail.row.sourceInfo)}
                          />
                          <JournalInfo
                            label="SecurityId（非 SID 字符串）"
                            value={
                              detail.row.securityId === null
                                ? "V4 不包含"
                                : String(detail.row.securityId)
                            }
                          />
                          <JournalInfo
                            label="文件属性标志"
                            value={
                              detail.row.attributes === null
                                ? "V4 不包含"
                                : hex(detail.row.attributes)
                            }
                          />
                        </div>
                        <div className="detail-section-title">
                          变更原因 <small>REASON BITMASK</small>
                        </div>
                        <div className="journal-reason-list">
                          {detail.row.reasons.map((r) => (
                            <code key={r}>{r}</code>
                          ))}
                        </div>
                        <p className="hint">
                          原因可由多个位组成；CLOSE
                          不代表程序执行，也无法仅凭日志确定操作者。重命名旧名与新名分别保留，不在缺乏上下文时自动配对。
                        </p>
                        {detail.row.warnings.map((w, i) => (
                          <p key={i} className="warning-box">
                            <AlertTriangle size={14} />
                            {w}
                          </p>
                        ))}
                        {detail.remainingExtents !== null && (
                          <>
                            <div className="detail-section-title">
                              V4 变更范围{" "}
                              <small>REMAINING {detail.remainingExtents}</small>
                            </div>
                            {detail.extents.slice(0, 128).map((e, i) => (
                              <div className="time-row" key={i}>
                                <span>Extent #{i + 1}</span>
                                <code>
                                  Offset {e.offset} / Length {e.length}
                                </code>
                              </div>
                            ))}
                            {detail.extents.length > 128 && (
                              <p className="hint">
                                显示前 128 / {detail.extents.length}{" "}
                                个范围；全部原始字段保留于日志字节。
                              </p>
                            )}
                          </>
                        )}
                      </>
                    ) : (
                      <>
                        <p className="hint">
                          未经 fixup 或其他重写的原始 USN
                          记录；左列为记录内偏移，输入偏移为 0x
                          {detail.row.offset.toString(16).toUpperCase()}。
                        </p>
                        <div className="hex-view">
                          {detail.hex.slice(0, hexLimit).map((line, i) => (
                            <div className="hex-row" key={i}>
                              <span className="hex-offset">
                                {(i * 16)
                                  .toString(16)
                                  .toUpperCase()
                                  .padStart(6, "0")}
                              </span>
                              <code>{line}</code>
                            </div>
                          ))}
                        </div>
                        {detail.hex.length > hexLimit && (
                          <button
                            className="journal-more"
                            onClick={() => setHexLimit((n) => n + 256)}
                          >
                            继续显示字节（当前 {hexLimit * 16} /{" "}
                            {detail.row.length} B）
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </>
              )
            )}
          </section>
        </div>
      )}
    </main>
  );
}
function JournalInfo({ label, value }: { label: string; value: string }) {
  return (
    <div className="info journal-info">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
