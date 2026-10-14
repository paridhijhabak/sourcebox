'use strict';
/* Builds the public marketing site out of the product page.
 *
 * The vault itself cannot be hosted: it watches folders on your own machine.
 * The page that describes it can be, so this copies that one page (and the
 * images it uses) into site/ for a static host. There is deliberately no
 * second copy of the HTML to keep in step — public/usp.html is the only
 * source, and the page notices for itself that no vault is answering and
 * shows install instructions instead of a sign-in form.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'site');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

fs.copyFileSync(path.join(ROOT, 'public', 'usp.html'), path.join(OUT, 'index.html'));

const media = path.join(ROOT, 'public', 'media');
if (fs.existsSync(media)) {
  fs.cpSync(media, path.join(OUT, 'media'), { recursive: true });
}

const files = fs.readdirSync(OUT, { recursive: true });
console.log('site/ built: ' + files.length + ' entries');
