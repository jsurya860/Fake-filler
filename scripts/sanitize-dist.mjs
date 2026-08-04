import fs from 'fs/promises';
import path from 'path';

const root = process.cwd();
const distDir = path.join(root, process.argv[2] || 'dist');

async function sanitizeFile(filePath) {
  try {
    let buf = await fs.readFile(filePath);
    // Remove UTF-8 BOM (0xEF,0xBB,0xBF)
    if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
      buf = buf.slice(3);
    }
    // Replace any NUL bytes which can cause syntax errors
    const nulIndex = buf.indexOf(0);
    if (nulIndex !== -1) {
      const cleaned = Buffer.from(buf.filter((b) => b !== 0));
      buf = cleaned;
    }
    await fs.writeFile(filePath, buf);
  } catch (err) {
    // Do not fail the whole build when sanitizer fails; log instead
    // eslint-disable-next-line no-console
    console.error('sanitize-dist: failed to sanitize', filePath, err);
  }
}

async function walk(dir) {
  for (const name of await fs.readdir(dir)) {
    const p = path.join(dir, name);
    const st = await fs.stat(p);
    if (st.isDirectory()) await walk(p);
    else if (p.endsWith('.js') || p.endsWith('.css') || p.endsWith('.html')) await sanitizeFile(p);
  }
}

(async () => {
  try {
    await walk(distDir);
    // eslint-disable-next-line no-console
    console.log('sanitize-dist: completed');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('sanitize-dist: error', err);
    process.exitCode = 1;
  }
})();
