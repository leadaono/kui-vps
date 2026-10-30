#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
trap 'echo "安装失败（第 $LINENO 行），请检查上方错误。" >&2' ERR
DOMAIN=''
while (($#)); do
 case "$1" in
 --domain) DOMAIN="${2:?缺少域名}"; shift 2 ;;
 -h|--help) echo 'sudo bash install-panel.sh --domain panel.example.com'; exit 0 ;;
 *) echo "未知参数: $1" >&2; exit 1 ;;
 esac
done
[[ $EUID == 0 ]] || { echo '请使用 sudo 或 root 运行'; exit 1; }
[[ -n $DOMAIN ]] || read -rp '面板域名（先解析到本机）: ' DOMAIN
[[ $DOMAIN =~ ^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$ ]] || { echo '域名格式错误'; exit 1; }
source /etc/os-release
[[ $ID == debian || $ID == ubuntu ]] || { echo '支持 Debian / Ubuntu'; exit 1; }
command -v systemctl >/dev/null
SOURCE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
[[ -f "$SOURCE/vendor/K-UI/functions/api/[[path]].js" && -f "$SOURCE/vendor/K-UI/index.html" ]] || { echo '仓库源码不完整'; exit 1; }
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl gnupg build-essential python3 rsync
if ! command -v node >/dev/null || ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 13) ? 0 : 1)'; then
 install -d -m 755 /etc/apt/keyrings
 curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
 chmod 644 /etc/apt/keyrings/nodesource.gpg
 echo 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main' > /etc/apt/sources.list.d/nodesource.list
 apt-get update
 apt-get install -y nodejs
fi
apt-get install -y caddy
id kui >/dev/null 2>&1 || useradd --system --home-dir /var/lib/kui-vps --shell /usr/sbin/nologin kui
install -d -m 750 -o kui -g kui /var/lib/kui-vps
install -d -m 700 /etc/kui-vps
install -d -m 755 /opt/kui-vps
if [[ $SOURCE != /opt/kui-vps ]]; then
 rsync -a --exclude=.git --exclude=node_modules --exclude=data --exclude='.env*' "$SOURCE/" /opt/kui-vps/
fi
cd /opt/kui-vps
(umask 022; npm ci --omit=dev)
if [[ ! -f /etc/kui-vps/kui-panel.env ]]; then
 PASSWORD=$(node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')
 PROXY_PASSWORD=$(node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')
 cat > /etc/kui-vps/kui-panel.env <<EOF
NODE_ENV=production
BIND_HOST=127.0.0.1
PORT=3000
PANEL_ORIGIN=https://$DOMAIN
REALTIME_URL=https://$DOMAIN
ADMIN_USERNAME=admin
ADMIN_PASSWORD=$PASSWORD
PROXY_USER=kui_proxy
PROXY_PASS=$PROXY_PASSWORD
DATABASE_PATH=/var/lib/kui-vps/kui.db
EOF
else
 grep -qx "PANEL_ORIGIN=https://$DOMAIN" /etc/kui-vps/kui-panel.env || { echo '现有配置域名不一致，请先修改环境文件'; exit 1; }
fi
chmod 600 /etc/kui-vps/kui-panel.env
install -m 644 systemd/kui-panel.service /etc/systemd/system/kui-panel.service
install -d -m 755 /etc/caddy/kui-sites
if ! grep -qF 'import /etc/caddy/kui-sites/*.caddy' /etc/caddy/Caddyfile; then
 cp -a /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.backup.$(date +%s)"
 printf '\nimport /etc/caddy/kui-sites/*.caddy\n' >> /etc/caddy/Caddyfile
fi
printf '%s {\n reverse_proxy 127.0.0.1:3000 {\n  header_up CF-Connecting-IP {remote_host}\n  header_up X-Forwarded-Proto {scheme}\n  header_up X-Forwarded-Host {host}\n }\n}\n' "$DOMAIN" > /etc/caddy/kui-sites/kui-panel.caddy
chmod 644 /etc/caddy/kui-sites/kui-panel.caddy
caddy validate --config /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl enable --now kui-panel
systemctl restart kui-panel
for attempt in {1..30}; do
 if curl -fsS http://127.0.0.1:3000/health >/dev/null; then break; fi
 sleep 2
done
curl -fsS http://127.0.0.1:3000/health
systemctl enable --now caddy
systemctl reload caddy
echo
echo "安装完成：https://$DOMAIN  用户名：admin"
echo '密码保存在 /etc/kui-vps/kui-panel.env 的 ADMIN_PASSWORD 中。'
echo '确保域名 A/AAAA 指向本机，并允许 TCP 80/443 入站。'
