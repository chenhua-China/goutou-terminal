const { ipcRenderer } = require('electron');
const { Terminal } = require('xterm');
const { FitAddon } = require('xterm-addon-fit');

// 状态管理
let terminals = new Map();
let activeTerminalId = null;
let terminalCounter = 0;
let shells = [];
let templates = [];
let quickReplyData = { groups: [], templates: [] };

// 监控状态
let monitorInterval = null;
let healthStatus = {
  status: 'healthy',
  terminals: { current: 0, max: 10 },
  memory: { estimatedUsageMB: 0, usagePercentage: 0 }
};

// DOM 元素
const sessionList = document.getElementById('sessionList');
const terminalContainer = document.getElementById('terminalContainer');
const emptyState = document.getElementById('emptyState');
const newSessionBtn = document.getElementById('newSessionBtn');
const cwdText = document.getElementById('cwdText');

// 弹窗
let modalOverlay;
let createTemplateModal;
let manageTemplateModal;

// 拖拽相关
let draggedItem = null;

// 历史目录管理
const CWD_HISTORY_KEY = 'cwdHistory';
const MAX_CWD_HISTORY = 20;

function getCwdHistory() {
  try {
    const data = localStorage.getItem(CWD_HISTORY_KEY);
    return data ? JSON.parse(data) : [];
  } catch (e) {
    return [];
  }
}

function addCwdHistory(cwd) {
  if (!cwd) return;
  let history = getCwdHistory();
  // 去重，移到最前面
  history = history.filter(p => p !== cwd);
  history.unshift(cwd);
  // 限制数量
  if (history.length > MAX_CWD_HISTORY) {
    history = history.slice(0, MAX_CWD_HISTORY);
  }
  try {
    localStorage.setItem(CWD_HISTORY_KEY, JSON.stringify(history));
  } catch (e) {}
}

// 初始化
async function init() {
  console.log('[Renderer] 初始化开始');

  shells = await ipcRenderer.invoke('get-shells');
  templates = await ipcRenderer.invoke('get-templates');
  quickReplyData = await ipcRenderer.invoke('get-quick-reply');

  console.log('[Renderer] Shell 预设:', shells);
  console.log('[Renderer] 模板:', templates);

  createMainModal();
  createCreateTemplateModal();
  createManageTemplateModal();

  // 启动监控
  startMonitor();
  
  newSessionBtn.addEventListener('click', showMainModal);

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 't') {
      e.preventDefault();
      showMainModal();
    }
    if (e.ctrlKey && e.key === 'w') {
      e.preventDefault();
      if (activeTerminalId) closeTerminal(activeTerminalId);
    }
    // Ctrl+Shift+S 保存会话
    if (e.ctrlKey && e.shiftKey && e.key === 's') {
      e.preventDefault();
      saveCurrentSession();
      alert('✅ 会话已保存!');
    }
    // F5 刷新当前终端的输入状态
    if (e.key === 'F5' && activeTerminalId) {
      e.preventDefault();
      const term = terminals.get(activeTerminalId);
      if (term) {
        term.terminal.blur();
        setTimeout(() => {
          term.terminal.focus();
          console.log('[Renderer] F5 刷新终端输入状态');
        }, 50);
      }
    }
  });

  ipcRenderer.on('terminal-data', (event, { id, data }) => {
    const term = terminals.get(id);
    if (!term) return;

    // 缓冲写入:合并短时间内的多次数据,减少渲染压力
    if (!term._writeBuffer) {
      term._writeBuffer = '';
      term._writeTimer = null;
      term._fitCounter = 0;
    }

    term._writeBuffer += data;

    // 清除之前的定时器
    if (term._writeTimer) clearTimeout(term._writeTimer);

    // 立即写入(保持响应速度)
    if (term._writeBuffer.length > 0) {
      term.terminal.write(term._writeBuffer);
      term._writeBuffer = '';
    }

    // 停止输出后 200ms 做最终 fit，避免在大量输出期间频繁重排
    term._writeTimer = setTimeout(() => {
      try {
        term.fitAddon.fit();
        // 同步 PTY 尺寸
        const dims = term.fitAddon.proposeDimensions();
        if (dims && dims.cols && dims.rows) {
          ipcRenderer.invoke('resize-terminal', {
            id: term.ptyId,
            cols: dims.cols,
            rows: dims.rows
          });
        }
      } catch (e) {
        console.error('[Renderer] 最终 fit 失败:', e.message);
      }
      term._fitCounter = 0;
    }, 200);
  });

  ipcRenderer.on('terminal-exit', (event, { id, exitCode }) => {
    const term = terminals.get(id);
    if (term) {
      term.terminal.writeln(`\r\n\x1b[31m[进程已退出,代码:${exitCode}]\x1b[0m`);
    }
    // 终端退出时自动保存会话
    saveCurrentSession();
  });

  // 监听窗口关闭事件
  window.addEventListener('beforeunload', () => {
    saveCurrentSession();
  });

  // 监听错误和崩溃
  window.addEventListener('error', (e) => {
    console.error('[Renderer] 全局错误:', e.error);
  });

  window.addEventListener('unhandledrejection', (e) => {
    console.error('[Renderer] 未处理的 Promise 拒绝:', e.reason);
  });

  // 监听页面刷新
  window.addEventListener('load', () => {
    console.log('[Renderer] 页面加载完成');
  });

  // 启动时恢复会话
  restoreSessionOnStartup();

  console.log('[Renderer] 初始化完成');
}

// 保存当前会话(窗口关闭时调用)
function saveCurrentSession() {
  const sessionData = [];
  terminals.forEach((term, id) => {
    sessionData.push({
      id,
      shell: term.preset.shell,
      cwd: term.preset.cwd,
      script: term.preset.script || '',
      name: term.name,
      icon: term.preset.icon || '📟',
    });
  });

  console.log('[Renderer] 保存会话,终端数量:', sessionData.length);
  ipcRenderer.invoke('save-session-manual', sessionData);
}

// 恢复会话（启动时）
async function restoreSessionOnStartup() {
  console.log('[Renderer] 尝试恢复会话...');
  
  try {
    const savedSessions = await ipcRenderer.invoke('get-session');
    
    if (savedSessions && savedSessions.length > 0) {
      console.log('[Renderer] 找到保存的会话:', savedSessions.length, '个');
      
      // 询问用户是否恢复
      const shouldRestore = confirm(`发现 ${savedSessions.length} 个上次保存的会话\n\n是否恢复这些会话？\n（点击"取消"将清除所有会话）`);
      
      if (shouldRestore) {
        // 恢复会话
        for (const session of savedSessions) {
          console.log('[Renderer] 恢复会话:', session.name);
          
          // 使用 restore 模式创建终端
          await openTerminal({
            shell: session.shell,
            cwd: session.cwd,
            icon: session.icon,
            name: session.name,  // 使用保存的别名
            script: session.script || '',
            restore: true,
            skipActivate: true,  // 先不激活，最后再激活第一个
          });
        }
        
        // 恢复完成后，激活第一个终端
        if (terminals.size > 0) {
          // 隐藏欢迎页面
          if (emptyState) emptyState.style.display = 'none';
          
          const firstId = Array.from(terminals.keys())[0];
          activateTerminal(firstId);
          console.log('[Renderer] 会话恢复完成，已激活第一个终端');
          // 更新状态显示
          updateHealthStatus();
        }
      } else {
        // 用户选择不恢复，清除会话
        await ipcRenderer.invoke('clear-session');
        console.log('[Renderer] 用户取消恢复，会话已清除');
      }
    } else {
      console.log('[Renderer] 没有保存的会话');
    }
  } catch (e) {
    console.error('[Renderer] 恢复会话失败:', e.message);
  }
}

// 主弹窗
function createMainModal() {
  console.log('[Renderer] 创建主弹窗,templates 数量:', templates.length);

  modalOverlay = document.createElement('div');
  modalOverlay.className = 'modal-overlay';

  const psShell = shells.find(s => s.shell.includes('powershell')) || shells[0];
  const cmdShell = shells.find(s => s.shell.includes('cmd')) || shells[0];
  const bashShell = shells.find(s => s.shell.includes('bash')) || shells[0];

  modalOverlay.innerHTML = `
    <div class="modal modal-large">
      <div class="modal-header">
        <span>🆕 新建终端</span>
        <button class="modal-close" id="closeModalBtn">×</button>
      </div>
      <div class="modal-body">
        <div class="section">
          <h3 class="section-title">⚡ 快速启动</h3>
          <div class="quick-buttons">
            <button class="quick-btn" data-type="shell" data-shell="${psShell.shell}" data-cwd="${psShell.cwd}" data-icon="${psShell.icon}">
              <span class="quick-icon">${psShell.icon}</span>
              <span class="quick-label">PowerShell</span>
            </button>
            <button class="quick-btn" data-type="shell" data-shell="${cmdShell.shell}" data-cwd="${cmdShell.cwd}" data-icon="${cmdShell.icon}">
              <span class="quick-icon">${cmdShell.icon}</span>
              <span class="quick-label">CMD</span>
            </button>
            ${bashShell ? `
            <button class="quick-btn" data-type="shell" data-shell="${bashShell.shell}" data-cwd="${bashShell.cwd}" data-icon="${bashShell.icon}">
              <span class="quick-icon">${bashShell.icon}</span>
              <span class="quick-label">Git Bash</span>
            </button>
            ` : ''}
          </div>
        </div>

        <div class="section">
          <div class="section-header">
            <h3 class="section-title">📋 自定义模板</h3>
            <div class="section-actions">
              <button class="btn-manage-templates" id="manageTemplatesBtn">⚙️ 管理模板</button>
              <button class="btn-create-template" id="createTemplateBtn">➕ 创建模板</button>
            </div>
          </div>
          <div class="template-grid">
            ${templates.length > 0 ? templates.map(t => `
              <div class="template-card" data-type="template" data-id="${t.id}" data-shell="${t.shell}" data-cwd="${t.cwd}" data-script="${encodeURIComponent(t.script || '')}" data-icon="${t.icon}" data-name="${t.name}">
                <div class="template-icon">${t.icon}</div>
                <div class="template-name">${t.name.replace(t.icon, '').trim()}</div>
                <div class="template-cwd">${t.cwd || '默认目录'}</div>
                <div class="template-script">${getScriptPreview(t.script)}</div>
                <div class="template-shell">${getShellName(t.shell)}</div>
              </div>
            `).join('') : '<div class="session-hint" style="grid-column: 1/-1; text-align: center;">💡 暂无模板,点击右上角"创建模板"添加</div>'}
          </div>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modalOverlay);

  // 验证按钮是否存在
  const manageBtn = modalOverlay.querySelector('#manageTemplatesBtn');
  const createBtn = modalOverlay.querySelector('#createTemplateBtn');
  console.log('[Renderer] 管理模板按钮:', manageBtn ? '存在' : '不存在');
  console.log('[Renderer] 创建模板按钮:', createBtn ? '存在' : '不存在');

  modalOverlay.querySelector('#closeModalBtn')?.addEventListener('click', hideMainModal);
  // 点击弹窗外部不关闭，必须点击确认或X才关闭
  // modalOverlay.addEventListener('click', (e) => {
  //   if (e.target === modalOverlay) hideMainModal();
  // });

  modalOverlay.querySelectorAll('.quick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      createTerminal({
        shell: btn.dataset.shell,
        cwd: btn.dataset.cwd,
        icon: btn.dataset.icon,
        name: btn.querySelector('.quick-label').textContent,
        script: '',
      });
      hideMainModal();
    });
  });

  modalOverlay.querySelectorAll('.template-card').forEach(card => {
    card.addEventListener('click', () => {
      const preset = {
        shell: card.dataset.shell,
        cwd: card.dataset.cwd,
        icon: card.dataset.icon,
        name: card.dataset.name,
        script: decodeURIComponent(card.dataset.script || ''),
      };
      createTerminal(preset);
      hideMainModal();
    });
  });

  manageBtn?.addEventListener('click', () => {
    console.log('[Renderer] 点击管理模板按钮');
    hideMainModal();
    showManageTemplateModal();
  });

  createBtn?.addEventListener('click', () => {
    console.log('[Renderer] 点击创建模板按钮');
    hideMainModal();
    showCreateTemplateModal();
  });
}

// 创建模板弹窗
function createCreateTemplateModal() {
  console.log('[Renderer] 创建模板弹窗,shells 数量:', shells.length);

  createTemplateModal = document.createElement('div');
  createTemplateModal.className = 'modal-overlay';

  // 确保 shells 不为空
  if (!shells || shells.length === 0) {
    console.error('[Renderer] shells 为空,使用默认值');
    shells = [
      { shell: 'powershell.exe', cwd: process.env.USERPROFILE || 'C:\\Users\\Default', icon: '💻', name: 'PowerShell' },
      { shell: 'cmd.exe', cwd: process.env.USERPROFILE || 'C:\\Users\\Default', icon: '📟', name: 'CMD' }
    ];
  }

  createTemplateModal.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <span>➕ 创建自定义模板</span>
        <button class="modal-close" id="closeCreateModalBtn">×</button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label>🏷️ 模板名称</label>
          <input type="text" id="tplName" placeholder="例如:启动后端服务">
        </div>
        <div class="form-group">
          <label>🎨 图标</label>
          <div class="icon-picker" id="iconPicker">
            ${['🚀','💻','🔧','📋','📡','🗄️','🎨','📱','⚙️','🌐','🐳','🔥','📊','🎮','🗂️','📁','🔔','💡','🛠️','🎯'].map(icon =>
              `<button type="button" class="icon-option${icon === '📝' ? ' selected' : ''}" data-icon="${icon}">${icon}</button>`
            ).join('')}
          </div>
          <input type="hidden" id="tplIcon" value="📝">
        </div>
        <div class="form-group">
          <label>💻 Shell 类型</label>
          <select id="tplShell">
            ${shells.map(s => `<option value="${s.shell}" data-cwd="${s.cwd}" data-icon="${s.icon}">${s.icon} ${s.name}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>📁 工作目录</label>
          <div class="cwd-input-group">
            <input type="text" id="tplCwd" placeholder="输入或选择工作目录">
            <button type="button" class="btn-cwd-dropdown" id="tplCwdDropdown" title="历史目录">▼</button>
            <button type="button" class="btn-cwd-browse" id="tplCwdBrowse" title="选择目录">📂</button>
            <div class="cwd-dropdown-list" id="tplCwdList"></div>
          </div>
        </div>
        <div class="form-group">
          <label>⚡ 执行脚本（可多行）</label>
          <textarea id="tplScript" rows="4" placeholder="例如：
npm run dev

# 或多行命令：
cd src
npm start"></textarea>
          <div class="script-hint">💡 每行一条命令，按顺序执行</div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary btn-small" id="cancelCreateBtn">取消</button>
        <button class="btn btn-primary btn-small" id="saveCreateBtn">保存模板</button>
      </div>
    </div>
  `;

  document.body.appendChild(createTemplateModal);

  const shellSelect = createTemplateModal.querySelector('#tplShell');
  const cwdInput = createTemplateModal.querySelector('#tplCwd');

  console.log('[Renderer] Shell 下拉框选项数量:', shellSelect?.options.length);

  shellSelect?.addEventListener('change', () => {
    const selected = shellSelect.options[shellSelect.selectedIndex];
    cwdInput.value = selected.dataset.cwd || '';
  });

  // 图标选择器
  createTemplateModal.querySelectorAll('.icon-option').forEach(btn => {
    btn.addEventListener('click', () => {
      createTemplateModal.querySelectorAll('.icon-option').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      createTemplateModal.querySelector('#tplIcon').value = btn.dataset.icon;
    });
  });

  // 工作目录选择器
  const cwdBrowseBtn = createTemplateModal.querySelector('#tplCwdBrowse');
  cwdBrowseBtn?.addEventListener('click', async () => {
    const result = await ipcRenderer.invoke('open-directory-dialog');
    if (result && !result.canceled && result.filePaths.length > 0) {
      cwdInput.value = result.filePaths[0];
    }
  });

  // 工作目录下拉列表
  const cwdDropdownBtn = createTemplateModal.querySelector('#tplCwdDropdown');
  const cwdList = createTemplateModal.querySelector('#tplCwdList');
  if (cwdDropdownBtn && cwdList) {
    const history = getCwdHistory();
    cwdList.innerHTML = history.length > 0 
      ? history.map(p => `<div class="cwd-option" data-path="${p}">${p}</div>`).join('')
      : '<div class="cwd-empty">暂无历史目录</div>';
    
    // 点击下拉按钮展开/收起列表
    cwdDropdownBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      cwdList.classList.toggle('show');
    });
    
    // 点击选项填入输入框
    cwdList.querySelectorAll('.cwd-option').forEach(opt => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        cwdInput.value = opt.dataset.path;
        cwdList.classList.remove('show');
      });
    });
  }
  
  // 点击弹窗其他地方关闭下拉列表
  createTemplateModal.addEventListener('click', () => {
    const cwdList = createTemplateModal.querySelector('#tplCwdList');
    cwdList?.classList.remove('show');
  });

  const initialShell = shellSelect?.options[shellSelect.selectedIndex];
  if (initialShell) {
    cwdInput.value = initialShell.dataset.cwd || '';
  }

  createTemplateModal.querySelector('#closeCreateModalBtn')?.addEventListener('click', hideCreateTemplateModal);
  createTemplateModal.querySelector('#cancelCreateBtn')?.addEventListener('click', hideCreateTemplateModal);
  createTemplateModal.querySelector('#saveCreateBtn')?.addEventListener('click', saveTemplate);
  // 点击弹窗外部不关闭
  // createTemplateModal.addEventListener('click', (e) => {
  //   if (e.target === createTemplateModal) hideCreateTemplateModal();
  // });

  console.log('[Renderer] 创建模板弹窗完成');
}

// 管理模板弹窗
function createManageTemplateModal() {
  manageTemplateModal = document.createElement('div');
  manageTemplateModal.className = 'modal-overlay';

  manageTemplateModal.innerHTML = `
    <div class="modal modal-large">
      <div class="modal-header">
        <span>⚙️ 管理模板</span>
        <button class="modal-close" id="closeManageModalBtn">×</button>
      </div>
      <div class="modal-body">
        <div class="manage-hint">💡 拖拽模板可调整顺序</div>
        <div class="template-list" id="templateList">
          ${templates.map((t, index) => `
            <div class="template-list-item" data-id="${t.id}" draggable="true">
              <div class="drag-handle">⋮⋮</div>
              <div class="template-list-info">
                <span class="template-list-icon">${t.icon}</span>
                <div class="template-list-details">
                  <div class="template-list-name">${t.name.replace(t.icon, '').trim()}</div>
                  <div class="template-list-meta">
                    <span class="template-list-shell">${getShellName(t.shell)}</span>
                    <span class="template-list-cwd">${t.cwd}</span>
                    ${t.script ? `<span class="template-list-script">⚡ ${getScriptPreview(t.script)}</span>` : ''}
                  </div>
                </div>
              </div>
              <div class="template-list-actions">
                <button class="btn-action btn-arrow btn-arrow-up" title="上移">↑</button>
                <button class="btn-action btn-arrow btn-arrow-down" title="下移">↓</button>
                <button class="btn-action btn-copy" data-action="copy" title="复制">📋</button>
                <button class="btn-action btn-edit" data-action="edit" title="编辑">✏️</button>
                <button class="btn-action btn-delete" data-action="delete" title="删除">🗑️</button>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(manageTemplateModal);

  manageTemplateModal.querySelector('#closeManageModalBtn').addEventListener('click', hideManageTemplateModal);
  // 点击弹窗外部不关闭
  // manageTemplateModal.addEventListener('click', (e) => {
  //   if (e.target === manageTemplateModal) hideManageTemplateModal();
  // });

  const listItems = manageTemplateModal.querySelectorAll('.template-list-item');
  listItems.forEach(item => {
    item.addEventListener('dragstart', handleDragStart);
    item.addEventListener('dragover', handleDragOver);
    item.addEventListener('drop', handleDrop);
    item.addEventListener('dragend', handleDragEnd);
  });

  manageTemplateModal.querySelectorAll('.template-list-item').forEach(item => {
    const id = item.dataset.id;
    const template = templates.find(t => t.id === id);

    item.querySelector('.btn-copy').addEventListener('click', (e) => {
      e.stopPropagation();
      copyTemplate(id);
    });

    item.querySelector('.btn-edit').addEventListener('click', (e) => {
      e.stopPropagation();
      hideManageTemplateModal();
      showEditTemplateModal(template);
    });

    item.querySelector('.btn-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteTemplate(id);
    });

    item.querySelector('.btn-arrow-up').addEventListener('click', (e) => {
      e.stopPropagation();
      moveTemplate(id, -1);
    });

    item.querySelector('.btn-arrow-down').addEventListener('click', (e) => {
      e.stopPropagation();
      moveTemplate(id, 1);
    });
  });
}

function handleDragStart(e) {
  draggedItem = this;
  this.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
}

function handleDragOver(e) {
  if (e.preventDefault) e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  return false;
}

function handleDrop(e) {
  if (e.stopPropagation) e.stopPropagation();

  if (draggedItem !== this) {
    const fromId = draggedItem.dataset.id;
    const toId = this.dataset.id;

    const fromIndex = templates.findIndex(t => t.id === fromId);
    const toIndex = templates.findIndex(t => t.id === toId);

    const temp = templates[fromIndex];
    templates.splice(fromIndex, 1);
    templates.splice(toIndex, 0, temp);

    refreshManageList();
  }

  return false;
}

function handleDragEnd() {
  this.classList.remove('dragging');
  draggedItem = null;
}

async function moveTemplate(id, direction) {
  const index = templates.findIndex(t => t.id === id);
  if (index === -1) return;

  const newIndex = index + direction;
  if (newIndex < 0 || newIndex >= templates.length) return;

  const temp = templates[index];
  templates.splice(index, 1);
  templates.splice(newIndex, 0, temp);

  console.log('[Renderer] 模板顺序已调整');

  await ipcRenderer.invoke('save-templates', templates);

  // 刷新管理列表
  refreshManageList();

  // 同时刷新主弹窗的模板网格(如果主弹窗是打开的)
  if (modalOverlay && modalOverlay.classList.contains('active')) {
    renderTemplateGrid();
  }
}

function refreshManageList() {
  const list = manageTemplateModal.querySelector('#templateList');
  list.innerHTML = templates.map(t => `
    <div class="template-list-item" data-id="${t.id}" draggable="true">
      <div class="drag-handle">⋮⋮</div>
      <div class="template-list-info">
        <span class="template-list-icon">${t.icon}</span>
        <div class="template-list-details">
          <div class="template-list-name">${t.name.replace(t.icon, '').trim()}</div>
          <div class="template-list-meta">
            <span class="template-list-shell">${getShellName(t.shell)}</span>
            <span class="template-list-cwd">${t.cwd}</span>
            ${t.script ? `<span class="template-list-script">⚡ ${getScriptPreview(t.script)}</span>` : ''}
          </div>
        </div>
      </div>
      <div class="template-list-actions">
        <button class="btn-action btn-arrow btn-arrow-up" title="上移">↑</button>
        <button class="btn-action btn-arrow btn-arrow-down" title="下移">↓</button>
        <button class="btn-action btn-copy" data-action="copy" title="复制">📋</button>
        <button class="btn-action btn-edit" data-action="edit" title="编辑">✏️</button>
        <button class="btn-action btn-delete" data-action="delete" title="删除">🗑️</button>
      </div>
    </div>
  `).join('');

  const listItems = list.querySelectorAll('.template-list-item');
  listItems.forEach(item => {
    item.addEventListener('dragstart', handleDragStart);
    item.addEventListener('dragover', handleDragOver);
    item.addEventListener('drop', handleDrop);
    item.addEventListener('dragend', handleDragEnd);

    const id = item.dataset.id;
    item.querySelector('.btn-copy').addEventListener('click', (e) => {
      e.stopPropagation();
      copyTemplate(id);
    });

    item.querySelector('.btn-edit').addEventListener('click', (e) => {
      e.stopPropagation();
      hideManageTemplateModal();
      showEditTemplateModal(templates.find(t => t.id === id));
    });

    item.querySelector('.btn-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteTemplate(id);
    });

    item.querySelector('.btn-arrow-up').addEventListener('click', (e) => {
      e.stopPropagation();
      moveTemplate(id, -1);
    });

    item.querySelector('.btn-arrow-down').addEventListener('click', (e) => {
      e.stopPropagation();
      moveTemplate(id, 1);
    });
  });
}

// 复制模板
function copyTemplate(id) {
  const template = templates.find(t => t.id === id);
  if (!template) return;

  const newTemplate = {
    ...template,
    id: `custom-${Date.now()}`,
    name: `${template.icon} ${template.name.replace(template.icon, '').trim()} (副本)`,
  };

  templates.push(newTemplate);
  ipcRenderer.invoke('save-templates', templates);
  hideManageTemplateModal();
  showManageTemplateModal();
  console.log('[Renderer] 模板已复制:', newTemplate.name);
}

function showEditTemplateModal(template) {
  const editModal = document.createElement('div');
  editModal.className = 'modal-overlay';

  editModal.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <span>✏️ 编辑模板</span>
        <button class="modal-close" id="closeEditModalBtn">×</button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label>🏷️ 模板名称</label>
          <input type="text" id="editTplName" value="${template.name.replace(template.icon, '').trim()}">
        </div>
        <div class="form-group">
          <label>🎨 图标</label>
          <div class="icon-picker" id="editIconPicker">
            ${['🚀','💻','🔧','📋','📡','🗄️','🎨','📱','⚙️','🌐','🐳','🔥','📊','🎮','🗂️','📁','🔔','💡','🛠️','🎯'].map(icon =>
              `<button type="button" class="icon-option${icon === template.icon ? ' selected' : ''}" data-icon="${icon}">${icon}</button>`
            ).join('')}
          </div>
          <input type="hidden" id="editTplIcon" value="${template.icon}">
        </div>
        <div class="form-group">
          <label>💻 Shell 类型</label>
          <select id="editTplShell">
            ${shells.map(s => `<option value="${s.shell}" data-cwd="${s.cwd}" data-icon="${s.icon}" ${s.shell === template.shell ? 'selected' : ''}>${s.icon} ${s.name}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>📁 工作目录</label>
          <div class="cwd-input-group">
            <input type="text" id="editTplCwd" value="${template.cwd}" placeholder="输入或选择工作目录">
            <button type="button" class="btn-cwd-dropdown" id="editCwdDropdown" title="历史目录">▼</button>
            <button type="button" class="btn-cwd-browse" id="editTplCwdBrowse" title="选择目录">📂</button>
            <div class="cwd-dropdown-list" id="editCwdList"></div>
          </div>
        </div>
        <div class="form-group">
          <label>⚡ 执行脚本（可多行）</label>
          <textarea id="editTplScript" rows="4">${template.script || ''}</textarea>
          <div class="script-hint">💡 每行一条命令，按顺序执行</div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary btn-small" id="cancelEditBtn">取消</button>
        <button class="btn btn-primary btn-small" id="saveEditBtn">保存修改</button>
      </div>
    </div>
  `;

  document.body.appendChild(editModal);

  // 图标选择器
  editModal.querySelectorAll('.icon-option').forEach(btn => {
    btn.addEventListener('click', () => {
      editModal.querySelectorAll('.icon-option').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      editModal.querySelector('#editTplIcon').value = btn.dataset.icon;
    });
  });

  // 工作目录选择器
  const editCwdBrowseBtn = editModal.querySelector('#editTplCwdBrowse');
  editCwdBrowseBtn?.addEventListener('click', async () => {
    const result = await ipcRenderer.invoke('open-directory-dialog');
    if (result && !result.canceled && result.filePaths.length > 0) {
      editModal.querySelector('#editTplCwd').value = result.filePaths[0];
    }
  });

  // 工作目录下拉列表
  const editCwdDropdownBtn = editModal.querySelector('#editCwdDropdown');
  const editCwdList = editModal.querySelector('#editCwdList');
  const editCwdInput = editModal.querySelector('#editTplCwd');
  if (editCwdDropdownBtn && editCwdList) {
    const history = getCwdHistory();
    editCwdList.innerHTML = history.length > 0 
      ? history.map(p => `<div class="cwd-option" data-path="${p}">${p}</div>`).join('')
      : '<div class="cwd-empty">暂无历史目录</div>';
    
    // 点击下拉按钮展开/收起列表
    editCwdDropdownBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      editCwdList.classList.toggle('show');
    });
    
    // 点击选项填入输入框
    editCwdList.querySelectorAll('.cwd-option').forEach(opt => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        editCwdInput.value = opt.dataset.path;
        editCwdList.classList.remove('show');
      });
    });
  }
  
  // 点击弹窗其他地方关闭下拉列表
  editModal.addEventListener('click', () => {
    editCwdList?.classList.remove('show');
  });

  const shellSelect = editModal.querySelector('#editTplShell');
  const cwdInput = editModal.querySelector('#editTplCwd');

  shellSelect.addEventListener('change', () => {
    const selected = shellSelect.options[shellSelect.selectedIndex];
    cwdInput.value = selected.dataset.cwd;
  });

  editModal.querySelector('#closeEditModalBtn').addEventListener('click', () => { editModal.remove(); focusActiveTerminal(); });
  editModal.querySelector('#cancelEditBtn').addEventListener('click', () => { editModal.remove(); focusActiveTerminal(); });
  editModal.querySelector('#saveEditBtn').addEventListener('click', () => saveEditTemplate(template.id, editModal));

  blurActiveTerminal();
  requestAnimationFrame(() => {
    editModal.classList.add('active');
    focusModalInput('#editTplName', editModal);
  });
}

async function saveEditTemplate(id, modal) {
  console.log('[Renderer] 保存编辑的模板,ID:', id);

  const name = modal.querySelector('#editTplName').value.trim();
  const icon = modal.querySelector('#editTplIcon').value.trim() || '📝';
  const shell = modal.querySelector('#editTplShell').value;
  const cwd = modal.querySelector('#editTplCwd').value.trim();
  const script = modal.querySelector('#editTplScript').value.trim();

  if (!name) {
    alert('请输入模板名称');
    return;
  }

  const index = templates.findIndex(t => t.id === id);
  if (index === -1) {
    console.error('[Renderer] 找不到模板,ID:', id);
    alert('❌ 模板不存在');
    return;
  }

  templates[index] = { id,
    name: `${icon} ${name}`,
    icon,
    shell,
    cwd,
    script,
  };

  // 保存工作目录到历史
  addCwdHistory(cwd);

  console.log('[Renderer] 更新后的模板:', templates[index]);
  console.log('[Renderer] 保存模板到文件,总数:', templates.length);

  const result = await ipcRenderer.invoke('save-templates', templates);
  console.log('[Renderer] 保存结果:', result);

  modal.remove();
  hideManageTemplateModal();
  if (modalOverlay && modalOverlay.classList.contains('active')) { hideMainModal(); }

  // 更新成功，不弹出通知
  console.log('[Renderer] 模板已更新');
}

async function deleteTemplate(id) {
  if (!confirm('确定要删除这个模板吗?')) return;

  console.log('[Renderer] 删除模板,ID:', id);

  templates = templates.filter(t => t.id !== id);
  console.log('[Renderer] 删除后模板数量:', templates.length);

  await ipcRenderer.invoke('save-templates', templates);

  // 重新创建管理弹窗,显示最新数据
  showManageTemplateModal();

  // 同时刷新主弹窗的模板网格(如果主弹窗是打开的)
  if (modalOverlay && modalOverlay.classList.contains('active')) {
    renderTemplateGrid();
  }

  // 删除成功不需要额外提示，用户已经确认了
  console.log('[Renderer] 模板已删除');
}

function getShellName(shellPath) {
  if (shellPath.includes('powershell')) return 'PowerShell';
  if (shellPath.includes('cmd')) return 'CMD';
  if (shellPath.includes('bash')) return 'Git Bash';
  return 'Shell';
}

// 获取脚本预览文本（多行脚本只显示第一行）
function getScriptPreview(script) {
  if (!script) return '无脚本';
  const lines = script.trim().split('\n');
  if (lines.length === 1) return script;
  return `${lines[0]} ... (共${lines.length}行)`;
}

function blurActiveTerminal() {
  // 强制释放任何元素上的焦点
  if (document.activeElement && document.activeElement !== document.body) {
    document.activeElement.blur();
    document.activeElement.dispatchEvent(new Event('blur', { bubbles: true }));
  }
  // 尝试通过 xterm API 释放
  if (activeTerminalId) {
    const term = terminals.get(activeTerminalId);
    if (term) {
      term.terminal.blur();
      // 直接找到 xterm 内部 textarea 强制 blur
      const wrapper = document.getElementById(`wrapper-${activeTerminalId}`);
      if (wrapper) {
        const ta = wrapper.querySelector('.xterm-helper-textarea');
        if (ta) { ta.blur(); ta.readOnly = true; setTimeout(() => { ta.readOnly = false; }, 100); }
      }
    }
  }
}

function focusActiveTerminal() {
  if (activeTerminalId) {
    const term = terminals.get(activeTerminalId);
    if (term) term.terminal.focus();
  }
}

// 通用弹窗输入框聚焦助手（解决 Electron 焦点问题）
async function focusModalInput(selector, root) {
  const input = (root || document).querySelector(selector);
  if (!input) return;

  // 确保输入框完全可用（清除任何 disabled/readOnly 状态）
  input.disabled = false;
  input.readOnly = false;

  // 让 overlay 可聚焦，防止焦点逃逸到底层
  const overlay = (root || input).closest('.modal-overlay, .qr-modal-overlay');
  if (overlay) {
    overlay.setAttribute('tabindex', '-1');
    overlay.style.outline = 'none';
  }

  // 计算输入框中心坐标（相对于 web contents），发给主进程用于 OS 级鼠标事件
  const rect = input.getBoundingClientRect();
  const coords = rect.width > 0 && rect.height > 0
    ? { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
    : null;

  // 等待主进程完成 OS 级聚焦（blur→focus→置顶→模拟鼠标点击→恢复，约 280ms）
  await ipcRenderer.invoke('focus-window', coords);

  // 等待浏览器渲染完成
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

  // focus 尝试函数：直接攻克输入框，不做多余操作
  const tryFocus = () => {
    try {
      input.focus({ preventScroll: true });
      if (typeof input.select === 'function') input.select();
      if (typeof input.setSelectionRange === 'function') {
        input.setSelectionRange(input.value.length, input.value.length);
      }
    } catch (e) {}
  };

  tryFocus();
  // 多次重试，应对冷启动时的渲染延迟
  setTimeout(tryFocus, 60);
  setTimeout(tryFocus, 200);
  setTimeout(tryFocus, 500);
}

function showMainModal() {
  blurActiveTerminal();
  // 关闭旧的弹窗,重新创建以获取最新数据
  if (modalOverlay) {
    modalOverlay.remove();
    modalOverlay = null;
  }
  createMainModal();
  modalOverlay.classList.add('active');
}
function hideMainModal() {
  modalOverlay.classList.remove('active');
  focusActiveTerminal();
}
function showCreateTemplateModal() {
  blurActiveTerminal();
  createTemplateModal.classList.add('active');
  focusModalInput('#tplName');
}
function hideCreateTemplateModal() {
  createTemplateModal.classList.remove('active');
  focusActiveTerminal();
}
function showManageTemplateModal() {
  blurActiveTerminal();
  manageTemplateModal?.remove();
  createManageTemplateModal();
  manageTemplateModal.classList.add('active');
}
function hideManageTemplateModal() {
  manageTemplateModal.classList.remove('active');
  focusActiveTerminal();
}

async function saveTemplate() {
  console.log('[Renderer] 保存模板');

  const nameInput = createTemplateModal.querySelector('#tplName');
  const iconInput = createTemplateModal.querySelector('#tplIcon');
  const shellSelect = createTemplateModal.querySelector('#tplShell');
  const cwdInput = createTemplateModal.querySelector('#tplCwd');
  const scriptInput = createTemplateModal.querySelector('#tplScript');

  if (!nameInput || !shellSelect) {
    console.error('[Renderer] 找不到输入框');
    alert('❌ 表单加载失败,请重试');
    return;
  }

  const name = nameInput.value.trim();
  const icon = iconInput?.value.trim() || '📝';
  const shell = shellSelect.value;
  const selectedOption = shellSelect.options[shellSelect.selectedIndex];
  const shellIcon = selectedOption?.dataset.icon || '💻';
  const cwd = cwdInput?.value.trim() || process.env.USERPROFILE;
  const script = scriptInput?.value.trim() || '';

  console.log('[Renderer] 模板数据:', { name, icon, shell, cwd, script });

  if (!name) {
    alert('请输入模板名称');
    return;
  }

  if (!shell) {
    alert('请选择 Shell 类型');
    return;
  }

  templates.push({
    id: `custom-${Date.now()}`,
    name: `${icon} ${name}`,
    shell,
    cwd,
    script,
    icon,
  });

  // 保存工作目录到历史
  addCwdHistory(cwd);

  console.log('[Renderer] 保存模板到文件,总数:', templates.length);
  const result = await ipcRenderer.invoke('save-templates', templates);
  console.log('[Renderer] 保存结果:', result);

  renderTemplateGrid();

  hideCreateTemplateModal();
  showMainModal();
  // 创建成功，不弹出通知
  console.log('[Renderer] 模板已保存');
}

function renderTemplateGrid() {
  const grid = modalOverlay.querySelector('.template-grid');
  grid.innerHTML = templates.map(t => `
    <div class="template-card" data-type="template" data-id="${t.id}" data-shell="${t.shell}" data-cwd="${t.cwd}" data-script="${encodeURIComponent(t.script || '')}" data-icon="${t.icon}" data-name="${t.name}">
      <div class="template-icon">${t.icon}</div>
      <div class="template-name">${t.name.replace(t.icon, '').trim()}</div>
      <div class="template-cwd">${t.cwd || '默认目录'}</div>
      <div class="template-script">${getScriptPreview(t.script)}</div>
      <div class="template-shell">${getShellName(t.shell)}</div>
    </div>
  `).join('');

  grid.querySelectorAll('.template-card').forEach(card => {
    card.addEventListener('click', () => {
      createTerminal({
        shell: card.dataset.shell,
        cwd: card.dataset.cwd,
        icon: card.dataset.icon,
        name: card.dataset.name,
        script: decodeURIComponent(card.dataset.script || ''),
      });
      hideMainModal();
    });
  });
}

function createTerminal(preset) {
  // 允许同一模板创建多个终端实例
  openTerminal({ ...preset, skipActivate: false });
}

async function openTerminal(preset) {
  // 检查终端数量限制
  if (!preset.restore) { // 恢复模式不检查限制
    const canCreate = await checkTerminalLimit();
    if (!canCreate) {
      console.log('[Renderer] 创建终端被限制阻止');
      return null;
    }
  }
  
  const id = `terminal-${++terminalCounter}`;
  const ptyId = id;
  const displayName = preset.name || `${getShellName(preset.shell)} ${terminalCounter}`;
  const isRestore = preset.restore === true;

  console.log('[Renderer] 打开终端:', id, '恢复模式:', isRestore, '跳过激活:', preset.skipActivate);

  const terminal = new Terminal({
    theme: {
      background: '#1e1e1e',
      foreground: '#cccccc',
      cursor: '#ffffff',
      cursorAccent: '#000000',
      selection: '#3a3d41',
      selectionInactive: '#2a2d2e',
    },
    fontSize: 14,
    fontFamily: 'Consolas, "Courier New", monospace',
    cursorBlink: true,
    cursorStyle: 'block',
    scrollback: 10000,
    tabStopWidth: 4,
    drawBoldTextInBrightColors: true,
    allowTransparency: false,
    lineHeight: 1.0,
    convertEol: true,  // 修复：正确处理换行，防止长内容移位
    termName: 'xterm-256color',
    // 允许选中文本
    disableStdin: false,
    screenReaderMode: false,
    // 确保正确处理所有键盘事件
    macOptionIsMeta: false,
    macOptionClickForcesSelection: false,
    altClickMovesCursor: true,
    // 启用 IME 支持(中文输入)
    overviewRulerWidth: 0,
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);

  // 监听 xterm 尺寸变化,同步 PTY
  terminal.onResize(({ cols, rows }) => {
    ipcRenderer.invoke('resize-terminal', {
      id: ptyId,
      cols,
      rows
    });
  });

  // 暂时不添加自定义键盘事件,让 xterm.js 原生处理所有按键
  // 复制/粘贴功能通过右键菜单实现

  const wrapper = document.createElement('div');
  wrapper.className = 'terminal-wrapper';
  wrapper.id = `wrapper-${id}`;
  wrapper.setAttribute('tabindex', '0');
  terminalContainer.appendChild(wrapper);

  // 不要设置 inline style,完全让 CSS 控制定位和显示

  // 强制浏览器先布局
  wrapper.offsetHeight;

  // 使用 requestAnimationFrame 确保在浏览器布局完成后 open
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      terminal.open(wrapper);

      // open 后再等一帧才 fit
      requestAnimationFrame(() => {
        fitAddon.fit();
        console.log('[Renderer] 终端已 open 并 fit');
      });
    });
  });

  // 确保 wrapper 可以接收焦点
  wrapper.addEventListener('click', () => {
    wrapper.focus();
    terminal.focus();
  });

  // 按 Tab 键时也聚焦终端
  wrapper.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      terminal.focus();
    }
  });

  // xterm v5 添加自定义键盘事件处理,支持 Ctrl+Shift+C/V 复制粘贴
  setupTerminalKeyHandler(terminal, ptyId);

  terminal.onData(data => {
    ipcRenderer.invoke('write-terminal', { id: ptyId, data });
  });

  // 添加右键菜单
  wrapper.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const selection = terminal.getSelection();

    // 创建右键菜单
    const menu = document.createElement('div');
    menu.className = 'terminal-context-menu';
    menu.style.cssText = `
      position: fixed;
      top: ${e.clientY}px;
      left: ${e.clientX}px;
      background: #252526;
      border: 1px solid #3c3c3c;
      border-radius: 4px;
      padding: 4px 0;
      box-shadow: 0 4px 12px rgba(0,0,0,0.5);
      z-index: 9999;
      min-width: 120px;
    `;

    const hasSelection = !!selection;

    // 复制选项
    const copyItem = document.createElement('div');
    copyItem.textContent = hasSelection ? '📋 复制' : '📋 复制 (无选中内容)';
    copyItem.style.cssText = `
      padding: 8px 16px;
      cursor: ${hasSelection ? 'pointer' : 'not-allowed'};
      color: ${hasSelection ? '#cccccc' : '#6a6a6a'};
      font-size: 13px;
    `;
    copyItem.addEventListener('mouseenter', () => {
      if (hasSelection) copyItem.style.background = '#0e639c';
    });
    copyItem.addEventListener('mouseleave', () => {
      if (hasSelection) copyItem.style.background = 'transparent';
    });
    if (hasSelection) {
      copyItem.addEventListener('click', () => {
        navigator.clipboard.writeText(selection).then(() => {
          console.log('[Renderer] 已复制到剪贴板');
        }).catch(err => {
          console.error('[Renderer] 复制失败:', err);
        });
        menu.remove();
      });
    }
    menu.appendChild(copyItem);

    // 粘贴选项
    const pasteItem = document.createElement('div');
    pasteItem.textContent = '📥 粘贴';
    pasteItem.style.cssText = `
      padding: 8px 16px;
      cursor: pointer;
      color: #cccccc;
      font-size: 13px;
    `;
    pasteItem.addEventListener('mouseenter', () => {
      pasteItem.style.background = '#0e639c';
    });
    pasteItem.addEventListener('mouseleave', () => {
      pasteItem.style.background = 'transparent';
    });
    pasteItem.addEventListener('click', async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (text) {
          ipcRenderer.invoke('write-terminal', { id: ptyId, data: text });
        }
      } catch (err) {
        console.error('[Renderer] 粘贴失败:', err);
      }
      menu.remove();
    });
    menu.appendChild(pasteItem);

    // 添加到快速回复选项（仅当有选中内容时显示）
    if (hasSelection) {
      const addToQuickReplyItem = document.createElement('div');
      addToQuickReplyItem.textContent = '💬 添加到快速回复';
      addToQuickReplyItem.style.cssText = `
        padding: 8px 16px;
        cursor: pointer;
        color: #cccccc;
        font-size: 13px;
      `;
      addToQuickReplyItem.addEventListener('mouseenter', () => {
        addToQuickReplyItem.style.background = '#0e639c';
      });
      addToQuickReplyItem.addEventListener('mouseleave', () => {
        addToQuickReplyItem.style.background = 'transparent';
      });
      addToQuickReplyItem.addEventListener('click', () => {
        menu.remove();
        // 打开新建模板弹窗，预填充选中的内容
        showAddTemplateModalWithContent(selection);
      });
      menu.appendChild(addToQuickReplyItem);
    }

    // 全选选项
    const selectAllItem = document.createElement('div');
    selectAllItem.textContent = '✅ 全选';
    selectAllItem.style.cssText = `
      padding: 8px 16px;
      cursor: pointer;
      color: #cccccc;
      font-size: 13px;
    `;
    selectAllItem.addEventListener('mouseenter', () => {
      selectAllItem.style.background = '#0e639c';
    });
    selectAllItem.addEventListener('mouseleave', () => {
      selectAllItem.style.background = 'transparent';
    });
    selectAllItem.addEventListener('click', () => {
      terminal.selectAll();
      menu.remove();
    });
    menu.appendChild(selectAllItem);

    document.body.appendChild(menu);

    // 点击其他地方关闭菜单（用 mousedown 更早捕获，避免 click 被延迟）
    const closeMenu = (e) => {
      // 如果点击的是菜单内部，不关闭
      if (menu.contains(e.target)) return;
      menu.remove();
      document.removeEventListener('mousedown', closeMenu);
      // 关闭后焦点回到终端
      const term = terminals.get(id);
      if (term) term.terminal.focus();
    };
    // 用 requestAnimationFrame 确保在下一帧才注册，避免当前右键事件被误捕获
    requestAnimationFrame(() => {
      document.addEventListener('mousedown', closeMenu);
    });
  });

  await new Promise(resolve => setTimeout(resolve, 50));
  fitAddon.fit();

  const dims = fitAddon.proposeDimensions();

  terminals.set(id, { terminal, fitAddon, ptyId, preset, name: displayName });

  // 恢复的终端也执行脚本
  const result = await ipcRenderer.invoke('create-terminal', {
    id: ptyId,
    cwd: preset.cwd,
    shell: preset.shell,
    script: preset.script || '',
    cols: dims?.cols || 80,
    rows: dims?.rows || 24,
    name: displayName,
    icon: preset.icon,
  });

  if (!result.success) {
    terminal.writeln(`\x1b[31m错误:${result.error}\x1b[0m`);
  } else {
    if (isRestore) {
      terminal.writeln(`\x1b[32m✓ 已恢复:${displayName}\x1b[0m`);
    } else {
      terminal.writeln(`\x1b[32m✓ 终端已启动:${displayName}\x1b[0m`);
      if (preset.script) {
        terminal.writeln(`\x1b[90m执行脚本:${preset.script}\x1b[0m`);
        terminal.writeln('');
      }
    }
  }

  createSessionItem(id, displayName, preset.cwd, preset.icon);

  // 如果不是恢复会话或没有跳过激活，则激活此终端
  if (!preset.skipActivate) {
    activateTerminal(id);

    // 分两次 fit：第一次立即执行，第二次等布局稳定后再执行
    const fitAndFocus = () => {
      wrapper.style.display = 'block';
      // 关键修复：先显示，等浏览器布局完成后再 fit
      requestAnimationFrame(() => {
        fitAddon.fit();
        terminal.focus();
      });
    };
    requestAnimationFrame(() => {
      fitAndFocus();
      setTimeout(() => {
        fitAndFocus();
        console.log('[Renderer] 终端刷新完成');
      }, 150);
    });
  }

  // 窗口 resize 时调整终端大小
  let resizeTimeout;
  window.addEventListener('resize', () => {
    if (activeTerminalId === id) {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        fitAddon.fit();
        const newDims = fitAddon.proposeDimensions();
        if (newDims && newDims.cols && newDims.rows) {
          ipcRenderer.invoke('resize-terminal', {
            id: ptyId,
            cols: newDims.cols,
            rows: newDims.rows
          });
        }
      }, 150);
    }
  });

  // 返回终端 ID 供恢复会话使用
  // 更新状态显示
  updateHealthStatus();
  return id;
}

function createSessionItem(id, name, cwd, icon) {
  // 去掉名称中的图标（只保留文字）
  const displayName = name.replace(/[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu, '').trim() || name;
  
  const item = document.createElement('div');
  item.className = 'session-item';
  item.id = `session-${id}`;
  item.innerHTML = `
    <span class="session-icon">${icon}</span>
    <div class="session-info">
      <div class="session-name">${displayName}</div>
      <div class="session-cwd">${cwd}</div>
    </div>
    <button class="session-close" title="关闭">×</button>
  `;

  // 保存原始名称（不含图标）用于别名编辑
  item.dataset.originalName = displayName;

  // 单击激活终端
  item.addEventListener('click', (e) => {
    if (!e.target.classList.contains('session-close')) {
      activateTerminal(id);
    }
  });

  // 右键菜单
  item.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showSessionContextMenu(e, id);
  });

  // 关闭按钮
  item.querySelector('.session-close').addEventListener('click', (e) => {
    e.stopPropagation();
    if (confirm('确定要关闭此终端吗？')) {
      closeTerminal(id);
    }
  });

  sessionList.appendChild(item);
}

// 显示会话右键菜单
function showSessionContextMenu(e, id) {
  // 移除已有的菜单
  const existingMenu = document.querySelector('.session-context-menu');
  if (existingMenu) existingMenu.remove();

  const menu = document.createElement('div');
  menu.className = 'session-context-menu';
  menu.style.cssText = `
    position: fixed;
    top: ${e.clientY}px;
    left: ${e.clientX}px;
    background: #252526;
    border: 1px solid #3c3c3c;
    border-radius: 4px;
    padding: 4px 0;
    box-shadow: 0 4px 12px rgba(0,0,0,0.5);
    z-index: 9999;
    min-width: 120px;
  `;

  // 编辑别名选项
  const editItem = document.createElement('div');
  editItem.textContent = '✏️ 编辑别名';
  editItem.style.cssText = `
    padding: 8px 16px;
    cursor: pointer;
    color: #cccccc;
    font-size: 13px;
  `;
  editItem.addEventListener('mouseenter', () => {
    editItem.style.background = '#0e639c';
  });
  editItem.addEventListener('mouseleave', () => {
    editItem.style.background = 'transparent';
  });
  editItem.addEventListener('click', () => {
    menu.remove();
    editSessionAlias(id);
  });
  menu.appendChild(editItem);

  // 关闭终端选项
  const closeItem = document.createElement('div');
  closeItem.textContent = '🗑️ 关闭终端';
  closeItem.style.cssText = `
    padding: 8px 16px;
    cursor: pointer;
    color: #cccccc;
    font-size: 13px;
  `;
  closeItem.addEventListener('mouseenter', () => {
    closeItem.style.background = '#cd3131';
  });
  closeItem.addEventListener('mouseleave', () => {
    closeItem.style.background = 'transparent';
  });
  closeItem.addEventListener('click', () => {
    menu.remove();
    if (confirm('确定要关闭此终端吗？')) {
      closeTerminal(id);
    }
  });
  menu.appendChild(closeItem);

  document.body.appendChild(menu);

  // 点击其他地方关闭菜单（用 mousedown 更早捕获，避免 click 被延迟）
  const closeMenu = (e) => {
    if (menu.contains(e.target)) return;
    menu.remove();
    document.removeEventListener('mousedown', closeMenu);
  };
  requestAnimationFrame(() => {
    document.addEventListener('mousedown', closeMenu);
  });
}

// 编辑会话别名
async function editSessionAlias(id) {
  const term = terminals.get(id);
  if (!term) {
    console.error('[Renderer] 找不到终端:', id);
    return;
  }

  const sessionItem = document.getElementById(`session-${id}`);
  const originalName = sessionItem?.dataset?.originalName || term.name.replace(/[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu, '').trim();
  const currentAlias = sessionItem?.dataset?.alias || '';
  const currentDisplayName = currentAlias || originalName;
  
  console.log('[Renderer] 编辑别名, 原名:', originalName, '当前别名:', currentAlias);

  // 使用无边框独立窗口（完全不受 xterm 影响，支持输入法）
  const result = await ipcRenderer.invoke('edit-alias-dialog', {
    currentName: currentDisplayName,
    originalName: originalName
  });

  if (result && result.newName) {
    const newName = result.newName.trim();
    if (newName && newName !== currentDisplayName) {
      term.name = newName;
      if (sessionItem) {
        sessionItem.dataset.alias = newName;
        sessionItem.dataset.originalName = originalName;
        const nameElement = sessionItem.querySelector('.session-name');
        if (nameElement) {
          nameElement.innerHTML = newName !== originalName
            ? `${newName} <span style="font-size: 11px; color: #6a6a6a;">(${originalName})</span>`
            : newName;
        }
      }
      activateTerminal(id);
      saveCurrentSession();
      console.log('[Renderer] 别名已更新:', id, '->', newName);
    }
  }
}

// 设置终端键盘处理（提取为独立函数以便复用）
function setupTerminalKeyHandler(terminal, ptyId) {
  terminal.attachCustomKeyEventHandler((event) => {
    // Ctrl+Shift+C: 复制选中的文本
    if (event.ctrlKey && event.shiftKey && (event.key === 'c' || event.key === 'C') && event.type === 'keydown') {
      const selection = terminal.getSelection();
      if (selection) {
        navigator.clipboard.writeText(selection).then(() => {
          console.log('[Renderer] ✅ 已复制到剪贴板');
        }).catch(err => {
          console.error('[Renderer] ❌ 复制失败:', err);
        });
        return false;
      }
      return true;
    }
    // Ctrl+Shift+V: 粘贴
    if (event.ctrlKey && event.shiftKey && (event.key === 'v' || event.key === 'V') && event.type === 'keydown') {
      navigator.clipboard.readText().then(text => {
        if (text) {
          ipcRenderer.invoke('write-terminal', { id: ptyId, data: text });
        }
      }).catch(err => {
        console.error('[Renderer] 粘贴失败:', err);
      });
      return false;
    }
    return true;
  });
}

function activateTerminal(id) {
  // 使用优化版的终端切换
  optimizeTerminalSwitch(id);
  
  const term = terminals.get(id);
  if (term) {
    // 获取显示名称（优先别名）
    const sessionItem = document.getElementById(`session-${id}`);
    const alias = sessionItem?.dataset?.alias || '';
    const originalName = sessionItem?.dataset?.originalName || term.name.replace(/[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu, '').trim();
    
    // 获取 Shell 类型名称（如 Git Bash、PowerShell）
    const shellType = getShellName(term.preset.shell);
    
    // 获取工作目录
    const cwd = term.preset.cwd || process.env.USERPROFILE || '~';
    
    // 构建显示内容：别名（Shell类型）📁 目录
    if (alias && alias !== originalName) {
      // 有别名：别名 (Shell类型) 📁 目录
      cwdText.innerHTML = `<span style="color: #0e639c; font-weight: 600;">${alias}</span> <span style="color: #8a8a8a; font-size: 12px;">(${shellType})</span> <span style="color: #6a6a6a;">📁</span> <span style="color: #8a8a8a; font-family: 'Consolas', monospace; font-size: 12px;">${cwd}</span>`;
    } else {
      // 无别名：Shell类型 📁 目录
      cwdText.innerHTML = `<span style="color: #0e639c; font-weight: 600;">${shellType}</span> <span style="color: #6a6a6a;">📁</span> <span style="color: #8a8a8a; font-family: 'Consolas', monospace; font-size: 12px;">${cwd}</span>`;
    }
    
    cwdText.title = `${alias || shellType}\nShell: ${shellType}\n目录: ${cwd}`;
    
    activeTerminalId = id;
  }
}

async function closeTerminal(id) {
  const term = terminals.get(id);
  if (!term) return;

  console.log('[Renderer] 关闭终端:', id);

  // 清理定时器
  if (term._writeTimer) {
    clearTimeout(term._writeTimer);
    term._writeTimer = null;
  }
  if (term._resizeTimer) {
    clearTimeout(term._resizeTimer);
    term._resizeTimer = null;
  }

  // 关闭 PTY 进程
  try {
    await ipcRenderer.invoke('close-terminal', { id: term.ptyId });
  } catch (e) {
    console.error('[Renderer] 关闭 PTY 失败:', e.message);
  }

  // 移除 DOM 元素
  const wrapper = document.getElementById(`wrapper-${id}`);
  if (wrapper) wrapper.remove();
  const sessionItem = document.getElementById(`session-${id}`);
  if (sessionItem) sessionItem.remove();

  // 释放 Terminal 对象
  try {
    term.terminal.dispose();
  } catch (e) {
    console.error('[Renderer] Terminal dispose 失败:', e.message);
  }

  // 从 Map 中删除
  terminals.delete(id);

  // 更新活动终端
  if (activeTerminalId === id) {
    activeTerminalId = null;
  }

  // 关闭终端后保存会话
  saveCurrentSession();

  if (terminals.size === 0) {
    emptyState.style.display = 'block';
    activeTerminalId = null;
    if (cwdText) cwdText.textContent = '~';
  } else if (!activeTerminalId) {
    const lastId = Array.from(terminals.keys()).pop();
    activateTerminal(lastId);
  }

  console.log('[Renderer] 终端已关闭，剩余数量:', terminals.size);
  
  // 更新状态显示
  updateHealthStatus();
}

// 启动监控
function startMonitor() {
  if (monitorInterval) {
    clearInterval(monitorInterval);
  }
  
  // 立即更新一次状态
  updateHealthStatus();
  
  monitorInterval = setInterval(async () => {
    try {
      // 获取健康状态
      const health = await ipcRenderer.invoke('health-check');
      healthStatus = health;
      
      // 更新界面状态显示
      updateStatusDisplay();
      
      // 如果状态为警告或严重，显示提示
      if (health.status === 'warning' || health.status === 'critical') {
        showStatusWarning(health);
      }
      
    } catch (e) {
      console.error('[Renderer] 监控失败:', e.message);
    }
  }, 120000); // 每2分钟检查一次
  
  console.log('[Renderer] 监控已启动');
}

// 立即更新健康状态（启动时调用）
async function updateHealthStatus() {
  try {
    const health = await ipcRenderer.invoke('health-check');
    healthStatus = health;
    updateStatusDisplay();
    // 状态已更新
  } catch (e) {
    console.error('[Renderer] 更新状态失败:', e.message);
  }
}

// 停止监控
function stopMonitor() {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
  console.log('[Renderer] 监控已停止');
}

// 更新状态显示
function updateStatusDisplay() {
  // 获取 cwd-bar 元素
  const cwdBar = document.getElementById('cwdBar');
  if (!cwdBar) return;
  
  // 在 cwd-bar 最右侧显示状态
  let statusElement = document.getElementById('status-indicator');
  if (!statusElement) {
    statusElement = document.createElement('div');
    statusElement.id = 'status-indicator';
    statusElement.className = 'status-indicator';
    statusElement.style.cssText = `
      margin-left: auto;
      padding: 2px 10px;
      border-radius: 4px;
      font-size: 11px;
      background: #4CAF50;
      color: white;
      cursor: pointer;
      user-select: none;
      white-space: nowrap;
    `;
    cwdBar.appendChild(statusElement);
    
    // 左键点击显示健康报告
    statusElement.addEventListener('click', (e) => {
      e.stopPropagation();
      showHealthReport();
    });
    
    // 右键点击显示性能报告
    statusElement.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showPerformanceReport();
      return false;
    });
    
    // 添加提示
    statusElement.title = '左键: 健康报告 | 右键: 性能报告';
  }
  
  // 根据状态设置颜色
  let color, text;
  const terminalCount = terminals.size;
  
  switch (healthStatus.status) {
    case 'healthy':
      color = '#4CAF50';
      text = `🖥️ ${terminalCount}/${healthStatus.terminals.max}`;
      break;
    case 'warning':
      color = '#FF9800';
      text = `⚠️ ${terminalCount}/${healthStatus.terminals.max}`;
      break;
    case 'critical':
      color = '#F44336';
      text = `🚨 ${terminalCount}/${healthStatus.terminals.max}`;
      break;
    default:
      color = '#757575';
      text = `🖥️ ${terminalCount}/${healthStatus.terminals.max}`;
  }
  
  statusElement.style.backgroundColor = color;
  statusElement.style.color = 'white';
  statusElement.textContent = text;
  statusElement.title = `终端数量: ${terminalCount}/${healthStatus.terminals.max}\n内存使用: ${healthStatus.memory.usagePercentage}%\n左键: 健康报告 | 右键: 性能报告`;
}

// 显示状态警告
function showStatusWarning(health) {
  // 避免频繁弹出警告
  const lastWarning = localStorage.getItem('lastWarningTime');
  const now = Date.now();
  
  if (lastWarning && (now - parseInt(lastWarning)) < 60000) {
    return; // 1分钟内不重复警告
  }
  
  localStorage.setItem('lastWarningTime', now.toString());
  
  let message = '';
  if (health.status === 'critical') {
    message = `🚨 系统状态严重警告！\n`;
    message += `• 终端数量: ${health.terminals.current}/${health.terminals.max}\n`;
    message += `• 内存使用率: ${health.memory.usagePercentage}%\n`;
    message += `• 建议: ${health.recommendations.join(', ')}`;
    
    if (confirm(message + '\n\n是否查看详细报告？')) {
      showHealthReport();
    }
  } else if (health.status === 'warning') {
    message = `⚠️ 系统状态警告\n`;
    message += `• ${health.recommendations.join('\n• ')}`;
    
    console.warn('[Renderer]', message);
  }
}

// 显示性能报告
async function showPerformanceReport() {
  try {
    const systemReport = await ipcRenderer.invoke('get-performance-report');
    
    const report = `
⚡ 系统状态
====================
⏰ 时间: ${new Date().toLocaleString()}

🖥️ 系统信息
• 平台: ${systemReport.system.platform} (${systemReport.system.arch})
• CPU 核心: ${systemReport.system.cpus} 个
• 系统内存: ${systemReport.system.totalMemoryMB} MB
• 可用内存: ${systemReport.system.freeMemoryMB} MB
• 终端数量: ${systemReport.terminals.count} 个
`;
    
    alert(report);
  } catch (e) {
    console.error('[Renderer] 获取系统状态失败:', e.message);
    alert('获取系统状态失败: ' + e.message);
  }
}

// 显示健康报告
async function showHealthReport() {
  try {
    const health = await ipcRenderer.invoke('health-check');
    const monitor = await ipcRenderer.invoke('get-process-monitor');
    const system = await ipcRenderer.invoke('get-system-status');
    
    const report = `
🧪 健康检查报告
====================
📊 系统状态: ${health.status.toUpperCase()}
⏰ 时间: ${new Date(health.timestamp).toLocaleString()}

📈 终端统计
• 当前终端: ${health.terminals.current} 个
• 最大限制: ${health.terminals.max} 个
• 健康状态: ${health.terminals.health}

💾 内存使用
• 预估占用: ${health.memory.estimatedUsageMB} MB
• 系统总量: ${health.memory.systemTotalMB} MB
• 系统可用: ${health.memory.systemFreeMB} MB
• 使用率: ${health.memory.usagePercentage}%

🖥️ 系统信息
• 平台: ${system.platform} (${system.arch})
• Node.js: ${system.nodeVersion}
• Electron: ${system.electronVersion}
• CPU 核心: ${system.cpus} 个
• 系统运行: ${Math.round(system.uptime / 3600)} 小时

📋 建议
${health.recommendations.length > 0 
  ? health.recommendations.map(r => `• ${r}`).join('\n')
  : '• 系统运行正常'
}
`;
    
    alert(report);
  } catch (e) {
    console.error('[Renderer] 获取健康报告失败:', e.message);
    alert('获取健康报告失败: ' + e.message);
  }
}

// 优化终端切换
function optimizeTerminalSwitch(id) {
  const startTime = performance.now();
  
  // 预加载终端数据
  const term = terminals.get(id);
  if (term) {
    // 立即切换显示，不等待 requestAnimationFrame
    const wrapper = document.getElementById(`wrapper-${id}`);
    const sessionItem = document.getElementById(`session-${id}`);
    
    if (wrapper) {
      // 隐藏所有其他终端
      terminals.forEach((t, termId) => {
        const w = document.getElementById(`wrapper-${termId}`);
        const s = document.getElementById(`session-${termId}`);
        if (w) w.style.display = 'none';
        if (s) s.classList.remove('active');
      });
      
      // 先显示当前终端（不立即 fit，等浏览器完成布局后再 fit）
      wrapper.style.display = 'block';
      if (sessionItem) sessionItem.classList.add('active');
      
      // 关键修复：用 requestAnimationFrame 确保浏览器完成布局后再 fit
      // 这样可以防止文本漂移和光标错位
      requestAnimationFrame(() => {
        try {
          term.fitAddon.fit();
          const dims = term.fitAddon.proposeDimensions();
          if (dims && dims.cols && dims.rows) {
            ipcRenderer.invoke('resize-terminal', {
              id: term.ptyId,
              cols: dims.cols,
              rows: dims.rows
            });
          }
        } catch (e) {
          console.error('[Renderer] fit 失败:', e.message);
        }
      });
      
      // 聚焦终端
      term.terminal.focus();
    }
  }
}

// 在创建新终端前检查限制
async function checkTerminalLimit() {
  try {
    const health = await ipcRenderer.invoke('health-check');
    
    if (health.terminals.current >= health.terminals.max) {
      const message = `已达到终端数量上限 (${health.terminals.max}个)\n\n` +
                     `当前已打开: ${health.terminals.current} 个终端\n` +
                     `请关闭一些终端后再创建新的。`;
      
      alert(message);
      return false;
    }
    
    if (health.status === 'critical') {
      const message = `系统资源紧张！\n\n` +
                     `内存使用率: ${health.memory.usagePercentage}%\n` +
                     `建议: ${health.recommendations.join(', ')}\n\n` +
                     `是否继续创建终端？`;
      
      if (!confirm(message)) {
        return false;
      }
    }
    
    return true;
  } catch (e) {
    console.error('[Renderer] 检查终端限制失败:', e.message);
    return true; // 出错时允许创建
  }
}

init();

// ========== 快速回复功能 ==========
let quickReplyBtn = null;
let quickReplyPanel = null;
let quickReplyVisible = false;

// 创建悬浮按钮
function createQuickReplyButton() {
  quickReplyBtn = document.createElement('div');
  quickReplyBtn.id = 'quickReplyBtn';
  quickReplyBtn.innerHTML = '💬';
  quickReplyBtn.title = '快速回复 (Ctrl+Shift+R)';
  quickReplyBtn.addEventListener('click', toggleQuickReplyPanel);
  document.body.appendChild(quickReplyBtn);
  console.log('[Renderer] 快速回复按钮已创建');
}

// 切换面板显示
function toggleQuickReplyPanel() {
  if (quickReplyVisible) {
    hideQuickReplyPanel();
  } else {
    showQuickReplyPanel();
  }
}

// 显示面板
function showQuickReplyPanel() {
  blurActiveTerminal();
  if (!quickReplyPanel) {
    createQuickReplyPanel();
  }
  quickReplyPanel.style.display = 'block';
  quickReplyVisible = true;

  // 聚焦搜索框
  focusModalInput('.qr-search-input');
}

// 隐藏面板
function hideQuickReplyPanel() {
  if (quickReplyPanel) {
    quickReplyPanel.style.display = 'none';
    quickReplyVisible = false;
  }
}

// 创建快速回复面板
function createQuickReplyPanel() {
  quickReplyPanel = document.createElement('div');
  quickReplyPanel.id = 'quickReplyPanel';
  quickReplyPanel.className = 'quick-reply-panel';
  quickReplyPanel.innerHTML = `
    <div class="qr-header">
      <div class="qr-search">
        <input type="text" class="qr-search-input" placeholder="🔍 搜索快速回复..." id="qrSearchInput">
      </div>
      <div class="qr-actions">
        <button class="qr-btn" id="qrAddGroupBtn" title="新建分组">📁 新建分组</button>
        <button class="qr-btn" id="qrAddTemplateBtn" title="新建模板">➕ 新建模板</button>
        <button class="qr-close" id="qrCloseBtn">✕</button>
      </div>
    </div>
    <div class="qr-content" id="qrContent">
      <!-- 分组和模板列表 -->
    </div>
  `;
  document.body.appendChild(quickReplyPanel);

  // 绑定事件
  document.getElementById('qrCloseBtn').addEventListener('click', hideQuickReplyPanel);
  document.getElementById('qrAddGroupBtn').addEventListener('click', () => showAddGroupModal());
  document.getElementById('qrAddTemplateBtn').addEventListener('click', () => showAddTemplateModal());
  document.getElementById('qrSearchInput').addEventListener('input', filterTemplates);

  // 点击外部关闭
  quickReplyPanel.addEventListener('click', (e) => {
    if (e.target === quickReplyPanel) {
      hideQuickReplyPanel();
    }
  });

  // 渲染模板列表
  renderQuickReplyList();
  console.log('[Renderer] 快速回复面板已创建');
}

// 渲染模板列表
function renderQuickReplyList(filterText = '') {
  const content = document.getElementById('qrContent');
  if (!content) return;

  const { groups, templates } = quickReplyData;
  const filter = (filterText || '').toLowerCase();

  let html = '';

  // ── 常用模板置顶区 ──
  const favorites = templates
    .filter(t => t.shortcut !== null && t.shortcut !== undefined)
    .sort((a, b) => a.shortcut - b.shortcut);

  html += '<div class="qr-favorites">';
  html += '<div class="qr-favorites-label">🔥 常用模板</div>';
  html += '<div class="qr-favorites-row">';

  for (let i = 1; i <= 6; i++) {
    const fav = favorites.find(t => t.shortcut === i);
    if (fav && (!filter || (fav.name || '').toLowerCase().includes(filter) || (fav.content || '').toLowerCase().includes(filter))) {
      html += `
        <div class="qr-favorite-card" data-template-id="${fav.id}" onclick="useTemplate('${fav.id}')" title="${fav.name}">
          <span class="qr-favorite-shortcut">Ctrl+${i}</span>
          <span class="qr-favorite-icon">${fav.icon || '📝'}</span>
          <span class="qr-favorite-name">${fav.name}</span>
          <span class="qr-favorite-submit ${fav.autoSubmit ? 'auto' : 'manual'}">${fav.autoSubmit ? '↵' : '手'}</span>
        </div>`;
    } else {
      html += `
        <div class="qr-favorite-card qr-favorite-empty">
          <span class="qr-favorite-shortcut">Ctrl+${i}</span>
          <span class="qr-favorite-placeholder">+</span>
        </div>`;
    }
  }

  html += '</div></div>';

  // ── 分组列表 ──
  if (groups.length === 0 && favorites.length === 0) {
    html += `
      <div class="qr-empty">
        <div class="qr-empty-icon">📝</div>
        <div class="qr-empty-text">还没有快速回复模板</div>
        <div class="qr-empty-hint">点击上方按钮创建</div>
      </div>
    `;
    content.innerHTML = html;
    return;
  }

  const filteredGroupsHtml = [];
  groups.sort((a, b) => (a.order || 0) - (b.order || 0)).forEach(group => {
    const groupTemplates = templates
      .filter(t => t.groupId === group.id)
      .filter(t => !filter || (t.name || '').toLowerCase().includes(filter) || (t.content || '').toLowerCase().includes(filter))
      .sort((a, b) => (a.order || 0) - (b.order || 0));

    if (filter && groupTemplates.length === 0) return;

    let groupHtml = `
      <div class="qr-group" data-group-id="${group.id}">
        <div class="qr-group-header" onclick="toggleGroup('${group.id}')">
          <span class="qr-group-icon">${group.icon || '📁'}</span>
          <span class="qr-group-name">${group.name}</span>
          <span class="qr-group-count">${groupTemplates.length}</span>
          <span class="qr-group-toggle">${group.collapsed ? '▶' : '▼'}</span>
        </div>
        <div class="qr-group-templates" style="display: ${group.collapsed ? 'none' : 'block'}">
          ${groupTemplates.map(t => {
            const isFavorite = t.shortcut !== null && t.shortcut !== undefined;
            const shortcutBadge = isFavorite
              ? `<span class="qr-shortcut qr-shortcut-active" title="常用快捷键 Ctrl+${t.shortcut}">⭐</span>`
              : '';
            return `
            <div class="qr-template" data-template-id="${t.id}" onclick="useTemplate('${t.id}')">
              ${shortcutBadge}
              <span class="qr-template-icon">${t.icon || '📝'}</span>
              <div class="qr-template-info">
                <div class="qr-template-name">${t.name}</div>
                <div class="qr-template-preview">${getTemplatePreview(t.content)}</div>
              </div>
              <span class="qr-template-submit ${t.autoSubmit ? 'auto' : 'manual'}">${t.autoSubmit ? '↵' : '手'}</span>
              <div class="qr-template-actions">
                <button class="qr-action-btn" onclick="event.stopPropagation(); editTemplate('${t.id}')" title="编辑">✏️</button>
                <button class="qr-action-btn" onclick="event.stopPropagation(); deleteTemplate('${t.id}')" title="删除">🗑️</button>
              </div>
            </div>`;
          }).join('')}
        </div>
      </div>
    `;
    filteredGroupsHtml.push(groupHtml);
  });

  html += filteredGroupsHtml.join('') || (filter ? `
    <div class="qr-empty">
      <div class="qr-empty-icon">🔍</div>
      <div class="qr-empty-text">没有找到匹配的模板</div>
    </div>
  ` : '');

  content.innerHTML = html;
}

// 获取常用模板列表（按 shortcut 排序）
function getFavoriteTemplates() {
  return quickReplyData.templates
    .filter(t => t.shortcut !== null && t.shortcut !== undefined)
    .sort((a, b) => a.shortcut - b.shortcut);
}

// 获取模板预览文本
function getTemplatePreview(content) {
  if (!content) return '';
  const lines = content.trim().split('\n');
  if (lines.length === 1) {
    return content.length > 30 ? content.substring(0, 30) + '...' : content;
  }
  return `${lines[0]} ... (${lines.length}行)`;
}

// 切换分组展开/折叠
window.toggleGroup = function(groupId) {
  const group = quickReplyData.groups.find(g => g.id === groupId);
  if (group) {
    group.collapsed = !group.collapsed;
    renderQuickReplyList();
  }
};

// 使用模板
window.useTemplate = function(templateId) {
  const template = quickReplyData.templates.find(t => t.id === templateId);
  if (!template) return;

  const term = terminals.get(activeTerminalId);
  if (!term) {
    alert('请先选择一个终端');
    return;
  }

  // 写入内容
  const content = template.content || '';
  ipcRenderer.invoke('write-terminal', { id: term.ptyId, data: content });

  // 如果自动提交，添加回车
  if (template.autoSubmit) {
    setTimeout(() => {
      ipcRenderer.invoke('write-terminal', { id: term.ptyId, data: '\r' });
    }, 50);
  }

  // 隐藏面板
  hideQuickReplyPanel();
  console.log('[Renderer] 使用快速回复模板:', template.name);
};

// 编辑模板
window.editTemplate = function(templateId) {
  const template = quickReplyData.templates.find(t => t.id === templateId);
  if (!template) return;

  showAddTemplateModal(template);
};

// 删除模板
window.deleteTemplate = function(templateId) {
  if (!confirm('确定要删除这个模板吗？')) return;

  quickReplyData.templates = quickReplyData.templates.filter(t => t.id !== templateId);
  ipcRenderer.invoke('save-quick-reply', quickReplyData);
  renderQuickReplyList();
};

// 搜索过滤
function filterTemplates() {
  const searchText = document.getElementById('qrSearchInput')?.value || '';
  renderQuickReplyList(searchText);
}

// 显示新建分组弹窗
function showAddGroupModal(existingGroup = null) {
  const isEdit = !!existingGroup;
  blurActiveTerminal();
  const modal = document.createElement('div');
  modal.className = 'qr-modal-overlay';
  modal.innerHTML = `
    <div class="qr-modal">
      <div class="qr-modal-header">
        <h3>${isEdit ? '编辑分组' : '新建分组'}</h3>
      </div>
      <div class="qr-modal-body">
        <div class="qr-form-group">
          <label>分组名称</label>
          <input type="text" id="qrGroupName" value="${existingGroup?.name || ''}" placeholder="输入分组名称">
        </div>
        <div class="qr-form-group">
          <label>图标</label>
          <input type="text" id="qrGroupIcon" value="${existingGroup?.icon || '📁'}" placeholder="输入图标">
        </div>
      </div>
      <div class="qr-modal-footer">
        <button class="qr-btn" id="qrGroupCancelBtn">取消</button>
        <button class="qr-btn qr-btn-primary" id="qrGroupSaveBtn">保存</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  focusModalInput('#qrGroupName', modal);

  document.getElementById('qrGroupCancelBtn').addEventListener('click', () => modal.remove());
  document.getElementById('qrGroupSaveBtn').addEventListener('click', () => {
    const name = document.getElementById('qrGroupName').value.trim();
    const icon = document.getElementById('qrGroupIcon').value.trim() || '📁';
    if (!name) {
      alert('请输入分组名称');
      return;
    }
    if (isEdit) {
      const group = quickReplyData.groups.find(g => g.id === existingGroup.id);
      if (group) {
        group.name = name;
        group.icon = icon;
      }
    } else {
      quickReplyData.groups.push({
        id: 'grp-' + Date.now(),
        name,
        icon,
        collapsed: false,
        order: quickReplyData.groups.length + 1
      });
    }
    ipcRenderer.invoke('save-quick-reply', quickReplyData);
    renderQuickReplyList();
    modal.remove();
  });
}

// 显示新建模板弹窗
function showAddTemplateModal(existingTemplate = null) {
  const isEdit = !!existingTemplate;
  const groups = quickReplyData.groups;
  blurActiveTerminal();

  const modal = document.createElement('div');
  modal.className = 'qr-modal-overlay';
  modal.innerHTML = `
    <div class="qr-modal qr-modal-large">
      <div class="qr-modal-header">
        <h3>${isEdit ? '编辑模板' : '新建模板'}</h3>
      </div>
      <div class="qr-modal-body">
        <div class="qr-form-row">
          <div class="qr-form-group">
            <label>模板名称</label>
            <input type="text" id="qrTemplateName" value="${existingTemplate?.name || ''}" placeholder="输入模板名称">
          </div>
          <div class="qr-form-group" style="width: 80px;">
            <label>图标</label>
            <input type="text" id="qrTemplateIcon" value="${existingTemplate?.icon || '📝'}" placeholder="图标">
          </div>
        </div>
        <div class="qr-form-group">
          <label>所属分组</label>
          <select id="qrTemplateGroup">
            ${groups.map(g => `<option value="${g.id}" ${existingTemplate?.groupId === g.id ? 'selected' : ''}>${g.icon} ${g.name}</option>`).join('')}
          </select>
        </div>
        <div class="qr-form-group">
          <label>内容（支持多行脚本）</label>
          <textarea id="qrTemplateContent" rows="5" placeholder="输入要发送的内容，多行会按行发送">${existingTemplate?.content || ''}</textarea>
        </div>
        <div class="qr-form-row">
          <div class="qr-form-group">
            <label>常用快捷键</label>
            <select id="qrTemplateShortcut">
              <option value="">无</option>
              ${[1,2,3,4,5,6].map(n => `<option value="${n}" ${existingTemplate?.shortcut === n ? 'selected' : ''}>Ctrl+${n}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="qr-form-group">
          <label class="qr-checkbox-label">
            <input type="checkbox" id="qrTemplateAutoSubmit" ${existingTemplate?.autoSubmit !== false ? 'checked' : ''}>
            <span>自动回车确认（发送后自动按回车）</span>
          </label>
        </div>
      </div>
      <div class="qr-modal-footer">
        <button class="qr-btn" id="qrTemplateCancelBtn">取消</button>
        <button class="qr-btn qr-btn-primary" id="qrTemplateSaveBtn">保存</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  focusModalInput('#qrTemplateName', modal);

  document.getElementById('qrTemplateCancelBtn').addEventListener('click', () => modal.remove());
  document.getElementById('qrTemplateSaveBtn').addEventListener('click', () => {
    const name = document.getElementById('qrTemplateName').value.trim();
    const icon = document.getElementById('qrTemplateIcon').value.trim() || '📝';
    const groupId = document.getElementById('qrTemplateGroup').value;
    const content = document.getElementById('qrTemplateContent').value;
    const autoSubmit = document.getElementById('qrTemplateAutoSubmit').checked;
    const shortcutVal = document.getElementById('qrTemplateShortcut').value;
    const shortcutNum = shortcutVal ? parseInt(shortcutVal) : null;

    if (!name) {
      alert('请输入模板名称');
      return;
    }
    if (!content) {
      alert('请输入模板内容');
      return;
    }

    // 快捷键冲突处理：如果被其他模板占用，直接覆盖
    if (shortcutNum) {
      const conflictId = isEdit ? existingTemplate.id : null;
      const conflicted = quickReplyData.templates.find(t => t.id !== conflictId && t.shortcut === shortcutNum);
      if (conflicted) {
        conflicted.shortcut = null;
      }
    }

    if (isEdit) {
      const template = quickReplyData.templates.find(t => t.id === existingTemplate.id);
      if (template) {
        template.name = name;
        template.icon = icon;
        template.groupId = groupId;
        template.content = content;
        template.autoSubmit = autoSubmit;
        template.shortcut = shortcutNum;
      }
    } else {
      const groupTemplates = quickReplyData.templates.filter(t => t.groupId === groupId);
      quickReplyData.templates.push({
        id: 'qr-' + Date.now(),
        name,
        icon,
        groupId,
        content,
        autoSubmit,
        shortcut: null,
        order: groupTemplates.length + 1
      });
    }

    ipcRenderer.invoke('save-quick-reply', quickReplyData);
    renderQuickReplyList();
    modal.remove();
  });
}

// 显示新建模板弹窗（预填充内容）
function showAddTemplateModalWithContent(content) {
  const groups = quickReplyData.groups;

  // 如果没有分组，先创建默认分组
  if (groups.length === 0) {
    groups.push({
      id: 'grp-default',
      name: '默认分组',
      icon: '📁',
      collapsed: false,
      order: 1
    });
    ipcRenderer.invoke('save-quick-reply', quickReplyData);
  }

  const modal = document.createElement('div');
  blurActiveTerminal();
  modal.className = 'qr-modal-overlay';
  modal.innerHTML = `
    <div class="qr-modal qr-modal-large">
      <div class="qr-modal-header">
        <h3>添加到快速回复</h3>
      </div>
      <div class="qr-modal-body">
        <div class="qr-form-row">
          <div class="qr-form-group">
            <label>模板名称</label>
            <input type="text" id="qrTemplateName" placeholder="输入模板名称" value="${content.substring(0, 20)}">
          </div>
          <div class="qr-form-group" style="width: 80px;">
            <label>图标</label>
            <input type="text" id="qrTemplateIcon" value="📝" placeholder="图标">
          </div>
        </div>
        <div class="qr-form-group">
          <label>所属分组</label>
          <select id="qrTemplateGroup">
            ${groups.map(g => `<option value="${g.id}">${g.icon} ${g.name}</option>`).join('')}
          </select>
        </div>
        <div class="qr-form-group">
          <label>内容（支持多行脚本）</label>
          <textarea id="qrTemplateContent" rows="5" placeholder="输入要发送的内容">${content.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</textarea>
        </div>
        <div class="qr-form-row">
          <div class="qr-form-group">
            <label>常用快捷键</label>
            <select id="qrTemplateShortcut">
              <option value="">无</option>
              ${[1,2,3,4,5,6].map(n => `<option value="${n}">Ctrl+${n}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="qr-form-group">
          <label class="qr-checkbox-label">
            <input type="checkbox" id="qrTemplateAutoSubmit" checked>
            <span>自动回车确认（发送后自动按回车）</span>
          </label>
        </div>
      </div>
      <div class="qr-modal-footer">
        <button class="qr-btn" id="qrTemplateCancelBtn">取消</button>
        <button class="qr-btn qr-btn-primary" id="qrTemplateSaveBtn">保存</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  focusModalInput('#qrTemplateName', modal);

  document.getElementById('qrTemplateCancelBtn').addEventListener('click', () => modal.remove());
  document.getElementById('qrTemplateSaveBtn').addEventListener('click', () => {
    const name = document.getElementById('qrTemplateName').value.trim();
    const icon = document.getElementById('qrTemplateIcon').value.trim() || '📝';
    const groupId = document.getElementById('qrTemplateGroup').value;
    const templateContent = document.getElementById('qrTemplateContent').value;
    const autoSubmit = document.getElementById('qrTemplateAutoSubmit').checked;
    const shortcutVal = document.getElementById('qrTemplateShortcut').value;
    const shortcutNum = shortcutVal ? parseInt(shortcutVal) : null;

    if (!name) {
      alert('请输入模板名称');
      return;
    }
    if (!templateContent) {
      alert('请输入模板内容');
      return;
    }

    // 快捷键冲突处理：如果被其他模板占用，直接覆盖
    if (shortcutNum) {
      const conflicted = quickReplyData.templates.find(t => t.shortcut === shortcutNum);
      if (conflicted) {
        conflicted.shortcut = null;
      }
    }

    const groupTemplates = quickReplyData.templates.filter(t => t.groupId === groupId);
    quickReplyData.templates.push({
      id: 'qr-' + Date.now(),
      name,
      icon,
      groupId,
      content: templateContent,
      autoSubmit,
      shortcut: shortcutNum,
      order: groupTemplates.length + 1
    });

    ipcRenderer.invoke('save-quick-reply', quickReplyData);
    renderQuickReplyList();
    modal.remove();

    // 提示用户
    console.log('[Renderer] 已添加到快速回复:', name);
  });
}

// 注册全局快捷键
document.addEventListener('keydown', (e) => {
  // Ctrl+Shift+R 切换快速回复面板
  if (e.ctrlKey && e.shiftKey && e.key === 'R') {
    e.preventDefault();
    toggleQuickReplyPanel();
  }
  // Escape 关闭面板
  if (e.key === 'Escape' && quickReplyVisible) {
    hideQuickReplyPanel();
  }
  // Ctrl+1~6 直接发送常用模板
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key >= '1' && e.key <= '6') {
    const shortcutNum = parseInt(e.key);
    const template = quickReplyData.templates.find(t => t.shortcut === shortcutNum);
    if (template) {
      e.preventDefault();
      window.useTemplate(template.id);
    }
  }
});

// 创建悬浮按钮
createQuickReplyButton();

