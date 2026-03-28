$ErrorActionPreference = "Stop"

Set-Location (Split-Path $PSScriptRoot -Parent)

$vsix = Get-ChildItem *.vsix -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $vsix) {
    Write-Host "📦 Building extension..."
    npm install
    npm run build
    npx @vscode/vsce package --no-dependencies
    $vsix = Get-ChildItem *.vsix | Select-Object -First 1
}

Write-Host "📦 Installing $($vsix.Name)..."

if (Get-Command code-insiders -ErrorAction SilentlyContinue) {
    code-insiders --install-extension $vsix.FullName
    Write-Host "✅ Installed $($vsix.Name) in VS Code Insiders"
} elseif (Get-Command code -ErrorAction SilentlyContinue) {
    code --install-extension $vsix.FullName
    Write-Host "✅ Installed $($vsix.Name) in VS Code"
} else {
    Write-Error "Neither 'code-insiders' nor 'code' found in PATH. Install VS Code Insiders: https://code.visualstudio.com/insiders/"
}
