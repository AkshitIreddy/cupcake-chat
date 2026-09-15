Option Explicit

' Compatibility launcher for existing shortcuts. New shortcuts should use
' "Launch Cupcake Chat Test.vbs" in this folder.

Dim shell, environment, fileSystem, repositoryRoot, executablePath
Set shell = CreateObject("WScript.Shell")
Set environment = shell.Environment("Process")
Set fileSystem = CreateObject("Scripting.FileSystemObject")

repositoryRoot = fileSystem.GetParentFolderName(WScript.ScriptFullName)
executablePath = fileSystem.BuildPath(repositoryRoot, "apps\desktop\src-tauri\target\release\CupcakeAI.exe")

environment("CUPCAKE_TEST_DATA_DIR") = fileSystem.BuildPath(repositoryRoot, "out\profiles\test")
environment("WEBVIEW2_USER_DATA_FOLDER") = fileSystem.BuildPath(repositoryRoot, "out\profiles\test-webview2")

shell.Run """" & executablePath & """", 1, False
