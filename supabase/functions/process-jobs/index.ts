import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import OpenAI from "https://deno.land/x/openai@v4.61.0/mod.ts";
const supabase = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
const openai = new OpenAI({
  apiKey: Deno.env.get("OPENAI_API_KEY")
});
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const EMAIL_FROM = Deno.env.get("EMAIL_FROM");
const EMAIL_TO = Deno.env.get("EMAIL_TO");
Deno.serve(async (_req)=>{
  try {
    console.log("🟢 Checking for pending jobs...");
    const { data: jobs, error } = await supabase.from("meeting_jobs").select("*").eq("status", "pending").order("created_at", {
      ascending: true
    }).limit(1);
    if (error) throw error;
    if (!jobs?.length) return new Response("No pending jobs", {
      status: 200
    });
    const job = jobs[0];
    console.log("🧩 Processing job:", job.id);
    // lock job
    await supabase.from("meeting_jobs").update({
      status: "processing",
      updated_at: new Date().toISOString()
    }).eq("id", job.id);
    // get merged audio URL directly from payload
    const mergedAudio = job.payload?.uploads?.[0]?.publicUrl;
    if (!mergedAudio) throw new Error("Merged audio URL missing in payload");
    // fetch the merged audio
    const audioRes = await fetch(mergedAudio);
    const audioArrayBuffer = await audioRes.arrayBuffer();
    // ✅ must be a File object, not just Blob
    const audioFile = new File([
      audioArrayBuffer
    ], "audio.mp3", {
      type: "audio/mpeg"
    });
    // 1️⃣ Transcribe with Whisper
    const transcription = await openai.audio.transcriptions.create({
      file: audioFile,
      model: "whisper-1"
    });
    const transcriptText = transcription.text;
    const prompts = {
      summary: `You are an expert clinical assistant. Summarize the following session transcript in clear, concise language. 
    Since the transcript only includes the psychologist’s dialogue, infer the client’s concerns, emotions, and responses from the psychologist’s statements and questions. 
    The transcript may be multilingual (English, Hindi, Hinglish) and can contain minor transcription errors. Normalize the meaning into clear English without quoting or relying on exact phrasing. 
    Highlight the main themes of the session, the likely client concerns, and any significant progress or challenges discussed. 
    Keep the summary factual, professional, and entirely in English. Avoid assumptions beyond what can be reasonably inferred.

    Transcript: `,
      soap: `You are a mental health professional writing SOAP notes. 
    The transcript below only contains the psychologist’s dialogue. 
    Carefully infer the client’s reported concerns and context based on the psychologist’s statements, reflections, and interventions. 
    The transcript may be multilingual (English, Hindi, Hinglish) and may include minor transcription errors. 
    Normalize into clear English and do not quote or reproduce transcription errors.

   S (Subjective): Summarize the client’s self-reported concerns, feelings, and symptoms as inferred.  
   O (Objective): Note observable or implied behaviors, mood, and clinician’s observations.  
   A (Assessment): Provide clinical impressions, themes, and progress inferred from the session.  
   P (Plan): Outline next steps, interventions, or recommendations.  

   Ensure clarity, professionalism, and avoid adding unsupported details.  

  Transcript:`,
      tips: `You are a therapist providing guidance. The transcript below only contains the psychologist’s dialogue. 
   Infer the client’s challenges and needs from the psychologist’s statements and generate tailored treatment tips and practical recommendations. 
   The transcript may be multilingual (English, Hindi, Hinglish) and may include minor transcription errors. Interpret meaning accurately and present guidance in clear English without quoting or reproducing raw transcription.  
   Make the tips empathetic, actionable, and evidence-based. Focus on coping strategies, skill-building, and next steps that align with the inferred context of the session.

  Transcript:`
    };
    async function runPrompt(prompt) {
      const resp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "user",
            content: prompt + transcriptText
          }
        ]
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
      await supabase.from("meetings").update({
        audio_link: mergedAudio,
        email_content: analysis,
        end_time: new Date().toISOString()
      }).eq("id", job.meeting_id);
    }
    // 4️⃣ Update job result
    await supabase.from("meeting_jobs").update({
      result: {
        mergedAudio,
        analysis
      },
      status: "done",
      updated_at: new Date().toISOString()
    }).eq("id", job.id);
    // 5️⃣ Send email via Resend
    await sendMeetingEmail(mergedAudio, analysis, job);
    return new Response(JSON.stringify({
      ok: true,
      job: job.id
    }), {
      headers: {
        "Content-Type": "application/json"
      }
    });
  } catch (err) {
    console.error("❌ process-jobs error:", err);
    return new Response(JSON.stringify({
      error: String(err)
    }), {
      status: 500
    });
  }
});
async function sendMeetingEmail(mergedAudio, analysis, job) {
  try {
    const meetingTitle = job.meeting_meta?.googleUser?.name;
    const subject = `Meeting Summary – ${meetingTitle}`;
    const toEmail = job.meeting_meta?.googleUser?.email;
    // Call your Node.js API
    const resp = await fetch('https://owl-backend1.vercel.app/api/send-email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        toEmail,
        subject,
        analysis,
        meta: job.meeting_meta,
        duration: job.meeting_meta?.durationMs
      })
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
