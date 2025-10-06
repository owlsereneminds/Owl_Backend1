// worker/processJobs.js
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import { v4 as uuidv4 } from 'uuid';
import OpenAI from 'openai';
import { sendAnalysisEmail } from './emailHelper.js';
import { safeUnlink } from './utils.js';

ffmpeg.setFfmpegPath(ffmpegStatic);

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// poll once and exit (cron-friendly)
async function pollAndProcessOnce() {
    try {
      const { data: jobs, error: fetchErr } = await supabase
        .from('meeting_jobs')
        .select('*')
        .eq('status', 'pending')
        .order('created_at', { ascending: true })
        .limit(1);
  
      if (fetchErr) throw fetchErr;
      if (!jobs || jobs.length === 0) {
        console.log("No pending jobs");
        return;
      }
  
      const job = jobs[0];
      // lock job
      const { error: lockErr } = await supabase
        .from('meeting_jobs')
        .update({ status: 'processing', updated_at: new Date().toISOString() })
        .eq('id', job.id)
        .eq('status', 'pending');
  
      if (lockErr) return console.warn('Failed to lock job', job.id);
  
      await processJob(job);
      await supabase.from('meeting_jobs').update({ status: 'done', updated_at: new Date().toISOString() }).eq('id', job.id);
    } catch (err) {
      console.error('poll error', err);
    }
  }
  
  pollAndProcessOnce().catch(err => { console.error(err); process.exit(1); });
  
async function processJob(job) {
  const tmpPaths = [];
  try {
    // 2) Download all chunk keys to tmp
    for (let i = 0; i < job.chunk_keys.length; i++) {
      const key = job.chunk_keys[i];
      const { data, error } = await supabase.storage.from('meeting_recordings').download(key.replace(/^recordings\//, 'recordings/'));
      if (error) throw error;
      const buffer = await data.arrayBuffer();
      const tmpPath = path.join(os.tmpdir(), `${Date.now()}-${uuidv4()}-chunk-${i}.webm`);
      await fs.promises.writeFile(tmpPath, Buffer.from(buffer));
      tmpPaths.push(tmpPath);
    }

    // 3) Merge
    const mergedName = `merged-${job.session_id}-${uuidv4()}.mp3`;
    const mergedPath = path.join(os.tmpdir(), mergedName);
    await mergeFilesWithFfmpeg(tmpPaths, mergedPath);

    // 4) Upload merged to Supabase
    const mergedBuffer = await fs.promises.readFile(mergedPath);
    const mergedKey = `merged/${mergedName}`;
    const { error: uploadErr } = await supabase.storage.from('meeting_recordings').upload(mergedKey, mergedBuffer, { contentType: 'audio/mpeg', upsert: true });
    if (uploadErr) throw uploadErr;
    const { data: urlData } = supabase.storage.from('meeting_recordings').getPublicUrl(mergedKey);
    const publicUrl = urlData.publicUrl;

    // 5) Transcribe with Whisper (OpenAI)
    const transcription = await openai.audio.transcriptions.create({ file: fs.createReadStream(mergedPath), model: 'whisper-1' });
    const transcriptText = transcription.text;

    // 6) GPT Analysis (reuse your prompts)
    const prompts = {
      summary: `You are an expert clinical assistant. Summarize the following session transcript in clear, concise language. Highlight main themes, client concerns, and any significant progress or challenges. Keep it factual and professional.\n\nTranscript: `,
      soap: `You are a mental health professional writing SOAP notes. Generate structured SOAP notes from the transcript below:\n\nS (Subjective): ...\nTranscript: `,
      tips: `You are a highly experienced psychologist. Based on the transcript below, generate exactly 3 practical, expert-level treatment tips and recommendations. Format:\n1.\n2.\n3.\n\nTranscript: `
    };

    async function runPrompt(prompt) {
      const resp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt + transcriptText }]
      });
      return resp.choices?.[0]?.message?.content ?? '';
    }

    const analysis = {
      transcript: transcriptText,
      summary: await runPrompt(prompts.summary),
      soap: await runPrompt(prompts.soap),
      tips: await runPrompt(prompts.tips)
    };

    // 7) Email
    const hostEmail = job.meeting_meta?.googleUser?.email;
    if (hostEmail) {
      await sendAnalysisEmail(hostEmail, `Owl Meeting Notes - ${job.meeting_meta?.meetingInfo?.meetingTitle || 'Meeting'}`, analysis, mergedPath, './1.png', {
        meetingTitle: job.meeting_meta?.meetingInfo?.meetingTitle,
        participants: job.meeting_meta?.participants || [],
        host: job.meeting_meta?.googleUser?.name || 'Host',
        hostEmail,
        startTime: job.meeting_meta?.startTime,
        endTime: new Date().toISOString(),
        durationMs: job.meeting_meta?.durationMs
      });
    }

    // 8) Update meetings table if meeting_id exists (optional)
    if (job.meeting_id) {
      await supabase.from('meetings').update({
        audio_link: publicUrl,
        email_content: analysis,
        end_time: new Date().toISOString(),
        duration_ms: job.meeting_meta?.durationMs || null
      }).eq('id', job.meeting_id);
    }

    // 9) Write result in job
    await supabase.from('meeting_jobs').update({ result: { mergedKey, publicUrl, analysis }, updated_at: new Date().toISOString() }).eq('id', job.id);

    // cleanup tmp
    await Promise.all(tmpPaths.map(p => safeUnlink(p)).catch(()=>{}));
    await safeUnlink(mergedPath);
  } catch (err) {
    // cleanup
    await Promise.all(tmpPaths.map(p => safeUnlink(p)).catch(()=>{}));
    throw err;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function mergeFilesWithFfmpeg(inputPaths, outPath) {
  return new Promise((resolve, reject) => {
    // create filelist for concat
    const listFile = path.join(os.tmpdir(), `list-${uuidv4()}.txt`);
    const content = inputPaths.map(p => `file '${p}'`).join('\n');
    fs.writeFileSync(listFile, content);
    ffmpeg()
      .input(listFile)
      .inputOptions(['-f concat', '-safe 0'])
      .outputOptions(['-c:a libmp3lame', '-q:a 2'])
      .save(outPath)
      .on('end', () => {
        fs.unlinkSync(listFile);
        resolve(outPath);
      })
      .on('error', err => {
        fs.unlinkSync(listFile);
        reject(err);
      });
  });
}

// start the poller
pollAndProcess().catch(err => { console.error(err); process.exit(1); });
