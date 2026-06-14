# 窗口透明度设置

## 概述

为狗头终端添加窗口透明度调节功能，类似 Windows CMD 的透明度设置。用户可通过 cwd-bar 上的控件调节整个窗口的透明度（30%~100%），设置在会话间持久化。

## 技术方案

使用 Electron 原生 `BrowserWindow.setOpacity(value)` API 实现窗口级透明度。该 API 在 Windows 上原生支持，macOS/Linux 降级为不生效。

## UI 设计

### 控件位置

cwd-bar 右侧新增一个透明度图标按钮（🌫️），位于 cwd-copy-btn 右侧。

### 弹出面板

点击图标按钮后，在按钮下方弹出浮动小面板：

- 面板宽度：220px
- 面板内容：水平滑块（range 30%~100%）+ 右侧百分比值显示
- 面板样式：深色背景 #252526，1px solid #3c3c3c 边框，border-radius: 6px，box-shadow
- 交互：拖动滑块实时更新窗口透明度；点击面板外部关闭面板
- 面板定位：fixed 定位，相对于图标按钮的位置计算

### 默认值

- 透明度默认值：100%（完全不透明）
- 滑块步进：1%

## 数据流

1. **设置透明度**：renderer 调用 `ipcRenderer.invoke('set-opacity', value)` → main 进程调用 `mainWindow.setOpacity(value)`
2. **获取透明度**：renderer 启动时通过 `ipcRenderer.invoke('get-opacity')` 从 main 获取上次的值
3. **保存透明度**：值变化时（滑块 change 事件）通过 `ipcRenderer.invoke('save-opacity', value)` 保存到 settings.json
4. **应用透明度**：main 进程启动时读取 settings.json 中的值，在 createWindow 后应用

## 持久化

新增 `settings.json`，存放在 `app.getPath('userData')` 目录：

```json
{
  "opacity": 0.85
}
```

存储值为 0.3~1.0 的浮点数。UI 显示为百分比（30%~100%）。

每次滑块值变化时即时保存（防抖 300ms），窗口关闭时无需特殊处理。

## IPC 接口

| 接口 | 方向 | 参数 | 返回值 | 说明 |
|------|------|------|--------|------|
| `get-opacity` | renderer → main | 无 | `{ opacity: number }` | 获取保存的透明度值 |
| `set-opacity` | renderer → main | `opacity: number` | `{ success: boolean }` | 设置窗口透明度 |
| `save-opacity` | renderer → main | `opacity: number` | `{ success: boolean }` | 保存透明度到 settings.json |

## 跨平台处理

- Windows：`setOpacity()` 原生支持，完整功能
- macOS/Linux：`setOpacity()` 可能不支持或行为不同，降级为不生效。滑块仍可操作但窗口透明度不变

## 修改文件清单

1. **main.js**：添加 SETTINGS_FILE 路径、settings 读写函数、3 个 IPC handler、启动时应用透明度
2. **renderer.js**：在 cwd-bar 渲染透明度按钮和弹出面板、滑块交互逻辑、IPC 调用
3. **index.html**：无需修改（面板由 JS 动态创建）
4. **styles.css**：添加透明度面板样式
