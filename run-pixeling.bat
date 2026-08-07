@echo off
cd /d %~dp0

echo Starting Pixeling on port 3000...
start "" http://localhost:3000

npm run dev -- -p 3000
