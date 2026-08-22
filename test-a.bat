@echo off
setlocal EnableExtensions EnableDelayedExpansion
where node >nul 2>&1
for /f "delims=" %%v in ('node --version') do set "NODE_VERSION=%%v"
node -e "const x=1;process.exit(0)" >nul 2>&1
set "X="
set /p "X=Input: "
echo got [!X!]
