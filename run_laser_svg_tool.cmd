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

echo Installing or updating dependencies...
"%VENV_PYTHON%" -m pip install --upgrade pip || exit /b 1
"%VENV_PYTHON%" -m pip install -e . || exit /b 1

if /I "%~1"=="--smoke-test" (
    echo Running smoke test...
    set "PYTHONPATH=%CD%\src"
    set "QT_QPA_PLATFORM=offscreen"
    "%VENV_PYTHON%" -c "from PySide6.QtWidgets import QApplication; from laser_svg_tool.main import MainWindow; app = QApplication([]); window = MainWindow(); print('Smoke test loaded:', window._canvas_projection is not None); window.close(); app.quit()" || exit /b 1
    echo Smoke test passed.
    exit /b 0
)

echo Launching Laser SVG Tool...
"%VENV_PYTHON%" -m laser_svg_tool
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