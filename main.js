const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

let mainWindow;
const terminals = new Map();

// 终端数量限制（最多10个）
const MAX_TERMINALS = 10;

// 进程监控
let processMonitorInterval = null;
const processStats = new Map();

// 内存监控
let memoryHistory = [];
const MAX_MEMORY_HISTORY = 60; // 保存最近60个采样点（10分钟）

// 进程池
const processPool = new Map();
const MAX_POOL_SIZE = 5;
const POOL_CLEANUP_INTERVAL = 300000; // 5分钟清理一次

// 使用用户数据目录存储可写文件
const userDataPath = app.getPath('userData');
const SESSION_FILE = path.join(userDataPath, 'session.json');
const TEMPLATES_FILE = path.join(userDataPath, 'templates.json');

// 确保用户数据目录存在
if (!fs.existsSync(userDataPath)) {
  fs.mkdirSync(userDataPath, { recursive: true });
}

let pty;
try {
  pty = require('node-pty');
  console.log('[Main] node-pty 加载成功');
} catch (e) {
  console.error('[Main] node-pty 加载失败:', e.message);
}

// 保存会话 - 由前端触发，传递终端列表
let lastSessionData = [];

function saveSession(terminalsToSave) {
  if (terminalsToSave && Array.isArray(terminalsToSave)) {
    lastSessionData = terminalsToSave;
  }
  
  try {
    fs.writeFileSync(SESSION_FILE, JSON.stringify({
      timestamp: Date.now(),
      terminals: lastSessionData,
    }, null, 2), 'utf-8');
    console.log('[Main] 会话已保存，终端数量:', lastSessionData.length);
  } catch (e) {
    console.error('[Main] 保存会话失败:', e.message);
  }
}

// 加载会话
function loadSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
      console.log('[Main] 加载会话，终端数量:', data.terminals?.length || 0);
      return data.terminals || [];
    }
  } catch (e) {
    console.error('[Main] 加载会话失败:', e.message);
  }
  return [];
}

// 清除会话
function clearSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      fs.unlinkSync(SESSION_FILE);
      console.log('[Main] 会话已清除');
    }
  } catch (e) {
    console.error('[Main] 清除会话失败:', e.message);
  }
}

// 启动进程监控
function startProcessMonitor() {
  if (processMonitorInterval) {
    clearInterval(processMonitorInterval);
  }
  
  processMonitorInterval = setInterval(() => {
    const stats = {
      timestamp: Date.now(),
      totalTerminals: terminals.size,
      processes: [],
      memory: {}
    };
    
    // 收集系统内存信息
    try {
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;
      
      stats.memory = {
        totalMB: Math.round(totalMem / 1024 / 1024),
        usedMB: Math.round(usedMem / 1024 / 1024),
        freeMB: Math.round(freeMem / 1024 / 1024),
        usagePercentage: Math.round((usedMem / totalMem) * 100)
      };
      
      // 保存到历史记录
      memoryHistory.push({
        timestamp: Date.now(),
        ...stats.memory
      });
      
      // 限制历史记录长度
      if (memoryHistory.length > MAX_MEMORY_HISTORY) {
        memoryHistory = memoryHistory.slice(-MAX_MEMORY_HISTORY);
      }
      
    } catch (e) {
      console.error('[Main] 获取内存信息失败:', e.message);
    }
    
    terminals.forEach((ptyProcess, id) => {
      try {
        // 获取进程统计信息
        const processStat = {
          id,
          pid: ptyProcess.pid,
          alive: !ptyProcess.killed,
          userData: ptyProcess.userData || {}
        };
        
        stats.processes.push(processStat);
        processStats.set(id, processStat);
        
        // 检查进程是否还活着
        if (ptyProcess.killed && !ptyProcess.exited) {
          console.warn(`[Main] 终端 ${id} (PID: ${ptyProcess.pid}) 可能已崩溃`);
          // 自动清理已死亡的进程
          terminals.delete(id);
          processStats.delete(id);
        }
      } catch (e) {
        console.error(`[Main] 监控终端 ${id} 失败:`, e.message);
      }
    });
    
    // 每5分钟输出一次监控报告
    if (Date.now() % (5 * 60 * 1000) < 1000) {
      console.log('[Main] 进程监控报告:', JSON.stringify(stats, null, 2));
    }
    
    // 发送实时更新到渲染进程
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('process-monitor-update', stats);
    }
    
  }, 10000); // 每10秒检查一次
}

// 停止进程监控
function stopProcessMonitor() {
  if (processMonitorInterval) {
    clearInterval(processMonitorInterval);
    processMonitorInterval = null;
  }
}

// 获取进程监控报告
function getProcessMonitorReport() {
  const report = {
    timestamp: Date.now(),
    totalTerminals: terminals.size,
    maxTerminals: MAX_TERMINALS,
    processes: Array.from(processStats.values())
  };
  
  // 计算资源使用情况
  const totalMemoryMB = report.processes.length * 80; // 预估每个终端80MB
  report.estimatedMemoryMB = totalMemoryMB;
  report.health = terminals.size < MAX_TERMINALS * 0.8 ? 'healthy' : 'warning';
  
  return report;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  mainWindow.loadFile('index.html');

  mainWindow.on('close', (e) => {
    // 有终端运行时，显示二次确认
    if (terminals.size > 0) {
      const result = require('electron').dialog.showMessageBoxSync(mainWindow, {
        type: 'question',
        buttons: ['确认关闭', '取消'],
        defaultId: 1,
        cancelId: 1,
        title: '确认关闭',
        message: `当前有 ${terminals.size} 个终端正在运行`,
        detail: '确定要关闭所有终端并退出程序吗？',
      });
      
      if (result === 1) {
        // 用户选择取消
        e.preventDefault();
        return;
      }
    }
    
    // 用户确认关闭
    console.log('[Main] 窗口关闭，终端数量:', terminals.size);
  });
  
  mainWindow.on('closed', () => {
    terminals.forEach(ptyProcess => {
      try { ptyProcess.kill(); } catch (e) {}
    });
    terminals.clear();
    mainWindow = null;
  });
  
  console.log('[Main] 窗口已创建');
}

app.whenReady().then(() => {
  console.log('[Main] App 就绪');
  createWindow();
  
  // 启动进程监控
  startProcessMonitor();
  console.log('[Main] 进程监控已启动');
  
  // 启动进程池清理
  startProcessPoolCleanup();
  console.log('[Main] 进程池清理已启动');
  
  // 监听渲染进程崩溃
  app.on('render-process-gone', (event, webContents, details) => {
    console.error('[Main] 渲染进程崩溃:', details);
  });
  
  // 监听子进程异常退出
  app.on('child-process-gone', (event, details) => {
    console.error('[Main] 子进程异常退出:', details);
  });
});

app.on('window-all-closed', () => {
  // 停止进程监控
  stopProcessMonitor();
  console.log('[Main] 进程监控已停止');
  
  // 停止进程池清理
  stopProcessPoolCleanup();
  console.log('[Main] 进程池清理已停止');
  
  // 清理所有进程池中的进程
  processPool.forEach((pool, shellPath) => {
    pool.forEach(ptyProcess => {
      try { ptyProcess.kill(); } catch (e) {}
    });
  });
  processPool.clear();
  console.log('[Main] 进程池已清空');
  
  if (process.platform !== 'darwin') app.quit();
});

// 监听应用级别的错误
process.on('uncaughtException', (err) => {
  console.error('[Main] 未捕获的异常:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Main] 未处理的 Promise 拒绝:', reason);
});

// 自动查找 Git Bash
function findGitBash() {
  const commonPaths = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    process.env['PROGRAMFILES'] + '\\Git\\bin\\bash.exe',
    process.env['PROGRAMFILES(X86)'] + '\\Git\\bin\\bash.exe',
    process.env['LOCALAPPDATA'] + '\\Programs\\Git\\bin\\bash.exe',
  ];
  
  // 检查 PATH 环境变量
  const pathEnv = process.env.PATH || '';
  const pathDirs = pathEnv.split(';');
  for (const dir of pathDirs) {
    const gitBashInPath = path.join(dir, 'bash.exe');
    if (fs.existsSync(gitBashInPath)) {
      // 确认是 Git Bash 而不是其他 bash
      try {
        const stat = fs.statSync(gitBashInPath);
        if (stat.isFile()) {
          console.log('[Main] 在 PATH 中找到 Git Bash:', gitBashInPath);
          return gitBashInPath;
        }
      } catch (e) {}
    }
  }
  
  // 检查常见安装路径
  for (const p of commonPaths) {
    if (p && fs.existsSync(p)) {
      console.log('[Main] 在常见路径找到 Git Bash:', p);
      return p;
    }
  }
  
  // 尝试从注册表读取 (Windows)
  if (process.platform === 'win32') {
    try {
      const { execSync } = require('child_process');
      const regOutput = execSync(
        'reg query "HKLM\\SOFTWARE\\GitForGit" /v InstallPath 2>nul',
        { encoding: 'utf8' }
      );
      const match = regOutput.match(/InstallPath\s+REG_SZ\s+(.+)/i);
      if (match) {
        const installPath = path.join(match[1].trim(), 'bin\\bash.exe');
        if (fs.existsSync(installPath)) {
          console.log('[Main] 从注册表找到 Git Bash:', installPath);
          return installPath;
        }
      }
    } catch (e) {
      // 注册表查询失败，忽略
    }
  }
  
  return null;
}

ipcMain.handle('get-shells', () => {
  const gitBashPath = findGitBash();
  
  const shells = [
    { id: 'powershell', name: 'PowerShell', shell: 'powershell.exe', cwd: process.env.USERPROFILE, icon: '💻' },
    { id: 'cmd', name: '命令提示符', shell: 'cmd.exe', cwd: process.env.USERPROFILE, icon: '📟' },
  ];
  
  if (gitBashPath) {
    shells.push({
      id: 'git-bash',
      name: 'Git Bash',
      shell: gitBashPath,
      cwd: process.env.USERPROFILE,
      icon: '🔧'
    });
    console.log('[Main] Git Bash 路径:', gitBashPath);
  } else {
    console.log('[Main] 未找到 Git Bash');
  }
  
  return shells;
});

ipcMain.handle('get-templates', () => {
  try {
    // 优先从用户数据目录加载
    if (fs.existsSync(TEMPLATES_FILE)) {
      const userTemplates = JSON.parse(fs.readFileSync(TEMPLATES_FILE, 'utf-8'));
      console.log('[Main] 从用户数据目录加载模板，数量:', userTemplates.length);
      return userTemplates;
    }
    
    // 如果用户数据目录没有，从打包目录复制默认模板
    const defaultTemplatesFile = path.join(__dirname, 'templates.json');
    if (fs.existsSync(defaultTemplatesFile)) {
      const defaultTemplates = JSON.parse(fs.readFileSync(defaultTemplatesFile, 'utf-8'));
      // 保存到用户数据目录
      fs.writeFileSync(TEMPLATES_FILE, JSON.stringify(defaultTemplates, null, 2), 'utf-8');
      console.log('[Main] 从默认模板复制，数量:', defaultTemplates.length);
      return defaultTemplates;
    }
  } catch (e) {
    console.error('[Main] 加载模板失败:', e.message);
  }
  return [];
});

ipcMain.handle('save-templates', (event, templates) => {
  try {
    console.log('[Main] 保存模板到用户数据目录，数量:', templates.length);
    fs.writeFileSync(TEMPLATES_FILE, JSON.stringify(templates, null, 2), 'utf-8');
  } catch (e) {
    console.error('[Main] 保存模板失败:', e.message);
  }
  return { success: true };
});

// 获取保存的会话
ipcMain.handle('get-session', () => {
  return loadSession();
});

// 清除保存的会话
ipcMain.handle('clear-session', () => {
  clearSession();
  return { success: true };
});

// 获取完整的用户环境变量（包括用户 PATH）
function getFullUserEnv() {
  // 复制基础环境变量
  const env = { ...process.env };
  
  // 在 Windows 上，通过注册表获取用户 PATH
  if (os.platform() === 'win32') {
    try {
      const { execSync } = require('child_process');
      
      // 获取用户 PATH
      const userPathOutput = execSync(
        'reg query "HKCU\\Environment" /v PATH 2>nul',
        { encoding: 'utf8' }
      );
      const userPathMatch = userPathOutput.match(/PATH\s+REG(?:_EXPAND_)?SZ\s+(.+)/i);
      if (userPathMatch) {
        const userPath = userPathMatch[1].trim();
        // 合并用户 PATH 到现有 PATH
        env['PATH'] = `${env['PATH'] || ''};${userPath}`;
        console.log('[Main] 用户 PATH:', userPath);
      }
      
      // 获取系统 PATH（确保完整）
      const systemPathOutput = execSync(
        'reg query "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment" /v PATH 2>nul',
        { encoding: 'utf8' }
      );
      const systemPathMatch = systemPathOutput.match(/PATH\s+REG(?:_EXPAND_)?SZ\s+(.+)/i);
      if (systemPathMatch) {
        const systemPath = systemPathMatch[1].trim();
        // 如果系统 PATH 不在当前 PATH 中，合并它
        if (env['PATH'] && !env['PATH'].includes(systemPath.split(';')[0])) {
          env['PATH'] = `${systemPath};${env['PATH']}`;
        }
        console.log('[Main] 系统 PATH:', systemPath);
      }
    } catch (e) {
      console.log('[Main] 获取注册表 PATH 失败:', e.message);
    }
  }
  
  return env;
}

ipcMain.handle('create-terminal', async (event, options) => {
  const { cwd, shell, id, script, cols, rows, name, icon } = options;
  
  console.log(`[Main] 创建终端：id=${id}, shell=${shell}, cwd=${cwd}`);
  
  // 检查终端数量限制
  if (terminals.size >= MAX_TERMINALS) {
    console.error(`[Main] 终端数量已达上限（${MAX_TERMINALS}个），无法创建新终端`);
    return { success: false, error: `终端数量已达上限（${MAX_TERMINALS}个），请关闭一些终端后再试` };
  }
  
  if (!pty) {
    return { success: false, error: 'node-pty 未正确安装' };
  }

  try {
    const defaultShell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';
    const shellPath = shell || defaultShell;
    
    if (shellPath.includes('\\') || shellPath.includes('/')) {
      if (!fs.existsSync(shellPath)) {
        return { success: false, error: `Shell 不存在：${shellPath}` };
      }
    }
    
    // 为 Git Bash 设置特殊环境变量
    const isGitBash = shellPath.includes('git') || shellPath.includes('bash');
    const env = getFullUserEnv();  // 使用完整用户环境变量
    
    if (isGitBash) {
      // Git Bash 需要这些环境变量才能正确执行命令
      env['MSYSTEM'] = 'MINGW64';
      env['CHERE_INVOKING'] = '1';
      env['MSYS2_PATH_TYPE'] = 'inherit';
      
      // 设置 Git Bash 使用暗色主题配色
      env['COLORTERM'] = 'truecolor';
      env['TERM'] = 'xterm-256color';
      
      // 完全禁用 ls 的彩色输出（最彻底的方法）
      env['CLICOLOR'] = '0';
      env['LS_COLORS'] = '';
      
      // 禁用 Git 的彩色输出
      env['GIT_CONFIG_PARAMETERS'] = "'color.ui=false'";
      env['GIT_PAGER'] = 'cat';
      
      // 禁用 grep 的彩色输出
      env['GREP_COLOR'] = '';
      env['GREP_COLORS'] = '';
      
      // 动态检测 Git Bash 的目录结构
      const gitDir = shellPath.substring(0, shellPath.lastIndexOf('\\'));
      const gitBinDir = gitDir; // bin 目录
      const gitUsrBinDir = path.join(gitDir, '..', 'usr', 'bin');
      const gitMingw64BinDir = path.join(gitDir, '..', 'mingw64', 'bin');
      
      // 动态检测 Node.js 和其他工具路径（不再硬编码）
      const extraPaths = [];
      
      // 1. 从系统 PATH 中提取所有有效目录（完整继承系统 PATH）
      const systemPath = env['PATH'] || '';
      const pathDirs = systemPath.split(';').filter(p => p && fs.existsSync(p));
      for (const dir of pathDirs) {
        if (!extraPaths.includes(dir)) {
          extraPaths.push(dir);
        }
      }
      
      // 2. 检查常见 Node.js 安装位置
      const commonNodePaths = [
        'C:\\Program Files\\nodejs',
        'C:\\Program Files (x86)\\nodejs',
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs'),
        path.join(process.env.PROGRAMFILES || '', 'nodejs'),
        path.join(process.env['PROGRAMFILES(X86)'] || '', 'nodejs'),
      ];
      for (const p of commonNodePaths) {
        if (p && fs.existsSync(p) && !extraPaths.includes(p)) {
          extraPaths.push(p);
        }
      }
      
      // 3. 检测 npm 全局安装路径（多个可能位置）
      const npmGlobalPaths = [
        path.join(process.env.APPDATA || '', 'npm'),
        path.join(process.env.LOCALAPPDATA || '', 'npm'),
        path.join(os.homedir(), 'AppData', 'Roaming', 'npm'),
        path.join(os.homedir(), 'AppData', 'Local', 'npm'),
      ];
      for (const p of npmGlobalPaths) {
        if (p && fs.existsSync(p) && !extraPaths.includes(p)) {
          extraPaths.push(p);
        }
      }
      
      // 4. 检测 nvm 安装的 Node.js
      const nvmDir = process.env.NVM_HOME || path.join(process.env.APPDATA || '', 'nvm');
      if (fs.existsSync(nvmDir)) {
        // 查找当前使用的 Node.js 版本
        try {
          const nvmSettings = fs.readFileSync(path.join(nvmDir, 'settings.txt'), 'utf-8');
          const rootMatch = nvmSettings.match(/root:\s*(.+)/);
          if (rootMatch) {
            const nvmRoot = rootMatch[1].trim();
            if (fs.existsSync(nvmRoot) && !extraPaths.includes(nvmRoot)) {
              extraPaths.push(nvmRoot);
            }
          }
        } catch (e) {}
        
        // 检查 nvm 的 symlink 目录
        const nvmSymlink = path.join(nvmDir, 'vcurrent');
        if (fs.existsSync(nvmSymlink) && !extraPaths.includes(nvmSymlink)) {
          extraPaths.push(nvmSymlink);
        }
      }
      
      // 5. 检测 fnm (Fast Node Manager) 安装的 Node.js
      const fnmDir = process.env.FNM_DIR || path.join(process.env.LOCALAPPDATA || '', 'fnm');
      const fnmMultishell = process.env.FNM_MULTISHELL_PATH;
      if (fnmMultishell && fs.existsSync(fnmMultishell) && !extraPaths.includes(fnmMultishell)) {
        extraPaths.push(fnmMultishell);
      }
      if (fs.existsSync(fnmDir)) {
        // 检查默认安装位置
        const fnmNodeVersions = path.join(fnmDir, 'node-versions');
        if (fs.existsSync(fnmNodeVersions)) {
          try {
            const versions = fs.readdirSync(fnmNodeVersions);
            for (const v of versions) {
              const installation = path.join(fnmNodeVersions, v, 'installation');
              if (fs.existsSync(installation) && !extraPaths.includes(installation)) {
                extraPaths.push(installation);
              }
            }
          } catch (e) {}
        }
      }
      
      // 6. 检测 Python 路径
      const commonPythonPaths = [
        'C:\\Python27',
        'C:\\Python27\\Scripts',
        'C:\\Python3',
        'C:\\Python3\\Scripts',
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python27'),
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python27', 'Scripts'),
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python311'),
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python311', 'Scripts'),
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python312'),
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python312', 'Scripts'),
      ];
      for (const p of commonPythonPaths) {
        if (p && fs.existsSync(p) && !extraPaths.includes(p)) {
          extraPaths.push(p);
        }
      }
      
      // 组合所有 PATH
      const allExtraPaths = [gitBinDir, gitUsrBinDir, gitMingw64BinDir, ...extraPaths];
      // 过滤掉不存在的路径和 undefined/null
      const validPaths = allExtraPaths.filter(p => p && typeof p === 'string' && fs.existsSync(p));
      env['PATH'] = `${validPaths.join(';')};${env['PATH'] || ''}`;
      
      console.log('[Main] Git Bash 模式：设置环境变量');
      console.log('[Main] Git 目录:', gitDir);
      console.log('[Main] 检测到的额外路径:', validPaths);
      console.log('[Main] PATH:', env['PATH']);
    }
    
    console.log('[Main] 准备 spawn，参数:', JSON.stringify({
      shell: shellPath,
      cwd: cwd || process.env.USERPROFILE,
      cols, rows,
      useConpty: true
    }));
    
    // 尝试从进程池获取可复用的进程
    let ptyProcess = getFromProcessPool(shellPath);
    let fromPool = false;
    
    if (ptyProcess) {
      fromPool = true;
      console.log(`[Main] 使用进程池中的进程 (PID: ${ptyProcess.pid})`);
      
      // 重置终端尺寸
      try {
        ptyProcess.resize(cols || 80, rows || 24);
      } catch (e) {
        console.warn('[Main] 重置终端尺寸失败:', e.message);
      }
    } else {
      // 创建新的进程
      ptyProcess = pty.spawn(shellPath, [], {
        name: 'xterm-256color',
        cols: cols || 80,
        rows: rows || 24,
        cwd: cwd || process.env.USERPROFILE,
        env: env,
        // 所有 Shell 都使用 ConPTY（Windows 10+ 原生支持）
        useConpty: true,
        conptyInheritCursor: true,
      });
      console.log(`[Main] 创建新的 PTY 进程 (PID: ${ptyProcess.pid})`);
    }

    // 如果是 Git Bash，在启动后执行无颜色配置
    if (isGitBash) {
      // 直接在 shell 中执行命令，而不是 source 外部文件
      console.log('[Main] Git Bash 配置中...');
      setTimeout(() => {
        try {
          // 禁用 ls 颜色
          ptyProcess.write('alias ls="ls --color=never"\n');
          ptyProcess.write('alias ll="ls -l --color=never"\n');
          ptyProcess.write('alias la="ls -a --color=never"\n');
          // 禁用 grep 颜色
          ptyProcess.write('alias grep="grep --color=never"\n');
          // 禁用 Git 颜色
          ptyProcess.write('git config --global color.ui false\n');
          // 设置环境变量
          ptyProcess.write('export CLICOLOR=0\n');
          ptyProcess.write('export LS_COLORS=""\n');
          // 显示当前 PATH
          ptyProcess.write('echo "[狗头管家] PATH 配置完成，Node.js 路径已包含"\n');
          console.log('[Main] Git Bash 配置完成');
        } catch (e) {
          console.error('[Main] Git Bash 配置失败:', e.message);
        }
      }, 500);
    }

    // 保存终端用户数据
    ptyProcess.userData = { shell, cwd, script, name, icon };

    console.log(`[Main] PTY spawn 成功，PID=${ptyProcess.pid}`);

    terminals.set(id, ptyProcess);

    ptyProcess.onData(data => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('terminal-data', { id, data });
      }
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      console.log(`[Main] 终端 ${id} 退出，code=${exitCode}, signal=${signal}`);
      terminals.delete(id);
      
      // 检查是否需要自动恢复（非正常退出）
      const shouldAutoRestore = (exitCode !== 0 || signal) && !ptyProcess.userClosed;
      
      if (shouldAutoRestore) {
        console.log(`[Main] 检测到终端 ${id} 异常退出，尝试自动恢复...`);
        
        // 延迟恢复，避免立即重试导致问题
        setTimeout(() => {
          try {
            // 获取终端配置
            const userData = ptyProcess.userData || {};
            const restoreOptions = {
              cwd: userData.cwd,
              shell: userData.shell,
              id: id, // 使用相同的 ID
              script: userData.script,
              cols: 80,
              rows: 24,
              name: userData.name || '恢复的终端',
              icon: userData.icon || '🔄'
            };
            
            // 重新创建终端
            const result = pty.spawn(restoreOptions.shell, [], {
              name: 'xterm-256color',
              cols: restoreOptions.cols,
              rows: restoreOptions.rows,
              cwd: restoreOptions.cwd || process.env.USERPROFILE,
              env: getFullUserEnv(),
              useConpty: true,
              conptyInheritCursor: true,
            });
            
            // 设置恢复的终端
            result.userData = userData;
            terminals.set(id, result);
            
            // 设置事件监听
            result.onData(data => {
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('terminal-data', { id, data });
              }
            });
            
            result.onExit(({ exitCode, signal }) => {
              console.log(`[Main] 恢复的终端 ${id} 退出，code=${exitCode}`);
              terminals.delete(id);
              saveSession();
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('terminal-exit', { id, exitCode, signal });
              }
            });
            
            // 重新执行脚本
            if (userData.script && userData.script.trim()) {
              setTimeout(() => {
                if (terminals.has(id)) {
                  result.write(`${userData.script}\r`);
                }
              }, 500);
            }
            
            console.log(`[Main] 终端 ${id} 自动恢复成功 (PID: ${result.pid})`);
            
            // 通知前端终端已恢复
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('terminal-restored', { 
                id, 
                pid: result.pid,
                message: '终端已自动恢复'
              });
            }
            
          } catch (error) {
            console.error(`[Main] 终端 ${id} 自动恢复失败:`, error.message);
          }
        }, 1000); // 1秒后尝试恢复
      }
      
      // 退出时更新会话
      saveSession();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('terminal-exit', { id, exitCode, signal });
      }
    });

    // 执行脚本
    if (script && script.trim()) {
      console.log(`[Main] 准备执行脚本：${script}`);
      setTimeout(() => {
        if (terminals.has(id)) {
          ptyProcess.write(`${script}\r`);
        }
      }, 500);
    }

    return { success: true, pid: ptyProcess.pid };
  } catch (error) {
    console.error('[Main] 创建终端失败:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('write-terminal', (event, { id, data }) => {
  const ptyProcess = terminals.get(id);
  if (ptyProcess) {
    ptyProcess.write(data);
    return { success: true };
  }
  return { success: false, error: 'Terminal not found' };
});

ipcMain.handle('resize-terminal', (event, { id, cols, rows }) => {
  const ptyProcess = terminals.get(id);
  if (ptyProcess) {
    try {
      ptyProcess.resize(cols, rows);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
  return { success: false, error: 'Terminal not found' };
});

ipcMain.handle('close-terminal', (event, { id, forceKill = false }) => {
  const ptyProcess = terminals.get(id);
  if (ptyProcess) {
    try {
      // 标记为用户手动关闭，不进行自动恢复
      ptyProcess.userClosed = true;
      
      if (forceKill) {
        // 强制关闭，不放入进程池
        ptyProcess.kill();
        console.log(`[Main] 强制关闭终端 ${id} (PID: ${ptyProcess.pid})`);
      } else {
        // 尝试将进程放回进程池
        const shellPath = ptyProcess.userData?.shell || '';
        if (shellPath && !ptyProcess.killed) {
          addToProcessPool(shellPath, ptyProcess);
          console.log(`[Main] 终端 ${id} 放入进程池 (PID: ${ptyProcess.pid})`);
        } else {
          ptyProcess.kill();
          console.log(`[Main] 关闭终端 ${id} (PID: ${ptyProcess.pid})`);
        }
      }
      
      terminals.delete(id);
      // 关闭时更新会话
      saveSession();
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
  return { success: false, error: 'Terminal not found' };
});

// 手动保存会话（前端传递终端列表）
ipcMain.handle('save-session-manual', (event, terminalsToSave) => {
  saveSession(terminalsToSave);
  return { success: true };
});

// 打开目录选择对话框
ipcMain.handle('open-directory-dialog', async (event) => {
  const { dialog } = require('electron');
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: '选择工作目录'
  });
  return result;
});

// 窗口关闭时保存（前端传递终端列表）
ipcMain.handle('save-session-on-close', (event, terminalsToSave) => {
  saveSession(terminalsToSave);
  return { success: true };
});

// 获取进程监控报告
ipcMain.handle('get-process-monitor', () => {
  return getProcessMonitorReport();
});

// 获取内存历史记录
ipcMain.handle('get-memory-history', () => {
  return {
    history: memoryHistory,
    current: memoryHistory[memoryHistory.length - 1] || null
  };
});

// 获取性能报告
ipcMain.handle('get-performance-report', () => {
  // 这里可以从渲染进程获取性能数据
  // 目前返回基础的系统性能数据
  return {
    timestamp: Date.now(),
    system: {
      platform: os.platform(),
      arch: os.arch(),
      cpus: os.cpus().length,
      totalMemoryMB: Math.round(os.totalmem() / 1024 / 1024),
      freeMemoryMB: Math.round(os.freemem() / 1024 / 1024),
      loadAvg: os.loadavg()
    },
    terminals: {
      count: terminals.size,
      poolSize: Array.from(processPool.values()).reduce((sum, pool) => sum + pool.length, 0)
    }
  };
});

// 手动恢复终端
ipcMain.handle('restore-terminal', (event, { id }) => {
  const ptyProcess = terminals.get(id);
  if (ptyProcess && !ptyProcess.killed) {
    return { success: false, error: '终端仍在运行' };
  }
  
  try {
    // 查找已保存的终端配置
    let terminalConfig = null;
    if (fs.existsSync(SESSION_FILE)) {
      const sessionData = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
      terminalConfig = sessionData.terminals.find(t => t.id === id);
    }
    
    if (!terminalConfig) {
      return { success: false, error: '未找到终端配置' };
    }
    
    // 重新创建终端
    const result = pty.spawn(terminalConfig.shell, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: terminalConfig.cwd || process.env.USERPROFILE,
      env: getFullUserEnv(),
      useConpty: true,
      conptyInheritCursor: true,
    });
    
    result.userData = {
      shell: terminalConfig.shell,
      cwd: terminalConfig.cwd,
      script: terminalConfig.script,
      name: terminalConfig.name,
      icon: terminalConfig.icon
    };
    
    terminals.set(id, result);
    
    // 设置事件监听
    result.onData(data => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('terminal-data', { id, data });
      }
    });
    
    result.onExit(({ exitCode, signal }) => {
      console.log(`[Main] 手动恢复的终端 ${id} 退出，code=${exitCode}`);
      terminals.delete(id);
      saveSession();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('terminal-exit', { id, exitCode, signal });
      }
    });
    
    // 重新执行脚本
    if (terminalConfig.script && terminalConfig.script.trim()) {
      setTimeout(() => {
        if (terminals.has(id)) {
          result.write(`${terminalConfig.script}\r`);
        }
      }, 500);
    }
    
    console.log(`[Main] 终端 ${id} 手动恢复成功 (PID: ${result.pid})`);
    return { success: true, pid: result.pid };
    
  } catch (error) {
    console.error(`[Main] 终端 ${id} 手动恢复失败:`, error);
    return { success: false, error: error.message };
  }
});

// 获取实时内存使用
ipcMain.handle('get-realtime-memory', () => {
  try {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    
    return {
      timestamp: Date.now(),
      totalMB: Math.round(totalMem / 1024 / 1024),
      usedMB: Math.round(usedMem / 1024 / 1024),
      freeMB: Math.round(freeMem / 1024 / 1024),
      usagePercentage: Math.round((usedMem / totalMem) * 100),
      terminals: terminals.size,
      estimatedTerminalMemoryMB: terminals.size * 80 // 预估每个终端80MB
    };
  } catch (e) {
    return { error: e.message };
  }
});

// 获取系统状态
ipcMain.handle('get-system-status', () => {
  const status = {
    timestamp: Date.now(),
    platform: os.platform(),
    arch: os.arch(),
    nodeVersion: process.version,
    electronVersion: process.versions.electron,
    totalMemoryMB: Math.round(os.totalmem() / 1024 / 1024),
    freeMemoryMB: Math.round(os.freemem() / 1024 / 1024),
    loadAvg: os.loadavg(),
    uptime: os.uptime(),
    cpus: os.cpus().length
  };
  return status;
});

// 进程池管理
function addToProcessPool(shellPath, ptyProcess) {
  if (!processPool.has(shellPath)) {
    processPool.set(shellPath, []);
  }
  
  const pool = processPool.get(shellPath);
  if (pool.length < MAX_POOL_SIZE) {
    // 标记进程为可复用
    ptyProcess.poolReady = true;
    ptyProcess.lastUsed = Date.now();
    pool.push(ptyProcess);
    console.log(`[Main] 进程添加到池中: ${shellPath}, 池大小: ${pool.length}`);
  } else {
    // 池已满，直接关闭进程
    try { ptyProcess.kill(); } catch (e) {}
  }
}

function getFromProcessPool(shellPath) {
  if (!processPool.has(shellPath)) {
    return null;
  }
  
  const pool = processPool.get(shellPath);
  for (let i = 0; i < pool.length; i++) {
    const ptyProcess = pool[i];
    if (ptyProcess.poolReady && !ptyProcess.killed) {
      // 从池中移除
      pool.splice(i, 1);
      ptyProcess.poolReady = false;
      console.log(`[Main] 从进程池获取: ${shellPath}, 剩余: ${pool.length}`);
      return ptyProcess;
    }
  }
  return null;
}

function cleanupProcessPool() {
  const now = Date.now();
  let cleaned = 0;
  
  processPool.forEach((pool, shellPath) => {
    for (let i = pool.length - 1; i >= 0; i--) {
      const ptyProcess = pool[i];
      // 清理超过30分钟未使用的进程
      if (now - ptyProcess.lastUsed > 1800000) { // 30分钟
        try {
          ptyProcess.kill();
          pool.splice(i, 1);
          cleaned++;
        } catch (e) {}
      }
    }
  });
  
  if (cleaned > 0) {
    console.log(`[Main] 进程池清理完成，清理了 ${cleaned} 个进程`);
  }
}

// 启动进程池清理定时器
let poolCleanupInterval = null;
function startProcessPoolCleanup() {
  if (poolCleanupInterval) {
    clearInterval(poolCleanupInterval);
  }
  
  poolCleanupInterval = setInterval(() => {
    cleanupProcessPool();
  }, POOL_CLEANUP_INTERVAL);
}

function stopProcessPoolCleanup() {
  if (poolCleanupInterval) {
    clearInterval(poolCleanupInterval);
    poolCleanupInterval = null;
  }
}

// 健康检查
ipcMain.handle('health-check', () => {
  const monitorReport = getProcessMonitorReport();
  const systemStatus = {
    timestamp: Date.now(),
    platform: os.platform(),
    arch: os.arch(),
    totalMemoryMB: Math.round(os.totalmem() / 1024 / 1024),
    freeMemoryMB: Math.round(os.freemem() / 1024 / 1024)
  };
  
  const health = {
    status: 'healthy',
    timestamp: Date.now(),
    terminals: {
      current: monitorReport.totalTerminals,
      max: monitorReport.maxTerminals,
      health: monitorReport.health
    },
    memory: {
      estimatedUsageMB: monitorReport.estimatedMemoryMB,
      systemTotalMB: systemStatus.totalMemoryMB,
      systemFreeMB: systemStatus.freeMemoryMB,
      usagePercentage: Math.round((monitorReport.estimatedMemoryMB / systemStatus.totalMemoryMB) * 100)
    },
    recommendations: []
  };
  
  // 添加建议
  if (monitorReport.totalTerminals >= MAX_TERMINALS) {
    health.status = 'warning';
    health.recommendations.push(`终端数量已达上限 (${MAX_TERMINALS}个)`);
  }
  
  if (health.memory.usagePercentage > 70) {
    health.status = 'warning';
    health.recommendations.push(`内存使用率较高 (${health.memory.usagePercentage}%)`);
  }
  
  if (health.memory.usagePercentage > 90) {
    health.status = 'critical';
    health.recommendations.push(`内存使用率过高 (${health.memory.usagePercentage}%)，建议关闭部分终端`);
  }
  
  return health;
});

// 编辑会话别名对话框（无边框独立窗口，完全不受 xterm 影响）
ipcMain.handle('edit-alias-dialog', async (event, { currentName, originalName }) => {
  return new Promise((resolve) => {
    const inputWindow = new BrowserWindow({
      width: 420,
      height: 180,
      parent: mainWindow,
      modal: true,
      show: false,
      resizable: false,
      frame: false,
      backgroundColor: '#252526',
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
      },
    });

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            font-family: 'Segoe UI', 'Microsoft YaHei', sans-serif;
            background: #252526;
            color: #cccccc;
            height: 100vh;
            display: flex;
            flex-direction: column;
            overflow: hidden;
          }
          .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 12px 16px;
            background: #2d2d30;
            border-bottom: 1px solid #3c3c3c;
            -webkit-app-region: drag;
          }
          .header span { font-size: 14px; font-weight: 600; color: #ffffff; }
          .close-btn {
            width: 28px; height: 28px; border: none; background: transparent;
            color: #969696; cursor: pointer; border-radius: 4px; font-size: 18px;
            display: flex; align-items: center; justify-content: center;
            -webkit-app-region: no-drag;
          }
          .close-btn:hover { background: #3c3c3c; color: #ffffff; }
          .body { padding: 20px 16px; flex: 1; }
          label { display: block; font-size: 12px; color: #969696; margin-bottom: 8px; }
          input {
            width: 100%; padding: 8px 12px; background: #1e1e1e;
            border: 1px solid #3c3c3c; border-radius: 4px; color: #cccccc; font-size: 13px; outline: none;
          }
          input:focus { border-color: #0e639c; }
          .hint { font-size: 11px; color: #6a6a6a; margin-top: 8px; }
          .footer { display: flex; gap: 8px; justify-content: flex-end; padding: 12px 16px; border-top: 1px solid #3c3c3c; }
          button { padding: 6px 16px; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; }
          .cancel-btn { background: #3c3c3c; color: #cccccc; }
          .cancel-btn:hover { background: #4c4c4c; }
          .save-btn { background: #0e639c; color: white; }
          .save-btn:hover { background: #1177bb; }
        </style>
      </head>
      <body>
        <div class="header">
          <span>✏️ 编辑会话别名</span>
          <button class="close-btn" id="closeBtn">×</button>
        </div>
        <div class="body">
          <label>会话别名</label>
          <input type="text" id="aliasInput" value="${currentName}" placeholder="输入别名">
          <div class="hint">💡 原始名称: ${originalName}</div>
        </div>
        <div class="footer">
          <button class="cancel-btn" id="cancelBtn">取消</button>
          <button class="save-btn" id="saveBtn">保存</button>
        </div>
        <script>
          const { ipcRenderer } = require('electron');
          const input = document.getElementById('aliasInput');
          setTimeout(() => { input.focus(); input.select(); }, 100);
          document.getElementById('saveBtn').addEventListener('click', () => {
            ipcRenderer.send('alias-dialog-result', { newName: input.value });
          });
          document.getElementById('cancelBtn').addEventListener('click', () => {
            ipcRenderer.send('alias-dialog-result', { cancelled: true });
          });
          document.getElementById('closeBtn').addEventListener('click', () => {
            ipcRenderer.send('alias-dialog-result', { cancelled: true });
          });
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') document.getElementById('saveBtn').click();
            if (e.key === 'Escape') document.getElementById('cancelBtn').click();
          });
        </script>
      </body>
      </html>
    `;

    inputWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    inputWindow.once('ready-to-show', () => { inputWindow.show(); });

    ipcMain.once('alias-dialog-result', (e, result) => {
      inputWindow.close();
      resolve(result);
    });
    inputWindow.on('closed', () => { resolve({ cancelled: true }); });
  });
});
