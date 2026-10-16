//go:build windows

// Mixtape-Setup.exe: per-user installer. The app files are a zip appended to this executable,
// followed by a 16-byte trailer: uint64 little-endian payload offset + "MIXTAPE!".
package main

import (
	"archive/zip"
	_ "embed"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"mixtape-installer/common"
	"mixtape-installer/winui"
)

//go:embed uninstall.exe
var uninstaller []byte

const magic = "MIXTAPE!"

func openPayload() (*zip.Reader, *os.File, error) {
	self, err := os.Executable()
	if err != nil {
		return nil, nil, err
	}
	f, err := os.Open(self)
	if err != nil {
		return nil, nil, err
	}
	st, _ := f.Stat()
	trailer := make([]byte, 16)
	if _, err := f.ReadAt(trailer, st.Size()-16); err != nil || string(trailer[8:]) != magic {
		f.Close()
		return nil, nil, errors.New("this installer is damaged (no app payload found) — please download it again")
	}
	off := int64(binary.LittleEndian.Uint64(trailer[:8]))
	zr, err := zip.NewReader(io.NewSectionReader(f, off, st.Size()-16-off), st.Size()-16-off)
	if err != nil {
		f.Close()
		return nil, nil, err
	}
	return zr, f, nil
}

func extract(zr *zip.Reader, dir string, p *winui.Progress) (int64, error) {
	var total, done int64
	for _, f := range zr.File {
		total += int64(f.UncompressedSize64)
	}
	last := -1
	for _, f := range zr.File {
		name := filepath.FromSlash(f.Name)
		dst := filepath.Join(dir, name)
		if !strings.HasPrefix(dst, filepath.Clean(dir)+string(os.PathSeparator)) {
			return 0, fmt.Errorf("bad path in payload: %s", f.Name)
		}
		if f.FileInfo().IsDir() {
			os.MkdirAll(dst, 0o755)
			continue
		}
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return 0, err
		}
		rc, err := f.Open()
		if err != nil {
			return 0, err
		}
		out, err := os.Create(dst)
		if err != nil {
			rc.Close()
			return 0, err
		}
		n, err := io.Copy(out, rc)
		rc.Close()
		out.Close()
		if err != nil {
			return 0, err
		}
		done += n
		if pct := int(done * 100 / max(total, 1)); pct != last {
			last = pct
			p.Percent(pct)
			p.Status(fmt.Sprintf("Installing Mixtape…  %d%%", pct))
		}
	}
	return total, nil
}

func removeWithRetry(dir string) error {
	var err error
	for i := 0; i < 10; i++ {
		if err = os.RemoveAll(dir); err == nil {
			return nil
		}
		time.Sleep(500 * time.Millisecond)
	}
	return err
}

func main() {
	dir := common.InstallDir()
	_, statErr := os.Stat(filepath.Join(dir, "Mixtape.exe"))
	verb := "Install"
	if statErr == nil {
		verb = "Update"
	}
	quiet := len(os.Args) > 1 && (os.Args[1] == "/S" || os.Args[1] == "--silent")
	if !quiet && winui.MessageBox("Mixtape Setup",
		fmt.Sprintf("%s Mixtape %s?\n\nLocation: %s\n\nYour playlists and liked songs are kept.", verb, common.Version, dir),
		winui.MB_OKCANCEL|winui.MB_ICONQUESTION) != winui.IDOK {
		return
	}

	zr, f, err := openPayload()
	if err != nil {
		winui.MessageBox("Mixtape Setup", err.Error(), winui.MB_ICONERROR)
		os.Exit(1)
	}
	defer f.Close()

	var mcpOK bool
	err = winui.RunWithProgress("Mixtape Setup", func(p *winui.Progress) error {
		p.Status("Closing Mixtape…")
		common.StopApp()
		p.Status("Removing the previous version…")
		if err := removeWithRetry(dir); err != nil {
			return fmt.Errorf("could not replace %s (is Mixtape still running?): %w", dir, err)
		}
		size, err := extract(zr, dir, p)
		if err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(dir, "Uninstall Mixtape.exe"), uninstaller, 0o755); err != nil {
			return err
		}
		p.Status("Creating shortcuts…")
		exe := filepath.Join(dir, "Mixtape.exe")
		if err := common.CreateShortcuts(exe, filepath.Join(dir, "Mixtape.ico"), dir); err != nil {
			return fmt.Errorf("could not create shortcuts: %w", err)
		}
		common.RegisterUninstall(dir, size/1024)
		p.Status("Connecting to Claude Code…")
		mcpOK = common.RegisterMCP(dir)
		p.Percent(100)
		p.Status("Done")
		return nil
	})
	if err != nil {
		winui.MessageBox("Mixtape Setup", "Installation failed:\n\n"+err.Error(), winui.MB_ICONERROR)
		os.Exit(1)
	}
	if quiet {
		return
	}
	note := ""
	if mcpOK {
		note = "\n\nClaude Code can now control Mixtape (MCP server \"mixtape\")."
	}
	if winui.MessageBox("Mixtape Setup", "Mixtape is installed. Shortcuts were added to your Desktop and Start menu."+note+"\n\nLaunch Mixtape now?",
		winui.MB_YESNO|winui.MB_ICONINFORMATION) == winui.IDYES {
		winui.Open(filepath.Join(dir, "Mixtape.exe"))
	}
}
