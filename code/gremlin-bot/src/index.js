// Gremlin: an AI that hangs out in your Discord voice call.
// Start with: npm start   (test your keys first with: npm run check)
//
// This file only checks the Node.js version, so an old Node gets a clear
// message instead of a confusing error from code it can't run.

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  console.error(`Node.js ${process.versions.node} is too old. Install Node 22.12 or newer (the LTS download at nodejs.org).`);
  process.exit(1);
}

await import('./app.js');
