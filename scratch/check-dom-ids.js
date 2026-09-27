const fs = require('fs');
const path = require('path');

const html = fs.readFileSync('public/index.html', 'utf8');
const jsDir = 'public/js';
const jsFiles = fs.readdirSync(jsDir).filter(f => f.endsWith('.js'));
const missingIds = [];

for (const f of jsFiles) {
  const content = fs.readFileSync(path.join(jsDir, f), 'utf8');
  const regex = /document\.getElementById\(['"]([^'"]+)['"]\)/g;
  let m;
  while ((m = regex.exec(content)) !== null) {
    const id = m[1];
    if (!html.includes(`id="${id}"`) && !html.includes(`id='${id}'`)) {
      missingIds.push({ file: f, id });
    }
  }
}

console.log('Total checked:', missingIds.length, 'missing');
console.log(missingIds);
