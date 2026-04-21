const path = require('path');
const { execFileSync, spawn } = require('child_process');
const dotenv = require('dotenv');

dotenv.config();

const projectRoot = path.resolve(__dirname, '..');
const projectRootLower = projectRoot.toLowerCase();
const port = Number(process.env.PORT) || 4040;

function runPowerShell(command) {
  return execFileSync(
    'powershell.exe',
    ['-NoProfile', '-Command', `& { ${command} }; exit 0`],
    { encoding: 'utf8' }
  ).trim();
}

function runPowerShellJson(command) {
  const output = runPowerShell(`${command} | ConvertTo-Json -Compress`);

  if (!output) {
    return [];
  }

  const parsed = JSON.parse(output);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function getWindowsNodeProcesses() {
  return runPowerShellJson(
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' } | Select-Object ProcessId,ParentProcessId,CommandLine"
  );
}

function getListeningProcessIds() {
  return runPowerShellJson(
    `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object OwningProcess`
  ).map((entry) => Number(entry.OwningProcess));
}

function isRepoAppProcess(commandLine = '') {
  const normalized = commandLine.toLowerCase();

  return normalized.includes(projectRootLower) && (
    normalized.includes('nodemon') ||
    normalized.includes('index.js')
  );
}

function killProcessTree(pid) {
  try {
    execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } catch (error) {
    // Ignore races where the process exits between inspection and cleanup.
  }
}

function cleanupExistingWindowsDevProcesses() {
  const staleProcesses = getWindowsNodeProcesses().filter((processInfo) => {
    const pid = Number(processInfo.ProcessId);
    return pid !== process.pid && isRepoAppProcess(processInfo.CommandLine);
  });

  for (const processInfo of staleProcesses) {
    killProcessTree(processInfo.ProcessId);
  }

  const remainingListeners = getListeningProcessIds();
  if (remainingListeners.length > 0) {
    console.error(`Port ${port} is still in use by PID ${remainingListeners[0]}. Stop that process and retry.`);
    process.exit(1);
  }
}

function startNodemon() {
  const nodemonEntry = path.join(
    projectRoot,
    'node_modules',
    'nodemon',
    'bin',
    'nodemon.js'
  );

  const child = spawn(process.execPath, [nodemonEntry, 'index.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ALLOW_START_WITHOUT_DB: process.env.ALLOW_START_WITHOUT_DB || 'true',
    },
    stdio: 'inherit',
    shell: false
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exit(code ?? 0);
  });
}

if (process.platform === 'win32') {
  cleanupExistingWindowsDevProcesses();
}

startNodemon();