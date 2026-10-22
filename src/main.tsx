import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Database,
  File,
  FileSearch,
  Folder,
  FolderOpen,
  Hexagon,
  Layers,
  LoaderCircle,
  Pause,
  Play,
  Search,
  ShieldCheck,
  X,
  AlertTriangle,
  Settings2,
  Sun,
  Moon,
  Copy,
  ExternalLink,
} from "lucide-react";
import type { Attribute, Detail, Entry, Summary, Times } from "./types";
import "./style.css";
import "./workspace.css";
import "./light.css";
import { JournalHome, JournalResults, type JournalSummary } from "./journal";

const num = (n: number) => n.toLocaleString("en-US");
const size = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1048576
      ? `${(n / 1024).toFixed(1)} KiB`
      : `${(n / 1048576).toFixed(1)} MiB`;
const time = (s: string) =>
  s ? s.replace("T", " ").replace(/\.\d+Z$/, " UTC") : "—";
const filters = [
  { id: "all", label: "全部记录", en: "ALL RECORDS", icon: Layers },
  { id: "active", label: "使用中", en: "ALLOCATED", icon: ShieldCheck },
  { id: "deleted", label: "空闲记录", en: "UNALLOCATED", icon: FileSearch },
  { id: "resident", label: "驻留数据", en: "RESIDENT DATA", icon: Database },
  {
    id: "differences",
    label: "时间差异",
    en: "TIME DIFFERENCES",
    icon: Activity,
  },
  { id: "directories", label: "目录记录", en: "DIRECTORIES", icon: Folder },
];
const themes = [
  { id: "violet", name: "OBSIDIAN", label: "曜石紫", color: "#ac88ef" },
  { id: "blue", name: "MIDNIGHT", label: "午夜蓝", color: "#69b6e4" },
  { id: "red", name: "CARMINE", label: "绯红黑", color: "#d47a88" },
  { id: "light", name: "PORCELAIN", label: "瓷白紫", color: "#7044b0" },
];
const resultsMode =
  new URLSearchParams(location.search).get("view") === "results";
const usnMode = new URLSearchParams(location.search).get("view") === "usn";
function App() {
  const [sourcePath, setSourcePath] = useState("");
  const [artifact, setArtifact] = useState<"mft" | "usn">("mft");
  const [journalPath, setJournalPath] = useState("");
  const [journalSummary, setJournalSummary] = useState<JournalSummary | null>(
    null,
  );
  const selectedPath = artifact === "usn" ? journalPath : sourcePath;
  const lastDarkTheme = useRef(
    localStorage.getItem("aura-dark-theme") || "violet",
  );
  const [theme, setTheme] = useState(
    () => localStorage.getItem("aura-theme") || "violet",
  );
  const [motion, setMotion] = useState(
    () => localStorage.getItem("aura-motion") !== "off",
  );
  const [settings, setSettings] = useState(false),
    [summary, setSummary] = useState<Summary | null>(null),
    [busy, setBusy] = useState(false),
    [progress, setProgress] = useState(0),
    [notice, setNotice] = useState(""),
    [error, setError] = useState("");
  const [filter, setFilter] = useState(
      new URLSearchParams(location.search).get("filter") || "all",
    ),
    [search, setSearch] = useState(""),
    [debounced, setDebounced] = useState(""),
    [page, setPage] = useState(0),
    [rows, setRows] = useState<Entry[]>([]),
    [total, setTotal] = useState(0),
    [querying, setQuerying] = useState(false);
  const [detail, setDetail] = useState<Detail | null>(null),
    [detailBusy, setDetailBusy] = useState(false),
    [tab, setTab] = useState("overview"),
    [selectedAttr, setSelectedAttr] = useState<Attribute | null>(null),
    [raw, setRaw] = useState(false),
    [extracting, setExtracting] = useState(false);
  const queryId = useRef(0),
    detailId = useRef(0),
    input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("aura-theme", theme);
    if (theme !== "light") {
      lastDarkTheme.current = theme;
      localStorage.setItem("aura-dark-theme", theme);
    }
  }, [theme]);
  useEffect(() => {
    document.documentElement.dataset.motion = motion ? "on" : "off";
    localStorage.setItem("aura-motion", motion ? "on" : "off");
  }, [motion]);
  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(search);
      setPage(0);
    }, 250);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    listen<[number, number]>("parse-progress", (e) =>
      setProgress(
        e.payload[1] ? Math.round((e.payload[0] / e.payload[1]) * 100) : 0,
      ),
    ).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        input.current?.focus();
      }
      if (e.key === "Escape") {
        setDetail(null);
        setSettings(false);
        detailId.current++;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
  useEffect(() => {
    if (!summary || !resultsMode) return;
    const id = ++queryId.current;
    setQuerying(true);
    invoke<{ rows: Entry[]; total: number }>("query_records", {
      search: debounced,
      filter,
      page,
      caseId: summary.sha256,
    })
      .then((r) => {
        if (id === queryId.current) {
          setRows(r.rows);
          setTotal(r.total);
        }
      })
      .catch((e) => setError(String(e)))
      .finally(() => {
        if (id === queryId.current) setQuerying(false);
      });
  }, [summary, filter, debounced, page]);
  useEffect(() => {
    const storage = (e: StorageEvent) => {
      if (e.key === "aura-theme" && e.newValue) setTheme(e.newValue);
      if (e.key === "aura-motion") setMotion(e.newValue !== "off");
    };
    window.addEventListener("storage", storage);
    return () => window.removeEventListener("storage", storage);
  }, []);
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const cleanups: (() => void)[] = [];
    const accept = (s: Summary) => {
      queryId.current++;
      detailId.current++;
      setSummary(s);
      setSourcePath(s.source);
      setRows([]);
      setTotal(0);
      setPage(0);
      setSearch("");
      setDetail(null);
      setDetailBusy(false);
    };
    const register = async () => {
      const a = await listen<Summary>("case-changed", (e) => accept(e.payload));
      if (disposed) {
        a();
        return;
      }
      cleanups.push(a);
      const b = await listen<string>("results-filter", (e) => {
        setFilter(filters.some((f) => f.id === e.payload) ? e.payload : "all");
        setPage(0);
        setSearch("");
      });
      if (disposed) {
        b();
        return;
      }
      cleanups.push(b);
      try {
        const s = await invoke<Summary>("get_summary");
        if (!disposed) accept(s);
      } catch {
        /* No evidence loaded yet. */
      }
    };
    void register();
    return () => {
      disposed = true;
      cleanups.forEach((fn) => fn());
    };
  }, []);
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let off: (() => void) | undefined;
    const accept = (s: JournalSummary) => {
      setJournalSummary(s);
      setJournalPath(s.source);
    };
    const setup = async () => {
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
        /* No journal loaded yet. */
      }
    };
    void setup().catch((e) => {
      if (!disposed) setError(String(e));
    });
    return () => {
      disposed = true;
      off?.();
    };
  }, []);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 6500);
    return () => clearTimeout(t);
  }, [notice]);
  async function browse() {
    if (!isTauri()) {
      setError("请在桌面端浏览并导入证据文件。");
      return;
    }
    try {
      const path = await open({
        multiple: false,
        directory: false,
        title:
          artifact === "usn"
            ? "选择原始 $UsnJrnl:$J 数据流"
            : "选择原始 $MFT 文件",
      });
      if (typeof path === "string") {
        if (artifact === "usn") setJournalPath(path);
        else setSourcePath(path);
      }
    } catch (e) {
      setError(String(e));
    }
  }
  async function showResults(target = "all") {
    try {
      await invoke("open_results", { filter: target });
    } catch (e) {
      setError(`无法打开分析窗口：${String(e)}`);
    }
  }
  async function load() {
    if (!isTauri()) {
      setError("请在桌面端导入并解析真实证据。");
      return;
    }
    if (!selectedPath.trim()) return;
    setBusy(true);
    setProgress(0);
    setError("");
    try {
      if (artifact === "usn") {
        const s = await invoke<JournalSummary>("import_journal", {
          path: selectedPath.trim(),
        });
        setJournalSummary(s);
        setNotice(`解析完成 · ${num(s.records)} 条 USN 记录`);
        await invoke("open_journal_results");
      } else {
        const s = await invoke<Summary>("import_mft", {
          path: selectedPath.trim(),
        });
        setSummary(s);
        setNotice(`解析完成 · ${num(s.parsed)} 条有效记录`);
        await showResults();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function select(e: Entry) {
    const id = ++detailId.current;
    setDetailBusy(true);
    setDetail(null);
    setTab("overview");
    setSelectedAttr(null);
    try {
      const d = await invoke<Detail>("get_detail", {
        id: e.id,
        caseId: summary?.sha256,
      });
      if (id === detailId.current) setDetail(d);
    } catch (e) {
      setError(String(e));
    } finally {
      if (id === detailId.current) setDetailBusy(false);
    }
  }
  async function extract(attrId: number, name: string) {
    if (!detail) return;
    try {
      const safe = (detail.entry.name + (name ? "." + name : "")).replace(
        /[<>:"/\\|?*\x00-\x1f]/g,
        "_",
      );
      const path = await save({
        title: "提取驻留数据（请选择新文件名）",
        defaultPath: safe + ".extracted",
      });
      if (!path) return;
      setExtracting(true);
      const result = await invoke<{ bytes: number; sha256: string }>(
        "extract_resident",
        {
          id: detail.entry.id,
          attributeId: attrId,
          path,
          caseId: summary?.sha256,
        },
      );
      setNotice(`已提取 ${result.bytes} 字节 · SHA-256 ${result.sha256}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setExtracting(false);
    }
  }

  const activeSummary = artifact === "usn" ? journalSummary : summary;
  const counts: Record<string, number> = {
    all: summary?.parsed || 0,
    active: summary?.active || 0,
    deleted: summary?.free || 0,
    resident: summary?.resident || 0,
    differences: summary?.differences || 0,
    directories: summary?.directories || 0,
  };
  return (
    <div
      className={`app-shell ${resultsMode || usnMode ? "results-mode" : "landing-mode"}`}
    >
      <div className="ambient" aria-hidden="true">
        <div className="orb orb-one" />
        <div className="orb orb-two" />
        <div className="orbit" />
        <div className="scanline" />
      </div>
      <header className="app-header">
        <a
          className="brand"
          href={usnMode ? "?view=usn" : resultsMode ? "?view=results" : "#"}
          aria-label="Aura 首页"
        >
          <div className="brand-mark">
            <Hexagon size={28} />
            <span>A</span>
          </div>
          <div>
            AURA<span>FORENSIC SYSTEMS</span>
          </div>
        </a>
        <div className="header-context">
          {usnMode
            ? "USN / CHANGE JOURNAL"
            : resultsMode
              ? "EVIDENCE / ANALYSIS"
              : "NTFS / INVESTIGATION WORKSPACE"}
        </div>
        <div className="header-tools">
          <span className="local-badge">
            <ShieldCheck size={13} />
            本地只读分析
          </span>
          <button
            className="icon-button"
            aria-label={theme === "light" ? "切换深色主题" : "切换亮色主题"}
            title={theme === "light" ? "切换深色主题" : "切换亮色主题"}
            onClick={() =>
              setTheme(theme === "light" ? lastDarkTheme.current : "light")
            }
          >
            {theme === "light" ? <Moon size={17} /> : <Sun size={17} />}
          </button>
          <button
            className="icon-button"
            title={motion ? "暂停动效" : "启用动效"}
            onClick={() => setMotion(!motion)}
          >
            {motion ? <Pause size={15} /> : <Play size={15} />}
          </button>
          <button
            className="icon-button"
            aria-label="外观与动效"
            onClick={() => setSettings(true)}
          >
            <Settings2 size={17} />
          </button>
        </div>
      </header>
      {usnMode ? (
        <JournalResults />
      ) : !resultsMode ? (
        <main className="landing-workspace">
          <section className="import-stage">
            <div className="stage-index">
              <span>01 / SOURCE</span>
              <span>THE INVESTIGATION BEGINS.</span>
            </div>
            <div className="landing-title">
              <div className="eyebrow">
                <span /> EVERY RECORD LEAVES A TRACE
              </div>
              <h1>
                {artifact === "usn" ? "USN" : "MFT"}
                <span>LENS</span>
                <sup>✦</sup>
              </h1>
              <p>
                从一份证据，
                <br />
                <strong>进入文件系统的深处。</strong>
              </p>
            </div>
            <div className="source-form">
              <div className="source-kind" role="group" aria-label="证据类型">
                <button
                  className={artifact === "mft" ? "chosen" : ""}
                  aria-pressed={artifact === "mft"}
                  disabled={busy}
                  onClick={() => setArtifact("mft")}
                >
                  $MFT / 文件记录
                </button>
                <button
                  className={artifact === "usn" ? "chosen" : ""}
                  aria-pressed={artifact === "usn"}
                  disabled={busy}
                  onClick={() => setArtifact("usn")}
                >
                  $J / USN Journal
                </button>
              </div>
              <label htmlFor="source-path">
                证据路径 <span>EVIDENCE SOURCE</span>
              </label>
              <div className="path-picker">
                <File size={19} />
                <input
                  id="source-path"
                  aria-label="证据路径"
                  value={selectedPath}
                  onChange={(e) =>
                    artifact === "usn"
                      ? setJournalPath(e.target.value)
                      : setSourcePath(e.target.value)
                  }
                  placeholder={
                    artifact === "usn"
                      ? "选择或粘贴 $UsnJrnl:$J 数据流路径"
                      : "选择或粘贴 $MFT 文件路径"
                  }
                  disabled={busy}
                />
                <button
                  aria-label="浏览文件"
                  disabled={busy}
                  onClick={() => browse()}
                >
                  <FolderOpen size={18} />
                  浏览
                </button>
              </div>
              <div className="source-footnote">
                <ShieldCheck size={12} />
                <span>
                  {artifact === "usn"
                    ? "原始 $J 数据流 · 变长记录 · 保持源文件不变"
                    : "原始 $MFT 文件 · 本地处理 · 保持源文件不变"}
                </span>
              </div>
              <button
                className="primary-button import-button"
                disabled={busy || !selectedPath.trim()}
                onClick={() => load()}
              >
                {busy ? (
                  <LoaderCircle size={19} className="spin" />
                ) : (
                  <ArrowUpRight size={21} />
                )}
                <span>
                  {busy ? "正在解析证据" : "导入并解析"}
                  <small>
                    {busy
                      ? `${progress}% / READING THE EVIDENCE`
                      : "INITIALIZE INVESTIGATION"}
                  </small>
                </span>
                <span className="button-index">↗</span>
              </button>
              {busy && (
                <div
                  className="progress-track"
                  role="progressbar"
                  aria-valuenow={progress}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div style={{ width: `${Math.max(progress, 2)}%` }} />
                </div>
              )}
            </div>
            <div className="stage-bottom">
              <span>
                <span className="live-dot" />{" "}
                {busy
                  ? "PARSING"
                  : activeSummary
                    ? "SOURCE VERIFIED"
                    : "AWAITING SOURCE"}
              </span>
              <span>
                {artifact === "usn"
                  ? "NTFS CHANGE JOURNAL"
                  : "NTFS MASTER FILE TABLE"}
              </span>
            </div>
          </section>
          <section
            className={`operation-stage ${activeSummary ? "ready" : ""}`}
          >
            <div className="stage-index">
              <span>02 / EXPLORE</span>
              <span>
                {activeSummary
                  ? "EVIDENCE IS READY."
                  : "WAITING FOR YOUR SIGNAL."}
              </span>
            </div>
            {artifact === "usn" ? (
              <JournalHome
                summary={journalSummary}
                busy={busy}
                openResults={() => {
                  void invoke("open_journal_results").catch((e) =>
                    setError(String(e)),
                  );
                }}
              />
            ) : summary ? (
              <div className="operation-content" key={summary.sha256}>
                <div className="ready-indicator">
                  <Check size={13} />
                  解析完成 / EVIDENCE VERIFIED
                </div>
                <h2>
                  线索已就位。<span>FOLLOW THE TRACE.</span>
                </h2>
                <div className="case-name">
                  <File size={20} />
                  <div>
                    <strong>{summary.source.split(/[\\/]/).pop()}</strong>
                    <span title={summary.source}>{summary.source}</span>
                  </div>
                </div>
                <div className="operation-stats">
                  <div>
                    <strong>{num(summary.parsed)}</strong>
                    <span>有效记录</span>
                  </div>
                  <div>
                    <strong>{num(summary.resident)}</strong>
                    <span>含可提取驻留流</span>
                  </div>
                </div>
                <div className="case-facts">
                  <span>{size(summary.bytes)}</span>
                  <span>{summary.recordSize} B / RECORD</span>
                  <span>{summary.invalid} 无效记录</span>
                </div>
                <button
                  className="primary-button view-results"
                  disabled={busy}
                  onClick={() => showResults()}
                >
                  <Layers size={18} />
                  <span>
                    打开分析窗口<small>EXPLORE IN A NEW WINDOW</small>
                  </span>
                  <ArrowUpRight size={22} />
                </button>
                <div className="secondary-actions">
                  <button
                    disabled={busy}
                    onClick={() => showResults("resident")}
                  >
                    <ArrowDownToLine size={15} />
                    提取驻留文件
                    <ArrowUpRight size={13} />
                  </button>
                  <button
                    onClick={() =>
                      navigator.clipboard
                        .writeText(summary.sha256)
                        .then(() => setNotice("证据 SHA-256 已复制"))
                        .catch(() => setError("剪贴板不可用"))
                    }
                  >
                    <Copy size={14} />
                    复制证据哈希
                  </button>
                </div>
                <p className="case-fingerprint" title={summary.sha256}>
                  SHA-256 / {summary.sha256}
                </p>
              </div>
            ) : (
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
                    <Database size={29} strokeWidth={1} />
                  </div>
                  <span className="sculpture-cross cross-a">+</span>
                  <span className="sculpture-cross cross-b">+</span>
                  <span className="sculpture-coordinate">0x00000000</span>
                </div>
                <div className="waiting-copy">
                  <span>
                    {busy
                      ? "DECODING THE STRUCTURE"
                      : "NOTHING HIDDEN. JUST UNEXPLORED."}
                  </span>
                  <h2>{busy ? "证据正在展开。" : "下一条线索，在这里。"}</h2>
                  <p>
                    {busy
                      ? "正在校验记录与重建路径，解析完成后自动打开分析窗口。"
                      : "从左侧导入证据，解析完成后在这里继续调查。"}
                  </p>
                </div>
              </div>
            )}
            <div className="stage-bottom">
              <span>RAW DATA. REAL EVIDENCE.</span>
              <span>AURA / 02.00</span>
            </div>
          </section>
        </main>
      ) : (
        <main className="results-main">
          <div className="results-heading">
            <div>
              <span className="micro">FOLLOW THE EVIDENCE</span>
              <h1>
                记录<span>档案</span>
                <sup>↗</sup>
              </h1>
            </div>
            <div className="results-total">
              <strong>{summary ? num(summary.parsed) : "—"}</strong>
              <span>PARSED RECORDS</span>
            </div>
          </div>
          {summary && (
            <section className="evidence-bar">
              <div className="evidence-icon">
                <File size={19} />
              </div>
              <div className="evidence-info">
                <strong>{summary.source.split(/[\\/]/).pop()}</strong>
                <span title={summary.source}>{summary.source}</span>
              </div>
              <div className="evidence-meta">
                <span>SIZE</span>
                <b>{size(summary.bytes)}</b>
              </div>
              <div className="evidence-meta">
                <span>RECORD</span>
                <b>{summary.recordSize} B</b>
              </div>
              <div className="evidence-meta hash" title={summary.sha256}>
                <span>SHA-256</span>
                <b>{summary.sha256.slice(0, 16)}…</b>
              </div>
            </section>
          )}
          <section className="records-panel">
            <div className="panel-heading">
              <div>
                <span className="section-number">01 /</span>
                <h2>
                  记录档案 <small>RECORD ARCHIVE</small>
                </h2>
              </div>
              <span className="panel-count">
                {num(total)} <small>RECORDS</small>
              </span>
            </div>
            <div className="toolbar">
              <div className="filter-tabs" role="tablist" aria-label="记录分类">
                {filters.map((f) => (
                  <button
                    role="tab"
                    aria-selected={filter === f.id}
                    key={f.id}
                    className={filter === f.id ? "chosen" : ""}
                    onClick={() => {
                      setFilter(f.id);
                      setPage(0);
                    }}
                  >
                    {f.label}
                    <span>{summary ? num(counts[f.id]) : "—"}</span>
                  </button>
                ))}
              </div>
              <label className="search">
                <Search size={16} />
                <input
                  ref={input}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="搜索文件名、路径或记录号…"
                  aria-label="搜索记录"
                />
                <kbd>⌃ K</kbd>
              </label>
            </div>
            <div className={`table-wrap ${querying ? "querying" : ""}`}>
              <table>
                <thead>
                  <tr>
                    <th className="col-id">记录 / ID</th>
                    <th>文件名 / NAME</th>
                    <th className="col-status">状态</th>
                    <th className="col-size">逻辑大小</th>
                    <th className="col-date">修改时间 / UTC</th>
                    <th className="col-stream">数据流</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((e) => (
                    <tr
                      key={e.id}
                      tabIndex={0}
                      onClick={() => select(e)}
                      onKeyDown={(ev) => {
                        if (ev.key === "Enter") select(e);
                      }}
                      aria-label={`查看 ${e.name}`}
                    >
                      <td className="record-id">
                        {String(e.id).padStart(6, "0")}
                        <small>:{e.sequence}</small>
                      </td>
                      <td>
                        <div className="file-cell">
                          <span
                            className={`file-icon ${e.directory ? "directory" : ""}`}
                          >
                            {e.directory ? (
                              <Folder size={18} />
                            ) : (
                              <File size={18} />
                            )}
                          </span>
                          <div>
                            <strong>{e.name}</strong>
                            <span title={e.path}>{e.path}</span>
                          </div>
                          {e.timeDifference && (
                            <span
                              title="SI/FN 时间存在差异，需结合上下文调查"
                              className="difference-dot"
                            />
                          )}
                        </div>
                      </td>
                      <td>
                        <span
                          className={`status-pill ${e.inUse ? "allocated" : "free"}`}
                        >
                          {e.inUse ? "使用中" : "空闲"}
                          {e.extension ? " · 扩展" : ""}
                        </span>
                      </td>
                      <td className="mono">
                        {e.directory ? "—" : size(e.size)}
                      </td>
                      <td className="date-cell">
                        {time(e.modified)
                          .replace(" UTC", "")
                          .replace(/\.\d+/, "")}
                      </td>
                      <td>
                        {e.resident ? (
                          <span className="resident-label">
                            <Database size={12} />
                            驻留
                          </span>
                        ) : (
                          <span className="muted">
                            {e.streams ? "非驻留" : "—"}
                          </span>
                        )}
                      </td>
                      <td>
                        <ChevronRight size={15} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!rows.length && (
                <div className="empty-state">
                  <div className="empty-symbol">
                    <Hexagon size={78} strokeWidth={0.6} />
                    <FileSearch size={29} strokeWidth={1} />
                    <span />
                  </div>
                  <div className="micro">
                    {summary
                      ? "NO MATCHING RECORDS"
                      : "YOUR INVESTIGATION STARTS HERE"}
                  </div>
                  <h3>{summary ? "没有匹配的记录" : "让证据，自己说话。"}</h3>
                  <p>
                    {summary
                      ? "尝试其他关键词，或切换记录分类。"
                      : "请先在主窗口导入证据。"}
                  </p>
                </div>
              )}
            </div>
            <div className="pagination">
              <span>
                {summary
                  ? `显示 ${total ? page * 80 + 1 : 0}–${Math.min((page + 1) * 80, total)} / ${num(total)} 条`
                  : "RAW METADATA → ACTIONABLE CONTEXT"}
                {querying && <LoaderCircle size={13} className="spin" />}
              </span>
              <div>
                <span>80 / 页</span>
                <button
                  aria-label="上一页"
                  disabled={page === 0 || busy}
                  onClick={() => setPage((p) => p - 1)}
                >
                  <ChevronLeft size={16} />
                </button>
                <b>{String(page + 1).padStart(2, "0")}</b>
                <button
                  aria-label="下一页"
                  disabled={(page + 1) * 80 >= total || busy}
                  onClick={() => setPage((p) => p + 1)}
                >
                  <ChevronRight size={16} />
                </button>
              </div>
            </div>
          </section>
          {summary && (
            <div className="parse-notes">
              <ShieldCheck size={14} />
              <span>
                {num(summary.empty)} 空槽 · {num(summary.invalid)} 无效记录 ·{" "}
                {num(summary.extensions)} 扩展记录 · 尾部 {summary.partial} 字节
              </span>
              <span>空闲 ≠ 已删除文件数量 / 扩展属性尚未合并</span>
            </div>
          )}
          <footer>
            <span>
              AURA <b>/</b> MFT LENS
            </span>
            <span>BUILT FOR THE DETAILS.</span>
            <span>
              <span className="live-dot" />
              {isTauri() ? "DESKTOP ENGINE READY" : "INTERFACE PREVIEW"}{" "}
              <b>02.00</b>
            </span>
          </footer>
        </main>
      )}
      {error && (
        <div className="toast error" role="alert">
          <AlertTriangle size={18} />
          <span>{error}</span>
          <button aria-label="关闭错误" onClick={() => setError("")}>
            <X size={16} />
          </button>
        </div>
      )}
      {notice && (
        <div className="toast" role="status">
          <Check size={18} />
          <span>{notice}</span>
          <button aria-label="关闭通知" onClick={() => setNotice("")}>
            <X size={16} />
          </button>
        </div>
      )}
      {(detail || detailBusy) && (
        <div
          className="drawer-backdrop"
          onClick={() => {
            detailId.current++;
            setDetail(null);
            setDetailBusy(false);
          }}
        >
          <section
            className="detail-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="记录调查卡片"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="drawer-header">
              <span className="micro">EVIDENCE / RECORD INSPECTOR</span>
              <button
                className="icon-button"
                aria-label="关闭详情"
                onClick={() => {
                  detailId.current++;
                  setDetail(null);
                  setDetailBusy(false);
                }}
              >
                <X size={20} />
              </button>
            </div>
            {detailBusy ? (
              <div className="detail-loading">
                <LoaderCircle className="spin" />
                正在解析记录…
              </div>
            ) : (
              detail && (
                <>
                  <div className="detail-title">
                    <span>
                      #{String(detail.entry.id).padStart(6, "0")} :{" "}
                      {detail.entry.sequence}
                    </span>
                    <h2>{detail.entry.name}</h2>
                    <p>{detail.entry.path}</p>
                    <div>
                      <span
                        className={`status-pill ${detail.entry.inUse ? "allocated" : "free"}`}
                      >
                        {detail.entry.inUse ? "使用中" : "空闲"}
                      </span>
                      <span className="status-pill">
                        {detail.entry.pathStatus}
                      </span>
                      {detail.entry.extension && (
                        <span className="status-pill">
                          扩展 → #{detail.entry.baseId}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="detail-tabs">
                    {[
                      { id: "overview", name: "调查概览" },
                      {
                        id: "streams",
                        name: `数据流 (${detail.streams.length})`,
                      },
                      { id: "hex", name: "原始证据" },
                    ].map((t) => (
                      <button
                        className={tab === t.id ? "chosen" : ""}
                        key={t.id}
                        onClick={() => setTab(t.id)}
                      >
                        {t.name}
                      </button>
                    ))}
                  </div>
                  <div className="detail-body">
                    {tab === "overview" && (
                      <>
                        <div className="detail-grid">
                          <Info
                            label="输入文件偏移"
                            value={`0x${detail.offset.toString(16).toUpperCase()}`}
                          />
                          <Info
                            label="记录 / 已用空间"
                            value={`${detail.recordSize} / ${detail.usedSize} B`}
                          />
                          <Info
                            label="默认流逻辑大小"
                            value={size(detail.entry.size)}
                          />
                          <Info
                            label="属性数量"
                            value={String(detail.attributes.length)}
                          />
                        </div>
                        <div className="detail-section-title">
                          时间对照 <small>UTC / SI → FN</small>
                        </div>
                        <p className="hint">
                          时间差异是调查线索，不能单独证明篡改。MFT
                          不是完整操作历史。
                        </p>
                        <div className="time-table">
                          <div className="time-row time-head">
                            <span>字段</span>
                            <span>STANDARD INFORMATION</span>
                          </div>
                          {(
                            [
                              "created",
                              "modified",
                              "changed",
                              "accessed",
                            ] as (keyof Times)[]
                          ).map((k, i) => (
                            <div className="time-row" key={k}>
                              <span>
                                {["创建", "内容修改", "元数据修改", "访问"][i]}
                              </span>
                              <code title={detail.si.raw[i]}>
                                {time(detail.si[k] as string)}
                              </code>
                            </div>
                          ))}
                        </div>
                        {detail.names.map((n, i) => (
                          <div key={i} className="fn-card">
                            <div>
                              <strong>{n.name}</strong>
                              <small>
                                FN #{i + 1} / NS {n.namespace} / PARENT{" "}
                                {n.parent}:{n.parentSequence}
                              </small>
                            </div>
                            {(
                              [
                                "created",
                                "modified",
                                "changed",
                                "accessed",
                              ] as (keyof Times)[]
                            ).map((k, j) => (
                              <div
                                className={`time-row ${detail.si[k] && detail.si[k] !== n.times[k] ? "diff" : ""}`}
                                key={k}
                              >
                                <span>
                                  {
                                    ["创建", "内容修改", "元数据修改", "访问"][
                                      j
                                    ]
                                  }
                                </span>
                                <code title={n.times.raw[j]}>
                                  {time(n.times[k] as string)}
                                </code>
                              </div>
                            ))}
                          </div>
                        ))}
                        {detail.entry.warnings.map((w, i) => (
                          <p className="warning-box" key={i}>
                            <AlertTriangle size={15} />
                            {w}
                          </p>
                        ))}
                        <div className="detail-section-title">
                          属性结构 <small>CLICK TO INSPECT BYTES</small>
                        </div>
                        {detail.attributes.map((a) => (
                          <button
                            className="attribute-row"
                            key={a.id}
                            onClick={() => {
                              setSelectedAttr(a);
                              setTab("hex");
                            }}
                          >
                            <span className="mono">
                              0x{a.kind.toString(16).toUpperCase()}
                            </span>
                            <strong>
                              {a.label}
                              {a.name && ` : ${a.name}`}
                            </strong>
                            <span>{a.length} B</span>
                            <ChevronRight size={14} />
                          </button>
                        ))}
                      </>
                    )}
                    {tab === "streams" && (
                      <>
                        <p className="hint">
                          驻留 $DATA 可从经过 fixup
                          还原的记录中精确提取。非驻留流需要原卷或镜像。保存时不会覆盖已有文件。
                        </p>
                        {!detail.streams.length && (
                          <div className="stream-empty">
                            此记录没有 $DATA 属性。
                          </div>
                        )}
                        {detail.streams.map((s) => (
                          <article className="stream-card" key={s.id}>
                            <div className="stream-heading">
                              <Database size={21} />
                              <div>
                                <strong>{s.name || "默认数据流"}</strong>
                                <small>$DATA · ATTRIBUTE #{s.id}</small>
                              </div>
                              <span className="status-pill">
                                {s.resident ? "驻留" : "非驻留"}
                              </span>
                            </div>
                            <div className="stream-meta">
                              <span>{size(s.size)}</span>
                              <span>
                                {s.name
                                  ? "NAMED STREAM / ADS"
                                  : "UNNAMED STREAM"}
                              </span>
                            </div>
                            {s.resident ? (
                              <>
                                <div className="preview-label">
                                  TEXT PREVIEW / UTF-8 LOSSY
                                </div>
                                <pre className="stream-preview">
                                  {s.preview || "（空数据流）"}
                                </pre>
                                <div className="preview-label">SHA-256</div>
                                <code className="hash-code">{s.sha256}</code>
                                <button
                                  className="primary-button extract-button"
                                  disabled={
                                    extracting || (s.flags & 0x4001) !== 0
                                  }
                                  onClick={() => extract(s.id, s.name)}
                                >
                                  <ArrowDownToLine size={17} />
                                  <span>
                                    {extracting ? "正在保存" : "提取此数据流"}
                                  </span>
                                  <ArrowUpRight size={17} />
                                </button>
                                {(s.flags & 0x4001) !== 0 && (
                                  <p className="hint">
                                    压缩或加密流暂不支持解码提取。
                                  </p>
                                )}
                              </>
                            ) : (
                              <div className="nonresident-note">
                                <ExternalLink size={17} />
                                数据位于 MFT 外部，当前证据不包含文件内容。
                              </div>
                            )}
                          </article>
                        ))}
                      </>
                    )}
                    {tab === "hex" && (
                      <>
                        <div className="hex-toolbar">
                          <div>
                            <button
                              className={!raw ? "chosen" : ""}
                              onClick={() => setRaw(false)}
                            >
                              Fixup 还原后
                            </button>
                            <button
                              className={raw ? "chosen" : ""}
                              onClick={() => setRaw(true)}
                            >
                              输入原始字节
                            </button>
                          </div>
                          <button
                            className="text-button"
                            onClick={() => setSelectedAttr(null)}
                          >
                            清除高亮
                          </button>
                        </div>
                        <p className="hint">
                          {selectedAttr
                            ? `${selectedAttr.label} · 记录内偏移 0x${selectedAttr.offset.toString(16).toUpperCase()} · ${selectedAttr.length} 字节`
                            : "左列为记录内偏移；输入文件偏移 = 记录偏移 + 左列偏移。"}
                        </p>
                        <div className="hex-view">
                          <div className="hex-head">
                            OFFSET　　00 01 02 03 04 05 06 07　08 09 0A 0B 0C 0D
                            0E 0F
                          </div>
                          {(raw ? detail.rawHex : detail.fixedHex).map(
                            (line, i) => (
                              <div className="hex-row" key={i}>
                                <span className="hex-offset">
                                  {(i * 16)
                                    .toString(16)
                                    .toUpperCase()
                                    .padStart(6, "0")}
                                </span>
                                <code>
                                  {line.split(" ").map((b, j) => (
                                    <span
                                      className={
                                        selectedAttr &&
                                        i * 16 + j >= selectedAttr.offset &&
                                        i * 16 + j <
                                          selectedAttr.offset +
                                            selectedAttr.length
                                          ? "highlight"
                                          : ""
                                      }
                                      key={j}
                                    >
                                      {b}{" "}
                                    </span>
                                  ))}
                                </code>
                                <span className="hex-ascii">
                                  {line
                                    .split(" ")
                                    .map((b) => {
                                      const n = parseInt(b, 16);
                                      return n >= 32 && n < 127
                                        ? String.fromCharCode(n)
                                        : ".";
                                    })
                                    .join("")}
                                </span>
                              </div>
                            ),
                          )}
                        </div>
                      </>
                    )}
                  </div>
                </>
              )
            )}
          </section>
        </div>
      )}
      {settings && (
        <div className="modal-backdrop" onClick={() => setSettings(false)}>
          <section
            className="settings-modal"
            role="dialog"
            aria-modal="true"
            aria-label="外观与动效"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="drawer-header">
              <span className="micro">PERSONALIZE YOUR WORKSPACE</span>
              <button
                className="icon-button"
                aria-label="关闭设置"
                onClick={() => setSettings(false)}
              >
                <X size={20} />
              </button>
            </div>
            <h2>
              选择你的色调<span>APPEARANCE</span>
            </h2>
            <div className="theme-list">
              {themes.map((t) => (
                <button
                  className={theme === t.id ? "selected" : ""}
                  key={t.id}
                  onClick={() => setTheme(t.id)}
                >
                  <span
                    className="theme-swatch"
                    style={{
                      background: `linear-gradient(135deg,${t.id === "light" ? "#f5f2fa" : "#100f16"} 48%,${t.color} 49%,${t.color} 60%,${t.id === "light" ? "#e2d9ef" : "#211c29"} 61%)`,
                    }}
                  />
                  <strong>
                    {t.label}
                    <small>{t.name}</small>
                  </strong>
                  {theme === t.id && <Check size={17} />}
                </button>
              ))}
            </div>
            <div className="motion-setting">
              <div>
                <strong>环境动效</strong>
                <p>流动光晕、轨道与扫描线</p>
              </div>
              <button
                role="switch"
                aria-checked={motion}
                aria-label="环境动效"
                className={`toggle ${motion ? "on" : ""}`}
                onClick={() => setMotion(!motion)}
              >
                <span />
              </button>
            </div>
            <p className="hint">
              系统启用“减少动态效果”时，自动降低动画。数据阅读区域保持稳定。
            </p>
          </section>
        </div>
      )}
    </div>
  );
}
function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="info">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
