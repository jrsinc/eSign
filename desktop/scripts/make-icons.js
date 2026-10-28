// Builds the app icons from the Method 365 mark (public/brand/method365-mark.svg).
// Run with: npm run icons (inside desktop/). Writes icons for the desktop app (build/) and for the
// installable web app (../public/icons/).
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const mark = fs.readFileSync(path.join(root, 'public', 'brand', 'method365-mark.svg')).toString('base64');
const INK = '#1B2350';

const outputs = [
  // [file, size, padding fraction, full-bleed ink background (for masked icons)]
  [path.join(__dirname, '..', 'build', 'icon.png'), 512, 0, false],
  [path.join(__dirname, '..', 'build', 'tray.png'), 32, 0, false],
  [path.join(root, 'public', 'icons', 'icon-192.png'), 192, 0, false],
  [path.join(root, 'public', 'icons', 'icon-512.png'), 512, 0, false],
  [path.join(root, 'public', 'icons', 'maskable-512.png'), 512, 0.12, true], // safe zone for Android/Windows masks
  [path.join(root, 'public', 'icons', 'favicon-32.png'), 32, 0, false],
];

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<canvas></canvas>');
  for (const [file, size, pad, bleed] of outputs) {
    const dataUrl = await win.webContents.executeJavaScript(`(async () => {
      const img = new Image();
      img.src = 'data:image/svg+xml;base64,${mark}';
      await img.decode();
      const c = document.createElement('canvas');
      c.width = c.height = ${size};
      const x = c.getContext('2d');
      if (${bleed}) { x.fillStyle = '${INK}'; x.fillRect(0, 0, ${size}, ${size}); }
      const inner = ${size} * (1 - 2 * ${pad});
      x.imageSmoothingQuality = 'high';
      x.drawImage(img, (${size} - inner) / 2, (${size} - inner) / 2, inner, inner);
      return c.toDataURL('image/png');
    })()`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log(`wrote ${path.relative(root, file)} (${size}x${size})`);
  }
  app.quit();
});
