' Mixtape lightweight desktop launcher: starts the player server hidden, then opens it in its own app window.
Option Explicit
Dim fso, sh, root, http, running, i, edgeProfile
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))

Function Healthy()
  On Error Resume Next
  Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  http.setTimeouts 1000, 1000, 1000, 1000
  http.open "GET", "http://127.0.0.1:4321/api/health", False
  http.send
  Healthy = (Err.Number = 0) And (http.status = 200)
  Err.Clear
End Function

If Not Healthy() Then
  ' "app" mode: proxy detection + hidden server, no console window, no extra browser tab
  sh.Run "cmd /c """ & root & "\scripts\windows\start-mixtape.cmd"" app", 0, False
  For i = 1 To 40
    WScript.Sleep 500
    If Healthy() Then Exit For
  Next
End If

edgeProfile = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Mixtape\app-window"
sh.Run "cmd /c start """" msedge --app=http://127.0.0.1:4321 --user-data-dir=""" & edgeProfile & """ --window-size=1280,820 --autoplay-policy=no-user-gesture-required", 0, False
