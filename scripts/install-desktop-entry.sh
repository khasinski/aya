#!/usr/bin/env sh
# Desktop integration for the Aya AppImage.
#
# An AppImage never registers itself: the .desktop entry and the icon set it
# ships stay sealed inside the image. Menus and taskbars are then left with no
# entry to associate a running window with, and fall back to a generic
# placeholder - on Wayland especially, where the window's app_id matched against
# an installed .desktop file is the only association mechanism there is.
# StartupWMClass cannot cover for it: that is an X11 WM_CLASS hint and Wayland
# has no WM_CLASS. Copying both into ~/.local/share is the whole fix.
#
# DEB installs get this from dpkg and do not need this script.
#
#   ./scripts/install-desktop-entry.sh [/path/to/Aya.AppImage]
#   ./scripts/install-desktop-entry.sh --uninstall
set -eu

# Matches the icon name the AppImage ships AND the executable inside it, which is
# what the compositor reports as the window's app_id. All three have to agree or
# the association silently fails.
APP_ID=aya
DATA_HOME=${XDG_DATA_HOME:-$HOME/.local/share}
DESKTOP_FILE=$DATA_HOME/applications/$APP_ID.desktop
ICON_ROOT=$DATA_HOME/icons/hicolor

refresh_caches() {
    if command -v update-desktop-database >/dev/null 2>&1; then
        update-desktop-database "$DATA_HOME/applications" 2>/dev/null || true
    fi
    if command -v gtk-update-icon-cache >/dev/null 2>&1; then
        gtk-update-icon-cache -f -t "$ICON_ROOT" 2>/dev/null || true
    fi
}

if [ "${1:-}" = "--uninstall" ]; then
    rm -f "$DESKTOP_FILE"
    find "$ICON_ROOT" -name "$APP_ID.png" -type f -delete 2>/dev/null || true
    refresh_caches
    printf 'Removed the Aya desktop entry and icons from %s\n' "$DATA_HOME"
    exit 0
fi

# $APPIMAGE is exported by the AppImage runtime, so running this from inside a
# mounted image needs no argument.
APPIMAGE_PATH=${1:-${APPIMAGE:-}}
if [ -z "$APPIMAGE_PATH" ]; then
    printf 'usage: %s [/path/to/Aya.AppImage] | --uninstall\n' "$0" >&2
    exit 2
fi
if [ ! -x "$APPIMAGE_PATH" ]; then
    printf '%s: not an executable file\n' "$APPIMAGE_PATH" >&2
    exit 1
fi
# Exec= must be absolute: the menu launches it from an arbitrary directory.
APPIMAGE_PATH=$(cd "$(dirname "$APPIMAGE_PATH")" && printf '%s/%s' "$(pwd -P)" "$(basename "$APPIMAGE_PATH")")

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT INT TERM
(cd "$WORK" && "$APPIMAGE_PATH" --appimage-extract 'usr/share/icons/*' >/dev/null)

count=0
for src in "$WORK"/squashfs-root/usr/share/icons/hicolor/*/apps/"$APP_ID".png; do
    [ -f "$src" ] || continue
    size=$(basename "$(dirname "$(dirname "$src")")")
    install -Dm0644 "$src" "$ICON_ROOT/$size/apps/$APP_ID.png"
    count=$((count + 1))
done
if [ "$count" -eq 0 ]; then
    printf 'No icons found inside %s\n' "$APPIMAGE_PATH" >&2
    exit 1
fi

mkdir -p "$(dirname "$DESKTOP_FILE")"
cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=Aya
Comment=Agentic terminal manager - Claude Code / Codex / shell sessions organized across projects.
Exec="$APPIMAGE_PATH" %U
Icon=$APP_ID
Terminal=false
Categories=Development;TerminalEmulator;
StartupNotify=true
StartupWMClass=Aya
EOF
chmod 0644 "$DESKTOP_FILE"
refresh_caches

printf 'Installed %s and %d icon sizes under %s\n' "$DESKTOP_FILE" "$count" "$ICON_ROOT"
