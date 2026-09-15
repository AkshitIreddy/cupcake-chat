Option Explicit

Dim shell, environment, fileSystem, repositoryRoot, executablePath
Set shell = CreateObject("WScript.Shell")
Set environment = shell.Environment("Process")
Set fileSystem = CreateObject("Scripting.FileSystemObject")

repositoryRoot = fileSystem.GetParentFolderName(WScript.ScriptFullName)
executablePath = fileSystem.BuildPath(repositoryRoot, "apps\desktop\src-tauri\target\release\CupcakeAI.exe")
environment("CUPCAKE_TEST_DATA_DIR") = fileSystem.BuildPath(repositoryRoot, "out\profiles\demo")
environment("WEBVIEW2_USER_DATA_FOLDER") = fileSystem.BuildPath(repositoryRoot, "out\profiles\demo-webview2")

' Open the isolated real-demo profile; the clean owner workspace stays separate.
shell.Run """" & executablePath & """", 1, False
