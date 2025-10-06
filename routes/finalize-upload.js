// server/finalizeUploadWasm.ts
import { createClient } from "@supabase/supabase-js";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { v4 as uuidv4 } from "uuid";
import { createFFmpeg, fetchFile } from "@ffmpeg/ffmpeg";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const ffmpeg = createFFmpeg({ log: true });

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

  // 3️⃣ Download chunks and prepare ffmpeg filesystem
  if (!ffmpeg.isLoaded()) await ffmpeg.load();

  const tmpFiles = [];
  for (let i = 0; i < chunkKeys.length; i++) {
    const key = chunkKeys[i];
    const { data, error } = await supabase.storage.from("meeting_recordings").download(key);
    if (error) throw error;

    const buffer = Buffer.from(await data.arrayBuffer());
    const tmpName = `chunk-${i}.webm`;
    ffmpeg.FS("writeFile", tmpName, buffer);
    tmpFiles.push(tmpName);
  }

  // 4️⃣ Merge chunks in ffmpeg.wasm
  // Create a text file listing all input files
  const listFileContent = tmpFiles.map(f => `file '${f}'`).join("\n");
  ffmpeg.FS("writeFile", "filelist.txt", Buffer.from(listFileContent));

  const mergedName = `merged-${sessionId}-${uuidv4()}.mp3`;

  await ffmpeg.run(
    "-f", "concat",
    "-safe", "0",
    "-i", "filelist.txt",
    "-c:a", "libmp3lame",
    "-q:a", "2",
    mergedName
  );

  // 5️⃣ Read merged output
  const mergedData = ffmpeg.FS("readFile", mergedName);

  // 6️⃣ Upload to Supabase
  const mergedKey = `merged/${mergedName}`;
  const { error: uploadErr } = await supabase.storage.from("meeting_recordings").upload(
    mergedKey,
    Buffer.from(mergedData),
    { contentType: "audio/mpeg", upsert: true }
  );
  if (uploadErr) throw uploadErr;

  const { data: urlData } = supabase.storage.from("meeting_recordings").getPublicUrl(mergedKey);
  const publicUrl = urlData.publicUrl;

  // 7️⃣ Insert job record
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
  return data[0];
}
