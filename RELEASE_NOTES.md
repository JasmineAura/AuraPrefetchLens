# AURA / MFT LENS v0.1.0

首个公开版本：面向 Windows NTFS `$MFT` 的本地离线分析工具。

## 功能

- 左右双段主界面，解析结果自动打开独立窗口。
- 曜石紫、午夜蓝、绯红黑主题与可关闭的持续环境动效。
- MFT 解析、USA / fixup 校验、主路径重建与后端分页搜索。
- 全部、使用中、空闲、驻留、时间差异、目录六类标签。
- SI / FN 时间对照、属性结构、原始与还原字节视图。
- 驻留数据流预览、精确提取与 SHA-256 校验。

## 下载

- `.exe`：直接运行。
- `.zip`：便携包，解压后运行 `Aura-MFT-Lens.exe`。
- `SHA256SUMS.txt`：校验下载文件。

适用于 Windows 10 / 11 x64，需要 [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)，无需 Node.js 或 Rust。

## 验证与边界

前端构建、6 项 Rust 测试、3 项界面测试及发行版双窗口和驻留落盘验证通过。307.5 MiB 本地样例解析出 314,832 条有效记录；驻留提取与源记录字节独立比对一致。样例证据不随发行包分发。

本版使用内存索引，扩展记录尚未通过 `$ATTRIBUTE_LIST` 合并。非驻留内容提取、压缩或加密流解码、USN / LogFile 关联、CSV 导出与案例持久化暂未提供。时间差异仅作为调查线索。

[完整说明与打赏作者](https://github.com/JasmineAura/AuraPrefetchLens#readme)
