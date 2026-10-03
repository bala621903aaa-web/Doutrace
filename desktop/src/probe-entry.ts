import { runProbe } from './probe/cli.js';

runProbe().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
