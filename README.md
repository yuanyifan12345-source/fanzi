# 饭搭子｜多人在线版（微信 / QQ OAuth）

这是可部署的 Node.js 网站项目，包含现有饭搭子页面、服务端会话、微信网站扫码登录、QQ 互联 OAuth2 登录，以及按用户 ID 隔离的 SQLite 云端账本。

> 重要：代码已搭建，但不能在没有开放平台应用 ID/密钥、已备案/可用的 HTTPS 域名和部署环境的情况下，直接让真实微信/QQ 账号登录。请勿把 `.env`、应用密钥或会话密钥提交到 GitHub。

## 技术结构

- 前端：`public/index.html`（饭搭子页面）
- 后端：Node.js + Express
- 登录：微信开放平台网站应用 OAuth、QQ 互联 OAuth2
- 数据：SQLite，`users` 表保存第三方身份映射，`user_data` 按内部 user ID 保存账本
- 会话：HttpOnly、SameSite=Lax Cookie；生产环境要求 HTTPS

## 本机启动

需要 Node.js 20 或更新版本。

```bash
npm install
cp .env.example .env
```

在 Windows PowerShell 中复制配置模板可用：

```powershell
Copy-Item .env.example .env
```

编辑 `.env`：

- `SESSION_SECRET`：替换为至少 32 个字符的随机秘密值
- `APP_BASE_URL`：本机测试用 `http://localhost:3000`；生产环境填完整的 HTTPS 网站根地址
- 填入 `WECHAT_APP_ID`、`WECHAT_APP_SECRET`、`QQ_APP_ID`、`QQ_APP_KEY`

启动：

```bash
npm start
```

打开 `http://localhost:3000`。如果未填写第三方凭据，登录按钮会给出尚未配置的提示，无法完成真正的微信/QQ 授权。

## 微信开放平台配置

1. 在微信开放平台申请/创建**网站应用**并完成所需审核。
2. 按平台要求配置网站应用资料、授权域名等。
3. 将授权回调地址登记为：`https://你的域名/auth/wechat/callback`
4. 将应用 ID 与应用密钥配置到服务器环境变量 `WECHAT_APP_ID`、`WECHAT_APP_SECRET`。
5. 确认上线域名、HTTPS 证书及平台要求均已生效。

## QQ 互联配置

1. 在 QQ 互联平台申请/创建网站应用并完成审核。
2. 按平台要求设置网站信息与回调地址。
3. 登记回调地址：`https://你的域名/auth/qq/callback`
4. 将 APP ID 与 APP Key 配置到服务器环境变量 `QQ_APP_ID`、`QQ_APP_KEY`。

第三方平台审核与权限以各平台控制台的当前要求为准；个人开发者是否可申请、可开放哪些权限，可能随平台政策变化。

## 部署建议（例如 Render / Railway / VPS）

1. 将整个项目放进私有 GitHub 仓库（或可信代码托管平台）。
2. 创建 Node Web Service，运行命令 `npm start`，Node 版本至少 20。
3. 配置所有 `.env.example` 中的生产环境变量。
4. 配置持久化磁盘，并把 `DATABASE_PATH` 指向该磁盘内的文件，例如 `/var/data/fandazi.sqlite`。SQLite 文件不可放在会随重启清空的临时文件系统。
5. 启用 HTTPS，并将 `APP_BASE_URL` 设置为真实公开的 HTTPS 域名。
6. 在微信/QQ 控制台登记上述两个回调 URL，等待审核/生效后测试登录。
7. 部署后检查 `https://你的域名/health` 应返回 `{"ok":true}`。

## API

- `GET /api/me`：当前登录用户资料
- `GET /api/data`：读取当前用户账本（必须登录）
- `PUT /api/data`：保存当前用户账本（必须登录）
- `GET /auth/wechat`：发起微信授权
- `GET /auth/qq`：发起 QQ 授权
- `POST /auth/logout`：退出登录

所有账本读取和写入都使用服务端会话对应的内部用户 ID，不接受客户端传入的用户 ID，因此不能通过修改请求中的 ID 访问其他人的账本。

## 上线前检查

- 使用 HTTPS，配置强 `SESSION_SECRET`。
- 不要提交 `.env` 或第三方密钥。
- 数据库放在持久化磁盘，设置定期备份与访问权限。
- 为生产环境设置日志监控和备份恢复流程。
- 若部署在多实例环境，需把会话存储迁移到共享的 Redis/PostgreSQL 等存储，并确保数据库也为共享的生产数据库；当前 SQLite 方案适合单实例起步部署。
