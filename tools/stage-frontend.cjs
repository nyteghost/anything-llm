const fs = require('node:fs');
const path = require('node:path');

function stageFrontend(root = path.resolve(__dirname, '..')) {
  const source = path.join(root, 'frontend/dist');
  const destination = path.join(root, 'server/public');
  const staging = path.join(root, 'server/public-fork-staging');
  const previous = path.join(root, 'server/public-fork-previous');
  // Validate before touching the previous successful build. AnythingLLM serves
  // _index.html through its metadata/SSR route, not a static index.html.
  if (!fs.existsSync(path.join(source, '_index.html')))
    throw new Error('Frontend build did not produce _index.html. Run the complete frontend build, including postbuild.');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.cpSync(source, staging, { recursive: true });
  fs.rmSync(previous, { recursive: true, force: true });
  if (fs.existsSync(destination)) fs.renameSync(destination, previous);
  try {
    fs.renameSync(staging, destination);
  } catch (error) {
    if (fs.existsSync(previous)) fs.renameSync(previous, destination);
    throw error;
  }
}
if (require.main === module) stageFrontend();
module.exports = { stageFrontend };
