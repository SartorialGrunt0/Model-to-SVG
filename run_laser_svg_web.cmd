@echo off
setlocal

cd /d "%~dp0"

set "VENV_DIR=%CD%\.venv"
set "VENV_PYTHON=%VENV_DIR%\Scripts\python.exe"

if not exist "%VENV_PYTHON%" (
    call :find_bootstrap_python || exit /b 1
    echo Creating virtual environment...
    "%BOOTSTRAP_PYTHON%" -m venv "%VENV_DIR%" || exit /b 1
)

echo Installing or updating Python dependencies...
"%VENV_PYTHON%" -m pip install --upgrade pip || exit /b 1
"%VENV_PYTHON%" -m pip install -e . || exit /b 1

call :find_npm || exit /b 1

pushd webapp || exit /b 1
if not exist node_modules (
    echo Installing frontend dependencies...
    call npm install || (popd & exit /b 1)
)

echo Building frontend...
call npm run build || (popd & exit /b 1)
popd

if /I not "%~1"=="--no-browser" (
    start "" "http://127.0.0.1:8000"
)

echo Starting Laser SVG web app on http://127.0.0.1:8000 ...
"%VENV_PYTHON%" -m uvicorn laser_svg_tool.web_api:app --host 127.0.0.1 --port 8000
exit /b %errorlevel%

:find_bootstrap_python
where py >nul 2>nul
if not errorlevel 1 (
    set "BOOTSTRAP_PYTHON=py"
    exit /b 0
)

where python >nul 2>nul
if not errorlevel 1 (
    set "BOOTSTRAP_PYTHON=python"
    exit /b 0
)

echo Python 3 was not found. Install Python and try again.
exit /b 1

:find_npm
where npm >nul 2>nul
if not errorlevel 1 (
    exit /b 0
)

echo npm was not found. Install Node.js and try again.
exit /b 1