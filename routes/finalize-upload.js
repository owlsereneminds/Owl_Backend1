import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  try {
    const { sessionId, meetingMeta } = req.body;
    if (!sessionId) return res.status(400).json({ ok: false, error: "sessionId required" });

    // list files in bucket under session path
    const folder = `recordings/${sessionId}`;
    const { data: listData, error: listErr } = await supabase
      .storage
      .from("meeting_recordings")
      .list(folder, { limit: 1000 });

    if (listErr) throw listErr;
    if (!listData || listData.length === 0) {
      console.warn("⚠️ No chunks found for", folder);
    }

    // gather chunk keys sorted by chunk index
    const chunkKeys = (listData || [])
      .map(i => i.name)
      .filter(n => n.endsWith(".webm"))
      .sort((a, b) => {
        const ai = parseInt(a.split("chunk-").pop().replace(".webm", ""), 10);
        const bi = parseInt(b.split("chunk-").pop().replace(".webm", ""), 10);
        return ai - bi;
      })
      .map(name => `${folder}/${name}`);

    console.log("📂 Found chunks:", chunkKeys);

    // build merged file path (what the edge function will produce later)
    const mergedPath = `merged/${sessionId}-merged.webm`;

    // build public URL for merged file
    const { data: publicUrlData } = supabase.storage
      .from("meeting_recordings")
      .getPublicUrl(mergedPath);

    console.log("📂 Public URL:", publicUrlData.publicUrl);

    // ✅ build payload exactly as required
    const payload = {
      uploads: [
        {
          path: mergedPath,
          field: "merged_audio",
          publicUrl: publicUrlData.publicUrl,
        },
      ],
      meetingMeta,
      chunks: chunkKeys, // optional: if the edge function needs to fetch and merge
    };

    // insert job row
    const { data, error } = await supabase
      .from("meeting_jobs")
      .insert([
        {
          session_id: sessionId,
          meeting_id: meetingMeta?.meeting_id || sessionId || null,
          chunk_keys: chunkKeys,
          meeting_meta: meetingMeta,
          payload, // ✅ now with uploads + meta
          status: "pending",
        },
      ])
      .select();

    if (error) throw error;

    return res.json({ ok: true, job: data[0] });
  } catch (err) {
    console.error("finalize-upload error", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
