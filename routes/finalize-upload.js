// server/finalizeUpload.ts
import { createClient } from "@supabase/supabase-js";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { v4 as uuidv4 } from "uuid";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";

ffmpeg.setFfmpegPath(ffmpegStatic);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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

  // 4️⃣ Merge using ffmpeg
  const mergedName = `merged-${sessionId}-${uuidv4()}.mp3`;
  const mergedPath = path.join(os.tmpdir(), mergedName);

  await new Promise((resolve, reject) => {
    const fileListPath = path.join(os.tmpdir(), `list-${uuidv4()}.txt`);
    fs.writeFileSync(fileListPath, tmpFiles.map(f => `file '${f}'`).join("\n"));

    ffmpeg()
      .input(fileListPath)
      .inputOptions(["-f concat", "-safe 0"])
      .outputOptions(["-c:a libmp3lame", "-q:a 2"])
      .save(mergedPath)
      .on("end", () => {
        fs.unlinkSync(fileListPath);
        resolve();
      })
      .on("error", (err) => {
        fs.unlinkSync(fileListPath);
        reject(err);
      });
  });

  // 5️⃣ Upload merged audio to Supabase
  const mergedBuffer = await fs.readFile(mergedPath);
  const mergedKey = `merged/${mergedName}`;
  const { error: uploadErr } = await supabase.storage.from("meeting_recordings").upload(
    mergedKey,
    mergedBuffer,
    { contentType: "audio/mpeg", upsert: true }
  );
  if (uploadErr) throw uploadErr;

  const { data: urlData } = supabase.storage.from("meeting_recordings").getPublicUrl(mergedKey);
  const publicUrl = urlData.publicUrl;

  // 6️⃣ Insert job with payload containing only merged audio link
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

  // 7️⃣ Cleanup tmp files
  for (const f of [...tmpFiles, mergedPath]) {
    try { await fs.unlink(f); } catch {}
  }

  if (jobErr) throw jobErr;
  return data[0];
}
