import os from "os";
import path from "path";
import fs from "fs";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import { v4 as uuidv4 } from "uuid";
import OpenAI from "openai";
import fetch from "node-fetch"; // for downloading publicUrl files

import supabase from "../../supabaseClient.js";
import { safeUnlink } from "../utils.js";
import { sendAnalysisEmail } from "../emailHelper.js";

// configure ffmpeg
ffmpeg.setFfmpegPath(ffmpegStatic);

// ---------------- Helpers ----------------
async function uploadBufferToSupabase(buffer, key, contentType = "audio/webm") {
  const { error } = await supabase.storage
    .from("meeting_recordings")
    .upload(key, buffer, { contentType, upsert: true });
  if (error) throw error;

  const { data: urlData } = supabase.storage
    .from("meeting_recordings")
    .getPublicUrl(key);
  return { path: key, publicUrl: urlData.publicUrl };
}

function mergeAudioFiles(inputPaths, outPath) {
  return new Promise((resolve, reject) => {
    const proc = ffmpeg();
    inputPaths.forEach((p) => proc.input(p));
    proc
      .complexFilter([
        `amix=inputs=${inputPaths.length}:duration=longest:dropout_transition=2`,
      ])
      .outputOptions(["-c:a libmp3lame", "-q:a 2"])
      .on("end", resolve)
      .on("error", reject)
      .save(outPath);
  });
}

// ---------------- Main Processor ----------------
export async function processMeeting(rawPayload) {
  // handle both string + object
  const payload =
    typeof rawPayload === "string" ? JSON.parse(rawPayload) : rawPayload;

  const { meetingMeta, uploads = [], files = [] } = payload;
  const tmpPaths = [];
  const meetingEnd = new Date();
  const durationMs = meetingEnd - new Date(meetingMeta?.startTime || Date.now());

  try {
    // 1. Normalize inputs: Either files (buffer) or uploads (download via URL)
    let userAudio = null;
let remotes = [];

if (Array.isArray(files) && files.length) {
  userAudio = files.find(f => f.fieldname === "user_audio");
  remotes = files.filter(f => f.fieldname === "remote_audio");
} else if (Array.isArray(uploads) && uploads.length) {
  userAudio = uploads.find(f => f.field === "user_audio");
  remotes = uploads.filter(f => f.field === "remote_audio");
}

    if (!userAudio) throw new Error("user_audio required");

    const hostEmail = meetingMeta?.googleUser?.email;
    const host = meetingMeta?.googleUser?.name || "Unknown Host";

    // 2. Write to tmp disk
    async function downloadToTmp(item) {
      const tmpPath = path.join(os.tmpdir(), `${Date.now()}-${uuidv4()}.webm`);
      if (item.buffer) {
        // from multer
        await fs.promises.writeFile(tmpPath, item.buffer);
      } else if (item.publicUrl) {
        const resp = await fetch(item.publicUrl);
        const buf = await resp.buffer();
        await fs.promises.writeFile(tmpPath, buf);
      }
      tmpPaths.push(tmpPath);
      return tmpPath;
    }

    const allInputs = [userAudio, ...remotes];
    const inputPaths = [];
    for (const f of allInputs) {
      const tmpPath = await downloadToTmp(f);
      inputPaths.push(tmpPath);
    }

    // 3. Merge into single audio
    const mergedName = `merged-${Date.now()}-${uuidv4()}.mp3`;
    const mergedPath = path.join(os.tmpdir(), mergedName);
    await mergeAudioFiles(inputPaths, mergedPath);

    // 4. Upload merged audio
    const mergedBuffer = await fs.promises.readFile(mergedPath);
    const mergedKey = `merged/${mergedName}`;
    const mergedUpload = await uploadBufferToSupabase(
      mergedBuffer,
      mergedKey,
      "audio/mpeg"
    );

    // 5. Transcribe
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(mergedPath),
      model: "whisper-1",
    });
    const transcriptText = transcription.text;

    // 6. Analysis
    async function runPrompt(prompt, transcript) {
      const resp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt + transcript }],
      });
      return resp.choices?.[0]?.message?.content ?? "";
    }

    const prompts = {
      summary: `You are an expert clinical assistant. Summarize the following session transcript... \n\nTranscript: `,
      soap: `You are a mental health professional writing SOAP notes... \n\nTranscript: `,
      tips: `You are a highly experienced psychologist. Generate exactly 3 tips... \n\nTranscript: `,
    };

    const analysis = {
      transcript: transcriptText,
      summary: await runPrompt(prompts.summary, transcriptText),
      soap: await runPrompt(prompts.soap, transcriptText),
      tips: await runPrompt(prompts.tips, transcriptText),
    };

    console.log("✅ Analysis ready");

    // 7. Email
    if (hostEmail) {
      await sendAnalysisEmail(
        hostEmail,
        `Owl Meeting Notes - Meet with ${host || "Participant"}`,
        analysis,
        mergedPath,
        "./1.png",
        {
          meetingTitle: meetingMeta?.meetingInfo?.meetingTitle,
          participants: Array.isArray(meetingMeta?.participants)
            ? meetingMeta.participants
            : typeof meetingMeta?.participants === "string"
            ? meetingMeta.participants.split(",")
            : [],
          host,
          hostEmail,
          startTime: meetingMeta?.startTime,
          endTime: meetingMeta?.endTime,
          durationMs,
        }
      );
      console.log("📧 Analysis email sent");
    }

    // 8. Update Supabase row if meeting_id exists
    if (meetingMeta?.meeting_id) {
      const { error: updateError } = await supabase
        .from("meetings")
        .update({
          audio_link: mergedUpload.publicUrl,
          email_content: JSON.stringify(analysis),
          end_time: meetingEnd.toISOString(),
          duration_ms: durationMs,
        })
        .eq("id", meetingMeta.meeting_id);

      if (updateError) console.error("❌ Supabase update error", updateError);
    } else {
      console.warn("⚠️ No meeting_id, skipping Supabase update");
    }

    return { ok: true, analysis, mergedUrl: mergedUpload.publicUrl };
  } catch (err) {
    console.error("❌ processMeeting error", err);
    return { ok: false, error: err.message };
  } finally {
    // cleanup tmp
    try {
      await Promise.all(tmpPaths.map((p) => safeUnlink(p)));
    } catch (e) {
      console.warn("Cleanup warning", e);
    }
  }
}
