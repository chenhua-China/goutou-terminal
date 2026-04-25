# 🐕 Doghead Terminal Workspace

> A powerful terminal workspace built with Electron + xterm.js + node-pty. Manage multiple terminal sessions with aliases, templates, and auto-restore.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Electron](https://img.shields.io/badge/Electron-41.2.1-blue.svg)](https://electronjs.org)
[![xterm.js](https://img.shields.io/badge/xterm.js-5.3.0-green.svg)](https://xtermjs.org)
[![node-pty](https://img.shields.io/badge/node--pty-1.1.0-orange.svg)](https://github.com/microsoft/node-pty)

## ✨ Features

- 📋 **Session Management** - Left sidebar with session list, right side terminal display
- ✏️ **Session Aliases** - Right-click to rename sessions with custom aliases
- 🔄 **Auto-Restore** - Automatically restores previous sessions on startup (with prompts)
- ⚡ **Templates** - Create custom templates with shell, working directory, and startup scripts
- 📝 **Alias Display** - Shows alias (original name) 📁 directory in top bar
- 🖥️ **Live Status** - Real-time terminal count indicator in the top bar
- 🎨 **Dark Theme** - VS Code-inspired dark theme
- ⌨️ **Keyboard Shortcuts** - `Ctrl+T` new terminal, `Ctrl+W` close, `Ctrl+Shift+C/V` copy/paste
- 📋 **Right-Click Menu** - Copy, paste, select all, and edit alias
- 💾 **Session Persistence** - Sessions saved and restored across app restarts
- 🛡️ **Health Monitoring** - Terminal count, memory usage, and health status

## 🚀 Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- npm or yarn

### Install & Run

```bash
git clone https://github.com/YOUR_USERNAME/doghead-terminal-workspace.git
cd doghead-terminal-workspace
npm install
npm start
```

### Build Installer

```bash
npm run build:win
```

The installer will be generated in `dist/` directory.

## 📖 Usage

### Creating Terminals

1. Click **➕ New Session** button or press `Ctrl+T`
2. Choose a quick launch shell (PowerShell, CMD, Git Bash) or click a template
3. Terminal opens in the right panel

### Managing Sessions

| Action | How |
|--------|-----|
| Switch session | Click session item in left sidebar |
| Edit alias | Right-click → ✏️ Edit Alias |
| Close session | Click × button or right-click → 🗑️ Close |
| Restore sessions | Restart the app - it will prompt to restore |

### Creating Templates

1. Click **➕ Create Template** in the new session dialog
2. Fill in: name, icon, shell, working directory, startup script
3. Save and use the template to create terminals with one click

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+T` | New terminal |
| `Ctrl+W` | Close current terminal |
| `Ctrl+Shift+S` | Save current session |
| `Ctrl+Shift+C` | Copy selected text |
| `Ctrl+Shift+V` | Paste text |
| `F5` | Refresh terminal input |

## 📁 Project Structure

```
terminal-workspace/
├── main.js              # Electron main process (PTY management)
├── renderer.js          # Frontend logic (UI, terminal management)
├── index.html           # Main HTML structure
├── styles.css           # VS Code-inspired dark theme
├── package.json         # Project configuration
└── templates.json       # Default terminal templates
```

## 🔧 Technical Details

### Architecture

- **Main Process** (`main.js`): Manages PTY processes, IPC communication, session persistence
- **Renderer Process** (`renderer.js`): xterm.js terminal rendering, UI management, session restore
- **Communication**: IPC channels for terminal create/write/resize/close operations

### Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| electron | 41.2.1 | Desktop app framework |
| xterm | 5.3.0 | Terminal emulator |
| xterm-addon-fit | 0.8.0 | Auto-fit terminal to container |
| xterm-addon-web-links | 0.9.0 | Clickable links in terminal |
| node-pty | 1.1.0 | Native PTY for Windows |
| electron-builder | 24.13.3 | Packaging and distribution |

### Session Storage

Sessions are stored in the Electron user data directory:
- **Windows**: `%APPDATA%/doghead.terminal/session.json`

## 🖼️ Screenshots

```
┌─────────────────────────────────────────────────────────────┐
│ 📋 Session List          │ 🖥️ 4/10                         │
├───────────────────────────┤                                 │
│ 🔧 Git Bash 1            │ Git Bash (Git Bash) 📁 D:\proj  │
│ 💻 PowerShell 1          │                                 │
│ 📟 CMD 1                 │ PS C:\Users\user> _             │
│ 🚀 My Project            │                                 │
│                           │                                 │
│ [+ New Session]          │                                 │
└───────────────────────────┴─────────────────────────────────┘
```

## 📝 License

MIT License - see [LICENSE](LICENSE) for details.

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 🐛 Issues

Found a bug? Have a feature request? [Open an issue](https://github.com/YOUR_USERNAME/doghead-terminal-workspace/issues)

---

*🐕 Doghead Agent Squad - Professional, Efficient, Reliable, with a touch of humor*
