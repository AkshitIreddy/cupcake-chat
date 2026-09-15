Option Explicit

Dim shell, environment, fileSystem, repositoryRoot, executablePath
Set shell = CreateObject("WScript.Shell")
Set environment = shell.Environment("Process")
Set fileSystem = CreateObject("Scripting.FileSystemObject")

repositoryRoot = fileSystem.GetParentFolderName(WScript.ScriptFullName)
' Keep the binary name stable so existing installs and owner-profile credentials
' continue to use the same Windows application identity.
executablePath = fileSystem.BuildPath(repositoryRoot, "apps\desktop\src-tauri\target\release\CupcakeAI.exe")

environment("CUPCAKE_TEST_DATA_DIR") = fileSystem.BuildPath(repositoryRoot, "out\profiles\test")
environment("WEBVIEW2_USER_DATA_FOLDER") = fileSystem.BuildPath(repositoryRoot, "out\profiles\test-webview2")

shell.Run """" & executablePath & """", 1, False
