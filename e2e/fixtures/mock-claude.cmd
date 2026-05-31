@echo off
setlocal

if defined HOME (
  set "MOCK_HOME=%HOME%"
) else (
  set "MOCK_HOME=%USERPROFILE%"
)
if not exist "%MOCK_HOME%\.claude-mock" mkdir "%MOCK_HOME%\.claude-mock"
echo %DATE% %TIME% wrapper node=%PIXEL_AGENTS_NODE_BIN% cwd=%CD% args=%* >> "%MOCK_HOME%\.claude-mock\actions.log"

if defined PIXEL_AGENTS_NODE_BIN (
  "%PIXEL_AGENTS_NODE_BIN%" "%~dp0mock-claude-runner.cjs" %*
) else (
  node "%~dp0mock-claude-runner.cjs" %*
)
