// Copies Twemoji's SVG set into public/twemoji so the build (web, desktop and
// mobile) ships it. The files are generated from node_modules and are not
// committed - see .gitignore.
import fs from 'node:fs';
import path from 'node:path';

const source = path.resolve('node_modules/@twemoji/svg');
const dest = path.resolve('public/twemoji');
const stamp = path.join(dest, '.count');

if (!fs.existsSync(source)) {
  console.warn('[twemoji] @twemoji/svg is not installed - emoji fall back to the system font');
  process.exit(0);
}

const files = fs.readdirSync(source).filter((file) => file.endsWith('.svg'));
if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === String(files.length)) {
  process.exit(0);
}

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });
for (const file of files) {
  fs.copyFileSync(path.join(source, file), path.join(dest, file));
}
fs.writeFileSync(stamp, String(files.length));
console.log(`[twemoji] copied ${files.length} svg files`);
