// api/finalize-upload.js
import { createClient } from '@supabase/supabase-js';
import multer from 'multer';
import nextConnect from 'next-connect'; // Optional, makes middleware easier to use

// ---------------- Supabase ----------------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ---------------- Multer Setup ----------------
// In-memory storage for small files (webm chunks)
const storage = multer.memoryStorage();
const upload = multer({ storage });

// ---------------- Handler ----------------
const handler = nextConnect({
  onError(err, req, res) {
    console.error('finalize-upload error', err);
    res.status(500).json({ ok: false, error: err.message });
  },
  onNoMatch(req, res) {
    res.status(405).json({ ok: false, error: `Method ${req.method} not allowed` });
  },
});

// Disable default body parsing for multipart/form-data
export const config = {
  api: {
    bodyParser: false,
  },
};

// Apply multer middleware
handler.use(upload.any());

handler.post(async (req, res) => {
  try {
    // ---------------- Parse Fields ----------------
    // req.body will have text fields, req.files will have blobs
    const sessionId = req.body.meeting_id || req.body.sessionId;
    const meetingMeta = req.body.meeting ? JSON.parse(req.body.meeting) : null;

    if (!sessionId) {
      return res.status(400).json({ ok: false, error: 'sessionId required' });
    }

    console.log('🎯 finalize-upload sessionId:', sessionId);
    console.log('🎯 meetingMeta:', meetingMeta);

    // ---------------- List Chunks from Supabase Storage ----------------
    const prefix = `recordings/${sessionId}/`;
    const { data: listData, error: listErr } = await supabase.storage
      .from('meeting_recordings')
      .list(prefix, { limit: 1000, offset: 0 });

    if (listErr) throw listErr;

    // Sort chunks by their index
    const chunkKeys = (listData || [])
      .map((i) => i.name)
      .filter((n) => n.endsWith('.webm'))
      .sort((a, b) => {
        const ai = parseInt(a.split('chunk-').pop().replace('.webm', ''), 10);
        const bi = parseInt(b.split('chunk-').pop().replace('.webm', ''), 10);
        return ai - bi;
      })
      .map((name) => `${prefix}${name}`);

    // ---------------- Insert Job in Supabase ----------------
    const { data, error } = await supabase
      .from('meeting_jobs')
      .insert([
        {
          session_id: sessionId,
          meeting_id: meetingMeta?.meetingInfo?.meetingCode || null,
          chunk_keys: chunkKeys,
          meeting_meta: meetingMeta,
        },
      ])
      .select();

    if (error) throw error;

    console.log('✅ Meeting job created:', data[0]);

    return res.json({ ok: true, job: data[0] });
  } catch (err) {
    console.error('finalize-upload error', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

export default handler;
