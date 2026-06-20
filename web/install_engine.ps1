$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $Root
$VenvPath = Join-Path $ProjectRoot ".venv"
$PythonExe = Join-Path $VenvPath "Scripts\python.exe"

if (-not (Test-Path $PythonExe)) {
    python -m venv $VenvPath
}

& $PythonExe -m pip install --upgrade pip
& $PythonExe -m pip install "setuptools==80.9.0"
& $PythonExe -m pip install "librosa>=0.11" "mir-eval>=0.8" "pretty-midi>=0.2.11" "resampy==0.4.2" "scikit-learn" "scipy" "onnxruntime"
& $PythonExe -m pip install "basic-pitch==0.4.0" --no-deps

Write-Host ""
Write-Host "Basic Pitch engine installed."
Write-Host "Run: .\web\serve.ps1"
