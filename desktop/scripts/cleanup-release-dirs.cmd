@echo off
setlocal enabledelayedexpansion
set LOG=D:\MyTube\desktop\release-cleanup.log
echo [%date% %time%] retry cleanup v2 start (interval 60s, up to 240 attempts) >> "%LOG%"
for /l %%i in (1,1,240) do (
    set DONE=1
    for %%d in (release2 release3 release4 release6 release7) do (
        if exist "D:\MyTube\desktop\%%d\" (
            set DONE=0
            rmdir /s /q "D:\MyTube\desktop\%%d" >nul 2>&1
            if exist "D:\MyTube\desktop\%%d\" (
                echo [%date% %time%] %%d still locked >> "%LOG%"
            ) else (
                echo [%date% %time%] %%d removed >> "%LOG%"
            )
        )
    )
    if !DONE!==1 (
        echo [%date% %time%] all cleaned >> "%LOG%"
        exit /b 0
    )
    ping -n 61 127.0.0.1 >nul
)
echo [%date% %time%] gave up after 240 attempts >> "%LOG%"
