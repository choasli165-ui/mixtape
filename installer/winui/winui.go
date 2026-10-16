//go:build windows

// Package winui is a tiny Win32 layer (no dependencies): message boxes, a progress window, hidden processes.
package winui

import (
	"os/exec"
	"runtime"
	"syscall"
	"unsafe"
)

var (
	user32   = syscall.NewLazyDLL("user32.dll")
	gdi32    = syscall.NewLazyDLL("gdi32.dll")
	kernel32 = syscall.NewLazyDLL("kernel32.dll")
	comctl32 = syscall.NewLazyDLL("comctl32.dll")
	shell32  = syscall.NewLazyDLL("shell32.dll")

	pMessageBoxW          = user32.NewProc("MessageBoxW")
	pRegisterClassExW     = user32.NewProc("RegisterClassExW")
	pCreateWindowExW      = user32.NewProc("CreateWindowExW")
	pDefWindowProcW       = user32.NewProc("DefWindowProcW")
	pGetMessageW          = user32.NewProc("GetMessageW")
	pTranslateMessage     = user32.NewProc("TranslateMessage")
	pDispatchMessageW     = user32.NewProc("DispatchMessageW")
	pPostMessageW         = user32.NewProc("PostMessageW")
	pSendMessageW         = user32.NewProc("SendMessageW")
	pPostQuitMessage      = user32.NewProc("PostQuitMessage")
	pDestroyWindow        = user32.NewProc("DestroyWindow")
	pSetWindowTextW       = user32.NewProc("SetWindowTextW")
	pLoadIconW            = user32.NewProc("LoadIconW")
	pLoadCursorW          = user32.NewProc("LoadCursorW")
	pGetSystemMetrics     = user32.NewProc("GetSystemMetrics")
	pSetProcessDPIAware   = user32.NewProc("SetProcessDPIAware")
	pGetDpiForSystem      = user32.NewProc("GetDpiForSystem")
	pCreateFontW          = gdi32.NewProc("CreateFontW")
	pCreateSolidBrush     = gdi32.NewProc("CreateSolidBrush")
	pGetModuleHandleW     = kernel32.NewProc("GetModuleHandleW")
	pInitCommonControlsEx = comctl32.NewProc("InitCommonControlsEx")
	pShellExecuteW        = shell32.NewProc("ShellExecuteW")
)

const (
	MB_OK              = 0x0
	MB_OKCANCEL        = 0x1
	MB_YESNO           = 0x4
	MB_ICONERROR       = 0x10
	MB_ICONQUESTION    = 0x20
	MB_ICONINFORMATION = 0x40
	IDOK               = 1
	IDYES              = 6

	wmDestroy     = 0x0002
	wmClose       = 0x0010
	wmSetFont     = 0x0030
	wmApp         = 0x8000
	pbmSetRange32 = 0x0406
	pbmSetPos     = 0x0402
)

func u16(s string) *uint16 { p, _ := syscall.UTF16PtrFromString(s); return p }

func init() {
	// Crisp text on high-DPI screens (the manifest also declares this).
	if pSetProcessDPIAware.Find() == nil {
		pSetProcessDPIAware.Call()
	}
}

func dpi() int {
	if pGetDpiForSystem.Find() == nil {
		if d, _, _ := pGetDpiForSystem.Call(); d > 0 {
			return int(d)
		}
	}
	return 96
}

func scale(v int) int { return v * dpi() / 96 }

// MessageBox shows a native dialog and returns the button id.
func MessageBox(title, text string, flags uintptr) int {
	r, _, _ := pMessageBoxW.Call(0, uintptr(unsafe.Pointer(u16(text))), uintptr(unsafe.Pointer(u16(title))), flags)
	return int(r)
}

// HiddenCommand returns an exec.Cmd that never shows a console window.
func HiddenCommand(name string, args ...string) *exec.Cmd {
	c := exec.Command(name, args...)
	c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} // CREATE_NO_WINDOW
	return c
}

// Open launches a program or document like a double-click (no console).
func Open(path string) {
	pShellExecuteW.Call(0, uintptr(unsafe.Pointer(u16("open"))), uintptr(unsafe.Pointer(u16(path))), 0, 0, 1)
}

type wndClassEx struct {
	cbSize        uint32
	style         uint32
	lpfnWndProc   uintptr
	cbClsExtra    int32
	cbWndExtra    int32
	hInstance     uintptr
	hIcon         uintptr
	hCursor       uintptr
	hbrBackground uintptr
	lpszMenuName  *uint16
	lpszClassName *uint16
	hIconSm       uintptr
}

type msg struct {
	hwnd    uintptr
	message uint32
	wParam  uintptr
	lParam  uintptr
	time    uint32
	pt      struct{ x, y int32 }
	private uint32
}

type initCommonControlsEx struct{ size, icc uint32 }

// Progress is a small fixed-size window with a status line and a progress bar.
type Progress struct {
	hwnd, label, bar uintptr
	done             chan struct{}
}

// RunWithProgress shows the window, runs work on a goroutine, and returns work's error after closing the window.
func RunWithProgress(title string, work func(p *Progress) error) error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	icc := initCommonControlsEx{size: 8, icc: 0x20} // ICC_PROGRESS_CLASS
	pInitCommonControlsEx.Call(uintptr(unsafe.Pointer(&icc)))
	hInst, _, _ := pGetModuleHandleW.Call(0)
	icon, _, _ := pLoadIconW.Call(hInst, 1)
	cursor, _, _ := pLoadCursorW.Call(0, 32512)
	bg, _, _ := pCreateSolidBrush.Call(0x00FFFFFF)

	p := &Progress{done: make(chan struct{})}
	wndProc := syscall.NewCallback(func(hwnd, m, w, l uintptr) uintptr {
		switch m {
		case wmApp: // w = percent
			pSendMessageW.Call(p.bar, pbmSetPos, w, 0)
			return 0
		case wmApp + 1:
			pDestroyWindow.Call(hwnd)
			return 0
		case wmClose:
			return 0 // not cancellable mid-install
		case wmDestroy:
			pPostQuitMessage.Call(0)
			return 0
		}
		r, _, _ := pDefWindowProcW.Call(hwnd, m, w, l)
		return r
	})
	cls := u16("MixtapeSetupWindow")
	wc := wndClassEx{lpfnWndProc: wndProc, hInstance: hInst, hIcon: icon, hIconSm: icon, hCursor: cursor, hbrBackground: bg, lpszClassName: cls}
	wc.cbSize = uint32(unsafe.Sizeof(wc))
	pRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc)))

	w, h := scale(440), scale(150)
	sw, _, _ := pGetSystemMetrics.Call(0)
	sh, _, _ := pGetSystemMetrics.Call(1)
	style := uintptr(0x00C00000 | 0x00080000 | 0x10000000) // WS_CAPTION | WS_SYSMENU | WS_VISIBLE
	p.hwnd, _, _ = pCreateWindowExW.Call(0, uintptr(unsafe.Pointer(cls)), uintptr(unsafe.Pointer(u16(title))), style,
		(sw-uintptr(w))/2, (sh-uintptr(h))/2, uintptr(w), uintptr(h), 0, 0, hInst, 0)
	font, _, _ := pCreateFontW.Call(uintptr(-scale(15)), 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 5, 0, uintptr(unsafe.Pointer(u16("Segoe UI"))))
	child := uintptr(0x40000000 | 0x10000000) // WS_CHILD | WS_VISIBLE
	p.label, _, _ = pCreateWindowExW.Call(0, uintptr(unsafe.Pointer(u16("STATIC"))), uintptr(unsafe.Pointer(u16("Preparing…"))), child,
		uintptr(scale(20)), uintptr(scale(18)), uintptr(w-scale(56)), uintptr(scale(22)), p.hwnd, 0, hInst, 0)
	pSendMessageW.Call(p.label, wmSetFont, font, 1)
	p.bar, _, _ = pCreateWindowExW.Call(0, uintptr(unsafe.Pointer(u16("msctls_progress32"))), 0, child,
		uintptr(scale(20)), uintptr(scale(50)), uintptr(w-scale(56)), uintptr(scale(20)), p.hwnd, 0, hInst, 0)
	pSendMessageW.Call(p.bar, pbmSetRange32, 0, 100)

	var workErr error
	go func() {
		workErr = work(p)
		pPostMessageW.Call(p.hwnd, wmApp+1, 0, 0)
	}()
	var m msg
	for {
		r, _, _ := pGetMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
		if int32(r) <= 0 {
			break
		}
		pTranslateMessage.Call(uintptr(unsafe.Pointer(&m)))
		pDispatchMessageW.Call(uintptr(unsafe.Pointer(&m)))
	}
	return workErr
}

// Status updates the text line (safe from any goroutine).
func (p *Progress) Status(s string) { pSetWindowTextW.Call(p.label, uintptr(unsafe.Pointer(u16(s)))) }

// Percent updates the bar (safe from any goroutine).
func (p *Progress) Percent(v int) { pPostMessageW.Call(p.hwnd, wmApp, uintptr(v), 0) }
