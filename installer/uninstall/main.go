//go:build windows

// "Uninstall Mixtape.exe": removes the app, shortcuts, the Settings > Apps entry and the Claude MCP registration.
// It copies itself to %TEMP% first so the install folder (which contains it) can be deleted.
package main

import (
	"io"
	"os"
	"path/filepath"
	"time"

	"mixtape-installer/common"
	"mixtape-installer/winui"
)

func copySelfToTemp() (string, error) {
	self, err := os.Executable()
	if err != nil {
		return "", err
	}
	dst := filepath.Join(os.TempDir(), "mixtape-uninstall.exe")
	in, err := os.Open(self)
	if err != nil {
		return "", err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return "", err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return dst, err
}

func main() {
	if len(os.Args) >= 3 && os.Args[1] == "--from" {
		cleanup(os.Args[2])
		return
	}
	if winui.MessageBox("Uninstall Mixtape", "Remove Mixtape from this PC?\n\nYour playlists and liked songs (in your user folder, .mixtape-agent) are kept.",
		winui.MB_OKCANCEL|winui.MB_ICONQUESTION) != winui.IDOK {
		return
	}
	tmp, err := copySelfToTemp()
	if err != nil {
		winui.MessageBox("Uninstall Mixtape", err.Error(), winui.MB_ICONERROR)
		return
	}
	cmd := winui.HiddenCommand(tmp, "--from", common.InstallDir())
	if err := cmd.Start(); err != nil {
		winui.MessageBox("Uninstall Mixtape", err.Error(), winui.MB_ICONERROR)
	}
}

func cleanup(dir string) {
	time.Sleep(800 * time.Millisecond) // let the launcher exit and release its file
	common.StopApp()
	common.RemoveShortcuts()
	common.UnregisterMCP()
	common.UnregisterUninstall()
	var err error
	for i := 0; i < 10; i++ {
		if err = os.RemoveAll(dir); err == nil {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	if err != nil {
		winui.MessageBox("Uninstall Mixtape", "Some files could not be removed:\n"+err.Error(), winui.MB_ICONERROR)
	} else {
		winui.MessageBox("Uninstall Mixtape", "Mixtape has been removed.", winui.MB_ICONINFORMATION)
	}
	// Delete this temporary copy after we exit.
	self, _ := os.Executable()
	winui.HiddenCommand("cmd.exe", "/c", "ping -n 3 127.0.0.1 >nul & del /f /q \""+self+"\"").Start()
}
