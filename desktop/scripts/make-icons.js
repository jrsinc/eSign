// Builds square app icons from the company logo (public/logo.png): the round emblem on the left of the
// logo, centred on white. Run with: npm run icons (inside desktop/). Writes icons for the desktop app
// (build/) and for the installable web app (../public/icons/).
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const logo = fs.readFileSync(path.join(root, 'public', 'logo.png')).toString('base64');

const outputs = [
  // [file, size, padding fraction, rounded corners]
  [path.join(__dirname, '..', 'build', 'icon.png'), 512, 0.08, true],
  [path.join(__dirname, '..', 'build', 'tray.png'), 32, 0.02, false],
  [path.join(root, 'public', 'icons', 'icon-192.png'), 192, 0.08, true],
  [path.join(root, 'public', 'icons', 'icon-512.png'), 512, 0.08, true],
  [path.join(root, 'public', 'icons', 'maskable-512.png'), 512, 0.2, false], // safe zone for Android/Windows masks
  [path.join(root, 'public', 'icons', 'favicon-32.png'), 32, 0.02, false],
];

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<canvas></canvas>');
  for (const [file, size, pad, rounded] of outputs) {
    const dataUrl = await win.webContents.executeJavaScript(`(async () => {
      const img = new Image();
      img.src = 'data:image/png;base64,${logo}';
      await img.decode();
      const c = document.createElement('canvas');
      c.width = c.height = ${size};
      const x = c.getContext('2d');
      x.fillStyle = '#ffffff';
      if (${rounded}) { x.beginPath(); x.roundRect(0, 0, ${size}, ${size}, ${size} * 0.18); x.fill(); } else x.fillRect(0, 0, ${size}, ${size});
      // The emblem is the square at the left of the logo (as tall as the image).
      const s = img.height;
      const inner = ${size} * (1 - 2 * ${pad});
      x.imageSmoothingQuality = 'high';
      x.drawImage(img, 0, 0, s, s, (${size} - inner) / 2, (${size} - inner) / 2, inner, inner);
      return c.toDataURL('image/png');
    })()`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log(`wrote ${path.relative(root, file)} (${size}x${size})`);
  }
  app.quit();
});
