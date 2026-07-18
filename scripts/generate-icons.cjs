const { createHash } = require('node:crypto');
const { mkdir, readFile, writeFile } = require('node:fs/promises');
const { dirname, join, relative, resolve, sep } = require('node:path');
const { deflateSync } = require('node:zlib');

const { app, BrowserWindow } = require('electron');

const workspaceRoot = resolve(__dirname, '..');
const sourcePath = join(workspaceRoot, 'assets', 'brand', 'novus-atelier-icon.svg');
const generatedRoot = join(workspaceRoot, 'assets', 'brand', 'generated');
const manifestPath = join(generatedRoot, 'novus-atelier-icon-manifest.json');
const previewPath = join(workspaceRoot, 'assets', 'brand', 'novus-atelier-icon.png');
const shellIconPaths = [
  join(workspaceRoot, 'apps', 'desktop-modern', 'build', 'icon.ico'),
  join(workspaceRoot, 'apps', 'desktop-legacy', 'build', 'icon.ico'),
];
const pngSizes = [16, 24, 32, 48, 64, 128, 256, 512];
const icoSizes = pngSizes.filter((size) => size <= 256);

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('force-color-profile', 'srgb');
app.on('window-all-closed', () => undefined);

app.whenReady()
  .then(generateIcons)
  .then(() => {
    console.log(`Generated Novus icon assets from ${sourcePath}`);
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });

async function generateIcons() {
  console.log('Reading Novus SVG source');
  const svgBuffer = await readFile(sourcePath);
  const svgSource = svgBuffer.toString('utf8');
  console.log('Rasterizing Novus SVG source');
  const raster = await renderSvg(svgSource);
  const svgImage = raster.image;
  console.log('Writing Novus raster assets');

  try {
    await mkdir(generatedRoot, { recursive: true });
    for (const iconPath of shellIconPaths) await mkdir(dirname(iconPath), { recursive: true });

    const pngBySize = new Map();
    const outputEntries = [];
    for (const size of pngSizes) {
      const png = nativeImageToPng(svgImage.resize({ height: size, quality: 'best', width: size }), size);
      if (png.length === 0) throw new Error(`Electron returned an empty ${size}px PNG`);
      pngBySize.set(size, png);
      const pngPath = join(generatedRoot, `novus-atelier-${size}.png`);
      await writeFile(pngPath, png);
      outputEntries.push(createBinaryHashEntry(pngPath, png));
    }

    const previewPng = requirePng(pngBySize, 512);
    await writeFile(previewPath, previewPng);
    outputEntries.push(createBinaryHashEntry(previewPath, previewPng));
    const ico = createPngBackedIco(icoSizes.map((size) => ({
      png: requirePng(pngBySize, size),
      size,
    })));
    for (const iconPath of shellIconPaths) {
      await writeFile(iconPath, ico);
      outputEntries.push(createBinaryHashEntry(iconPath, ico));
    }

    const generatorSource = await readFile(__filename, 'utf8');
    const manifest = {
      schemaVersion: 1,
      source: createTextHashEntry(sourcePath, svgSource),
      generator: createTextHashEntry(__filename, generatorSource),
      outputs: outputEntries,
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  } finally {
    raster.window.destroy();
  }
}

function createBinaryHashEntry(path, buffer) {
  return {
    path: toManifestPath(path),
    sha256: createHash('sha256').update(buffer).digest('hex'),
  };
}

function createTextHashEntry(path, source) {
  return createBinaryHashEntry(path, Buffer.from(source.replace(/\r\n/g, '\n'), 'utf8'));
}

function toManifestPath(path) {
  return relative(workspaceRoot, path).split(sep).join('/');
}

async function renderSvg(svgSource) {
  const size = 512;
  const window = new BrowserWindow({
    backgroundColor: '#00000000',
    frame: false,
    height: size,
    resizable: false,
    show: false,
    transparent: true,
    useContentSize: true,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: true,
      sandbox: true,
    },
    width: size,
  });

  try {
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;width:${size}px;height:${size}px;overflow:hidden;background:transparent}
      svg{display:block;width:${size}px;height:${size}px}
    </style></head><body>${svgSource}</body></html>`;
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    const image = await window.webContents.capturePage({ height: size, width: size, x: 0, y: 0 });
    if (image.isEmpty()) throw new Error('Electron could not rasterize the Novus SVG source');
    return { image: image.resize({ height: size, quality: 'best', width: size }), window };
  } catch (error) {
    window.destroy();
    throw error;
  }
}

function nativeImageToPng(image, size) {
  const bitmap = image.toBitmap();
  const expectedLength = size * size * 4;
  if (bitmap.length !== expectedLength) {
    throw new Error(`Unexpected ${size}px bitmap length: ${bitmap.length}`);
  }

  const scanlines = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y += 1) {
    const rowOffset = y * (1 + size * 4);
    scanlines[rowOffset] = 0;
    for (let x = 0; x < size; x += 1) {
      const sourceOffset = (y * size + x) * 4;
      const targetOffset = rowOffset + 1 + x * 4;
      scanlines[targetOffset] = bitmap[sourceOffset + 2];
      scanlines[targetOffset + 1] = bitmap[sourceOffset + 1];
      scanlines[targetOffset + 2] = bitmap[sourceOffset];
      scanlines[targetOffset + 3] = bitmap[sourceOffset + 3];
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    createPngChunk('IHDR', header),
    createPngChunk('IDAT', deflateSync(scanlines, { level: 9 })),
    createPngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function createPngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return chunk;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function requirePng(pngBySize, size) {
  const png = pngBySize.get(size);
  if (png === undefined) throw new Error(`Missing generated ${size}px PNG`);
  return png;
}

function createPngBackedIco(frames) {
  const directorySize = 6 + frames.length * 16;
  const output = Buffer.alloc(directorySize + frames.reduce((total, frame) => total + frame.png.length, 0));
  output.writeUInt16LE(0, 0);
  output.writeUInt16LE(1, 2);
  output.writeUInt16LE(frames.length, 4);

  let imageOffset = directorySize;
  frames.forEach((frame, index) => {
    const entryOffset = 6 + index * 16;
    const encodedSize = frame.size === 256 ? 0 : frame.size;
    output[entryOffset] = encodedSize;
    output[entryOffset + 1] = encodedSize;
    output[entryOffset + 2] = 0;
    output[entryOffset + 3] = 0;
    output.writeUInt16LE(1, entryOffset + 4);
    output.writeUInt16LE(32, entryOffset + 6);
    output.writeUInt32LE(frame.png.length, entryOffset + 8);
    output.writeUInt32LE(imageOffset, entryOffset + 12);
    frame.png.copy(output, imageOffset);
    imageOffset += frame.png.length;
  });

  return output;
}
