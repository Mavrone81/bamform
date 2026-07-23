#!/usr/bin/env bash
#
# BamForm — Phase 0 Reconnaissance
# BAMFORM-RUN-001 §2 / master build prompt §1.2
#
# READ-ONLY. This script creates nothing, modifies nothing, restarts nothing,
# removes nothing. Every command below is an inspection. It is safe to run on a
# live, shared production host.
#
# Usage:   sudo bash recon.sh > bamform-recon-$(hostname)-$(date +%Y%m%d).txt 2>&1
# Then:    send the output file back for the port deconfliction table.
#
# Some sections need root to show process names against listening ports. Without
# sudo the script still runs; those fields will be blank.

set -uo pipefail   # deliberately NOT -e: a missing tool must not abort the sweep

hr()  { printf '\n%s\n' "------------------------------------------------------------"; }
sec() { hr; printf '## %s\n' "$*"; hr; }
have(){ command -v "$1" >/dev/null 2>&1; }
try() { if have "${1%% *}"; then eval "$@" 2>&1 || echo "(command failed — non-fatal)"; else echo "(not installed: ${1%% *})"; fi; }

printf 'BamForm Phase 0 recon\n'
printf 'Generated: %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
printf 'Host: %s\n' "$(hostname -f 2>/dev/null || hostname)"
printf 'Run as: %s\n' "$(id -un)"
[ "$(id -u)" -ne 0 ] && printf 'WARNING: not root — process names on ports will be hidden\n'

# =============================================================================
sec "1. HOST AND RESOURCES"

echo "--- kernel ---";            try "uname -a"
echo; echo "--- distribution ---"; try "lsb_release -a"; [ -r /etc/os-release ] && cat /etc/os-release
echo; echo "--- uptime / load ---"; try "uptime"
echo; echo "--- cpu ---";          try "nproc"; try "lscpu | grep -E 'Model name|^CPU\(s\)|Socket|Thread'"
echo; echo "--- memory (MB) ---";  try "free -m"
echo; echo "--- disk ---";         try "df -h"
echo; echo "--- inodes ---";       try "df -i"
echo; echo "--- largest consumers under /var ---"; try "du -sh /var/lib/docker /var/log /var/backups 2>/dev/null"

# =============================================================================
sec "2. TIME SYNCHRONISATION  [PR-ENV-02 — signature evidence depends on this]"

try "timedatectl status"
echo; try "chronyc tracking"
echo; try "ntpq -p"
echo
echo "NOTE: a host that is not NTP-synchronised cannot produce trustworthy"
echo "      signature or audit timestamps. This is a hard requirement."

# =============================================================================
sec "3. DOCKER"

echo "--- versions ---"
try "docker --version"
try "docker compose version"
try "docker info --format 'Server {{.ServerVersion}} | Driver {{.Driver}} | Root {{.DockerRootDir}} | Containers {{.Containers}} running={{.ContainersRunning}}'"

echo; echo "--- ALL containers (running and stopped) ---"
try "docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'"

echo; echo "--- compose projects already on this host ---"
try "docker compose ls --all"

echo; echo "--- compose project labels (which containers belong to which project) ---"
try "docker ps -a --format '{{.Names}}' | while read -r c; do printf '%-40s %s\n' \"\$c\" \"\$(docker inspect -f '{{index .Config.Labels \"com.docker.compose.project\"}}' \"\$c\" 2>/dev/null)\"; done"

echo; echo "--- networks ---";  try "docker network ls"
echo; echo "--- VOLUMES  [any bamform_* must never be deleted] ---"; try "docker volume ls"
echo; echo "--- images ---";    try "docker images --format 'table {{.Repository}}\t{{.Tag}}\t{{.Size}}'"
echo; echo "--- resource usage snapshot ---"; try "docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}'"

echo; echo "--- containers WITHOUT a memory limit  [RK-08: unbounded container can take down the host] ---"
try "docker ps -q | while read -r c; do lim=\$(docker inspect -f '{{.HostConfig.Memory}}' \"\$c\"); [ \"\$lim\" = \"0\" ] && docker inspect -f '  UNLIMITED: {{.Name}}' \"\$c\"; done"

# =============================================================================
sec "4. PORT MAP  [required for deconfliction — the key output of this sweep]"

echo "--- all listening sockets ---"
try "ss -tulpn | sort -k5"
echo; echo "--- fallback ---"; try "netstat -tulpn | sort -k4"

echo; echo "--- container port publications ---"
try "docker ps --format '{{.Names}}\t{{.Ports}}'"

echo; echo "--- who owns :80 / :443 / :3000-3010 / :5432 / :6379 / :9000-9001 ---"
try "ss -tulpn | grep -E ':(80|443|300[0-9]|3010|5432|6379|900[0-1])\\b'"

echo
echo "NOTE: BamForm will bind ALL containers to 127.0.0.1 only (PR-001)."
echo "      Postgres, Redis and MinIO publish NO host port at all (PR-ENV-11)."

# =============================================================================
sec "5. REVERSE PROXY  [decides PRD §3.7 — Caddy vs existing vhost]"

for svc in nginx caddy traefik apache2 httpd haproxy; do
  printf '\n--- %s ---\n' "$svc"
  try "systemctl is-active $svc"
  try "systemctl status $svc --no-pager -l | head -15"
done

echo; echo "--- nginx config ---"
try "nginx -v"
try "nginx -T 2>/dev/null | grep -E 'server_name|listen|ssl_certificate ' | head -40"
try "ls -la /etc/nginx/sites-enabled/ /etc/nginx/conf.d/"

echo; echo "--- caddy config ---"
try "caddy version"
try "ls -la /etc/caddy/"
[ -r /etc/caddy/Caddyfile ] && grep -E '^[a-zA-Z0-9.*]|reverse_proxy' /etc/caddy/Caddyfile | head -40

echo; echo "--- proxy running as a container? ---"
try "docker ps --format '{{.Names}}\t{{.Image}}' | grep -Ei 'nginx|caddy|traefik|proxy'"

echo
echo "DECISION INPUT: if anything already terminates TLS on :443, BamForm adds a"
echo "vhost to it. A second listener on :443 would take other applications down (CN-01)."

# =============================================================================
sec "6. DNS AND CERTIFICATES  [form.bevorasg.com]"

try "getent hosts form.bevorasg.com"
try "dig +short form.bevorasg.com"
echo; echo "--- this host's public address ---"; try "curl -s --max-time 5 https://ifconfig.me"; echo
echo; echo "--- existing certificates ---"
try "ls -la /etc/letsencrypt/live/ 2>/dev/null"
try "find /var/lib/caddy -name '*.crt' 2>/dev/null | head"
echo; echo "--- does the name already resolve to something serving? ---"
try "curl -sS -o /dev/null -w 'HTTP %{http_code}  TLS %{ssl_verify_result}\n' --max-time 8 https://form.bevorasg.com"

# =============================================================================
sec "7. SCHEDULED JOBS  [deconflict the deploy cron]"

echo "--- root crontab ---";     try "crontab -l"
echo; echo "--- /etc/cron.d ---"; try "ls -la /etc/cron.d/"; try "grep -r . /etc/cron.d/ 2>/dev/null | head -30"
echo; echo "--- /etc/crontab ---"; [ -r /etc/crontab ] && grep -v '^#' /etc/crontab | grep -v '^$'
echo; echo "--- per-user crontabs ---"; try "ls -la /var/spool/cron/crontabs/ 2>/dev/null"
echo; echo "--- systemd timers ---"; try "systemctl list-timers --all --no-pager"
echo; echo "--- cron service ---";   try "systemctl is-active cron crond"

# =============================================================================
sec "8. TOOLING  [required by the CD mechanism]"

for t in git flock curl jq openssl rsync pg_dump mc logrotate; do
  if have "$t"; then printf '  %-12s OK   %s\n' "$t" "$(command -v "$t")"
  else                printf '  %-12s MISSING\n' "$t"; fi
done
echo; try "git --version"
echo; echo "--- can this host reach GitHub? ---"
try "timeout 10 ssh -o StrictHostKeyChecking=accept-new -T git@github.com"
echo "(the expected success message is 'Hi <user>! You've successfully authenticated,"
echo " but GitHub does not provide shell access' — anything else means a deploy key is needed)"
echo; try "curl -sS -o /dev/null -w 'github.com HTTP %{http_code}\n' --max-time 8 https://github.com"

# =============================================================================
sec "9. MAIL RELAY  [notification dispatch]"

try "systemctl is-active postfix exim4"
echo; echo "--- is an SMTP port reachable locally? ---"
try "ss -tulpn | grep -E ':(25|465|587)\\b'"

# =============================================================================
sec "10. SECURITY POSTURE"

echo "--- firewall ---"; try "ufw status verbose"; try "iptables -S | head -30"
echo; echo "--- SSH config (non-default lines) ---"
try "grep -vE '^\\s*#|^\\s*$' /etc/ssh/sshd_config"
echo; echo "--- fail2ban ---"; try "fail2ban-client status"
echo; echo "--- pending updates ---"; try "apt list --upgradable 2>/dev/null | head -20"
echo; echo "--- unattended upgrades ---"; try "systemctl is-active unattended-upgrades"
echo; echo "--- SELinux / AppArmor ---"; try "getenforce"; try "aa-status --enabled && echo 'AppArmor enabled'"

# =============================================================================
sec "11. EXISTING APPLICATION FOOTPRINT  [what must not be disturbed]"

echo "--- candidate application directories ---"
try "ls -la /opt /srv /home 2>/dev/null"
echo; echo "--- compose files on disk ---"
try "find /opt /srv /home /root -maxdepth 4 -name 'docker-compose*.y*ml' 2>/dev/null | head -20"
echo; echo "--- is /opt/bamform already present? ---"
try "ls -la /opt/bamform 2>/dev/null || echo '(not present — expected on first run)'"

# =============================================================================
sec "12. SUMMARY — ANSWER THESE FROM THE OUTPUT ABOVE"

cat <<'SUMMARY'

  1. Production or staging?                         ..................
  2. Free RAM available to BamForm (need 4 GB min)? ..................
  3. Free disk (need 60 GB min)?                    ..................
  4. NTP synchronised?                              ..................
  5. What already listens on :80 / :443?            ..................
  6. Existing reverse proxy — which, and container or host service?
                                                    ..................
  7. Other Compose projects, and their service names?
                                                    ..................
  8. Does form.bevorasg.com resolve to this host?   ..................
  9. Can this host `git fetch` from GitHub already? ..................
 10. Free ports for bamform-web and bamform-api?    ..................
 11. Is `flock` present (required by the deploy lock)?
                                                    ..................
 12. SMTP relay available for notifications?        ..................

END OF RECON — nothing was created, modified, restarted or removed.
SUMMARY
