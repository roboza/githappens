#!/bin/bash
# deb/rpm post-install (electron-builder `linux.afterInstall` equivalent for deb + rpm, spec 15 §6.4).
# Based on electron-builder 26's default after-install.tpl; the only change is that /usr/bin/githappens
# points at the CLI launcher (resources/bin/githappens: makes paths absolute, detaches from the terminal)
# instead of the Electron binary. electron-builder substitutes the dollar-brace macros below
# (executable, sanitizedProductName), so plain shell variables here must not use braces.

APP_DIR='/opt/${sanitizedProductName}'
CLI='/opt/${sanitizedProductName}/resources/bin/${executable}'
LINK='/usr/bin/${executable}'

chmod 0755 "$CLI" || true

if type update-alternatives >/dev/null 2>&1; then
    # Releases before the CLI launcher registered the binary itself as the alternative.
    update-alternatives --remove '${executable}' "$APP_DIR/${executable}" >/dev/null 2>&1 || true
    # Remove previous link if it doesn't use update-alternatives
    if [ -L "$LINK" -a -e "$LINK" -a "`readlink "$LINK"`" != '/etc/alternatives/${executable}' ]; then
        rm -f "$LINK"
    fi
    update-alternatives --install "$LINK" '${executable}' "$CLI" 100 || ln -sf "$CLI" "$LINK"
else
    ln -sf "$CLI" "$LINK"
fi

# Check if user namespaces are supported by the kernel and working with a quick test:
if ! { [[ -L /proc/self/ns/user ]] && unshare --user true; }; then
    # Use SUID chrome-sandbox only on systems without user namespaces:
    chmod 4755 "$APP_DIR/chrome-sandbox" || true
else
    chmod 0755 "$APP_DIR/chrome-sandbox" || true
fi

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi

# AppArmor profile (Ubuntu 24+), as in electron-builder's default: only when this AppArmor supports it.
if apparmor_status --enabled > /dev/null 2>&1; then
  APPARMOR_PROFILE_SOURCE="$APP_DIR/resources/apparmor-profile"
  APPARMOR_PROFILE_TARGET='/etc/apparmor.d/${executable}'
  if apparmor_parser --skip-kernel-load --debug "$APPARMOR_PROFILE_SOURCE" > /dev/null 2>&1; then
    cp -f "$APPARMOR_PROFILE_SOURCE" "$APPARMOR_PROFILE_TARGET"
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      apparmor_parser --replace --write-cache --skip-read-cache "$APPARMOR_PROFILE_TARGET"
    fi
  else
    echo "Skipping the installation of the AppArmor profile as this version of AppArmor does not seem to support the bundled profile"
  fi
fi
