const { app, BrowserWindow, ipcMain, clipboard, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

let mainWindow;
let focusInitialized = false;
const terminals = new Map();

// 终端数量限制（最多10个）
const MAX_TERMINALS = 10;

// 进程监控
let processMonitorInterval = null;
const processStats = new Map();

// 内存监控
let memoryHistory = [];
const MAX_MEMORY_HISTORY = 60; // 保存最近60个采样点（10分钟）

// 使用用户数据目录存储可写文件
const userDataPath = app.getPath('userData');
const SESSION_FILE = path.join(userDataPath, 'session.json');
const TEMPLATES_FILE = path.join(userDataPath, 'templates.json');
const QUICK_REPLY_FILE = path.join(userDataPath, 'quick-reply.json');

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
  } else if ((!lastSessionData || lastSessionData.length === 0) && terminals.size > 0) {
    // 降级方案：从 terminals Map 自动构建会话数据（用于窗口关闭时）
    const autoData = [];
    terminals.forEach((ptyProcess, id) => {
      const userData = ptyProcess.userData || {};
      autoData.push({
        id,
        shell: userData.shell || 'powershell.exe',
        cwd: userData.cwd || process.env.USERPROFILE,
        script: userData.script || '',
        name: userData.name || 'Terminal',
        icon: userData.icon || '📟',
      });
    });
    lastSessionData = autoData;
    console.log('[Main] 自动构建会话数据，终端数量:', autoData.length);
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
    
  }, 60000); // 每60秒检查一次
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
    show: false,
    focusable: true,  // 明确声明窗口可聚焦
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  mainWindow.loadFile('index.html');

  // 窗口准备好后显示并强制聚焦（多次尝试）
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.moveTop();
    
    // 多次尝试强制聚焦
    const forceFocus = () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.focus();
        mainWindow.webContents.focus();
        mainWindow.flashFrame(true);  // 闪烁任务栏，触发焦点
        setTimeout(() => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.flashFrame(false);
          }
        }, 200);
      }
    };
    
    forceFocus();
    setTimeout(forceFocus, 50);
    setTimeout(forceFocus, 200);
    setTimeout(forceFocus, 500);
    
    console.log('[Main] 窗口已显示并尝试聚焦');
  });

  // 监听窗口获得焦点的事件
  mainWindow.on('focus', () => {
    console.log('[Main] 窗口获得焦点');
  });

  mainWindow.on('minimize', () => {
    console.log('[Main] 窗口最小化');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window-minimized');
    }
  });

  mainWindow.on('restore', () => {
    console.log('[Main] 窗口恢复');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window-restored');
    }
  });

  mainWindow.on('resize', () => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isMinimized()) {
      const [width, height] = mainWindow.getContentSize();
      // 窗口内容区域太小时不触发 resize，避免 PTY 崩溃
      if (width >= 200 && height >= 100) {
        mainWindow.webContents.send('window-resized');
      }
    }
  });

  // 统一清理函数：杀掉所有终端进程 + 清理资源
  function cleanupAllTerminals() {
    console.log('[Main] 清理所有终端进程，数量:', terminals.size);
    
    // 先收集所有 PID（clear 后就没了）
    const pids = [];
    terminals.forEach((ptyProcess, id) => {
      if (ptyProcess.pid) pids.push(ptyProcess.pid);
    });
    
    // Windows 上先用 taskkill 强制杀掉进程树（在 ptyProcess.kill 之前，否则 PID 没了）
    if (process.platform === 'win32' && pids.length > 0) {
      try {
        const { execSync } = require('child_process');
        for (const pid of pids) {
          try {
            execSync(`taskkill /F /PID ${pid} /T 2>nul`, { timeout: 3000 });
            console.log(`[Main] taskkill 已清理进程树 PID ${pid}`);
          } catch (_) {
            // 进程已不存在，忽略
          }
        }
      } catch (e) {
        console.error('[Main] taskkill 清理失败:', e.message);
      }
    }
    
    // 再调用 ptyProcess.kill() 作为兜底
    terminals.forEach((ptyProcess) => {
      try {
        if (!ptyProcess.killed) {
          ptyProcess.kill();
        }
      } catch (e) {}
    });
    terminals.clear();
  }

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
    
    // 用户确认关闭 → 阻止默认关闭，先保存会话再清理退出
    e.preventDefault();
    console.log('[Main] 窗口关闭，开始清理...');
    
    // 先保存会话（在清理终端前，此时 terminals Map 还有数据）
    saveSession();
    
    // 停止监控
    stopProcessMonitor();
    
    // 清理所有终端
    cleanupAllTerminals();
    
    // 销毁窗口
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.removeAllListeners('closed');
      mainWindow.destroy();
    }
    
    // 强制退出应用
    console.log('[Main] 清理完成，退出应用');
    app.quit();
  });
  
  mainWindow.on('closed', () => {
    // 兜底清理（防止 close 没走到）
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
  
  
  // 监听渲染进程崩溃
  app.on('render-process-gone', (event, webContents, details) => {
    console.error('[Main] 渲染进程崩溃:', details);
  });
  
  // 监听子进程异常退出
  app.on('child-process-gone', (event, details) => {
    console.error('[Main] 子进程异常退出:', details);
  });
});

app.on('before-quit', () => {
  console.log('[Main] before-quit，清理所有终端');
  stopProcessMonitor();
  terminals.forEach((ptyProcess) => {
    try { ptyProcess.kill(); } catch (e) {}
  });
  terminals.clear();
});

app.on('window-all-closed', () => {
  // 停止进程监控
  stopProcessMonitor();
  console.log('[Main] 进程监控已停止');
  
  // 清理残留终端
  terminals.forEach((ptyProcess) => {
    try { ptyProcess.kill(); } catch (e) {}
  });
  terminals.clear();
  
  if (process.platform !== 'darwin') app.quit();
});

// 监听应用级别的错误
process.on('uncaughtException', (err) => {
  console.error('[Main] 未捕获的异常:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Main] 未处理的 Promise 拒绝:', reason);
});

// 自动查找 Git Bash（使用 usr/bin/bash.exe，避免与 WSL bash 混淆）
function findGitBash() {
  const commonPaths = [
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe',
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    process.env['PROGRAMFILES'] + '\\Git\\usr\\bin\\bash.exe',
    process.env['PROGRAMFILES(X86)'] + '\\Git\\usr\\bin\\bash.exe',
    process.env['LOCALAPPDATA'] + '\\Programs\\Git\\usr\\bin\\bash.exe',
  ];
  
  // 检查常见安装路径（优先 usr/bin，这是 MSYS2 标准位置）
  for (const p of commonPaths) {
    if (p && fs.existsSync(p)) {
      console.log('[Main] 在常见路径找到 Git Bash:', p);
      return p;
    }
  }
  
  // 从注册表读取 Git 安装路径
  if (process.platform === 'win32') {
    try {
      const { execSync } = require('child_process');
      const regOutput = execSync(
        'reg query "HKLM\\SOFTWARE\\GitForGit" /v InstallPath 2>nul',
        { encoding: 'utf8' }
      );
      const match = regOutput.match(/InstallPath\s+REG_SZ\s+(.+)/i);
      if (match) {
        const installPath = path.join(match[1].trim(), 'usr\\bin\\bash.exe');
        if (fs.existsSync(installPath)) {
          console.log('[Main] 从注册表找到 Git Bash:', installPath);
          return installPath;
        }
        // 降级到 bin/bash.exe
        const binPath = path.join(match[1].trim(), 'bin\\bash.exe');
        if (fs.existsSync(binPath)) {
          console.log('[Main] 从注册表找到 Git Bash (bin):', binPath);
          return binPath;
        }
      }
    } catch (e) {
      // 注册表查询失败，忽略
    }
  }
  
  // 最终降级：在 PATH 中查找 bash.exe（严格验证必须是 Git 目录）
  const pathEnv = process.env.PATH || '';
  const pathDirs = pathEnv.split(';');
  for (const dir of pathDirs) {
    const bashInPath = path.join(dir, 'bash.exe');
    if (fs.existsSync(bashInPath)) {
      try {
        const stat = fs.statSync(bashInPath);
        if (stat.isFile()) {
          const normalizedPath = bashInPath.toLowerCase();
          if (normalizedPath.includes('\\git\\') || normalizedPath.includes('/git/')) {
            console.log('[Main] 在 PATH 中找到 Git Bash:', bashInPath);
            return bashInPath;
          } else {
            console.log('[Main] 跳过非 Git bash:', bashInPath);
          }
        }
      } catch (e) {}
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
    // 只从用户数据目录加载，不自动创建默认模板
    if (fs.existsSync(TEMPLATES_FILE)) {
      const userTemplates = JSON.parse(fs.readFileSync(TEMPLATES_FILE, 'utf-8'));
      console.log('[Main] 从用户数据目录加载模板，数量:', userTemplates.length);
      return userTemplates;
    }
    
    // 用户数据目录没有模板，返回空数组（不自动创建默认模板）
    console.log('[Main] 用户数据目录没有模板，返回空数组');
    return [];
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

// 快速回复模板管理
ipcMain.handle('get-quick-reply', () => {
  try {
    if (fs.existsSync(QUICK_REPLY_FILE)) {
      const data = JSON.parse(fs.readFileSync(QUICK_REPLY_FILE, 'utf-8'));
      console.log('[Main] 加载快速回复模板，分组:', data.groups?.length || 0, '模板:', data.templates?.length || 0);
      return data;
    }
    // 返回默认结构
    const defaultData = {
      groups: [
        { id: 'grp-default', name: '默认分组', icon: '📁', collapsed: false, order: 1 }
      ],
      templates: []
    };
    fs.writeFileSync(QUICK_REPLY_FILE, JSON.stringify(defaultData, null, 2), 'utf-8');
    return defaultData;
  } catch (e) {
    console.error('[Main] 加载快速回复失败:', e.message);
    return { groups: [], templates: [] };
  }
});

ipcMain.handle('save-quick-reply', (event, data) => {
  try {
    console.log('[Main] 保存快速回复，分组:', data.groups?.length || 0, '模板:', data.templates?.length || 0);
    fs.writeFileSync(QUICK_REPLY_FILE, JSON.stringify(data, null, 2), 'utf-8');
    return { success: true };
  } catch (e) {
    console.error('[Main] 保存快速回复失败:', e.message);
    return { success: false, error: e.message };
  }
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

// 展开环境变量中的 %VAR% 引用
function expandEnvVars(value) {
  if (!value || typeof value !== 'string' || !value.includes('%')) return value;
  return value.replace(/%([^%]+)%/g, (_, varName) => {
    return process.env[varName] || `%${varName}%`;
  });
}

// 合并 PATH 字符串并去重
function mergePaths(...pathStrings) {
  const allPaths = new Set();
  for (const p of pathStrings) {
    if (p) p.split(';').filter(Boolean).forEach(x => allPaths.add(x));
  }
  return Array.from(allPaths).join(';');
}

// 获取完整的用户环境变量（包括用户 PATH + 系统 PATH + 其他系统变量）
function getFullUserEnv() {
  const env = { ...process.env };
  
  if (os.platform() === 'win32') {
    try {
      const { execSync } = require('child_process');
      
      // 读取所有系统环境变量
      const systemEnvVars = {};
      const systemOutput = execSync(
        'reg query "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment" 2>nul',
        { encoding: 'utf8' }
      );
      const systemLines = systemOutput.split('\n').filter(l => l.trim());
      for (const line of systemLines) {
        const match = line.match(/^(\S+)\s+REG_(?:EXPAND_)?SZ\s+(.+)$/i);
        if (match) {
          const key = match[1].trim();
          let value = match[2].trim();
          value = expandEnvVars(value);
          systemEnvVars[key] = value;
        }
      }
      
      // 合并系统环境变量（不覆盖已有的 process.env 值）
      for (const [key, value] of Object.entries(systemEnvVars)) {
        if (!env[key]) env[key] = value;
      }
      
      // 读取所有用户环境变量
      const userEnvVars = {};
      try {
        const userOutput = execSync(
          'reg query "HKCU\\Environment" 2>nul',
          { encoding: 'utf8' }
        );
        const userLines = userOutput.split('\n').filter(l => l.trim());
        for (const line of userLines) {
          const match = line.match(/^(\S+)\s+REG_(?:EXPAND_)?SZ\s+(.+)$/i);
          if (match) {
            const key = match[1].trim();
            let value = match[2].trim();
            value = expandEnvVars(value);
            userEnvVars[key] = value;
          }
        }
      } catch (_) {}
      
      // 合并用户环境变量（覆盖系统变量）
      for (const [key, value] of Object.entries(userEnvVars)) {
        env[key] = value;
      }
      
      // PATH 特殊处理：去重合并用户 + 系统 + 进程
      env['PATH'] = mergePaths(
        userEnvVars['PATH'] || '',
        systemEnvVars['PATH'] || '',
        process.env['PATH'] || ''
      );
      
      console.log('[Main] 系统环境变量已加载:', Object.keys(systemEnvVars).length, '个');
      console.log('[Main] 用户环境变量已加载:', Object.keys(userEnvVars).length, '个');
    } catch (e) {
      console.log('[Main] 获取注册表环境变量失败:', e.message);
    }
  }
  
  return env;
}

ipcMain.handle('create-terminal', async (event, options) => {
  const { cwd, shell, id, script, cols, rows, name, icon, restore } = options;
  
  // 检查工作目录是否存在（恢复会话时不检查，直接使用默认目录）
  let actualCwd = cwd;
  if (!restore && cwd && !fs.existsSync(cwd)) {
    console.log(`[Main] 工作目录不存在: ${cwd}`);
    return { success: false, error: `工作目录不存在：${cwd}\n请修改模板配置或创建该目录` };
  }
  
  // 如果没有指定目录，或者恢复会话时目录不存在，使用默认目录
  if (!actualCwd || (restore && cwd && !fs.existsSync(cwd))) {
    actualCwd = process.env.USERPROFILE || os.homedir();
  }
  
  console.log(`[Main] 创建终端：id=${id}, shell=${shell}, cwd=${actualCwd}, restore=${restore}`);
  
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
    let shellPath = shell || defaultShell;
    
    // 修复：如果会话保存了 WSL bash 路径，强制替换为正确的 Git Bash
    const normalizedShell = shellPath.toLowerCase();
    if (normalizedShell.includes('windows\\system32\\bash') || normalizedShell.includes('wsl')) {
      const correctGitBash = findGitBash();
      if (correctGitBash) {
        console.log(`[Main] 检测到历史会话使用了 WSL bash，已替换为 Git Bash: ${correctGitBash}`);
        shellPath = correctGitBash;
      } else {
        console.error('[Main] 无法找到 Git Bash，拒绝启动 WSL bash');
        return { success: false, error: '检测到 WSL bash，但无法找到 Git Bash。请安装 Git for Windows。' };
      }
    }
    
    if (shellPath.includes('\\') || shellPath.includes('/')) {
      if (!fs.existsSync(shellPath)) {
        return { success: false, error: `Shell 不存在：${shellPath}` };
      }
    }
    
    // 为 Git Bash 设置环境变量
    const isGitBash = shellPath.includes('git') || shellPath.includes('bash');
    const env = getFullUserEnv();
    
    if (isGitBash) {
      console.log('[Main] Git Bash 诊断 - shellPath:', shellPath);
      console.log('[Main] Git Bash 诊断 - isGitBash:', isGitBash);
      
      // 验证：确认这个 bash.exe 确实是 Git 的，不是 WSL 的
      const normalizedShell = shellPath.toLowerCase();
      if (normalizedShell.includes('\\windows\\system32\\') || normalizedShell.includes('wsl')) {
        console.error('[Main] 错误：检测到 WSL bash，拒绝启动:', shellPath);
        return { success: false, error: '检测到 WSL bash.exe，请使用 Git Bash' };
      }
      
      env['MSYSTEM'] = 'MINGW64';
      env['CHERE_INVOKING'] = '1';
      env['MSYS2_PATH_TYPE'] = 'inherit';
      env['TERM'] = 'xterm-256color';
      // 禁用 ls/grep 彩色输出
      env['CLICOLOR'] = '0';
      env['LS_COLORS'] = '';
      env['GREP_COLOR'] = '';
      env['GREP_COLORS'] = '';
    }
    
    // 创建新的进程（Git Bash 使用 --login 触发 /etc/profile 初始化，包含 open 命令）
    const spawnArgs = isGitBash ? ['--login', '-i'] : [];
    if (isGitBash) {
      console.log('[Main] Git Bash 诊断 - spawnArgs:', JSON.stringify(spawnArgs));
      console.log('[Main] Git Bash 诊断 - MSYSTEM:', env['MSYSTEM']);
      console.log('[Main] Git Bash 诊断 - CHERE_INVOKING:', env['CHERE_INVOKING']);
    }
    const ptyProcess = pty.spawn(shellPath, spawnArgs, {
      name: 'xterm-256color',
      cols: cols || 80,
      rows: rows || 24,
      cwd: actualCwd,
      env: env,
      useConpty: true,
      conptyInheritCursor: true,
    });

    if (isGitBash) {
      setTimeout(() => {
        try {
          ptyProcess.write('alias ls="ls --color=never"\nalias ll="ls -l --color=never"\nalias la="ls -a --color=never"\nalias grep="grep --color=never"\n');
          ptyProcess.write('export CLICOLOR=0\nLS_COLORS=""\n');
        } catch (e) {
          console.error('[Main] Git Bash 颜色配置失败:', e.message);
        }
      }, 300);
    }

    // 保存终端用户数据
    ptyProcess.userData = { shell, cwd: actualCwd, script, name, icon };

    terminals.set(id, ptyProcess);

    ptyProcess.onData(data => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('terminal-data', { id, data });
      }
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      terminals.delete(id);
      
      // 退出时更新会话
      saveSession();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('terminal-exit', { id, exitCode, signal });
      }
    });

    // 执行脚本（逐行执行）
    if (script && script.trim()) {
      console.log(`[Main] 准备执行脚本：${script}`);
      const lines = script.split('\n').filter(line => line.trim());
      lines.forEach((line, index) => {
        setTimeout(() => {
          if (terminals.has(id)) {
            ptyProcess.write(`${line.trim()}\r`);
            console.log(`[Main] 执行第 ${index + 1} 行: ${line.trim()}`);
          }
        }, 500 + index * 150); // 每行间隔150ms，避免命令粘连
      });
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
      // 强制最小安全尺寸，防止 PTY 崩溃
      const safeCols = Math.max(20, Math.min(Math.floor(cols), 500));
      const safeRows = Math.max(5, Math.min(Math.floor(rows), 200));
      if (!ptyProcess.killed && safeCols > 0 && safeRows > 0) {
        ptyProcess.resize(safeCols, safeRows);
        return { success: true };
      }
      return { success: false, error: 'Invalid dimensions or process killed' };
    } catch (e) {
      console.error('[Main] resize-terminal 异常:', e.message);
      return { success: false, error: e.message };
    }
  }
  return { success: false, error: 'Terminal not found' };
});

ipcMain.handle('close-terminal', (event, { id, forceKill = false }) => {
  const ptyProcess = terminals.get(id);
  if (ptyProcess) {
    try {
      ptyProcess.userClosed = true;
      ptyProcess.kill();
      terminals.delete(id);
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
      count: terminals.size
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
    
    // 重新执行脚本（逐行执行）
    if (terminalConfig.script && terminalConfig.script.trim()) {
      const lines = terminalConfig.script.split('\n').filter(line => line.trim());
      lines.forEach((line, index) => {
        setTimeout(() => {
          if (terminals.has(id)) {
            result.write(`${line.trim()}\r`);
          }
        }, 500 + index * 150);
      });
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

// 聚焦窗口（解决弹窗输入框无法输入的焦点问题）
ipcMain.handle('focus-window', (event, coords) => {
  return new Promise((resolve) => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      resolve();
      return;
    }

    const doFocusSequence = () => {
      mainWindow.focus();
      mainWindow.webContents.focus();
      mainWindow.moveTop();
      mainWindow.setAlwaysOnTop(true, 'screen-saver');
      setTimeout(() => {
        if (!mainWindow || mainWindow.isDestroyed()) { resolve(); return; }
        if (coords) {
          mainWindow.webContents.sendInputEvent({ type: 'mouseMove', x: coords.x, y: coords.y, button: 'left' });
          mainWindow.webContents.sendInputEvent({ type: 'mouseDown', x: coords.x, y: coords.y, button: 'left', clickCount: 1 });
          mainWindow.webContents.sendInputEvent({ type: 'mouseUp', x: coords.x, y: coords.y, button: 'left', clickCount: 1 });
        }
        setTimeout(() => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.setAlwaysOnTop(false);
            mainWindow.webContents.focus();
          }
          resolve();
        }, 80);
      }, 150);
    };

    if (!focusInitialized) {
      // 首次弹窗：先 blur 再 focus，强制 OS 重新授予键盘焦点（会有一次短暂闪烁）
      focusInitialized = true;
      mainWindow.blur();
      setTimeout(doFocusSequence, 60);
    } else {
      // 后续弹窗：窗口已有 OS 焦点，直接聚焦即可（无闪烁）
      doFocusSequence();
    }
  });
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

// 剪贴板读写（Electron 原生 clipboard，避免 navigator.clipboard 受限）
ipcMain.handle('clipboard-write', (event, text) => {
  try {
    clipboard.writeText(text);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('clipboard-read', async (event) => {
  try {
    const text = clipboard.readText();
    return { success: true, text };
  } catch (e) {
    return { success: false, error: e.message };
  }
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

    const escapedCurrentName = currentName.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const escapedOriginalName = originalName.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
          <input type="text" id="aliasInput" value="${escapedCurrentName}" placeholder="输入别名">
          <div class="hint">💡 原始名称: ${escapedOriginalName}</div>
        </div>
        <div class="footer">
          <button class="cancel-btn" id="cancelBtn">取消</button>
          <button class="save-btn" id="saveBtn">保存</button>
        </div>
        <script>
          const { ipcRenderer } = require('electron');
          const input = document.getElementById('aliasInput');
          requestAnimationFrame(() => { input.focus(); input.select(); });
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
