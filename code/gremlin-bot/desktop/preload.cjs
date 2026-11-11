// The only bridge between the app's window and the rest of the PC: a short list
// of functions (start, stop, settings, files, usage, logs). The window itself
// can't touch files or run programs.

const { contextBridge, ipcRenderer } = require('electron');

const invoke =
  (channel) =>
  (...args) =>
    ipcRenderer.invoke(channel, ...args);

const listen = (channel) => (callback) => {
  const fn = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
};

contextBridge.exposeInMainWorld('winslow', {
  bot: {
    get: invoke('bot:get'),
    start: invoke('bot:start'),
    stop: invoke('bot:stop'),
    restart: invoke('bot:restart'),
    onState: listen('bot:state'),
    onLine: listen('bot:line'),
  },
  settings: { get: invoke('settings:get'), save: invoke('settings:save') },
  files: { get: invoke('files:get'), save: invoke('files:save') },
  calls: { get: invoke('calls:get'), forget: invoke('calls:forget'), jokes: invoke('calls:jokes') },
  usage: { get: invoke('usage:get'), credits: invoke('usage:credits') },
  logs: { get: invoke('logs:get') },
  whisper: { health: invoke('whisper:health'), stop: invoke('whisper:stop'), setup: invoke('whisper:setup') },
  app: {
    info: invoke('app:info'),
    openExternal: invoke('app:open-external'),
    copy: invoke('app:copy'),
    setUnsaved: invoke('app:unsaved'),
    updateState: invoke('app:update-state'),
    onUpdate: listen('app:update'),
  },
});
