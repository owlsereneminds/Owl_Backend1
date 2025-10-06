import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import OpenAI from "https://deno.land/x/openai@v4.61.0/mod.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);
const openai = new OpenAI({ apiKey: Deno.env.get("OPENAI_API_KEY")! });

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const EMAIL_FROM = Deno.env.get("EMAIL_FROM")!;
const EMAIL_TO = Deno.env.get("EMAIL_TO")!;

Deno.serve(async (_req) => {
  try {
    console.log("🟢 Checking for pending jobs...");

    const { data: jobs, error } = await supabase
      .from("meeting_jobs")
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(1);

    if (error) throw error;
    if (!jobs?.length) return new Response("No pending jobs", { status: 200 });

    const job = jobs[0];
    console.log("🧩 Processing job:", job.id);

    // lock job
    await supabase
      .from("meeting_jobs")
      .update({ status: "processing", updated_at: new Date().toISOString() })
      .eq("id", job.id);

    // get merged audio URL directly from payload
    const mergedAudio = job.payload?.uploads?.[0]?.publicUrl;
    if (!mergedAudio) throw new Error("Merged audio URL missing in payload");

    // fetch the merged audio
const audioRes = await fetch(mergedAudio);
const audioArrayBuffer = await audioRes.arrayBuffer();

// ✅ must be a File object, not just Blob
const audioFile = new File([audioArrayBuffer], "audio.mp3", { type: "audio/mpeg" });

// 1️⃣ Transcribe with Whisper
const transcription = await openai.audio.transcriptions.create({
  file: audioFile,
  model: "whisper-1",
});


    const transcriptText = transcription.text;

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

    // 3️⃣ Update meetings table if meeting_id exists
    if (job.meeting_id) {
      await supabase
        .from("meetings")
        .update({
          audio_link: mergedAudio,
          email_content: analysis,
          end_time: new Date().toISOString(),
        })
        .eq("id", job.meeting_id);
    }

    // 4️⃣ Update job result
    await supabase
      .from("meeting_jobs")
      .update({ result: { mergedAudio, analysis }, status: "done", updated_at: new Date().toISOString() })
      .eq("id", job.id);

    // 5️⃣ Send email via Resend
    await sendMeetingEmail(mergedAudio, analysis, job);

    return new Response(JSON.stringify({ ok: true, job: job.id }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("❌ process-jobs error:", err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});

async function sendMeetingEmail(mergedAudio: string, analysis: any, job: any) {
  try {
    const meetingTitle = job.meeting_meta?.topic || job.meeting_meta?.title || `Session ${job.session_id}`;
    const subject = `📝 Meeting Summary – ${meetingTitle}`;
    const toEmail = job.meeting_meta?.googleUser?.email  || process.env.EMAIL_TO;

    // Call your Node.js API
    const resp = await fetch('https://owl-backend1.vercel.app/api/send-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        toEmail,
        subject,
        analysis,
        meta: job.meeting_meta,
        duration: job.meeting_meta?.durationMs,
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      console.error('❌ send-email API failed:', err);
    } else {
      console.log('📩 Email sent successfully via Node API to', toEmail);
    }
  } catch (err) {
    console.error('❌ sendMeetingEmail error:', err);
  }
}