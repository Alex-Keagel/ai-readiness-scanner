#!/bin/bash
set -e

cd "$(dirname "$0")/.."

VSIX=$(ls *.vsix 2>/dev/null | head -1)
if [ -z "$VSIX" ]; then
  echo "📦 Building extension..."
  npm install
  npm run build
  npx @vscode/vsce package --no-dependencies
  VSIX=$(ls *.vsix | head -1)
fi

echo "📦 Installing $VSIX..."

if command -v code-insiders &>/dev/null; then
  code-insiders --install-extension "$VSIX"
  echo "✅ Installed $VSIX in VS Code Insiders"
elif command -v code &>/dev/null; then
  code --install-extension "$VSIX"
  echo "✅ Installed $VSIX in VS Code"
else
  echo "❌ Neither 'code-insiders' nor 'code' found in PATH"
  echo "   Install VS Code Insiders: https://code.visualstudio.com/insiders/"
  exit 1
fi
