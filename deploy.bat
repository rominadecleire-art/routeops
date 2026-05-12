@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo  RouteOps Deploy
echo  ===============
echo.

for /f "tokens=1-5 delims=/ " %%a in ('date /t') do set FECHA=%%c-%%b-%%a
for /f "tokens=1-2 delims=: " %%a in ('time /t') do set HORA=%%a:%%b
set MSG=deploy %FECHA% %HORA%

echo Commit: %MSG%
echo.

git add .
git commit -m "%MSG%"
git push origin master

echo.
if %errorlevel%==0 (
    echo  Listo. Render actualizara en 1-2 minutos.
) else (
    echo  Algo salio mal. Revisa los mensajes de arriba.
)
echo.
pause
