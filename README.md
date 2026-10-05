# FreeMCHost 自动保活与永久续期脚本

> 专为 FreeMCHost 免费 Minecraft 服务器设计的自动化工具：
> 1. **服务器唤醒（Auto Start）**：无论服务器是否开机，均点击 **Start** 开机（已开机状态无影响）。
> 2. **长效租期续期（Billing Renew）**：巡检 `PLAN: Billing` 到期时间，低于 46 小时门槛自动完成免费的 `60 hours` 租期加时。

---

在 GitHub 仓库的 `Settings` -> `Secrets and variables` -> `Actions` 中添加：
  - `FREE_EMAIL`：登录邮箱
  - `FREE_PASSWORD`：登录密码
  - `SERVER_PAGE_URL`：服务器控制台链接
  - `TG_BOT_TOKEN` / `TG_CHAT_ID`：Telegram 结果推送（可选）
  - `NODE_LINK` ：代理节点链接（可选，防止平台风控）
