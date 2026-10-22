//! Offline logical $UsnJrnl:$J streams. Not FSCTL response buffers or disk images.
use crate::mft::Case;
use chrono::{DateTime, Utc};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{fs::File, io::Read, path::Path, sync::Arc};

const MAX_RECORD: usize = 1024 * 1024;
const PAGE_SIZE: usize = 80;
fn u16le(b: &[u8], o: usize) -> u16 {
    u16::from_le_bytes(b[o..o + 2].try_into().unwrap())
}
fn u32le(b: &[u8], o: usize) -> u32 {
    u32::from_le_bytes(b[o..o + 4].try_into().unwrap())
}
fn u64le(b: &[u8], o: usize) -> u64 {
    u64::from_le_bytes(b[o..o + 8].try_into().unwrap())
}
fn i64le(b: &[u8], o: usize) -> i64 {
    i64::from_le_bytes(b[o..o + 8].try_into().unwrap())
}
fn filetime(value: u64) -> String {
    if value == 0 {
        return String::new();
    }
    let secs = (value / 10_000_000) as i64 - 11_644_473_600;
    DateTime::<Utc>::from_timestamp(secs, ((value % 10_000_000) * 100) as u32)
        .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true))
        .unwrap_or_default()
}
fn hex_id(bytes: &[u8]) -> String {
    format!(
        "0x{}",
        bytes
            .iter()
            .rev()
            .map(|v| format!("{v:02X}"))
            .collect::<String>()
    )
}
pub fn reason_names(reason: u32) -> Vec<String> {
    let flags = [
        (0x1, "DATA_OVERWRITE"),
        (0x2, "DATA_EXTEND"),
        (0x4, "DATA_TRUNCATION"),
        (0x10, "NAMED_DATA_OVERWRITE"),
        (0x20, "NAMED_DATA_EXTEND"),
        (0x40, "NAMED_DATA_TRUNCATION"),
        (0x100, "FILE_CREATE"),
        (0x200, "FILE_DELETE"),
        (0x400, "EA_CHANGE"),
        (0x800, "SECURITY_CHANGE"),
        (0x1000, "RENAME_OLD_NAME"),
        (0x2000, "RENAME_NEW_NAME"),
        (0x4000, "INDEXABLE_CHANGE"),
        (0x8000, "BASIC_INFO_CHANGE"),
        (0x10000, "HARD_LINK_CHANGE"),
        (0x20000, "COMPRESSION_CHANGE"),
        (0x40000, "ENCRYPTION_CHANGE"),
        (0x80000, "OBJECT_ID_CHANGE"),
        (0x100000, "REPARSE_POINT_CHANGE"),
        (0x200000, "STREAM_CHANGE"),
        (0x400000, "TRANSACTED_CHANGE"),
        (0x800000, "INTEGRITY_CHANGE"),
        (0x80000000, "CLOSE"),
    ];
    let mut result = Vec::new();
    let mut known = 0;
    for (mask, label) in flags {
        known |= mask;
        if reason & mask != 0 {
            result.push(label.into());
        }
    }
    if reason & !known != 0 {
        result.push(format!("UNKNOWN_0x{:08X}", reason & !known));
    }
    result
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub id: usize,
    pub offset: u64,
    pub length: usize,
    pub major: u16,
    pub minor: u16,
    pub file_reference: String,
    pub parent_reference: String,
    pub usn: String,
    pub timestamp: String,
    pub raw_timestamp: String,
    pub name: String,
    pub reason: u32,
    pub reasons: Vec<String>,
    pub source_info: u32,
    pub security_id: Option<u32>,
    pub attributes: Option<u32>,
    pub warnings: Vec<String>,
    #[serde(skip)]
    pub file_ref_v2: Option<u64>,
    #[serde(skip)]
    pub parent_ref_v2: Option<u64>,
    #[serde(skip)]
    raw: Vec<u8>,
}
#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub source: String,
    pub sha256: String,
    pub bytes: u64,
    pub records: usize,
    pub v2: usize,
    pub v3: usize,
    pub v4: usize,
    pub creates: usize,
    pub deletes: usize,
    pub renames: usize,
    pub writes: usize,
    pub closed: usize,
    pub padding_bytes: u64,
    pub skipped_bytes: u64,
    pub unsupported: usize,
    pub truncated_bytes: u64,
    pub start_time: String,
    pub end_time: String,
    pub diagnostics: Vec<String>,
    pub session_id: String,
    pub linked_mft: String,
    pub linked_mft_source: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    #[serde(flatten)]
    pub record: Record,
    pub path: String,
    pub path_status: String,
}
#[derive(Serialize)]
pub struct Page {
    pub rows: Vec<Row>,
    pub total: usize,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Extent {
    pub offset: String,
    pub length: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Detail {
    pub row: Row,
    pub hex: Vec<String>,
    pub extents: Vec<Extent>,
    pub remaining_extents: Option<u32>,
}
pub struct Journal {
    pub records: Vec<Record>,
    pub summary: Summary,
}
pub struct Session {
    pub journal: Arc<Journal>,
    pub mft: Option<Arc<Case>>,
}

fn parse_record(raw: &[u8], offset: u64, id: usize) -> Result<Record, String> {
    if raw.len() < 8 {
        return Err("公共记录头被截断".into());
    }
    let length = u32le(raw, 0) as usize;
    let major = u16le(raw, 4);
    let minor = u16le(raw, 6);
    if length != raw.len() || length % 8 != 0 || length > MAX_RECORD {
        return Err("记录长度或对齐无效".into());
    }
    if minor != 0 {
        return Err(format!("暂不支持版本 {major}.{minor}"));
    }
    let (reference_size, usn_pos) = match major {
        2 => (8, 24),
        3 | 4 => (16, 40),
        _ => return Err("不支持的主版本".into()),
    };
    let minimum = match major {
        2 => 60,
        3 => 76,
        _ => 64,
    };
    if raw.len() < minimum {
        return Err("版本记录头被截断".into());
    }
    let mut record = Record {
        id,
        offset,
        length,
        major,
        minor,
        file_reference: hex_id(&raw[8..8 + reference_size]),
        parent_reference: hex_id(&raw[8 + reference_size..8 + reference_size * 2]),
        usn: i64le(raw, usn_pos).to_string(),
        timestamp: String::new(),
        raw_timestamp: String::new(),
        name: String::new(),
        reason: 0,
        reasons: vec![],
        source_info: 0,
        security_id: None,
        attributes: None,
        warnings: vec![],
        file_ref_v2: if major == 2 {
            Some(u64le(raw, 8))
        } else {
            None
        },
        parent_ref_v2: if major == 2 {
            Some(u64le(raw, 16))
        } else {
            None
        },
        raw: raw.to_vec(),
    };
    if major == 4 {
        let count = u16le(raw, 60) as usize;
        let stride = u16le(raw, 62) as usize;
        if stride < 16 || 64 + count * stride > length {
            return Err("V4 extent 数组越界或步长无效".into());
        }
        record.reason = u32le(raw, 48);
        record.source_info = u32le(raw, 52);
        record
            .warnings
            .push("V4 为范围跟踪记录，不包含文件名和时间戳；不自动拼接后续 extent".into());
    } else {
        let time_pos = usn_pos + 8;
        let value = u64le(raw, time_pos);
        record.timestamp = filetime(value);
        record.raw_timestamp = value.to_string();
        let reason_pos = time_pos + 8;
        record.reason = u32le(raw, reason_pos);
        record.source_info = u32le(raw, reason_pos + 4);
        record.security_id = Some(u32le(raw, reason_pos + 8));
        record.attributes = Some(u32le(raw, reason_pos + 12));
        let name_length = u16le(raw, reason_pos + 16) as usize;
        let name_offset = u16le(raw, reason_pos + 18) as usize;
        if name_length % 2 != 0
            || name_offset % 2 != 0
            || name_offset < minimum
            || name_offset > length
            || name_length > length - name_offset
        {
            return Err("UTF-16 文件名长度或偏移越界".into());
        }
        let units: Vec<_> = raw[name_offset..name_offset + name_length]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        record.name = match String::from_utf16(&units) {
            Ok(s) => s,
            Err(_) => {
                record
                    .warnings
                    .push("文件名含无效 UTF-16，显示时使用替代字符；原始字节仍保留".into());
                String::from_utf16_lossy(&units)
            }
        };
        if value != 0 && record.timestamp.is_empty() {
            record.warnings.push("时间戳超出显示范围".into());
        }
    }
    record.reasons = reason_names(record.reason);
    Ok(record)
}
impl Journal {
    pub fn load(path: &Path, progress: impl Fn(u64, u64)) -> Result<Self, String> {
        let file = File::open(path).map_err(|e| format!("读取 $J 失败：{e}"))?;
        let before = file.metadata().map_err(|e| e.to_string())?;
        let mut journal = Self::scan(
            file,
            path.to_string_lossy().into_owned(),
            before.len(),
            progress,
        )?;
        let after = std::fs::metadata(path).map_err(|e| e.to_string())?;
        if before.len() != after.len() || before.modified().ok() != after.modified().ok() {
            return Err("输入在读取时发生变化，请导入稳定的离线副本".into());
        }
        journal.summary.session_id = format!("{}:none", journal.summary.sha256);
        Ok(journal)
    }
    fn scan(
        mut reader: impl Read,
        source: String,
        total: u64,
        progress: impl Fn(u64, u64),
    ) -> Result<Self, String> {
        let mut summary = Summary {
            source,
            bytes: total,
            ..Default::default()
        };
        let mut records = Vec::new();
        let mut digest = Sha256::new();
        let mut buffer = Vec::new();
        let mut chunk = vec![0u8; 64 * 1024];
        let mut base = 0u64;
        let mut read_bytes = 0u64;
        let mut reported = 0u64;
        let mut min_time = u64::MAX;
        let mut max_time = 0;
        loop {
            let n = reader
                .read(&mut chunk)
                .map_err(|e| format!("读取日志中断：{e}"))?;
            let eof = n == 0;
            if n > 0 {
                digest.update(&chunk[..n]);
                buffer.extend_from_slice(&chunk[..n]);
                read_bytes += n as u64;
                if read_bytes - reported >= 8 * 1024 * 1024 || read_bytes == total {
                    progress(read_bytes, total);
                    reported = read_bytes;
                }
            }
            let mut cursor = 0;
            while buffer.len() - cursor >= 8 {
                let head = &buffer[cursor..cursor + 8];
                if head.iter().all(|b| *b == 0) {
                    summary.padding_bytes += 8;
                    cursor += 8;
                    continue;
                }
                let length = u32le(head, 0) as usize;
                let major = u16le(head, 4);
                let minor = u16le(head, 6);
                if length < 8 || length % 8 != 0 || length > MAX_RECORD || major == 0 || major > 255
                {
                    summary.skipped_bytes += 8;
                    cursor += 8;
                    continue;
                }
                if length > buffer.len() - cursor {
                    if !eof {
                        break;
                    }
                    summary.truncated_bytes += (buffer.len() - cursor) as u64;
                    if summary.diagnostics.len() < 100 {
                        summary.diagnostics.push(format!(
                            "偏移 0x{:X}：尾部记录被截断，声明 {length} 字节",
                            base + cursor as u64
                        ));
                    }
                    cursor = buffer.len();
                    break;
                }
                if ![2, 3, 4].contains(&major) || minor != 0 {
                    summary.unsupported += 1;
                    if summary.diagnostics.len() < 100 {
                        summary.diagnostics.push(format!(
                            "偏移 0x{:X}：跳过不支持的版本 {major}.{minor}",
                            base + cursor as u64
                        ));
                    }
                    cursor += length;
                    continue;
                }
                match parse_record(
                    &buffer[cursor..cursor + length],
                    base + cursor as u64,
                    records.len(),
                ) {
                    Ok(record) => {
                        match major {
                            2 => summary.v2 += 1,
                            3 => summary.v3 += 1,
                            _ => summary.v4 += 1,
                        }
                        if record.reason & 0x100 != 0 {
                            summary.creates += 1;
                        }
                        if record.reason & 0x200 != 0 {
                            summary.deletes += 1;
                        }
                        if record.reason & 0x3000 != 0 {
                            summary.renames += 1;
                        }
                        if record.reason & 0x77 != 0 {
                            summary.writes += 1;
                        }
                        if record.reason & 0x80000000 != 0 {
                            summary.closed += 1;
                        }
                        if let Ok(t) = record.raw_timestamp.parse::<u64>() {
                            if t > 0 && !record.timestamp.is_empty() {
                                min_time = min_time.min(t);
                                max_time = max_time.max(t);
                            }
                        }
                        records.push(record);
                        cursor += length;
                    }
                    Err(error) => {
                        summary.skipped_bytes += 8;
                        if summary.diagnostics.len() < 100 {
                            summary.diagnostics.push(format!(
                                "偏移 0x{:X}：{error}；尝试按 8 字节重新同步",
                                base + cursor as u64
                            ));
                        }
                        cursor += 8;
                    }
                }
            }
            if eof {
                let tail = &buffer[cursor..];
                if tail.iter().all(|b| *b == 0) {
                    summary.padding_bytes += tail.len() as u64;
                } else {
                    summary.truncated_bytes += tail.len() as u64;
                }
                break;
            }
            buffer.drain(..cursor);
            base += cursor as u64;
        }
        if records.is_empty() {
            return Err(format!("未找到支持的 USN V2/V3/V4 记录。请选择原始 $UsnJrnl:$J 数据流；空白 {} 字节，跳过 {} 字节，不支持版本 {} 条",summary.padding_bytes,summary.skipped_bytes,summary.unsupported));
        }
        summary.records = records.len();
        summary.bytes = read_bytes;
        summary.sha256 = format!("{:x}", digest.finalize());
        if max_time > 0 {
            summary.start_time = filetime(min_time);
            summary.end_time = filetime(max_time);
        }
        progress(read_bytes, total);
        Ok(Self { records, summary })
    }
}
impl Session {
    pub fn summary(&self) -> Summary {
        let mut s = self.journal.summary.clone();
        if let Some(mft) = &self.mft {
            s.linked_mft = mft.summary.sha256.clone();
            s.linked_mft_source = mft.summary.source.clone();
        }
        s.session_id = format!(
            "{}:{}",
            s.sha256,
            if s.linked_mft.is_empty() {
                "none"
            } else {
                &s.linked_mft
            }
        );
        s
    }
    pub fn row(&self, r: &Record) -> Row {
        let mut path = String::new();
        let status = if let Some(mft) = &self.mft {
            if let (Some(parent), Some(file)) = (r.parent_ref_v2, r.file_ref_v2) {
                let parent_id = parent & 0x0000ffffffffffff;
                let seq = (parent >> 48) as u16;
                if let Some(index) = mft.by_id.get(&parent_id) {
                    let p = &mft.entries[*index];
                    if p.sequence != seq {
                        "父引用序列号失效"
                    } else if !p.directory || p.path_status != "已重建" {
                        "MFT 父路径不完整"
                    } else if r.name.contains(['\\', '/', '\0']) {
                        "文件名含路径分隔符，未拼接"
                    } else {
                        path = format!("{}\\{}", p.path.trim_end_matches('\\'), r.name);
                        let stale = mft
                            .by_id
                            .get(&(file & 0x0000ffffffffffff))
                            .map(|i| mft.entries[*i].sequence != (file >> 48) as u16)
                            .unwrap_or(false);
                        if stale {
                            "父目录快照推导；文件记录已复用"
                        } else {
                            "父目录匹配 · MFT 快照路径"
                        }
                    }
                } else {
                    "MFT 父记录缺失"
                }
            } else {
                "128 位标识不参与 NTFS 引用关联"
            }
        } else {
            "未关联 MFT"
        };
        Row {
            record: r.clone(),
            path,
            path_status: status.into(),
        }
    }
    pub fn query(&self, search: &str, filter: &str, page: usize) -> Page {
        let needle = search.trim().to_lowercase();
        let mut total = 0;
        let mut rows = Vec::new();
        let begin = page.saturating_mul(PAGE_SIZE);
        for r in &self.journal.records {
            let mask = match filter {
                "created" => 0x100,
                "deleted" => 0x200,
                "renamed" => 0x3000,
                "written" => 0x77,
                "closed" => 0x80000000,
                _ => 0,
            };
            if mask != 0 && r.reason & mask == 0 {
                continue;
            }
            let row = if needle.is_empty() {
                None
            } else {
                Some(self.row(r))
            };
            if !needle.is_empty()
                && !r.name.to_lowercase().contains(&needle)
                && !r.file_reference.to_lowercase().contains(&needle)
                && r.usn != needle
                && !r.reasons.iter().any(|s| s.to_lowercase().contains(&needle))
                && !row.as_ref().unwrap().path.to_lowercase().contains(&needle)
            {
                continue;
            }
            if total >= begin && rows.len() < PAGE_SIZE {
                rows.push(row.unwrap_or_else(|| self.row(r)));
            }
            total += 1;
        }
        Page { rows, total }
    }
    pub fn detail(&self, id: usize) -> Result<Detail, String> {
        let r = self.journal.records.get(id).ok_or("USN 记录不存在")?;
        let mut extents = Vec::new();
        let mut remaining = None;
        if r.major == 4 {
            remaining = Some(u32le(&r.raw, 56));
            let stride = u16le(&r.raw, 62) as usize;
            for n in 0..u16le(&r.raw, 60) as usize {
                let o = 64 + n * stride;
                extents.push(Extent {
                    offset: i64le(&r.raw, o).to_string(),
                    length: i64le(&r.raw, o + 8).to_string(),
                });
            }
        }
        let hex = r
            .raw
            .chunks(16)
            .map(|line| {
                line.iter()
                    .map(|b| format!("{b:02X}"))
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .collect();
        Ok(Detail {
            row: self.row(r),
            hex,
            extents,
            remaining_extents: remaining,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    pub fn fixture(version: u16, name: &str, reason: u32) -> Vec<u8> {
        let minimum = if version == 2 { 60 } else { 76 };
        let text = name
            .encode_utf16()
            .flat_map(|c| c.to_le_bytes())
            .collect::<Vec<_>>();
        let length = (minimum + text.len() + 7) & !7;
        let mut b = vec![0; length];
        b[..4].copy_from_slice(&(length as u32).to_le_bytes());
        b[4..6].copy_from_slice(&version.to_le_bytes());
        let u = if version == 2 { 24 } else { 40 };
        b[8..16].copy_from_slice(&((7u64 << 48) | 27).to_le_bytes());
        let parent = if version == 2 { 16 } else { 24 };
        b[parent..parent + 8].copy_from_slice(&((1u64 << 48) | 5).to_le_bytes());
        b[u..u + 8].copy_from_slice(&9007199254740999i64.to_le_bytes());
        b[u + 8..u + 16].copy_from_slice(&134000000000000000u64.to_le_bytes());
        b[u + 16..u + 20].copy_from_slice(&reason.to_le_bytes());
        b[u + 28..u + 32].copy_from_slice(&0x20u32.to_le_bytes());
        b[u + 32..u + 34].copy_from_slice(&(text.len() as u16).to_le_bytes());
        b[u + 34..u + 36].copy_from_slice(&(minimum as u16).to_le_bytes());
        b[minimum..minimum + text.len()].copy_from_slice(&text);
        b
    }
    fn scan(b: Vec<u8>) -> Journal {
        Journal::scan(Cursor::new(&b), "fixture".into(), b.len() as u64, |_, _| {}).unwrap()
    }
    #[test]
    fn v2_unicode_flags_and_exact_usn() {
        let b = fixture(2, "调查🚀.txt", 0x80000102);
        let r = parse_record(&b, 4096, 0).unwrap();
        assert_eq!(r.name, "调查🚀.txt");
        assert_eq!(r.usn, "9007199254740999");
        assert_eq!(r.reasons, vec!["DATA_EXTEND", "FILE_CREATE", "CLOSE"]);
        assert_eq!(r.offset, 4096);
    }
    #[test]
    fn v3_keeps_all_128_bits() {
        let mut b = fixture(3, "v3.txt", 0x200);
        b[23] = 0xab;
        let r = parse_record(&b, 0, 0).unwrap();
        assert!(r.file_reference.starts_with("0xAB"));
        assert!(r.file_ref_v2.is_none());
    }
    #[test]
    fn v4_extents_without_fabricated_time_or_name() {
        let mut b = vec![0u8; 80];
        b[..4].copy_from_slice(&80u32.to_le_bytes());
        b[4..6].copy_from_slice(&4u16.to_le_bytes());
        b[60..62].copy_from_slice(&1u16.to_le_bytes());
        b[62..64].copy_from_slice(&16u16.to_le_bytes());
        b[64..72].copy_from_slice(&4096i64.to_le_bytes());
        b[72..80].copy_from_slice(&8192i64.to_le_bytes());
        let s = Session {
            journal: Arc::new(scan(b)),
            mft: None,
        };
        let d = s.detail(0).unwrap();
        assert!(d.row.record.timestamp.is_empty());
        assert!(d.row.record.name.is_empty());
        assert_eq!(d.extents[0].length, "8192");
    }
    #[test]
    fn padding_and_record_across_read_boundary() {
        let mut b = vec![0; 65528];
        b.extend(fixture(2, "cross-boundary.txt", 0x100));
        let j = scan(b);
        assert_eq!(j.summary.padding_bytes, 65528);
        assert_eq!(j.records[0].offset, 65528);
        assert_eq!(j.summary.records, 1);
    }
    #[test]
    fn corrupt_bounds_recover_next_aligned_record() {
        let mut b = fixture(2, "broken", 0x100);
        b[58..60].copy_from_slice(&0xfffeu16.to_le_bytes());
        b.extend(fixture(2, "valid.txt", 0x200));
        let j = scan(b);
        assert_eq!(j.records.last().unwrap().name, "valid.txt");
        assert!(j.summary.skipped_bytes > 0);
    }
    #[test]
    fn future_version_and_truncated_tail_are_reported() {
        let mut future = vec![0; 16];
        future[..4].copy_from_slice(&16u32.to_le_bytes());
        future[4] = 5;
        let mut b = fixture(2, "good", 0x100);
        b.extend(future);
        b.extend(&fixture(3, "truncated", 0x200)[..32]);
        let j = scan(b);
        assert_eq!(j.summary.unsupported, 1);
        assert_eq!(j.summary.truncated_bytes, 32);
    }
    #[test]
    fn filename_bounds_and_truncations_never_panic() {
        let b = fixture(2, "test.txt", 0x100);
        for end in 0..b.len() {
            assert!(parse_record(&b[..end], 0, 0).is_err());
        }
        let mut invalid = b.clone();
        invalid[56..58].copy_from_slice(&3u16.to_le_bytes());
        assert!(parse_record(&invalid, 0, 0).is_err());
    }
    #[test]
    fn flags_are_bitmasks_and_search_paginates() {
        let mut b = Vec::new();
        for n in 0..101 {
            b.extend(fixture(2, &format!("file-{n}.txt"), 0x80000300));
        }
        let s = Session {
            journal: Arc::new(scan(b)),
            mft: None,
        };
        assert_eq!(s.query("", "created", 1).rows.len(), 21);
        assert_eq!(s.query("", "deleted", 0).total, 101);
        assert_eq!(s.query("file-100", "all", 0).total, 1);
        assert!(s.query("", "all", usize::MAX).rows.is_empty());
    }
    #[test]
    fn invalid_extent_stride_is_rejected() {
        let mut b = vec![0; 64];
        b[..4].copy_from_slice(&64u32.to_le_bytes());
        b[4] = 4;
        b[60] = 1;
        b[62] = 8;
        assert!(parse_record(&b, 0, 0).is_err());
    }
    fn root_case(sequence: u16) -> Arc<Case> {
        let root = crate::mft::Entry {
            id: 5,
            sequence,
            name: ".".into(),
            path: "\\".into(),
            path_status: "已重建".into(),
            in_use: true,
            directory: true,
            extension: false,
            base_id: 0,
            size: 0,
            resident: false,
            streams: 0,
            modified: String::new(),
            warnings: vec![],
            time_difference: false,
        };
        Arc::new(Case {
            bytes: vec![],
            entries: vec![root],
            summary: crate::mft::Summary::default(),
            by_id: std::collections::HashMap::from([(5, 0)]),
        })
    }
    #[test]
    fn correlation_requires_parent_sequence_and_preserves_event_name() {
        let journal = Arc::new(scan(fixture(2, "old-name.txt", 0x1000)));
        let good = Session {
            journal: journal.clone(),
            mft: Some(root_case(1)),
        };
        assert_eq!(good.row(&journal.records[0]).path, "\\old-name.txt");
        let stale = Session {
            journal: journal.clone(),
            mft: Some(root_case(2)),
        };
        let row = stale.row(&journal.records[0]);
        assert!(row.path.is_empty());
        assert!(row.path_status.contains("序列号失效"));
    }
    #[test]
    fn v3_identity_is_never_truncated_for_mft_matching() {
        let journal = Arc::new(scan(fixture(3, "v3.txt", 0x100)));
        let session = Session {
            journal: journal.clone(),
            mft: Some(root_case(1)),
        };
        let row = session.row(&journal.records[0]);
        assert!(row.path.is_empty());
        assert!(row.path_status.contains("128"));
    }
}
