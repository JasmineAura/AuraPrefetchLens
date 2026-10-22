# AURA / MFT LENS v0.2.0

## USN Journal 支持

- 主界面增加 MFT / USN Journal 证据类型切换，独立保存两种输入路径与分析状态。
- 原始 `$UsnJrnl:$J` 流式解析，支持 V2.0 / V3.0 / V4.0；零填充区不常驻内存。
- 日志独立窗口：事件分类、分页搜索、原始字段、字节查看和解析诊断。
- 完整保留 64 位 USN、FILETIME 和 128 位文件标识；V4 范围记录不伪造文件名或时间戳。
- 手动关联同卷 MFT，以 V2 父引用和序列号推导快照路径；支持解除关联与旧会话校验。

## 使用

选择 **$J / USN Journal**，导入离线导出的原始 `$J`。如需路径，再导入同卷 MFT，并在日志窗口点击 **关联当前 MFT（同卷）**。

仅凭 MFT 快照无法保证历史路径正确；原因标志可能累计，日志不等于每次文件操作的完整历史。不同卷不能关联，程序无法从两个独立文件自动验证卷身份。

## 下载

- `.exe`：直接运行。
- `.zip`：解压后运行 `Aura-MFT-Lens.exe`。
- `SHA256SUMS.txt`：下载校验值。

Windows 10 / 11 x64，需要 [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)。

## 验证

17 项 Rust 测试与 5 项界面测试通过。包含 V2/V3/V4、跨读取边界、中文文件名、大整数、损坏与截断、父引用序列号、主题同步及原有 MFT 驻留提取测试。

发行版另通过 153 条确定性记录的桌面实测：独立导入、精确大整数、原始字节、MFT 关联与解除、失效会话和 V3/V4 均验证通过。

本次未提供真实 $J 样例，USN 验证使用脚本生成的确定性夹具；不分发原始证据。

[完整说明与打赏作者](https://github.com/JasmineAura/AuraPrefetchLens#readme)
