#!/usr/bin/env node
// 用 Electron 把 tools/social-preview.html 渲染成 1280x640 的 PNG。
import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow } from "electron";

app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.disableHardwareAcceleration();

const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, "docs", "images", "social-preview.png");

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 640,
    useContentSize: true,
    frame: false,
    show: false,
    backgroundColor: "#0c0f14",
    webPreferences: { offscreen: false, sandbox: true },
  });
  await win.loadFile(path.join(import.meta.dirname, "social-preview.html"));
  await new Promise((resolve) => setTimeout(resolve, 600));
  const image = await win.webContents.capturePage();
  fs.writeFileSync(out, image.toPNG());
  console.log(`${path.relative(root, out)} ${image.getSize().width}x${image.getSize().height}`);
  win.destroy();
  app.quit();
});
