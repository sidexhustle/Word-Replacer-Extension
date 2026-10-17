@echo off
rem make-extension-windows.cmd - Double-click me.
rem Builds the Word Replacer extension for Vivaldi: creates word-replacer-extension.zip,
rem extracts it, and shows the folder to load in Vivaldi (the path is copied to the clipboard).
rem Optional: make-extension-windows.cmd [output-folder]   (default: %USERPROFILE%\VivaldiExtensions)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\make-extension-windows.ps1" %*
echo.
pause
