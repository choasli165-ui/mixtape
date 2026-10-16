//go:build windows

// Package common holds install locations and the steps shared by setup and uninstall.
package common

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"mixtape-installer/winui"
)

const (
	AppName   = "Mixtape"
	UninstKey = `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Mixtape`
)

// Version is set at build time from package.json (installer/build.sh: -ldflags -X).
var Version = "dev"

func InstallDir() string {
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		home, _ := os.UserHomeDir()
		base = filepath.Join(home, "AppData", "Local")
	}
	return filepath.Join(base, "Programs", AppName)
}

func shortcutPaths() []string {
	home, _ := os.UserHomeDir()
	appdata := os.Getenv("APPDATA")
	return []string{
		filepath.Join(home, "Desktop", AppName+".lnk"),
		filepath.Join(appdata, `Microsoft\Windows\Start Menu\Programs`, AppName+".lnk"),
	}
}

func psQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }

// CreateShortcuts writes Desktop and Start Menu shortcuts (via a hidden PowerShell).
func CreateShortcuts(exe, icon, workdir string) error {
	var b strings.Builder
	b.WriteString("$s = New-Object -ComObject WScript.Shell\n")
	// Desktop may be redirected (OneDrive); ask the shell for the real folder.
	b.WriteString("$targets = @((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Mixtape.lnk'), (Join-Path ([Environment]::GetFolderPath('Programs')) 'Mixtape.lnk'))\n")
	b.WriteString("foreach ($t in $targets) { $l = $s.CreateShortcut($t); ")
	b.WriteString("$l.TargetPath = " + psQuote(exe) + "; $l.WorkingDirectory = " + psQuote(workdir) + "; ")
	b.WriteString("$l.IconLocation = " + psQuote(icon+",0") + "; $l.Description = 'Mixtape - AI music player'; $l.Save() }\n")
	return winui.HiddenCommand("powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", b.String()).Run()
}

func RemoveShortcuts() {
	winui.HiddenCommand("powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
		"Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Mixtape.lnk'), (Join-Path ([Environment]::GetFolderPath('Programs')) 'Mixtape.lnk')").Run()
	for _, p := range shortcutPaths() {
		os.Remove(p)
	}
}

func regAdd(name, typ, data string) error {
	return winui.HiddenCommand("reg.exe", "add", UninstKey, "/v", name, "/t", typ, "/d", data, "/f").Run()
}

// RegisterUninstall adds Mixtape to Settings > Apps (per-user, no admin rights needed).
func RegisterUninstall(dir string, sizeKB int64) {
	exe := filepath.Join(dir, "Mixtape.exe")
	regAdd("DisplayName", "REG_SZ", AppName)
	regAdd("DisplayVersion", "REG_SZ", Version)
	regAdd("Publisher", "REG_SZ", AppName)
	regAdd("DisplayIcon", "REG_SZ", exe)
	regAdd("InstallLocation", "REG_SZ", dir)
	regAdd("UninstallString", "REG_SZ", `"`+filepath.Join(dir, "Uninstall Mixtape.exe")+`"`)
	regAdd("NoModify", "REG_DWORD", "1")
	regAdd("NoRepair", "REG_DWORD", "1")
	regAdd("EstimatedSize", "REG_DWORD", itoa(sizeKB))
}

func UnregisterUninstall() { winui.HiddenCommand("reg.exe", "delete", UninstKey, "/f").Run() }

func itoa(n int64) string {
	if n == 0 {
		return "0"
	}
	s := ""
	for n > 0 {
		s = string(rune('0'+n%10)) + s
		n /= 10
	}
	return s
}

// StopApp closes a running Mixtape so its files can be replaced or removed.
func StopApp() {
	if winui.HiddenCommand("taskkill.exe", "/IM", "Mixtape.exe", "/F", "/T").Run() == nil {
		time.Sleep(1500 * time.Millisecond)
	}
}

// FindClaude locates the Claude Code CLI, if installed.
func FindClaude() string {
	if p, err := exec.LookPath("claude.exe"); err == nil {
		return p
	}
	home, _ := os.UserHomeDir()
	p := filepath.Join(home, ".local", "bin", "claude.exe")
	if _, err := os.Stat(p); err == nil {
		return p
	}
	return ""
}

// RegisterMCP lets Claude Code drive Mixtape: Mixtape.exe runs the MCP server in Node mode (no system Node needed).
func RegisterMCP(dir string) bool {
	claude := FindClaude()
	if claude == "" {
		return false
	}
	cfg, _ := json.Marshal(map[string]any{
		"type":    "stdio",
		"command": filepath.Join(dir, "Mixtape.exe"),
		"args":    []string{filepath.Join(dir, "resources", "app", "bin", "mixtape.js"), "mcp"},
		"env":     map[string]string{"ELECTRON_RUN_AS_NODE": "1"},
	})
	winui.HiddenCommand(claude, "mcp", "remove", "mixtape", "-s", "user").Run()
	return winui.HiddenCommand(claude, "mcp", "add-json", "mixtape", string(cfg), "-s", "user").Run() == nil
}

func UnregisterMCP() {
	if c := FindClaude(); c != "" {
		winui.HiddenCommand(c, "mcp", "remove", "mixtape", "-s", "user").Run()
	}
}
