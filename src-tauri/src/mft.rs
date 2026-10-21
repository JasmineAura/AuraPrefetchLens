use chrono::{DateTime, Utc};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::Path,
};

fn u16le(b: &[u8], o: usize) -> u16 {
    b.get(o..o + 2)
        .map(|v| u16::from_le_bytes(v.try_into().unwrap()))
        .unwrap_or(0)
}
fn u32le(b: &[u8], o: usize) -> u32 {
    b.get(o..o + 4)
        .map(|v| u32::from_le_bytes(v.try_into().unwrap()))
        .unwrap_or(0)
}
fn u64le(b: &[u8], o: usize) -> u64 {
    b.get(o..o + 8)
        .map(|v| u64::from_le_bytes(v.try_into().unwrap()))
        .unwrap_or(0)
}
fn utf16(b: &[u8]) -> String {
    String::from_utf16_lossy(
        &b.chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect::<Vec<_>>(),
    )
}
pub fn hash(b: &[u8]) -> String {
    format!("{:x}", Sha256::digest(b))
}
fn date(t: u64) -> String {
    if t == 0 {
        return String::new();
    }
    let seconds = (t / 10_000_000) as i128 - 11_644_473_600i128;
    i64::try_from(seconds)
        .ok()
        .and_then(|s| DateTime::<Utc>::from_timestamp(s, ((t % 10_000_000) * 100) as u32))
        .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true))
        .unwrap_or_else(|| "无效时间".into())
}
#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Times {
    pub created: String,
    pub modified: String,
    pub changed: String,
    pub accessed: String,
    pub raw: Vec<String>,
}
fn times(b: &[u8], o: usize) -> Times {
    let v: Vec<u64> = (0..4).map(|i| u64le(b, o + i * 8)).collect();
    Times {
        created: date(v[0]),
        modified: date(v[1]),
        changed: date(v[2]),
        accessed: date(v[3]),
        raw: v.iter().map(|x| x.to_string()).collect(),
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Name {
    pub name: String,
    pub parent: u64,
    pub parent_sequence: u16,
    pub namespace: u8,
    pub times: Times,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attribute {
    pub kind: u32,
    pub label: String,
    pub id: u16,
    pub name: String,
    pub offset: usize,
    pub length: usize,
    pub resident: bool,
    pub size: u64,
    pub value_offset: usize,
    pub flags: u16,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: u64,
    pub sequence: u16,
    pub name: String,
    pub path: String,
    pub path_status: String,
    pub in_use: bool,
    pub directory: bool,
    pub extension: bool,
    pub base_id: u64,
    pub size: u64,
    pub resident: bool,
    pub streams: usize,
    pub modified: String,
    pub warnings: Vec<String>,
    pub time_difference: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Detail {
    pub entry: Entry,
    pub names: Vec<Name>,
    pub si: Times,
    pub attributes: Vec<Attribute>,
    pub raw_hex: Vec<String>,
    pub fixed_hex: Vec<String>,
    pub offset: u64,
    pub used_size: usize,
    pub record_size: usize,
    pub streams: Vec<Stream>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stream {
    pub id: u16,
    pub name: String,
    pub resident: bool,
    pub size: u64,
    pub preview: String,
    pub hex: Vec<String>,
    pub sha256: String,
    pub flags: u16,
}
#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub source: String,
    pub sha256: String,
    pub bytes: u64,
    pub record_size: usize,
    pub slots: usize,
    pub parsed: usize,
    pub active: usize,
    pub free: usize,
    pub directories: usize,
    pub extensions: usize,
    pub resident: usize,
    pub ads: usize,
    pub differences: usize,
    pub invalid: usize,
    pub empty: usize,
    pub partial: usize,
}
pub struct Case {
    pub bytes: Vec<u8>,
    pub entries: Vec<Entry>,
    pub summary: Summary,
    pub by_id: HashMap<u64, usize>,
}
struct Parsed {
    fixed: Vec<u8>,
    names: Vec<Name>,
    si: Times,
    attrs: Vec<Attribute>,
    warnings: Vec<String>,
    used: usize,
}

pub fn fix_record(raw: &[u8]) -> Result<Vec<u8>, String> {
    if raw.get(..4) != Some(b"FILE") {
        return Err("不是 FILE 记录".into());
    }
    if raw.len() < 48 {
        return Err("记录头被截断".into());
    }
    let offset = u16le(raw, 4) as usize;
    let count = u16le(raw, 6) as usize;
    if count < 2 || offset < 40 || offset + count * 2 > raw.len() {
        return Err("USA 数组越界".into());
    }
    let sectors = count - 1;
    if raw.len() % sectors != 0 {
        return Err("USA 扇区数量不匹配".into());
    }
    let sector = raw.len() / sectors;
    if ![512, 1024, 2048, 4096].contains(&sector) || offset + count * 2 > sector - 2 {
        return Err("不支持的扇区布局".into());
    }
    let mut fixed = raw.to_vec();
    let usn = &raw[offset..offset + 2];
    for i in 1..count {
        let end = i * sector;
        if &raw[end - 2..end] != usn {
            return Err(format!("USA/fixup 校验失败：扇区 {i}"));
        }
        fixed[end - 2..end].copy_from_slice(&raw[offset + i * 2..offset + i * 2 + 2]);
    }
    Ok(fixed)
}
fn parse(raw: &[u8]) -> Result<Parsed, String> {
    let b = fix_record(raw)?;
    let used = u32le(&b, 24) as usize;
    let mut pos = u16le(&b, 20) as usize;
    if used > b.len() || used < 48 || pos < 48 || pos >= used {
        return Err("属性区边界无效".into());
    }
    let mut p = Parsed {
        fixed: b,
        names: vec![],
        si: Times::default(),
        attrs: vec![],
        warnings: vec![],
        used,
    };
    let b = &p.fixed;
    let mut terminated = false;
    while pos + 4 <= used {
        let kind = u32le(b, pos);
        if kind == u32::MAX {
            terminated = true;
            break;
        }
        if pos + 16 > used {
            p.warnings.push("属性头被截断".into());
            break;
        }
        let len = u32le(b, pos + 4) as usize;
        let form = b[pos + 8];
        let resident = form == 0;
        let minimum = if resident { 24 } else { 64 };
        if form > 1 || len < minimum || len % 8 != 0 || pos + len > used {
            p.warnings.push(format!("属性边界无效 @ 0x{pos:X}"));
            break;
        }
        let a = &b[pos..pos + len];
        let name_len = a[9] as usize * 2;
        let name_off = u16le(a, 10) as usize;
        if name_len > 0 && (name_off < minimum || name_off + name_len > len) {
            p.warnings.push("属性名称越界".into());
            break;
        }
        let name = if name_len > 0 {
            utf16(&a[name_off..name_off + name_len])
        } else {
            String::new()
        };
        let size = if resident {
            u32le(a, 16) as u64
        } else {
            u64le(a, 48)
        };
        let vo = if resident { u16le(a, 20) as usize } else { 0 };
        if resident && (vo < 24 || size > len as u64 || vo as u64 + size > len as u64) {
            p.warnings.push("驻留属性内容越界".into());
            break;
        }
        let label = match kind {
            0x10 => "$STANDARD_INFORMATION",
            0x20 => "$ATTRIBUTE_LIST",
            0x30 => "$FILE_NAME",
            0x40 => "$OBJECT_ID",
            0x50 => "$SECURITY_DESCRIPTOR",
            0x60 => "$VOLUME_NAME",
            0x70 => "$VOLUME_INFORMATION",
            0x80 => "$DATA",
            0x90 => "$INDEX_ROOT",
            0xa0 => "$INDEX_ALLOCATION",
            0xb0 => "$BITMAP",
            0xc0 => "$REPARSE_POINT",
            _ => "UNKNOWN",
        }
        .to_string();
        if kind == 0x20 {
            p.warnings
                .push("含 ATTRIBUTE_LIST：本版逐记录展示，未合并扩展属性".into());
        }
        if resident {
            let v = &a[vo..vo + size as usize];
            if kind == 0x10 {
                if v.len() >= 32 {
                    p.si = times(v, 0);
                } else {
                    p.warnings.push("SI 属性截断".into());
                }
            }
            if kind == 0x30 {
                if v.len() >= 66 && 66 + v[64] as usize * 2 <= v.len() {
                    let parent = u64le(v, 0);
                    p.names.push(Name {
                        name: utf16(&v[66..66 + v[64] as usize * 2]),
                        parent: parent & 0x0000ffffffffffff,
                        parent_sequence: (parent >> 48) as u16,
                        namespace: v[65],
                        times: times(v, 8),
                    });
                } else {
                    p.warnings.push("FN 属性截断".into());
                }
            }
        }
        p.attrs.push(Attribute {
            kind,
            label,
            id: u16le(a, 14),
            name,
            offset: pos,
            length: len,
            resident,
            size,
            value_offset: vo,
            flags: u16le(a, 12),
        });
        pos += len;
    }
    if !terminated {
        p.warnings.push("未找到属性结束标记".into());
    }
    Ok(p)
}
fn hex(b: &[u8]) -> Vec<String> {
    b.chunks(16)
        .map(|c| {
            c.iter()
                .map(|x| format!("{x:02X}"))
                .collect::<Vec<_>>()
                .join(" ")
        })
        .collect()
}
impl Case {
    pub fn load(path: &Path, progress: impl Fn(usize, usize)) -> Result<Self, String> {
        let bytes = fs::read(path).map_err(|e| format!("读取失败：{e}"))?;
        if bytes.get(..4) != Some(b"FILE") {
            return Err("请选择从卷中导出的原始 $MFT 文件，文件头不是 FILE".into());
        }
        let record_size = u32le(&bytes, 28) as usize;
        if !(512..=65536).contains(&record_size) || !record_size.is_power_of_two() {
            return Err("无法从首条记录确定可靠的记录大小".into());
        }
        fix_record(bytes.get(..record_size).ok_or("首条记录被截断")?)?;
        let mut summary = Summary {
            source: path.to_string_lossy().into_owned(),
            sha256: hash(&bytes),
            bytes: bytes.len() as u64,
            record_size,
            slots: bytes.len() / record_size,
            partial: bytes.len() % record_size,
            ..Default::default()
        };
        let mut entries = Vec::new();
        let mut parents = HashMap::new();
        let mut by_id = HashMap::new();
        for (slot, raw) in bytes.chunks_exact(record_size).enumerate() {
            if slot % 8192 == 0 {
                progress(slot, summary.slots);
            }
            if raw.iter().all(|v| *v == 0) {
                summary.empty += 1;
                continue;
            }
            let p = match parse(raw) {
                Ok(p) => p,
                Err(_) => {
                    summary.invalid += 1;
                    continue;
                }
            };
            let id = slot as u64;
            let flags = u16le(raw, 22);
            let base = u64le(raw, 32);
            let directory = flags & 2 != 0;
            let in_use = flags & 1 != 0;
            let preferred = p
                .names
                .iter()
                .find(|n| n.namespace == 1 || n.namespace == 3)
                .or_else(|| p.names.first());
            let name = preferred.map(|n| n.name.clone()).unwrap_or_else(|| {
                if base != 0 {
                    format!("[扩展记录 #{id}]")
                } else {
                    format!("[无文件名 #{id}]")
                }
            });
            if let Some(n) = preferred {
                parents.insert(id, (n.parent, n.parent_sequence));
            }
            let data: Vec<_> = p.attrs.iter().filter(|a| a.kind == 0x80).collect();
            let default = data.iter().find(|a| a.name.is_empty());
            let resident = data.iter().any(|a| a.resident && a.flags & 0x4001 == 0);
            let ads = data.iter().filter(|a| !a.name.is_empty()).count();
            let difference = !p.si.raw.is_empty()
                && p.names
                    .iter()
                    .any(|n| n.namespace != 2 && n.times.raw != p.si.raw);
            let e = Entry {
                id,
                sequence: u16le(raw, 16),
                name,
                path: String::new(),
                path_status: String::new(),
                in_use,
                directory,
                extension: base != 0,
                base_id: base & 0x0000ffffffffffff,
                size: default.map(|a| a.size).unwrap_or(0),
                resident,
                streams: data.len(),
                modified: p.si.modified.clone(),
                warnings: p.warnings,
                time_difference: difference,
            };
            summary.parsed += 1;
            if in_use {
                summary.active += 1
            } else {
                summary.free += 1
            }
            if directory {
                summary.directories += 1
            }
            if base != 0 {
                summary.extensions += 1
            }
            if resident {
                summary.resident += 1
            }
            if ads > 0 {
                summary.ads += 1
            }
            if difference {
                summary.differences += 1
            }
            by_id.insert(id, entries.len());
            entries.push(e);
        }
        for i in 0..entries.len() {
            let mut current = entries[i].id;
            let mut parts = vec![];
            let mut seen = HashSet::new();
            let mut status = "已重建";
            for _ in 0..256 {
                if !seen.insert(current) {
                    status = "循环引用";
                    break;
                }
                let Some(&idx) = by_id.get(&current) else {
                    status = "父记录缺失";
                    break;
                };
                let entry = &entries[idx];
                if current == 5 {
                    break;
                }
                parts.push(entry.name.clone());
                let Some(&(parent, seq)) = parents.get(&current) else {
                    status = "缺少父引用";
                    break;
                };
                if let Some(&pi) = by_id.get(&parent) {
                    if entries[pi].sequence != seq {
                        status = "父引用序列号失效";
                        break;
                    }
                    if !entries[pi].directory {
                        status = "父引用不是目录";
                        break;
                    }
                } else {
                    status = "父记录缺失";
                    break;
                }
                current = parent;
            }
            if seen.len() >= 256 && current != 5 {
                status = "路径深度超限";
            }
            parts.reverse();
            entries[i].path = format!(
                "{}\\{}",
                if status == "已重建" {
                    ""
                } else {
                    "[未确认路径]"
                },
                parts.join("\\")
            );
            entries[i].path_status = status.into();
        }
        progress(summary.slots, summary.slots);
        Ok(Self {
            bytes,
            entries,
            summary,
            by_id,
        })
    }
    fn parsed(&self, id: u64) -> Result<(Parsed, &[u8]), String> {
        if !self.by_id.contains_key(&id) {
            return Err("记录不存在".into());
        }
        let off = id as usize * self.summary.record_size;
        let raw = self
            .bytes
            .get(off..off + self.summary.record_size)
            .ok_or("记录越界")?;
        Ok((parse(raw)?, raw))
    }
    pub fn extract(&self, id: u64, attr_id: u16) -> Result<Vec<u8>, String> {
        let (p, _) = self.parsed(id)?;
        let a = p
            .attrs
            .iter()
            .find(|a| a.id == attr_id && a.kind == 0x80)
            .ok_or("数据流不存在")?;
        if !a.resident {
            return Err("非驻留数据位于卷外部，独立 MFT 无法提取".into());
        }
        if a.flags & 0x4001 != 0 {
            return Err("压缩或加密数据流暂不支持解码提取".into());
        }
        let start = a.offset + a.value_offset;
        Ok(p.fixed[start..start + a.size as usize].to_vec())
    }
    pub fn detail(&self, id: u64) -> Result<Detail, String> {
        let (p, raw) = self.parsed(id)?;
        let entry = self.entries[*self.by_id.get(&id).ok_or("记录不存在")?].clone();
        let streams = p
            .attrs
            .iter()
            .filter(|a| a.kind == 0x80)
            .map(|a| {
                let data = if a.resident {
                    &p.fixed[a.offset + a.value_offset..a.offset + a.value_offset + a.size as usize]
                } else {
                    &[]
                };
                Stream {
                    id: a.id,
                    name: a.name.clone(),
                    resident: a.resident,
                    size: a.size,
                    preview: if a.resident {
                        String::from_utf8_lossy(data).into_owned()
                    } else {
                        String::new()
                    },
                    hex: hex(data),
                    sha256: if a.resident {
                        hash(data)
                    } else {
                        String::new()
                    },
                    flags: a.flags,
                }
            })
            .collect();
        Ok(Detail {
            entry,
            names: p.names,
            si: p.si,
            attributes: p.attrs,
            raw_hex: hex(raw),
            fixed_hex: hex(&p.fixed),
            offset: id * self.summary.record_size as u64,
            used_size: p.used,
            record_size: self.summary.record_size,
            streams,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn record(size: usize, data: &[u8]) -> Vec<u8> {
        let mut b = vec![0u8; size];
        b[..4].copy_from_slice(b"FILE");
        b[4..6].copy_from_slice(&48u16.to_le_bytes());
        b[6..8].copy_from_slice(&((size / 512 + 1) as u16).to_le_bytes());
        b[16..18].copy_from_slice(&1u16.to_le_bytes());
        b[20..22].copy_from_slice(&72u16.to_le_bytes());
        b[28..32].copy_from_slice(&(size as u32).to_le_bytes());
        let len = (24 + data.len() + 7) & !7;
        let used = 72 + len + 8;
        b[24..28].copy_from_slice(&(used as u32).to_le_bytes());
        b[72..76].copy_from_slice(&0x80u32.to_le_bytes());
        b[76..80].copy_from_slice(&(len as u32).to_le_bytes());
        b[86..88].copy_from_slice(&3u16.to_le_bytes());
        b[88..92].copy_from_slice(&(data.len() as u32).to_le_bytes());
        b[92..94].copy_from_slice(&24u16.to_le_bytes());
        b[96..96 + data.len()].copy_from_slice(data);
        b[72 + len..76 + len].fill(255);
        b[48..50].copy_from_slice(&[0xab, 0xcd]);
        for i in 1..=size / 512 {
            let tail = b[i * 512 - 2..i * 512].to_vec();
            b[48 + i * 2..50 + i * 2].copy_from_slice(&tail);
            b[i * 512 - 2..i * 512].copy_from_slice(&[0xab, 0xcd]);
        }
        b
    }
    #[test]
    fn resident_crossing_sector_is_restored() {
        let payload = vec![0x42; 600];
        let b = record(1024, &payload);
        let p = parse(&b).unwrap();
        assert_eq!(&p.fixed[96..696], payload);
        assert_eq!(p.attrs[0].size, 600);
        let c = Case {
            bytes: b,
            entries: vec![],
            summary: Summary {
                record_size: 1024,
                ..Default::default()
            },
            by_id: HashMap::from([(0, 0)]),
        };
        assert_eq!(c.extract(0, 3).unwrap(), payload);
    }
    #[test]
    fn supports_4096_records() {
        let p = parse(&record(4096, b"hello")).unwrap();
        assert_eq!(p.attrs[0].size, 5);
    }
    #[test]
    fn rejects_torn_sector() {
        let mut b = record(1024, b"hello");
        b[510] = 0;
        assert!(parse(&b).is_err());
    }
    #[test]
    fn rejects_bad_attribute_bounds() {
        let mut b = record(1024, b"hello");
        b[76..80].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(parse(&b)
            .unwrap()
            .warnings
            .iter()
            .any(|w| w.contains("边界")));
    }
    #[test]
    fn never_panics_on_truncation() {
        let b = record(1024, b"hello");
        for i in 0..1024 {
            let _ = parse(&b[..i]);
        }
    }
    #[test]
    fn real_sample_integrity_and_resident_extraction() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../example/$MFT");
        if !path.exists() {
            return;
        }
        let c = Case::load(&path, |_, _| {}).unwrap();
        assert_eq!(c.summary.record_size, 1024);
        assert_eq!(c.summary.slots, 314880);
        assert_eq!(
            c.summary.parsed + c.summary.empty + c.summary.invalid,
            c.summary.slots
        );
        let mut count = 0;
        for e in c.entries.iter().filter(|e| e.resident).take(50) {
            let d = c.detail(e.id).unwrap();
            for s in d
                .streams
                .iter()
                .filter(|s| s.resident && s.flags & 0x4001 == 0)
            {
                let data = c.extract(e.id, s.id).unwrap();
                assert_eq!(data.len() as u64, s.size);
                assert_eq!(hash(&data), s.sha256);
                count += 1;
            }
        }
        assert!(count > 0);
        println!("SAMPLE {}", serde_json::to_string(&c.summary).unwrap());
    }
}
