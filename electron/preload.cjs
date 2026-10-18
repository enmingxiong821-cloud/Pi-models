const { contextBridge, ipcRenderer } = require("electron");

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld("pmh", {
  init: () => invoke("pmh:init"),
  list: (params) => invoke("pmh:list", params),
  switchModel: (params) => invoke("pmh:switch", params),
  favorite: (params) => invoke("pmh:favorite", params),
  refresh: (params) => invoke("pmh:refresh", params),
  openAgentDir: () => invoke("pmh:open-agent-dir"),
  providers: () => invoke("pmh:providers"),
  providerGet: (params) => invoke("pmh:provider-get", params),
  providerSave: (params) => invoke("pmh:provider-save", params),
  providerDelete: (params) => invoke("pmh:provider-delete", params),
  keySet: (params) => invoke("pmh:key-set", params),
  keyClear: (params) => invoke("pmh:key-clear", params),
  modelSave: (params) => invoke("pmh:model-save", params),
  modelDelete: (params) => invoke("pmh:model-delete", params),
  thinkingGet: (params) => invoke("pmh:thinking-get", params),
  thinkingSet: (params) => invoke("pmh:thinking-set", params),
  autoGet: () => invoke("pmh:auto-get"),
  autoSet: (params) => invoke("pmh:auto-set", params),
  autoPreview: (params) => invoke("pmh:auto-preview", params),
  usage: (params) => invoke("pmh:usage", params),
});
