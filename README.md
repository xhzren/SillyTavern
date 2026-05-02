# SillyTavern

LLM Frontend for Power Users

## 适配说明

基于原版 SillyTavern v1.17.0，主要优化：

- **海量角色卡 (2600+) 性能** — 索引缓存增量更新，解决加载 OOM
- **角色管理页面** — 新增管理界面，修复重命名崩溃与文件名乱码
- **世界书自动关联** — 角色卡覆盖导入时自动重建世界书关联
- **扩展配置重构** — 按扩展名独立存储 JSON，配置更新不丢失
- **海量消息 (2000+) 优化** — 索引构建防 OOM，增量更新
- **Windows 兼容** — write-file-atomic EPERM 修复

---

## Resources

- GitHub: <https://github.com/SillyTavern/SillyTavern>
- Docs: <https://docs.sillytavern.app/>
- Discord: <https://discord.gg/sillytavern>
- Reddit: <https://reddit.com/r/SillyTavernAI>

## License

AGPL-3.0
