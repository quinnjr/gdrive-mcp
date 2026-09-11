import { start } from './server.js';

start().catch((err) => { console.error(String((err as Error)?.message ?? err)); process.exit(1); });
