// Until the soltoolkit packages of the other repositories are on npm, a checkout that has those repositories
// cloned beside it uses them directly. Without them beside it, this file does nothing and npm is used.
/* eslint-disable @typescript-eslint/no-require-imports -- pnpm loads this file as CommonJS */
const fs = require('node:fs');
const path = require('node:path');

const SIBLINGS = {
  '@soltoolkit/rpc': 'soltoolkit-sdk/packages/rpc',
  '@soltoolkit/launchpad-sdk': 'soltoolkit-sdk/packages/launchpad-sdk',
};

function readPackage(pkg) {
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    for (const name of Object.keys(pkg[field] || {})) {
      const rel = SIBLINGS[name];
      if (!rel) continue;
      const dir = path.resolve(__dirname, '..', rel);
      if (fs.existsSync(path.join(dir, 'package.json'))) pkg[field][name] = `link:${dir}`;
    }
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };
