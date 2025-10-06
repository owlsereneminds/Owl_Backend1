// api/upload-chunk.js  (Vercel serverless handler)
import { createClient } from '@supabase/supabase-js';
import formidable from 'formidable-serverless';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

export const config = {
  api: { bodyParser: false } // use formidable
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const form = new formidable.IncomingForm();
    const parsed = await new Promise((resolve, reject) =>
      form.parse(req, (err, fields, files) => (err ? reject(err) : resolve({ fields, files })))
    );

    const { sessionId, chunkIndex } = parsed.fields;
    const audioFile = parsed.files?.audio;
    if (!sessionId || typeof chunkIndex === 'undefined' || !audioFile) {
      return res.status(400).json({ ok: false, error: 'sessionId, chunkIndex and audio required' });
    }

    const buffer = await fs.promises.readFile(audioFile.path);
    // create unique key
    const key = `recordings/${sessionId}/chunk-${chunkIndex}.webm`;

    // upload to Supabase (service role key)
    const { error } = await supabase.storage
      .from('meeting_recordings')
      .upload(key, buffer, { contentType: audioFile.type, upsert: true });

    if (error) {
      console.error("Supabase upload error", error);
      return res.status(500).json({ ok: false, error: error.message || error });
    }

    // optional: return public URL or storage key; for privacy, we return the storage key and let worker build URL
    return res.json({ ok: true, key });
  } catch (err) {
    console.error("upload-chunk handler error", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
