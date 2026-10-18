import { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, shell } from "electron";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeContext } from "../src/commands.mjs";
import { createSession, safeError } from "../src/desktop-service.mjs";
import { registerHandlers } from "./ipc.mjs";

const preloadPath = fileURLToPath(new URL("./preload.cjs", import.meta.url));
const indexPath = fileURLToPath(new URL("./renderer/index.html", import.meta.url));
const indexUrl = pathToFileURL(indexPath).href;

let mainWindow = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 980,
    height: 700,
    minWidth: 720,
    minHeight: 480,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#14171c" : "#f6f7f9",
    title: "pmh",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  win.once("ready-to-show", () => win.show());
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    if (url !== indexUrl) event.preventDefault();
  });
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());
  if (app.isPackaged) {
    win.webContents.on("devtools-opened", () => win.webContents.closeDevTools());
  }

  win.loadFile(indexPath);
  if (!app.isPackaged && process.env.PMH_DEVTOOLS === "1") {
    win.webContents.openDevTools({ mode: "detach" });
  }
  return win;
}

async function start() {
  nativeTheme.themeSource = "system";
  app.setAppUserModelId("com.enmingxiong821.pmh");
  if (process.platform !== "darwin") Menu.setApplicationMenu(null);

  let session;
  try {
    session = createSession(makeContext({}));
  } catch (err) {
    dialog.showErrorBox("pmh 无法读取配置", safeError(err));
    app.quit();
    return;
  }

  registerHandlers({
    ipcMain,
    session,
    shell,
    isTrustedEvent: (event) => Boolean(mainWindow) && event.sender === mainWindow.webContents,
  });

  mainWindow = createWindow();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });

  app.whenReady().then(start).catch((err) => {
    dialog.showErrorBox("pmh 无法启动", safeError(err));
    app.quit();
  });
}
