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
// ---------------- Core Processor ----------------
async function processMeeting(files, meetingMeta) {
  const tmpPaths = [];
  const meetingEnd = new Date();
const durationMs = meetingEnd - new Date(meetingMeta.startTime || Date.now());

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

    // Merge audio files
    const mergedName = `merged-${Date.now()}-${uuidv4()}.mp3`;
    const mergedPath = path.join(os.tmpdir(), mergedName);
    await mergeAudioFiles(tmpPaths, mergedPath);

    // Upload merged audio
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
    if (hostEmail) {
      await sendAnalysisEmail(
        hostEmail,
        `Owl Meeting Notes - Meet with ${host || 'Participant'}`,
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
    } else {
      console.warn("⚠️ Host email not found, skipping email send");
    }

    // ---------------- Supabase update ----------------
    try {
      const meetingId = meetingMeta?.meeting_id;

      // find host + participant uploads
  const hostAudioUpload = originals.find(o => o.field === 'user_audio');
  const participantAudios = originals.filter(o => o.field === 'remote_audio');

  const hostAudioUrl = hostAudioUpload?.publicUrl || null;
  const participantAudioUrls = participantAudios.map(p => p.publicUrl);

      if (meetingId) {
        const { error: updateError } = await supabase
          .from('meetings')
          .update({
            audio_link: mergedUpload.publicUrl,
            email_content: JSON.stringify(analysis),
            end_time: meetingEnd.toISOString(),
      duration_ms: durationMs,
      host_audio: hostAudioUrl,
      participant_audio: JSON.stringify(participantAudioUrls)
          })
          .eq('id', meetingId);
      if(!meetingId)
      {
        console.log("No meetingId")
        const { error: insertError } = await supabase
          .from('meetings')
          .insert({
            audio_link: mergedUpload.publicUrl,
            email_content: JSON.stringify(analysis),
            end_time: meetingEnd.toISOString(),
            duration_ms: durationMs
          })
          .eq('meeting_code', meetingMeta.meetingInfo.meetingCode);
      }
        if (updateError) {
          console.error("❌ Failed to update Supabase meeting:", updateError);
        } else {
          console.log(`✅ Supabase row for meeting_id ${meetingId} updated with audio + analysis`);
        }
      } else {
        console.log("No meetingId")
        const { error: insertError } = await supabase
          .from('meetings')
          .insert({
            audio_link: mergedUpload.publicUrl,
            email_content: JSON.stringify(analysis),
            end_time: meetingEnd.toISOString(),
            duration_ms: durationMs
          })
          .eq('meeting_code', meetingMeta.meetingInfo.meetingCode);
      }
    } catch (err) {
      console.error("❌ Supabase update failed:", err);
    }

  } catch (err) {
    console.error("❌ processMeeting error:", err);
  } finally {
    // Cleanup temp files
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

    console.log("Meting", meetingMeta)

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


// import express from 'express';
// import multer from 'multer';
// import os from 'os';
// import path from 'path';
// import fs from 'fs';
// import ffmpeg from 'fluent-ffmpeg';
// import ffmpegStatic from 'ffmpeg-static';
// import { v4 as uuidv4 } from 'uuid';
// import OpenAI from "openai";
// import { safeUnlink } from './utils.js';
// import supabase from '../supabaseClient.js';
// import dotenv from 'dotenv';
// import { sendAnalysisEmail } from './emailHelper.js';

// dotenv.config();

// ffmpeg.setFfmpegPath(ffmpegStatic);

// const router = express.Router();
// const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

// // ---------------- Helpers ----------------
// async function uploadBufferToSupabase(buffer, key, contentType = 'audio/webm') {
//   const { error } = await supabase.storage.from('meeting_recordings').upload(key, buffer, {
//     contentType,
//     upsert: true
//   });
//   if (error) throw error;

//   const { data: urlData } = supabase.storage.from('meeting_recordings').getPublicUrl(key);
//   return { path: key, publicUrl: urlData.publicUrl };
// }

// function mergeAudioFiles(inputPaths, outPath) {
//   return new Promise((resolve, reject) => {
//     const proc = ffmpeg();
//     inputPaths.forEach(p => proc.input(p));
//     proc
//       .complexFilter([`amix=inputs=${inputPaths.length}:duration=longest:dropout_transition=2`])
//       .outputOptions(['-c:a libmp3lame', '-q:a 2'])
//       .on('end', resolve)
//       .on('error', reject)
//       .save(outPath);
//   });
// }

// // ---------------- Core Processor ----------------
// // ---------------- Core Processor ----------------
// async function processMeeting(files, meetingMeta) {
//   const tmpPaths = [];
//   const meetingEnd = new Date();
// const durationMs = meetingEnd - new Date(meetingMeta.startTime || Date.now());

//   try {
//     const userAudio = files.find(f => f.fieldname === 'user_audio');
//     const remotes = files.filter(f => f.fieldname === 'remote_audio');
//     if (!userAudio) throw new Error("user_audio required");

//     // Host info
//     const hostEmail = meetingMeta?.googleUser?.email;
//     const host = meetingMeta?.googleUser?.name || "Unknown Host";

//     // Write temp files
//     for (const f of [userAudio, ...remotes]) {
//       const tmpPath = path.join(os.tmpdir(), `${Date.now()}-${uuidv4()}-${f.originalname}`);
//       await fs.promises.writeFile(tmpPath, f.buffer);
//       tmpPaths.push(tmpPath);
//     }

//     // Merge audio files
//     const mergedName = `merged-${Date.now()}-${uuidv4()}.mp3`;
//     const mergedPath = path.join(os.tmpdir(), mergedName);
//     await mergeAudioFiles(tmpPaths, mergedPath);

//     // Upload merged audio
//     const mergedBuffer = await fs.promises.readFile(mergedPath);
//     const mergedKey = `merged/${mergedName}`;
//     const mergedUpload = await uploadBufferToSupabase(mergedBuffer, mergedKey, 'audio/mpeg');

//     // Upload originals
//     const originals = [];
//     for (const f of files) {
//       const key = `originals/${Date.now()}-${f.originalname}`;
//       const upload = await uploadBufferToSupabase(f.buffer, key, f.mimetype || 'audio/webm');
//       originals.push({ field: f.fieldname, ...upload });
//     }

//     // Transcribe with Whisper
//     const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
//     const transcription = await openai.audio.transcriptions.create({
//       file: fs.createReadStream(mergedPath),
//       model: "whisper-1"
//     });
//     const transcriptText = transcription.text;

//     // GPT Analysis
//     const prompts = {
//       summary: `You are an expert clinical assistant. Summarize the following session transcript in clear, concise language. Highlight main themes, client concerns, and any significant progress or challenges. Keep it factual and professional.\n\nTranscript: `,
//       soap: `You are a mental health professional writing SOAP notes. Generate structured SOAP notes from the transcript below:\n\nS (Subjective): Client’s self-reported concerns, feelings, and symptoms.\nO (Objective): Observable behaviors, mood, and clinician’s observations.\nA (Assessment): Clinical impressions, patterns, and progress.\nP (Plan): Next steps, interventions, or recommendations.\n\nTranscript: `,
//       tips: `You are a highly experienced psychologist. Based on the transcript below, generate exactly 3 practical, expert-level treatment tips and recommendations. Avoid generic advice and ensure each tip is actionable. Generate treatment tips and practical recommendations tailored to the client. Keep them empathetic, actionable, and evidence-based. Focus on coping strategies, skill-building, and next steps.\n\nDo not add any preface, thank-you note, or extra headers and strictly give me only 3 relevant tips. Follow the exact format below:\n\nFormat:\n1. ...\n2. ...\n3. ...\n\nTranscript: `
//     };

//     async function runPrompt(prompt, transcript) {
//       const resp = await openai.chat.completions.create({
//         model: "gpt-4o-mini",
//         messages: [{ role: "user", content: prompt + transcript }]
//       });
//       return resp.choices?.[0]?.message?.content ?? '';
//     }

//     const analysis = {
//       transcript: transcriptText,
//       summary: await runPrompt(prompts.summary, transcriptText),
//       soap: await runPrompt(prompts.soap, transcriptText),
//       tips: await runPrompt(prompts.tips, transcriptText)
//     };

//     console.log("✅ Analysis ready:", analysis);

//     // Send email
//     if (hostEmail) {
//       await sendAnalysisEmail(
//         hostEmail,
//         `Owl Meeting Notes - Meet with ${host || 'Participant'}`,
//         analysis,
//         mergedPath,
//         "./1.png",
//         {
//           meetingTitle: meetingMeta?.meetingInfo?.meetingTitle,
//           participants: Array.isArray(meetingMeta?.participants)
//             ? meetingMeta.participants
//             : (typeof meetingMeta?.participants === 'string'
//                 ? meetingMeta.participants.split(",")
//                 : []),
//           host,
//           hostEmail,
//           startTime: meetingMeta?.startTime,
//           endTime: meetingMeta?.endTime,
//           durationMs: meetingMeta?.durationMs
//         }
//       );
//       console.log("📧 Analysis email sent successfully.");
//     } else {
//       console.warn("⚠️ Host email not found, skipping email send");
//     }

//     // ---------------- Supabase update ----------------
//     try {
//       const meetingId = meetingMeta?.meeting_id;

//       // find host + participant uploads
//   const hostAudioUpload = originals.find(o => o.field === 'user_audio');
//   const participantAudios = originals.filter(o => o.field === 'remote_audio');

//   const hostAudioUrl = hostAudioUpload?.publicUrl || null;
//   const participantAudioUrls = participantAudios.map(p => p.publicUrl);

//       if (meetingId) {
//         const { error: updateError } = await supabase
//           .from('meetings')
//           .update({
//             audio_link: mergedUpload.publicUrl,
//             email_content: JSON.stringify(analysis),
//             end_time: meetingEnd.toISOString(),
//       duration_ms: durationMs,
//       host_audio: hostAudioUrl,
//       participant_audio: JSON.stringify(participantAudioUrls)
//           })
//           .eq('id', meetingId);
//       if(!meetingId)
//       {
//         console.log("No meetingId")
//         const { error: insertError } = await supabase
//           .from('meetings')
//           .insert({
//             audio_link: mergedUpload.publicUrl,
//             email_content: JSON.stringify(analysis),
//             end_time: meetingEnd.toISOString(),
//             duration_ms: durationMs,
//             host_audio: hostAudioUrl,
//             participant_audio: JSON.stringify(participantAudioUrls)
//           })
//           .eq('meeting_code', meetingMeta.meetingInfo.meetingCode);
//       }
//         if (updateError) {
//           console.error("❌ Failed to update Supabase meeting:", updateError);
//         } else {
//           console.log(`✅ Supabase row for meeting_id ${meetingId} updated with audio + analysis`);
//         }
//       } else {
//         console.warn("⚠️ No meeting_id provided, skipping Supabase update");
//       }
//     } catch (err) {
//       console.error("❌ Supabase update failed:", err);
//     }

//   } catch (err) {
//     console.error("❌ processMeeting error:", err);
//   } finally {
//     // Cleanup temp files
//     try { await Promise.all(tmpPaths.map(p => safeUnlink(p))); }
//     catch (e) { console.warn("Cleanup warning", e); }
//   }
// }


// // ---------------- Routes ----------------
// router.options('/', (req, res) => res.sendStatus(204));

// router.post('/', upload.any(), async (req, res) => {
//   try {
//     const files = req.files || [];
//     if (!files.length) return res.status(400).json({ ok: false, error: 'No files uploaded' });

//     let meetingMeta = {};
//     if (req.body.meeting) {
//       try { meetingMeta = JSON.parse(req.body.meeting); }
//       catch (err) { console.error("❌ Failed to parse meeting JSON:", err); }
//     }

//     // Upload files to Supabase first
//     const uploads = [];
//     for (const f of files) {
//       const key = `raw/${Date.now()}-${f.originalname}`;
//       const upload = await uploadBufferToSupabase(f.buffer, key, f.mimetype || 'audio/webm');
//       uploads.push({ field: f.fieldname, ...upload });
//     }

//     // Insert job into queue
//     const { data, error } = await supabase
//       .from('meeting_jobs')
//       .insert({
//         meeting_id: meetingMeta.meeting_id || null,
//         payload: {
//           meetingMeta,
//           uploads
//         }
//       })
//       .select();

//     if (error) throw error;

//     res.json({ ok: true, msg: "Job queued successfully", job: data[0] });
//   } catch (err) {
//     console.error("❌ Upload route error:", err);
//     if (!res.headersSent) {
//       res.status(500).json({ ok: false, error: err.message });
//     }
//   }
// });

// export default router;
