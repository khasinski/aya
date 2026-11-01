import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('artifactPreview', {
  suggest: (text: unknown) => { if (typeof text === 'string' && text.trim() && text.length <= 4000) ipcRenderer.send('artifact-preview:suggest', text); },
});
