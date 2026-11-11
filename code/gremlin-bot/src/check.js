// npm run check
// Tests every key and library before you go live, and saves a voice sample
// to data/voice-test.wav so you can hear the voice you picked.

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  console.error(`FAIL  Node.js version: ${process.versions.node} (install Node 22.12 or newer from nodejs.org)`);
  process.exit(1);
}

await import('./preflight.js');
