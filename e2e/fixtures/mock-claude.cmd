@echo off
setlocal

if defined HOME (
  set "MOCK_HOME=%HOME%"
) else (
  set "MOCK_HOME=%USERPROFILE%"
)
if not exist "%MOCK_HOME%\.claude-mock" mkdir "%MOCK_HOME%\.claude-mock"
echo %DATE% %TIME% wrapper node=%PIXEL_AGENTS_NODE_BIN% cwd=%CD% args=%* >> "%MOCK_HOME%\.claude-mock\actions.log"

rem Cosmetic: background a headerless narration tail into this terminal tab
rem (twin of the bash wrapper). Windows never records review videos, but the
rem hook must stay failure-proof so CI stays green. Only internal (terminal-
rem hosted) sessions get PIXEL_AGENTS_TEST_NARRATION_LOG.
if defined PIXEL_AGENTS_TEST_NARRATION_LOG (
  if defined PIXEL_AGENTS_NODE_BIN (
    start /b "" "%PIXEL_AGENTS_NODE_BIN%" "%~dp0tail-follow.cjs" none "%PIXEL_AGENTS_TEST_NARRATION_LOG%" "%PIXEL_AGENTS_EXTERNAL_NARRATION_LOG%"
  ) else (
    start /b "" node "%~dp0tail-follow.cjs" none "%PIXEL_AGENTS_TEST_NARRATION_LOG%" "%PIXEL_AGENTS_EXTERNAL_NARRATION_LOG%"
  )
)

if defined PIXEL_AGENTS_NODE_BIN (
  "%PIXEL_AGENTS_NODE_BIN%" "%~dp0mock-claude-runner.cjs" %*
) else (
  node "%~dp0mock-claude-runner.cjs" %*
)
