# GitHub 项目整理工具

Type: task
Status: ready-for-agent

## Spec

完整产品规格见 [spec.md](../spec.md)。

## Scope

实现一个运行在本地的 Web 工具：复用本机 `gh` CLI 扫描 Star 与 owned/fork 项目条目，展示可解释的健康信号，采用“批量表格 + 右侧详情面板”UI，支持人工确认后执行 Star/List/Archive/Unarchive/删除动作，并将结果保存到单个本地 JSON 文件。

## Highest seam

以“扫描与动作编排层”作为最高测试 seam。该 seam 连接 Web UI 与 GitHub CLI 适配器，负责输出项目条目、扫描证据、整理建议以及逐项动作结果；前端不直接拼接或执行 `gh` 命令。

## Design source

- [0003-table-first-review-workspace.md](../../../docs/adr/0003-table-first-review-workspace.md)
- [UI 原型](../prototype/index.html?variant=B)

## Comments

- 已由用户确认采用 B · 批量表格作为正式 UI/UX 主方案。
