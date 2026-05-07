// UI-driven RAG endpoints. Distinct from the LLM-callable `rag_upload`
// MCP tool (which takes a public URL); these wire the chat-composer's
// "Add to KB" button to a real local-file ingest path.
//
//   GET  /api/rag/kbs          -> list user's RAGFlow knowledge bases
//   POST /api/rag/upload       -> multipart { file, knowledgeBaseId }
//                                 → forwards to RAGFlow

import path from 'path';
import fs from 'fs';
import { Router, type Request, type Response } from 'express';
import multer, { MulterError } from 'multer';
import { paths } from '../config/paths.js';
import { env } from '../config/env.js';
import { listKnowledgeBases, uploadFileToKb } from '../services/ragUploadService.js';
import { logger } from '../lib/logger.js';

// Ensure the spool dir exists so multer can write the temp file.
fs.mkdirSync(paths.uploadsTmpDir, { recursive: true, mode: 0o700 });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, paths.uploadsTmpDir),
  filename: (_req, _file, cb) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    cb(null, id);
  },
});

const upload = multer({ storage, limits: { fileSize: env.UPLOAD_MAX_BYTES } });

function safeFilename(originalname: string): string {
  return path.basename(originalname);
}

const router = Router();

router.get('/rag/kbs', async (_req: Request, res: Response) => {
  try {
    const kbs = await listKnowledgeBases();
    res.json({ kbs });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('GET /rag/kbs failed', { error: msg });
    const status = msg.includes('not configured') ? 503 : 502;
    res.status(status).json({ error: msg });
  }
});

router.post(
  '/rag/upload',
  upload.single('file'),
  async (req: Request, res: Response) => {
    const file = req.file;
    const kbId = (req.body as { knowledgeBaseId?: unknown }).knowledgeBaseId;
    if (!file) {
      res.status(400).json({ error: 'multipart `file` field is required' });
      return;
    }
    if (typeof kbId !== 'string' || kbId.length === 0) {
      // Clean up the spool — we won't ingest.
      try { fs.unlinkSync(file.path); } catch { /* best-effort */ }
      res.status(400).json({ error: 'knowledgeBaseId form field is required' });
      return;
    }
    try {
      const buf = fs.readFileSync(file.path);
      const result = await uploadFileToKb(buf, safeFilename(file.originalname), kbId);
      res.json({ ok: true, documentIds: result.documentIds });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = msg.includes('not configured') ? 503 : 502;
      logger.warn('POST /rag/upload failed', { error: msg });
      res.status(status).json({ error: msg });
    } finally {
      // Always clean up the spool — RAGFlow has its own copy now.
      try { fs.unlinkSync(file.path); } catch { /* best-effort */ }
    }
  },
);

router.use('/rag/upload', (
  err: unknown,
  _req: Request,
  res: Response,
  _next: () => void,
) => {
  if (err instanceof MulterError && err.code === 'LIMIT_FILE_SIZE') {
    res.status(413).json({ error: `File too large (max ${env.UPLOAD_MAX_BYTES} bytes)` });
    return;
  }
  const msg = err instanceof Error ? err.message : String(err);
  res.status(500).json({ error: msg });
});

export default router;
