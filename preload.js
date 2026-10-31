'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * 渲染进程唯一可用的桥接 API。
 * 所有文件读写、导出、打开目录都经过主进程校验。
 */
contextBridge.exposeInMainWorld('electronAPI', {
    loadData: () => ipcRenderer.invoke('data:load'),
    saveData: (data) => ipcRenderer.invoke('data:save', data),
    saveDataSync: (data) => ipcRenderer.sendSync('data:save-sync', data),
    loadWords: () => ipcRenderer.invoke('words:load'),
    loadConfig: () => ipcRenderer.invoke('config:load'),
    getAppInfo: () => ipcRenderer.invoke('app:info'),
    exportDocument: (payload) => ipcRenderer.invoke('export:document', payload),
    exportBackup: () => ipcRenderer.invoke('data:export-backup'),
    importBackup: () => ipcRenderer.invoke('data:import-backup'),
    openDataFolder: () => ipcRenderer.invoke('shell:open-data'),
    showItemInFolder: (filePath) => ipcRenderer.invoke('shell:show-item', filePath),
    openExternal: (url) => ipcRenderer.invoke('shell:open-external', url)
});
