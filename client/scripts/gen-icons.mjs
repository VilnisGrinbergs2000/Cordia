import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode, encode, bodyBounds, resize, crop, compose } from './lib/png.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SOURCE = path.join(ROOT, 'client/public/codi.png');
const INK = '#0F1117';

// `fill` is the fraction of the shorter side that Codi's body occupies. It is
// measured against the body, not the raw file: codi.png carries a detached drop
// shadow, and a shadow belongs in an illustration, not in an icon.
const ICONS = [
  { file: 'electron/build/icon.png', size: 1024, fill: 0.8 },
  { file: 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png', size: 1024, fill: 0.72, bg: INK, alpha: false },
  { file: 'client/public/icon-512.png', size: 512, fill: 0.78 },
  { file: 'client/public/icon-maskable-512.png', size: 512, fill: 0.64, bg: INK },
  { file: 'client/public/icon-192.png', size: 192, fill: 0.78 },
  { file: 'client/public/apple-touch-icon.png', size: 180, fill: 0.76, bg: INK, alpha: false },
  { file: 'landing/assets/apple-touch-icon.png', size: 180, fill: 0.76, bg: INK, alpha: false },
  { file: 'client/public/favicon-64.png', size: 64, fill: 0.94 },
  { file: 'client/public/favicon-32.png', size: 32, fill: 0.94 },
  { file: 'client/public/codi-mark.png', size: 128, fill: 0.98 },
  { file: 'landing/assets/codi-mark.png', size: 128, fill: 0.88 },
  { file: 'android/app/src/main/res/mipmap-mdpi/ic_launcher.png', size: 48, fill: 0.74, bg: INK },
  { file: 'android/app/src/main/res/mipmap-hdpi/ic_launcher.png', size: 72, fill: 0.74, bg: INK },
  { file: 'android/app/src/main/res/mipmap-xhdpi/ic_launcher.png', size: 96, fill: 0.74, bg: INK },
  { file: 'android/app/src/main/res/mipmap-xxhdpi/ic_launcher.png', size: 144, fill: 0.74, bg: INK },
  { file: 'android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png', size: 192, fill: 0.74, bg: INK },
  { file: 'android/app/src/main/res/mipmap-mdpi/ic_launcher_round.png', size: 48, fill: 0.7, bg: INK },
  { file: 'android/app/src/main/res/mipmap-hdpi/ic_launcher_round.png', size: 72, fill: 0.7, bg: INK },
  { file: 'android/app/src/main/res/mipmap-xhdpi/ic_launcher_round.png', size: 96, fill: 0.7, bg: INK },
  { file: 'android/app/src/main/res/mipmap-xxhdpi/ic_launcher_round.png', size: 144, fill: 0.7, bg: INK },
  { file: 'android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_round.png', size: 192, fill: 0.7, bg: INK },
  { file: 'android/app/src/main/res/mipmap-mdpi/ic_launcher_foreground.png', size: 108, fill: 0.56 },
  { file: 'android/app/src/main/res/mipmap-hdpi/ic_launcher_foreground.png', size: 162, fill: 0.56 },
  { file: 'android/app/src/main/res/mipmap-xhdpi/ic_launcher_foreground.png', size: 216, fill: 0.56 },
  { file: 'android/app/src/main/res/mipmap-xxhdpi/ic_launcher_foreground.png', size: 324, fill: 0.56 },
  { file: 'android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_foreground.png', size: 432, fill: 0.56 }
];

// Splash screens are opaque and hold Codi smaller: on a launch screen the mark
// is a cue, not the subject.
const SPLASH_FILL = 0.3;
const SPLASHES = [
  ['android/app/src/main/res/drawable/splash.png', 480, 320],
  ['android/app/src/main/res/drawable-land-mdpi/splash.png', 480, 320],
  ['android/app/src/main/res/drawable-land-hdpi/splash.png', 800, 480],
  ['android/app/src/main/res/drawable-land-xhdpi/splash.png', 1280, 720],
  ['android/app/src/main/res/drawable-land-xxhdpi/splash.png', 1600, 960],
  ['android/app/src/main/res/drawable-land-xxxhdpi/splash.png', 1920, 1280],
  ['android/app/src/main/res/drawable-port-mdpi/splash.png', 320, 480],
  ['android/app/src/main/res/drawable-port-hdpi/splash.png', 480, 800],
  ['android/app/src/main/res/drawable-port-xhdpi/splash.png', 720, 1280],
  ['android/app/src/main/res/drawable-port-xxhdpi/splash.png', 960, 1600],
  ['android/app/src/main/res/drawable-port-xxxhdpi/splash.png', 1280, 1920],
  ['ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732.png', 2732, 2732],
  ['ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732-1.png', 2732, 2732],
  ['ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732-2.png', 2732, 2732]
].map(([file, width, height]) => ({ file, width, height, fill: SPLASH_FILL, bg: INK, alpha: false }));

const jobs = ICONS.map((job) => ({ ...job, width: job.size, height: job.size })).concat(SPLASHES);

const source = decode(fs.readFileSync(SOURCE));
const bounds = bodyBounds(source);
const body = crop(source, bounds.minX, bounds.minY, bounds.width, bounds.height);
const aspect = body.width / body.height;

function inspect(file) {
  const buffer = fs.readFileSync(file);
  const image = decode(buffer);
  const rows = [];
  for (let y = 0; y < image.height; y += 1) {
    let ink = 0;
    for (let x = 0; x < image.width; x += 1) if (image.data[(y * image.width + x) * 4 + 3] > 12) ink += 1;
    rows.push(ink);
  }
  let first = 0;
  while (first < rows.length && rows[first] === 0) first += 1;
  let last = rows.length - 1;
  while (last > 0 && rows[last] === 0) last -= 1;
  let gaps = 0;
  for (let y = first; y <= last; y += 1) if (rows[y] === 0) gaps += 1;
  return { colorType: buffer[25], width: image.width, height: image.height, first, last, gaps };
}

let bytes = 0;
for (const job of jobs) {
  const target = Math.max(1, Math.round(job.fill * Math.min(job.width, job.height)));
  const piece = resize(body, Math.max(1, Math.round(target * aspect)), target);
  const canvas = compose(job.width, job.height, job.bg || null, piece);
  const buffer = encode(canvas, { alpha: job.alpha !== false });
  const destination = path.join(ROOT, job.file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, buffer);
  bytes += buffer.length;
  console.log(`${job.file.padEnd(72)} ${job.width}x${job.height} ${String(Math.round(buffer.length / 1024)).padStart(5)} KiB`);
}

// The tab icon stays a .svg URL so no page has to change its <link>, with the
// 64px render embedded. It is a raster inside a vector, which is not elegant,
// but there is no vector Codi to draw from.
const favicon = fs.readFileSync(path.join(ROOT, 'client/public/favicon-64.png'));
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64"><image href="data:image/png;base64,'
  + favicon.toString('base64') + '" width="64" height="64"/></svg>\n';
fs.writeFileSync(path.join(ROOT, 'client/public/favicon.svg'), svg);

const failures = [];
for (const job of jobs) {
  const file = path.join(ROOT, job.file);
  const seen = inspect(file);
  if (seen.width !== job.width || seen.height !== job.height) {
    failures.push(`${job.file}: ${seen.width}x${seen.height}, expected ${job.width}x${job.height}`);
  }
  if (job.alpha === false && seen.colorType !== 2) {
    failures.push(`${job.file}: colour type ${seen.colorType}, expected 2 (no alpha)`);
  }
  // A transparent row inside the inked span means the drop shadow survived the
  // crop, which is the bug this generator exists to avoid.
  if (seen.gaps > 0) {
    failures.push(`${job.file}: ${seen.gaps} transparent rows inside the mark`);
  }
  // And an icon with no ink at all is a file that looks fine by every other
  // measure and renders as nothing. Size, colour type and gap count all pass.
  if (seen.first >= seen.last) {
    failures.push(`${job.file}: nothing visible in the image`);
  }
}

console.log(`\nbody crop ${bounds.width}x${bounds.height} from ${source.width}x${source.height}`);
console.log(`${jobs.length} files, ${Math.round(bytes / 1024)} KiB total, favicon.svg ${Math.round(svg.length / 1024)} KiB`);
if (failures.length) {
  console.error('\n' + failures.length + ' problem(s):');
  for (const failure of failures) console.error('  ' + failure);
  process.exitCode = 1;
} else {
  console.log('all outputs verified: correct size, no stray shadow, correct colour type');
}
