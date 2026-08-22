@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul
title DeepSeek Harness 一键部署启动

cd /d "%~dp0"

echo.
echo ============================================
echo   DeepSeek Harness 一键部署启动
echo ============================================
echo.

:: ---------- 参数解析 ----------
set "REBUILD=0"
set "FORCE_SETUP=0"
set "MODE=web"
set "WEB_PORT=3080"
set "DSH_ARGS="

:parse_args
if "%~1"=="" goto args_done
if /i "%~1"=="--rebuild" (
    set "REBUILD=1"
) else if /i "%~1"=="--setup" (
    set "FORCE_SETUP=1"
) else if /i "%~1"=="--headless" (
    set "MODE=headless"
) else if /i "%~1"=="--help" (
    goto usage
) else (
    if /i "%~1"=="--port" set "WEB_PORT=%~2"
    set "DSH_ARGS=!DSH_ARGS! %~1"
)
shift
goto parse_args
:args_done

:: ---------- 项目目录校验 ----------
if not exist "package.json" (
    echo [失败] 当前目录不是项目根目录，缺少 package.json...
    echo        修复方法: 将 start-dsh.bat 放在仓库根目录后重试...
    goto fail
)

:: ---------- Node.js 检测与自动安装 ----------
where node >nul 2>&1
if not errorlevel 1 goto node_ok

echo [信息] 未检测到 Node.js，尝试通过 winget 自动安装 LTS...
where winget >nul 2>&1
if errorlevel 1 (
    echo [失败] 未找到 winget，无法自动安装 Node.js...
    echo        修复方法: 手动安装 Node.js LTS 后重试...
    echo        下载地址: https://nodejs.org/
    goto fail
)
winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements --disable-interactivity
if not exist "%ProgramFiles%\nodejs\node.exe" (
    echo [失败] winget 自动安装 Node.js 未成功...
    echo        修复方法: 手动安装 Node.js LTS 后重试...
    echo        下载地址: https://nodejs.org/
    goto fail
)
set "PATH=%ProgramFiles%\nodejs;%PATH%"

:node_ok

:: ---------- Node.js 版本校验（项目要求 ^22.19.0 或 >=24.0.0） ----------
for /f "delims=" %%v in ('node --version') do set "NODE_VERSION=%%v"
node -e "const [maj,min]=process.versions.node.split('.').map(Number);process.exit((maj===22&&min>=19)||maj>=24?0:1)" >nul 2>&1
if errorlevel 1 (
    echo [失败] Node.js 版本 %NODE_VERSION% 不满足要求...
    echo        项目要求 ^22.19.0 或 ^>=24...
    echo        修复方法: 使用 nvm 切换或升级 Node.js 后重试...
    goto fail
)
echo [通过] Node.js %NODE_VERSION%

:: ---------- pnpm 检测与自动安装 ----------
set "PNPM=pnpm"
where pnpm >nul 2>&1
if not errorlevel 1 goto pnpm_ready

corepack pnpm --version >nul 2>&1
if not errorlevel 1 (
    set "PNPM=corepack pnpm"
    goto pnpm_ready
)

echo [信息] 未找到 pnpm，正在通过 npm 全局安装...
call npm install -g pnpm --progress=false
if errorlevel 1 (
    echo [失败] pnpm 全局安装失败...
    echo        修复方法: 手动执行 npm install -g pnpm 后重试...
    goto fail
)

:pnpm_ready
echo [通过] pnpm 就绪

:: ---------- 依赖安装 ----------
if not exist "node_modules" (
    echo [信息] 未找到 node_modules，正在安装依赖（首次可能需要数分钟）...
    call %PNPM% install --prefer-offline
    if errorlevel 1 (
        echo [失败] pnpm install 失败...
        echo        常见原因: 网络不可达或镜像源不可用...
        echo        修复方法: 配置镜像源后重试，例如:
        echo            pnpm config set registry https://registry.npmmirror.com
        goto fail
    )
    echo [通过] 依赖安装完成
) else (
    echo [信息] node_modules 已存在，跳过依赖安装（--setup 可强制重装）...
)
if "%FORCE_SETUP%"=="1" (
    echo [信息] 收到 --setup，重新执行依赖安装...
    call %PNPM% install --prefer-offline
    if errorlevel 1 (
        echo [失败] pnpm install 失败...
        echo        修复方法: 查看上方错误输出，网络不可达时配置镜像源...
        goto fail
    )
)

:: ---------- 构建 ----------
set "NEED_BUILD=0"
if not exist "apps\cli\lib\bin.js" set "NEED_BUILD=1"
if not exist "apps\web\dist\index.html" set "NEED_BUILD=1"
if "%REBUILD%"=="1" set "NEED_BUILD=1"
if "%NEED_BUILD%"=="1" (
    if "%REBUILD%"=="1" (
        echo [信息] 收到 --rebuild，正在重新构建（可能需要数分钟）...
    ) else (
        echo [信息] 构建产物缺失，正在构建（可能需要数分钟）...
    )
    call %PNPM% run build
    if errorlevel 1 (
        echo [失败] pnpm run build 构建失败...
        echo        修复方法: 查看上方错误输出定位失败包...
        echo        依赖不完整时先执行 pnpm install 再重试...
        goto fail
    )
    echo [通过] 构建完成
) else (
    echo [信息] 构建产物已存在，跳过构建（--rebuild 可强制重建）...
)

:: ---------- 端口占用检测（仅 Web 模式） ----------
if not "%MODE%"=="web" goto after_port_check
set "OCCUPIED="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /c:":%WEB_PORT% " ^| findstr /c:"LISTENING"') do set "OCCUPIED=1"
if not defined OCCUPIED goto after_port_check

echo [信息] 端口 %WEB_PORT% 已被占用，正在识别占用进程:
set "FOREIGN=0"
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /c:":%WEB_PORT% " ^| findstr /c:"LISTENING"') do (
    tasklist /fi "PID eq %%p" /fo csv /nh 2>nul | findstr /i /c:"node.exe" >nul
    if errorlevel 1 (
        echo [警告] 端口 %WEB_PORT% 被非 node 进程占用: PID %%p...
        set "FOREIGN=1"
    ) else (
        echo [信息] 端口被 node 进程占用: PID %%p...
    )
)
if "%FOREIGN%"=="1" (
    echo [失败] 端口 %WEB_PORT% 被其他程序占用，不会自动结束...
    echo        修复方法: 换端口启动，例如 start-dsh.bat --port 8080...
    goto fail
)

:: dsh web 的服务进程可能由父进程派生，仅结束监听进程会被重新拉起，
:: 因此清理所有 dsh 相关 node 进程树，并循环确认端口真正释放。
set "KILL_RETRY=0"
:free_port_loop
set "STILL_BUSY="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /c:":%WEB_PORT% " ^| findstr /c:"LISTENING"') do set "STILL_BUSY=1"
if not defined STILL_BUSY goto after_port_check
set /a KILL_RETRY+=1
if %KILL_RETRY% gtr 5 (
    echo [失败] 清理 %KILL_RETRY% 次后端口 %WEB_PORT% 仍被占用...
    echo        修复方法: 换端口启动，例如 start-dsh.bat --port 8080...
    goto fail
)
echo [信息] 结束旧的 dsh web 实例（第 %KILL_RETRY% 次）...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'bin\.ts' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F | Out-Null }" >nul 2>&1
ping -n 3 127.0.0.1 >nul
goto free_port_loop

:after_port_check

:: ---------- 启动 ----------
echo.
if "%MODE%"=="headless" goto launch_headless
echo [信息] 正在启动 DeepSeek Harness Web 界面...
echo       默认地址: http://127.0.0.1:%WEB_PORT%
echo       首次运行自动初始化配置目录，就绪后自动打开浏览器...
echo       停止服务: 在窗口内按 Ctrl+C...
echo.
call %PNPM% dsh web %DSH_ARGS%
goto after_launch

:launch_headless
echo [信息] 以 headless 模式启动（需要已配置 DEEPSEEK_API_KEY）...
call %PNPM% dsh --profile headless %DSH_ARGS%

:after_launch
set "EXIT_CODE=%errorlevel%"
if "%EXIT_CODE%"=="3221225786" (
    echo.
    echo [信息] 服务已手动停止（Ctrl+C）...
    set "EXIT_CODE=0"
    exit /b 0
)
if not "%EXIT_CODE%"=="0" (
    echo.
    echo [失败] dsh 启动失败（退出码 %EXIT_CODE%）...
    echo        常见原因: 端口被占用 / 依赖缺失 / 构建产物损坏...
    echo        修复方法: 查看上方错误输出，端口占用时可用 --port 换端口...
    echo        模型请求失败时，在界面 Settings 中配置 API Key...
    pause
)
exit /b %EXIT_CODE%

:usage
echo 用法: start-dsh.bat [选项]
echo.
echo   选项:
echo     --rebuild   强制重新构建，默认仅在产物缺失时构建...
echo     --setup     强制重新安装依赖，默认仅在 node_modules 缺失时安装...
echo     --headless  以 headless 模式启动 CLI，需要 DEEPSEEK_API_KEY...
echo     --no-open   不自动打开浏览器（透传给 dsh web）...
echo     --port ^<端口^>  指定 Web 服务端口（透传给 dsh web）...
echo.
echo   说明:
echo     端口被旧 dsh 实例占用时自动结束重启，被其他程序占用时提示换端口...
echo.
echo   示例:
echo     start-dsh.bat                       首次部署并启动 Web 界面
echo     start-dsh.bat --no-open --port 8080
echo     start-dsh.bat --headless "写一个快速排序"
echo.
exit /b 0

:fail
echo.
echo 部署失败，请根据上方提示修复后重新运行...
pause
exit /b 1
