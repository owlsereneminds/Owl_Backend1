// server/finalizeUploadWasm.ts
import { createClient } from "@supabase/supabase-js";
import express from "express";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { v4 as uuidv4 } from "uuid";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

ffmpeg.setFfmpegPath(ffmpegStatic);

export async function finalizeUpload(sessionId, meetingMeta) {
  if (!sessionId) throw new Error("sessionId required");

  const folder = `recordings/${sessionId}`;

  // 1️⃣ List all chunks
  const { data: listData, error: listErr } = await supabase
    .storage
    .from("meeting_recordings")
    .list(folder, { limit: 1000 });

  if (listErr) throw listErr;
  if (!listData || listData.length === 0) {
    console.warn("⚠️ No chunks found for", folder);
    return;
  }

  // 2️⃣ Sort chunk keys
  const chunkKeys = listData
    .map(i => i.name)
    .filter(n => n.endsWith(".webm"))
    .sort((a, b) => {
      const ai = parseInt((a.split("chunk-").pop() || "").replace(".webm", ""), 10);
      const bi = parseInt((b.split("chunk-").pop() || "").replace(".webm", ""), 10);
      return ai - bi;
    })
    .map(name => `${folder}/${name}`);

// 3️⃣ Download chunks locally
const tmpFiles = [];
  for (let i = 0; i < chunkKeys.length; i++) {
    const key = chunkKeys[i];
    const { data, error } = await supabase.storage.from("meeting_recordings").download(key);
    if (error) throw error;

  const buffer = Buffer.from(await data.arrayBuffer());
  const tmpPath = path.join(os.tmpdir(), `${Date.now()}-${uuidv4()}-chunk-${i}.webm`);
  await fs.writeFile(tmpPath, buffer);
  tmpFiles.push(tmpPath);
  }

// 4️⃣ Merge using ffmpeg (native)
const mergedName = `merged-${sessionId}-${uuidv4()}.mp3`;
const mergedPath = path.join(os.tmpdir(), mergedName);

// Create concat file list
const listFilePath = path.join(os.tmpdir(), `list-${uuidv4()}.txt`);
await fs.writeFile(listFilePath, tmpFiles.map(f => `file '${f}'`).join("\n"));

await new Promise((resolve, reject) => {
  ffmpeg()
    .input(listFilePath)
    .inputOptions(["-f concat", "-safe 0"])
    .outputOptions(["-c:a libmp3lame", "-q:a 2"])
    .save(mergedPath)
    .on("end", resolve)
    .on("error", reject);
});

// 5️⃣ Upload to Supabase
  const mergedKey = `merged/${mergedName}`;
const mergedBuffer = await fs.readFile(mergedPath);
const { error: uploadErr } = await supabase.storage.from("meeting_recordings").upload(
  mergedKey,
  mergedBuffer,
  { contentType: "audio/mpeg", upsert: true }
);
  if (uploadErr) throw uploadErr;

  const { data: urlData } = supabase.storage.from("meeting_recordings").getPublicUrl(mergedKey);
  const publicUrl = urlData.publicUrl;

// 6️⃣ Insert job record
  const { data, error: jobErr } = await supabase.from("meeting_jobs").insert([
    {
      session_id: sessionId,
      meeting_id: meetingMeta?.meeting_id || sessionId,
      chunk_keys: chunkKeys,
      meeting_meta: meetingMeta,
      payload: {
        uploads: [
          {
            path: mergedKey,
            field: "merged_audio",
            publicUrl,
          },
        ],
      },
      status: "pending",
    },
  ]).select();

if (jobErr) throw jobErr;
// cleanup temp files
try { await fs.unlink(listFilePath); } catch {}
for (const p of [...tmpFiles, mergedPath]) { try { await fs.unlink(p); } catch {} }
return data[0];
}

// Express router to integrate with server.js
const router = express.Router();

router.post('/', async (req, res) => {
  try {
    const { sessionId, meetingMeta } = req.body || {};
    if (!sessionId) return res.status(400).json({ ok: false, error: 'sessionId required' });
    const job = await finalizeUpload(sessionId, meetingMeta);
    res.json({ ok: true, job });
  } catch (err) {
    console.error('finalize-upload route error', err);
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

export default router;
