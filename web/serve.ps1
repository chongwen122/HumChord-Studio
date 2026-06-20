$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $Root
$PythonExe = Join-Path $ProjectRoot ".venv\Scripts\python.exe"
$Port = 8765

if (-not (Test-Path $PythonExe)) {
    $PythonExe = "python"
}

& $PythonExe (Join-Path $Root "studio_server.py") --host 127.0.0.1 --port $Port
