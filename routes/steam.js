// stream.js
import express from 'express';
import multer from 'multer';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

router.post('/', upload.single('chunk'), async (req, res) => {
  try {
    const meetingId = req.body.meetingId;
    if (!meetingId) return res.status(400).json({ ok: false, error: "meetingId required" });

    const seq = req.query.seq || Date.now();
    const tmpDir = path.join(os.tmpdir(), 'meet-recorder', meetingId);
    await fs.promises.mkdir(tmpDir, { recursive: true });

    const filename = path.join(tmpDir, `chunk-${seq}-${uuidv4()}.webm`);
    await fs.promises.writeFile(filename, req.file.buffer);

    return res.json({ ok: true, stored: filename });
  } catch (err) {
    console.error('stream route error', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
