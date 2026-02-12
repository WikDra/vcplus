#!/bin/bash
echo "========================================"
echo "  VC+ Server Launcher (Linux/macOS)"
echo "========================================"
echo

cd "$(dirname "$0")"

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "[ERROR] Node.js is not installed!"
    echo "Install with: sudo apt install nodejs npm  (or use nvm)"
    exit 1
fi

echo "[1/2] Installing dependencies..."
npm install

echo
echo "[2/2] Starting VC+ server..."
echo
node server/index.js
