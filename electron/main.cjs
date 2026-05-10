const { app, BrowserWindow, dialog, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const isDev = !app.isPackaged;
const backendPort = process.env.CENSUS_NOTEBOOK_API_PORT || "8000";
let backendProcess;

function getBackendCommand() {
  if (isDev) {
    return {
      command: path.join(__dirname, "..", "backend", ".venv", "bin", "python"),
      args: ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", backendPort],
      cwd: path.join(__dirname, "..", "backend"),
    };
  }

  const binaryName = process.platform === "win32" ? "census-notebook-api.exe" : "census-notebook-api";
  const command = path.join(process.resourcesPath, "backend", "census-notebook-api", binaryName);
  return {
    command,
    args: [],
    cwd: path.dirname(command),
  };
}

function waitForBackend(retries = 80) {
  return new Promise((resolve, reject) => {
    const check = (attempt) => {
      const request = http.get(`http://127.0.0.1:${backendPort}/health`, (response) => {
        response.resume();
        if (response.statusCode === 200) {
          resolve();
          return;
        }

        retry(attempt);
      });

      request.on("error", () => retry(attempt));
      request.setTimeout(1000, () => {
        request.destroy();
        retry(attempt);
      });
    };

    const retry = (attempt) => {
      if (attempt >= retries) {
        reject(new Error("Census Notebook API did not start."));
        return;
      }

      setTimeout(() => check(attempt + 1), 250);
    };

    check(0);
  });
}

async function startBackend() {
  if (backendProcess) return;

  const userDataDir = app.getPath("userData");
  const uploadDir = path.join(userDataDir, "uploads");
  fs.mkdirSync(uploadDir, { recursive: true });

  const { command, args, cwd } = getBackendCommand();
  if (!fs.existsSync(command)) {
    if (!isDev) return;
    throw new Error(`Census Notebook API was not found at ${command}.`);
  }

  backendProcess = spawn(command, args, {
    cwd,
    env: {
      ...process.env,
      CENSUS_NOTEBOOK_API_PORT: backendPort,
      CENSUS_NOTEBOOK_DATA_DIR: userDataDir,
      CENSUS_NOTEBOOK_UPLOAD_DIR: uploadDir,
      DATABASE_URL: `sqlite:///${path.join(userDataDir, "census_notebook.db")}`,
    },
    stdio: isDev ? "inherit" : "ignore",
  });

  backendProcess.on("exit", () => {
    backendProcess = undefined;
  });

  await waitForBackend();
}

async function createMainWindow() {
  try {
    await startBackend();
  } catch (error) {
    dialog.showErrorBox(
      "Census Notebook could not start",
      error instanceof Error ? error.message : "The local API could not be started."
    );
    app.quit();
    return;
  }

  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 960,
    minHeight: 700,
    title: "Census Notebook",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:|^mailto:/.test(url)) {
      shell.openExternal(url);
      return { action: "deny" };
    }

    return { action: "allow" };
  });

  if (isDev) {
    mainWindow.loadURL("http://127.0.0.1:5173");
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

app.whenReady().then(() => {
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("before-quit", () => {
  if (backendProcess) {
    backendProcess.kill();
    backendProcess = undefined;
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
