# KUI VPS — K-UI 纯 VPS 自托管部署套件

把 [a6216abcd/K-UI](https://github.com/a6216abcd/K-UI)（原部署在 Cloudflare Pages + D1 + Workers/Durable Objects）改为 **直接部署在任意 VPS**，无需 Cloudflare。

原理与细节见主对话「方案一」：本项目用 Node.js 20+ 接管 Pages 静态服务、`functions/api/[[path]].js` 后端、D1（`better-sqlite3` 适配器）和 Realtime Worker/Durable Objects（内置 WebSocket Hub），全部合并为**单进程、单端口**服务。前端 `index.html` 与受控端 VPS Agent 代码零修改。

## 目录结构

```
kui-vps/
├── install.sh          # 一键安装（在 VPS root 下执行）
├── server.js           # Node.js 兼容服务器（API + 静态 + 实时 WebSocket）
├── package.json        # 项目元数据与依赖清单
├── systemd/kui-panel.service  # Systemd 守护进程模板
├── caddy/Caddyfile.example    # 反向代理示例（自动 HTTPS）
└── README.md
```

## 快速开始

### 1. 安装你的主控 VPS（Debian / Ubuntu）

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get update && apt-get install -y nodejs git build-essential python3 caddy
```

### 2. 部署本项目

```bash
git clone https://github.com/<你的用户名>/kui-vps.git /opt/kui-vps
bash /opt/kui-vps/install.sh <你的面板域名> <管理员密码(>=16位)>
```

`install.sh` 会自动：
- 克隆上游 `a6216abcd/K-UI` 到 `/opt/kui-panel`（保留原版 `index.html`、`functions/`、`vps/`）。
- 把本项目的 `server.js` 复制进 `/opt/kui-panel` 并安装 `better-sqlite3`、`ws`。
- 生成 `/etc/systemd/system/kui-panel.service`（环境变量写好）并启动。
- 提示安装 Caddy 反代（模板见 `caddy/Caddyfile.example`）。

### 3. 配置 HTTPS 反代（必须）

浏览器端 Web Crypto（管理员登录签名）要求 HTTPS 安全上下文。将下方内容复制到 `/etc/caddy/Caddyfile`：

```
你的面板域名 {
    reverse_proxy 127.0.0.1:3000 {
        header_up CF-Connecting-IP {remote_host}
        header_up X-Forwarded-Proto {scheme}
        header_up X-Forwarded-Host {host}
    }
}
```

```bash
systemctl reload caddy
```

### 4. 使用

- 打开 `https://你的面板域名`，用 `admin` + 设置的密码登录。
- 「服务器与节点 → 接入机器」添加 VPS，**复制面板生成的 Full Deploy Command** 在节点机执行（Agent 是 `vps/` 下的原版脚本，完全兼容）。
- 添加节点、下发 8 合 1、切换 WARP/住宅出口等操作与 Cloudflare 版一致。

## 环境变量（systemd 服务内）

| 变量 | 说明 |
| --- | --- |
| `PORT` | 本地监听端口，默认 3000 |
| `PANEL_ORIGIN` | 面板对外 HTTPS 地址，`https://你的域名` |
| `REALTIME_URL` | 同 `PANEL_ORIGIN`（实时 Hub 已内置于同进程） |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | 管理员账号（密码≥16位） |
| `PROXY_USER` / `PROXY_PASS` | 住宅 SOCKS5 代理凭据 |

## 数据与运维

- 数据库 SQLite 文件：`/opt/kui-panel/data/kui.db`（WAL 模式），备份即拷贝此目录。
- 日志：`journalctl -u kui-panel -f`
- 升级面板：`cd /opt/kui-panel && git pull && systemctl restart kui-panel`
- 卸载：`systemctl disable --now kui-panel && rm -rf /opt/kui-panel /etc/systemd/system/kui-panel.service`

## 已知差异（相对 Cloudflare 版）

| 项目 | Cloudflare | 本项目 |
| --- | --- | --- |
| 数据库 | D1（云端 SQLite） | 本地 `better-sqlite3`，SQL 语法 100% 兼容 |
| Realtime | 独立 Worker + DO | 同进程内存 Hub，协议一致 |
| 防爆破限流 | 按 `CF-Connecting-IP` | 反代注入同一头，行为一致 |
| 公开探针缓存 | Edge Cache（15秒） | 进程内存缓存（15秒） |
| 页面国家代码 `request.cf.country` | 边缘读取 | 固定 'US'（仅用于首次探针默认分组，可改） |
| Sub/Agent 更新分发 | `env.ASSETS` | 本地文件读取，行为一致 |

## 常见问题

**登录后 500 / DB 缺失**：检查 `/opt/kui-panel/data` 可写、`server.js` 启动日志中 SQLite 初始化未报错。

**Agent 401/403**：确认节点公网 IP 已先加入面板；重新复制 Full Deploy Command。

**Realtime 不连接**：确认 `PANEL_ORIGIN` 与浏览器实际访问域名一致（HTTPS、末尾无 `/`）。

## License

本项目适配层沿用上游仓库的许可与免责声明。
