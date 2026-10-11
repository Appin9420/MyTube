@echo off
rem Build the MyTubeTray.exe single-file tray program.
rem Uses the in-box .NET Framework compiler - no Visual Studio required.
rem Run from anywhere: cmd /c "%~dp0build-tray.cmd"
setlocal
set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%CSC%" (
  echo .NET Framework 4.x csc.exe not found
  exit /b 1
)
"%CSC%" /nologo /target:winexe /out:"%~dp0MyTubeTray.exe" /win32icon:"%~dp0mytube-tray.ico" /r:System.Windows.Forms.dll /r:System.Drawing.dll "%~dp0MyTubeTray.cs"
if errorlevel 1 exit /b 1
echo Built: %~dp0MyTubeTray.exe
endlocal
