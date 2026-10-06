const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const shared = fs.readdirSync(path.join(root, 'shared')).filter((f) => f.endsWith('.js'));

for (const file of shared) {
  for (const dir of ['src', 'docs/shared']) {
    test(`${dir}/${file} matches shared/${file} (run npm run sync)`, () => {
      const want = fs.readFileSync(path.join(root, 'shared', file), 'utf8');
      const got = fs.readFileSync(path.join(root, dir, file), 'utf8');
      assert.strictEqual(got, want);
    });
  }
}
