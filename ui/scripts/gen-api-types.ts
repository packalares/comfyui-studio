// Reads the OpenAPI 3.1 spec from the Studio server and generates
// `ui/src/generated/api.d.ts` via openapi-typescript.
//
// Usage:
//   npm run gen:api               — uses OPENAPI_URL env (defaults to http://localhost:3002/api/openapi.json)
//   OPENAPI_URL=http://... npm run gen:api

import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const outFile = path.resolve(__dir, '../src/generated/api.d.ts');
const url = process.env.OPENAPI_URL ?? 'http://localhost:3002/api/openapi.json';

console.log(`gen:api — fetching spec from ${url}`);
execSync(
  `npx openapi-typescript "${url}" -o "${outFile}"`,
  { stdio: 'inherit', cwd: __dir },
);
console.log(`gen:api — written to ${outFile}`);
