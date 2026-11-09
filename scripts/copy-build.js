const fs = require("fs");
const path = require("path");

const src = path.resolve(__dirname, "../excalidraw-app/build");
const dest = path.resolve(__dirname, "../build");

if (fs.existsSync(src)) {
  fs.cpSync(src, dest, { recursive: true, force: true });
  console.log("Successfully copied excalidraw-app/build to ./build");
} else {
  console.warn("Warning: excalidraw-app/build does not exist to copy.");
}
