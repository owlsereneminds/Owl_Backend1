// api/finalize-upload.js
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  try {
    const { sessionId, meetingMeta } = req.body;
    if (!sessionId) return res.status(400).json({ ok: false, error: 'sessionId required' });

    // list files in bucket under session path
    const folder = `recordings/${sessionId}`;
    const { data: listData, error: listErr } = await supabase
      .storage
      .from('meeting_recordings')
      .list(folder, { limit: 1000 });
    
    if (listErr) throw listErr;
    if (!listData || listData.length === 0) {
      console.warn("⚠️ No chunks found for", folder);
    }
    
    if (listErr) throw listErr;

    // gather keys sorted by chunk index
    const chunkKeys = (listData || [])
      .map(i => i.name)
      .filter(n => n.endsWith('.webm'))
      .sort((a, b) => {
        const ai = parseInt(a.split('chunk-').pop().replace('.webm',''), 10);
        const bi = parseInt(b.split('chunk-').pop().replace('.webm',''), 10);
        return ai - bi;
      })
      .map(name => `${folder}/${name}`);


      console.log("📂 Found chunks:", listData.map(f => f.name));

    // insert job row
    const { data, error } = await supabase
      .from('meeting_jobs')
      .insert([{ session_id: sessionId, meeting_id: sessionId || null, chunk_keys: chunkKeys, meeting_meta: meetingMeta }])
      .select();

    if (error) throw error;

    return res.json({ ok: true, job: data[0] });
  } catch (err) {
    console.error("finalize-upload error", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
