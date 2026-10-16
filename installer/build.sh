#!/usr/bin/env bash
# Cross-compiles the Windows installer stub (no app payload yet) into dist/setup-stub.exe.
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$(cd .. && pwd)
VERSION=$(node -p "require('$ROOT/package.json').version")
IFS=. read -r V1 V2 V3 <<< "$VERSION"
WINDRES=${WINDRES:-$(command -v llvm-windres || command -v llvm-windres-18 || command -v x86_64-w64-mingw32-windres)}
[ -n "$WINDRES" ] || { echo "Need llvm-windres or mingw windres (set WINDRES=...)"; exit 1; }
mkdir -p dist
# stamp only Mixtape's own identity; the Common-Controls dependency must stay at 6.0.0.0
sed -E "s/(name=\"Mixtape\.Setup\" version=)\"[0-9.]+\"/\1\"$V1.$V2.$V3.0\"/" "$ROOT/installer/res/app.manifest" > "${TMPDIR:-/tmp}/mx.manifest"
grep -q 'Common-Controls" version="6.0.0.0"' "${TMPDIR:-/tmp}/mx.manifest" || { echo "manifest check failed: Common-Controls must be 6.0.0.0"; exit 1; }
grep -q "Mixtape.Setup\" version=\"$V1.$V2.$V3.0\"" "${TMPDIR:-/tmp}/mx.manifest" || { echo "manifest check failed: version not stamped"; exit 1; }
mkres() { # $1=out.syso $2=description $3=original filename
  cat > "${TMPDIR:-/tmp}/mx.rc" <<RC
1 ICON "$ROOT/desktop/icon.ico"
1 24 "${TMPDIR:-/tmp}/mx.manifest"
1 VERSIONINFO
FILEVERSION $V1,$V2,$V3,0
PRODUCTVERSION $V1,$V2,$V3,0
FILEOS 0x40004
FILETYPE 0x1
BEGIN
  BLOCK "StringFileInfo"
  BEGIN
    BLOCK "040904B0"
    BEGIN
      VALUE "CompanyName", "Mixtape"
      VALUE "FileDescription", "$2"
      VALUE "FileVersion", "$VERSION"
      VALUE "ProductName", "Mixtape"
      VALUE "ProductVersion", "$VERSION"
      VALUE "OriginalFilename", "$3"
    END
  END
  BLOCK "VarFileInfo"
  BEGIN
    VALUE "Translation", 0x409, 1200
  END
END
RC
  "$WINDRES" --target=pe-x86-64 -O coff -i "${TMPDIR:-/tmp}/mx.rc" -o "$1"
}
mkres uninstall/rsrc_windows_amd64.syso "Uninstall Mixtape" "Uninstall Mixtape.exe"
mkres setup/rsrc_windows_amd64.syso "Mixtape Setup" "Mixtape-Setup.exe"
export GOOS=windows GOARCH=amd64 CGO_ENABLED=0 GOFLAGS=-mod=mod
go build -trimpath -ldflags "-H=windowsgui -s -w -X mixtape-installer/common.Version=$VERSION" -o setup/uninstall.exe ./uninstall
go vet ./...
go build -trimpath -ldflags "-H=windowsgui -s -w -X mixtape-installer/common.Version=$VERSION" -o dist/setup-stub.exe ./setup
ls -la dist setup/uninstall.exe
