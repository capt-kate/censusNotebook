const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
const cacheDir = path.join(rootDir, ".pyinstaller-cache");
const python = path.join(rootDir, "backend", ".venv", "bin", "python");

fs.mkdirSync(cacheDir, { recursive: true });

const result = spawnSync(
  python,
  [
    "-m",
    "PyInstaller",
    "--clean",
    "--noconfirm",
    "--name",
    "census-notebook-api",
    "--paths",
    "backend",
    "--distpath",
    "backend/dist",
    "--workpath",
    "backend/build",
    "--specpath",
    "backend/build",
    "backend/desktop_server.py",
  ],
  {
    cwd: rootDir,
    env: {
      ...process.env,
      PYINSTALLER_CONFIG_DIR: cacheDir,
    },
    stdio: "inherit",
  }
);

process.exit(result.status ?? 1);
