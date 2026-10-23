@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js nao foi encontrado. Instale Node.js 20 ou superior e reabra este arquivo.
  pause
  exit /b 1
)
if not exist "dist\cli.js" (
  echo O projeto ainda nao foi compilado.
  echo Nesta pasta, execute: npm ci
  echo Depois execute: npm run build
  pause
  exit /b 1
)
echo Iniciando Pixel Agents com Kiro na porta 3100...
echo Abra o link completo com token que sera impresso pelo CLI.
echo Para encerrar, pressione Ctrl+C.
node dist\cli.js --provider kiro --port 3100
if errorlevel 1 (
  echo.
  echo Nao foi possivel manter o escritorio em execucao. Consulte o erro acima.
  pause
  exit /b 1
)
endlocal
