#!/usr/bin/env node
import { main } from '../src/cli.js';

main(process.argv.slice(2))
  .then((code) => { process.exitCode = code ?? 0; })
  .catch((err) => {
    console.error(`[slackcensor] ${err.message}`);
    process.exitCode = 1;
  });
