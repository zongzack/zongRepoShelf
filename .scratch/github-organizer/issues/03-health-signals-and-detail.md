# 03 — 健康信号、筛选与详情建议

**What to build:** 扫描结果补齐 archived/disabled/deprecated、最近 commit、最近 release、近期 Issue/PR 活动等扫描证据。用户可以在 B 方案表格中搜索和筛选项目，调整 12/18/6 个月阈值，选中项目后在右侧详情面板查看完整证据和可解释整理建议。

**Blocked by:** 02 — 本地启动、gh 认证与首次 Star 扫描

**Status:** ready-for-agent

- [ ] 每个可访问项目条目展示四类健康信号及其原始时间/状态值。
- [ ] 默认阈值为最近 commit 12 个月、最近 release 18 个月、近期 Issue/PR 活动 6 个月。
- [ ] 页面允许修改阈值并在重新计算后更新命中信号。
- [ ] 默认视图只展示命中至少一项健康信号的项目，同时可切换查看全部项目。
- [ ] 搜索支持 `owner/repo`，筛选支持健康信号、Star/Owned/Fork 关系和 Lists 维度的后续扩展入口。
- [ ] 选中表格行后，右侧详情面板展示完整证据、命中原因和整理建议。
- [ ] archived/deprecated 只提高建议优先级，不触发自动写操作。
- [ ] 通过编排 seam 的行为测试覆盖阈值边界、缺失 release/活动数据和证据可解释性。
