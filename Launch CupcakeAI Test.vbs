Option Explicit

Dim shell, environment, fileSystem, repositoryRoot, executablePath
Set shell = CreateObject("WScript.Shell")
Set environment = shell.Environment("Process")
Set fileSystem = CreateObject("Scripting.FileSystemObject")

repositoryRoot = fileSystem.GetParentFolderName(WScript.ScriptFullName)
executablePath = fileSystem.BuildPath(repositoryRoot, "apps\desktop\src-tauri\target\release\CupcakeAI.exe")

environment("CUPCAKE_TEST_DATA_DIR") = "E:\temp\cupcakeai-owner-test-20260902"
environment("WEBVIEW2_USER_DATA_FOLDER") = "E:\temp\cupcakeai-owner-test-20260902-webview2"

shell.Run """" & executablePath & """", 1, False
