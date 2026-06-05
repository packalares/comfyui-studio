// GET /api/openapi.json — serves the generated OpenAPI 3.1 document.
// GET /api/docs        — serves Swagger UI (HTML + static assets).
//
// Both are public (auth: {required: false}) — docs are openly accessible.
// The openapi.json endpoint is registered via defineRoute so it appears as
// a meta-route in the registry itself (Wave 4 requirement). Swagger UI is
// served via raw Express routes (they return HTML / static files, not JSON).

import { Router, type Request, type Response, type NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { buildOpenApiDocument } from '../lib/openapi/emit.js';
import { NotFoundError } from '../lib/errors.js';

const router = Router();

// ---- GET /api/openapi.json ------------------------------------------

// Served directly (no defineRoute) because the spec MUST be at the response
// root, not wrapped in the `{data}` envelope — that's what generators expect.
router.get('/openapi.json', (_req, res) => {
  res.json(buildOpenApiDocument());
});

// ---- Swagger UI static assets + HTML --------------------------------
//
// The assets are served from swagger-ui-dist. We resolve the dist dir
// via require.resolve so it works regardless of where the server runs.

function getSwaggerDistPath(): string {
  // swagger-ui-dist ships an absolute-path.js helper; use it when available.
  // Fall back to resolving the package root from node_modules.
  try {
    const absPath = new URL('../../node_modules/swagger-ui-dist', import.meta.url);
    return fileURLToPath(absPath);
  } catch {
    const __dir = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(__dir, '../../node_modules/swagger-ui-dist');
  }
}

const swaggerDistPath = getSwaggerDistPath();
const swaggerCss = path.join(swaggerDistPath, 'swagger-ui.css');
const swaggerBundle = path.join(swaggerDistPath, 'swagger-ui-bundle.js');

// Inline the Swagger UI HTML so we control the spec URL. The page fetches
// /api/openapi.json at runtime — no build step needed.
const swaggerHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>ComfyUI Studio API Docs</title>
  <link rel="stylesheet" href="/api/docs/swagger-ui.css" />
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="/api/docs/swagger-ui-bundle.js"></script>
  <script>
    window.onload = () => {
      SwaggerUIBundle({
        url: '/api/openapi.json',
        dom_id: '#swagger-ui',
        presets: [SwaggerUIBundle.presets.apis],
        layout: 'BaseLayout',
        deepLinking: true,
        displayRequestDuration: true,
      });
    };
  </script>
</body>
</html>`;

router.get('/docs', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(swaggerHtml);
});

// Serve swagger-ui.css + swagger-ui-bundle.js from the npm package on-demand.
// We only expose the two files the HTML above references, nothing else.
router.get('/docs/swagger-ui.css', (_req: Request, res: Response, next: NextFunction) => {
  if (!fs.existsSync(swaggerCss)) {
    next(new NotFoundError('swagger-ui.css not found')); return;
  }
  res.setHeader('Content-Type', 'text/css; charset=utf-8');
  res.sendFile(swaggerCss);
});

router.get('/docs/swagger-ui-bundle.js', (_req: Request, res: Response, next: NextFunction) => {
  if (!fs.existsSync(swaggerBundle)) {
    next(new NotFoundError('swagger-ui-bundle.js not found')); return;
  }
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.sendFile(swaggerBundle);
});

export default router;
