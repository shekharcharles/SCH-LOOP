' SCH Loop — launch the dashboard with no console window.
' Used by sch-dashboard.bat (Start) and by the auto-start entry.
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = scriptDir
sh.Run "node scripts\dashboard.mjs", 0, False
