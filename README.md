# KUI VPS 自托管面板

项目内置 K-UI 前端、API 与 Agent 源码，使用 Node.js 内置 SQLite 和 WebSocket 在单台 VPS 运行，不需要 Cloudflare，也不会在安装时克隆上游仓库。

## 一键安装

支持使用 systemd 的 Debian 12/13、Ubuntu 22.04/24.04，建议全新 VPS。先将域名 A/AAAA 解析到 VPS，开放 TCP 80、443。需要 root 权限和可访问 Debian/Ubuntu、NodeSource、npm 软件源的网络。

```bash
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/leadaono/kui-vps.git
cd kui-vps
sudo bash install-panel.sh --domain panel.example.com
```

把 `panel.example.com` 换成自己的域名。脚本安装 Node.js 22、Caddy、运行依赖，创建专用用户、systemd 服务与 HTTPS 站点，并检查本地 `/health`。Caddy 自动申请证书，证书是否成功取决于 DNS 和 80/443 的可达性。

安装完成访问 `https://你的域名`，用户名 `admin`。首次安装生成随机密码，在 VPS 查看：

```bash
sudo cat /etc/kui-vps/kui-panel.env
```

`ADMIN_PASSWORD` 是登录密码。请勿将该文件提交到 GitHub。修改配置后运行 `sudo systemctl restart kui-panel`。

## 文件与数据

- `/opt/kui-vps`：程序；内置源码在 `vendor/K-UI`。
- `/var/lib/kui-vps/kui.db`：SQLite 数据库，服务重启后保留。
- `/etc/kui-vps/kui-panel.env`：账号和生产配置，权限 600。
- `/etc/caddy/kui-sites/kui-panel.caddy`：本项目站点。安装器保留主 Caddy 配置并添加 import，首次修改前备份。
- `install-panel.sh`：主控面板安装器。
- `install.sh`、`vendor/K-UI/vps/kui.sh`：受控 VPS Agent 安装器；使用面板生成的接入命令。

重复运行安装器保留环境文件和数据库；域名必须与已有配置一致。已有占用 80/443 的 Web 服务需要先自行协调端口。

## 更新和备份

更新前停止服务并备份数据库与配置，备份文件包含凭据，应保存在受保护位置：

```bash
sudo systemctl stop kui-panel
sudo cp -a /var/lib/kui-vps /root/kui-vps-data-backup
sudo cp -a /etc/kui-vps /root/kui-vps-config-backup
git pull --ff-only
sudo bash install-panel.sh --domain panel.example.com
```

备份目录已存在时请改用新的目录名。更新失败可恢复旧版本程序及备份，然后重启服务。

## 故障检查

```bash
sudo systemctl status kui-panel caddy
sudo journalctl -u kui-panel -n 100 --no-pager
curl -fsS http://127.0.0.1:3000/health
```

## 开发与验证

需要 Node.js 22.13+，推荐当前 Node.js 22 或 24。SQLite 使用 Node.js 内置模块，无需原生 npm 编译模块。

```bash
npm ci
ADMIN_PASSWORD='replace-with-a-long-random-password' npm start
node test/smoke.mjs
```

测试覆盖首页、Agent 静态文件、内部文件访问限制、管理员登录、鉴权、Dashboard WebSocket，以及重启后的会话持久化。GitHub Actions 在 Linux Node.js 22/24 运行相同检查。

前端仍使用 Vue、Tailwind 等第三方 CDN，地图、测速、软件包安装等功能也可能访问第三方服务；独立部署指不依赖上游 K-UI 仓库或 Cloudflare 运行平台，不代表离线运行。

源码来源：[a6216abcd/K-UI](https://github.com/a6216abcd/K-UI)，保留 `vendor/K-UI` 中的来源说明。当前快照未包含独立 LICENSE 文件，请在进一步分发前确认上游许可。
