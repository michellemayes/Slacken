import fs from 'node:fs';
import path from 'node:path';

// Write beside the target and rename into place, so a crash mid-write leaves
// the old file rather than a truncated one. The pid keeps the CLI and the
// daemon from sharing a temp file when both write at once.
export function writeFileAtomic(file, data, options = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, data, options);
    fs.renameSync(temp, file);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
}
