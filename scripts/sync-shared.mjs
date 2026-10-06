// Copies shared/*.js into the Apps Script project (src/) and the phone app
// (docs/shared/). Edit the files in shared/, then run `npm run sync`.
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const targets = [join(root, 'src'), join(root, 'docs', 'shared')];

for (const file of readdirSync(join(root, 'shared')).filter((f) => f.endsWith('.js'))) {
  for (const dir of targets) {
    mkdirSync(dir, { recursive: true });
    copyFileSync(join(root, 'shared', file), join(dir, file));
  }
  console.log(`synced ${file}`);
}
