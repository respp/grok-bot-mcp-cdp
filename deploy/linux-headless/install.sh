#!/bin/sh
# Installs the Grok Bot app as a headless systemd service on Debian/Ubuntu (amd64).
# Safe to re-run. Usage: sudo ./install.sh
set -eu

KEY_URL=https://downloads.cursor.com/keys/anysphere.asc
KEY_FPR=380FF4BCDC34A4BD92A3565342A1772E62E492D6
KEYRING=/usr/share/keyrings/anysphere.gpg
BOOTSTRAP_LIST=/etc/apt/sources.list.d/grok-bot.list
# The grok-bot package writes its own source file on install. apt refuses two entries for the
# same repository with different Signed-By values, so the bootstrap entry is removed once it exists.
PACKAGE_SOURCES=/etc/apt/sources.list.d/grok-bot.sources
SVC_USER=grokbot
SVC_HOME=/home/grokbot
HERE=$(cd "$(dirname "$0")" && pwd)

if [ "$(id -u)" != 0 ]; then
  echo "Run as root: sudo $0" >&2
  exit 1
fi
if [ "$(dpkg --print-architecture)" != amd64 ]; then
  echo "The grok-bot apt package is published for amd64 only." >&2
  exit 1
fi

drop_bootstrap_source() {
  if [ -f "$PACKAGE_SOURCES" ] && [ -f "$BOOTSTRAP_LIST" ]; then
    echo "Removing $BOOTSTRAP_LIST (the package manages $PACKAGE_SOURCES)"
    rm -f "$BOOTSTRAP_LIST"
  fi
}

# 1. apt source and package
drop_bootstrap_source
if ! dpkg -s grok-bot >/dev/null 2>&1; then
  apt-get update
  apt-get install -y --no-install-recommends ca-certificates curl gnupg xvfb
  if [ ! -f "$PACKAGE_SOURCES" ]; then
    tmp=$(mktemp -d)
    trap 'rm -rf "$tmp"' EXIT
    curl -fsSL "$KEY_URL" -o "$tmp/key.asc"
    pubs=$(GNUPGHOME="$tmp" gpg --batch --show-keys --with-colons "$tmp/key.asc" | grep -c '^pub:' || true)
    fpr=$(GNUPGHOME="$tmp" gpg --batch --show-keys --with-colons "$tmp/key.asc" | awk -F: '$1 == "fpr" { print $10; exit }')
    if [ "$pubs" != 1 ] || [ "$fpr" != "$KEY_FPR" ]; then
      echo "Signing key fingerprint mismatch: expected $KEY_FPR, got '$fpr' ($pubs keys). Not trusting it." >&2
      exit 1
    fi
    GNUPGHOME="$tmp" gpg --batch --yes --dearmor -o "$KEYRING" "$tmp/key.asc"
    chmod 644 "$KEYRING"
    echo "deb [arch=amd64 signed-by=$KEYRING] https://downloads.cursor.com/aptrepo grok-bot main" > "$BOOTSTRAP_LIST"
  fi
  apt-get update
  apt-get install -y grok-bot
  drop_bootstrap_source
else
  apt-get install -y --no-install-recommends xvfb
fi

# 2. dedicated user (no login shell, private home)
if ! id "$SVC_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "$SVC_HOME" --shell /usr/sbin/nologin "$SVC_USER"
fi
chmod 700 "$SVC_HOME"

# 3. fake browser that logs the URLs the app opens (sign-in link)
install -m 755 "$HERE/grokbot-capture-url" /usr/local/bin/grokbot-capture-url

# 4. services
install -m 644 "$HERE/grok-bot-xvfb.service" /etc/systemd/system/grok-bot-xvfb.service
install -m 644 "$HERE/grok-bot.service" /etc/systemd/system/grok-bot.service
systemctl daemon-reload
systemctl enable --now grok-bot-xvfb.service grok-bot.service

echo
echo "Done. Grok Bot runs as '$SVC_USER' with CDP on 127.0.0.1:9333."
echo "If you changed the unit files on a re-run: sudo systemctl restart grok-bot-xvfb grok-bot"
echo "Next: sign in (see README), then run: node src/index.js doctor"
