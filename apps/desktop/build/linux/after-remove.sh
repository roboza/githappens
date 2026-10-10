#!/bin/bash
# deb/rpm post-remove (spec 15 §6.4): drop the /usr/bin/githappens link and the AppArmor profile.
# Based on electron-builder 26's default after-remove.tpl, plus an upgrade guard: rpm runs the old
# package's %postun (with $1 = 1) *after* the new package's %post, and deb runs postrm with "upgrade";
# removing the link then would undo the new install. electron-builder substitutes the dollar-brace
# macros (executable, sanitizedProductName); plain shell variables here must not use braces.

case "$1" in
    upgrade | 1 | 2 | 3) exit 0 ;;
esac

CLI='/opt/${sanitizedProductName}/resources/bin/${executable}'

if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove '${executable}' "$CLI" >/dev/null 2>&1 || true
    # Pre-launcher releases registered the binary itself.
    update-alternatives --remove '${executable}' '/opt/${sanitizedProductName}/${executable}' >/dev/null 2>&1 || true
fi
if [ -L '/usr/bin/${executable}' ] && [ ! -e '/usr/bin/${executable}' ]; then
    rm -f '/usr/bin/${executable}'
fi

APPARMOR_PROFILE_DEST='/etc/apparmor.d/${executable}'
if [ -f "$APPARMOR_PROFILE_DEST" ]; then
  if apparmor_status --enabled > /dev/null 2>&1; then
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      apparmor_parser --remove "$APPARMOR_PROFILE_DEST" || true
    fi
  fi
  rm -f "$APPARMOR_PROFILE_DEST"
fi
