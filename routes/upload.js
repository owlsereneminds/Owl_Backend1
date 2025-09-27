import express from 'express';
import multer from 'multer';
import os from 'os';
import path from 'path';
import fs from 'fs';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import { v4 as uuidv4 } from 'uuid';
import OpenAI from "openai";
import { safeUnlink } from './utils.js';
import supabase from '../supabaseClient.js';
import dotenv from 'dotenv';
import { sendAnalysisEmail } from './emailHelper.js';

dotenv.config();

ffmpeg.setFfmpegPath(ffmpegStatic);

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

// ---------------- Helpers ----------------
async function uploadBufferToSupabase(buffer, key, contentType = 'audio/webm') {
  const { error } = await supabase.storage.from('meeting_recordings').upload(key, buffer, {
    contentType,
    upsert: true
  });
  if (error) throw error;

  const { data: urlData } = supabase.storage.from('meeting_recordings').getPublicUrl(key);
  return { path: key, publicUrl: urlData.publicUrl };
}

function mergeAudioFiles(inputPaths, outPath) {
  return new Promise((resolve, reject) => {
    const proc = ffmpeg();
    inputPaths.forEach(p => proc.input(p));
    proc
      .complexFilter([`amix=inputs=${inputPaths.length}:duration=longest:dropout_transition=2`])
      .outputOptions(['-c:a libmp3lame', '-q:a 2'])
      .on('end', resolve)
      .on('error', reject)
      .save(outPath);
  });
}

// ---------------- Core Processor ----------------
async function processMeeting(files, meetingMeta) {
  const tmpPaths = [];
  try {
    const userAudio = files.find(f => f.fieldname === 'user_audio');
    const remotes = files.filter(f => f.fieldname === 'remote_audio');
    if (!userAudio) throw new Error("user_audio required");

    // Host info
    const hostEmail = meetingMeta?.googleUser?.email;
    const host = meetingMeta?.googleUser?.name || "Unknown Host";

    // Write temp files
    for (const f of [userAudio, ...remotes]) {
      const tmpPath = path.join(os.tmpdir(), `${Date.now()}-${uuidv4()}-${f.originalname}`);
      await fs.promises.writeFile(tmpPath, f.buffer);
      tmpPaths.push(tmpPath);
    }

    // Merge
    const mergedName = `merged-${Date.now()}-${uuidv4()}.mp3`;
    const mergedPath = path.join(os.tmpdir(), mergedName);
    await mergeAudioFiles(tmpPaths, mergedPath);

    // Upload merged
    const mergedBuffer = await fs.promises.readFile(mergedPath);
    const mergedKey = `merged/${mergedName}`;
    const mergedUpload = await uploadBufferToSupabase(mergedBuffer, mergedKey, 'audio/mpeg');

    // Upload originals
    const originals = [];
    for (const f of files) {
      const key = `originals/${Date.now()}-${f.originalname}`;
      const upload = await uploadBufferToSupabase(f.buffer, key, f.mimetype || 'audio/webm');
      originals.push({ field: f.fieldname, ...upload });
    }

    // Transcribe with Whisper
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(mergedPath),
      model: "whisper-1"
    });
    const transcriptText = transcription.text;

    // GPT Analysis
    const prompts = {
      summary: `You are an expert clinical assistant. Summarize the following session transcript in clear, concise language. Highlight main themes, client concerns, and any significant progress or challenges. Keep it factual and professional.\n\nTranscript: `,
      soap: `You are a mental health professional writing SOAP notes. Generate structured SOAP notes from the transcript below:\n\nS (Subjective): Client’s self-reported concerns, feelings, and symptoms.\nO (Objective): Observable behaviors, mood, and clinician’s observations.\nA (Assessment): Clinical impressions, patterns, and progress.\nP (Plan): Next steps, interventions, or recommendations.\n\nTranscript: `,
      tips: `You are a highly experienced psychologist. Based on the transcript below, generate exactly 3 practical, expert-level treatment tips and recommendations. Avoid generic advice and ensure each tip is actionable. Generate treatment tips and practical recommendations tailored to the client. Keep them empathetic, actionable, and evidence-based. Focus on coping strategies, skill-building, and next steps.\n\nDo not add any preface, thank-you note, or extra headers and strictly give me only 3 relevant tips. Follow the exact format below:\n\nFormat:\n1. ...\n2. ...\n3. ...\n\nTranscript: `
    };

    async function runPrompt(prompt, transcript) {
      const resp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt + transcript }]
      });
      return resp.choices?.[0]?.message?.content ?? '';
    }

    const analysis = {
      transcript: transcriptText,
      summary: await runPrompt(prompts.summary, transcriptText),
      soap: await runPrompt(prompts.soap, transcriptText),
      tips: await runPrompt(prompts.tips, transcriptText)
    };

    console.log("✅ Analysis ready:", analysis);

    // Send email
    await sendAnalysisEmail(
      hostEmail,
      `Owl Meeting Notes - Meet with ${host || 'Patient'}`,
      analysis,
      mergedPath,
      "./1.png",
      {
        meetingTitle: meetingMeta?.meetingInfo?.meetingTitle,
        participants: Array.isArray(meetingMeta?.participants)
          ? meetingMeta.participants
          : (typeof meetingMeta?.participants === 'string'
              ? meetingMeta.participants.split(",")
              : []),
        host,
        hostEmail,
        startTime: meetingMeta?.startTime,
        endTime: meetingMeta?.endTime,
        durationMs: meetingMeta?.durationMs
      }
    );

    console.log("📧 Analysis email sent successfully.");

  } catch (err) {
    console.error("❌ processMeeting error:", err);
  } finally {
    try { await Promise.all(tmpPaths.map(p => safeUnlink(p))); }
    catch (e) { console.warn("Cleanup warning", e); }
  }
}

// ---------------- Routes ----------------
router.options('/', (req, res) => res.sendStatus(204));

router.post('/', upload.any(), async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ ok: false, error: 'No files uploaded' });

    let meetingMeta = {};
    if (req.body.meeting) {
      try { meetingMeta = JSON.parse(req.body.meeting); }
      catch (err) { console.error("❌ Failed to parse meeting JSON:", err); }
    }

    // ✅ Immediate response
    res.json({ ok: true, msg: "Processing started..." });

    // Background process
    processMeeting(files, meetingMeta)
      .then(() => console.log("🎉 Meeting processed fully"))
      .catch(err => console.error("❌ Background job failed:", err));

  } catch (err) {
    console.error("❌ Upload route error:", err);
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: err.message });
    }
  }
});

export default router;
