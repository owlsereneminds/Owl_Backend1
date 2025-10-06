// process-jobs.ts
declare const Deno: {
  env: { get(key: string): string | undefined };
  serve: (handler: (req: Request) => Response | Promise<Response>) => void;
};

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import OpenAI from "https://deno.land/x/openai@v4.61.0/mod.ts";

// --- Environment Variables ---
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY")!;

// --- Clients ---
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// --- Types ---
interface Job {
  id: string;
  meeting_id: string;
  chunks: string[];
  status: string;
}

// --- Fetch the next pending job ---
async function fetchPendingJob(): Promise<Job | null> {
  const { data, error } = await supabase
    .from<Job>("meeting_jobs")
    .select("*")
    .eq("status", "pending")
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data ?? null;
}

// --- Process a single job ---
async function processJob(job: Job) {
  const { id, meeting_id, chunks } = job;
  console.log(`Processing job ${id}`);

  // Mark job as processing
  await supabase.from("meeting_jobs").update({ status: "processing" }).eq("id", id);

  try {
    // TODO: Replace this with real merging/downloading logic
    const mergedFileUrl = "https://example.com/fake-merged.mp3";

    // Transcription via OpenAI Whisper
    const transcription = await openai.audio.transcriptions.create({
      file: await fetch(mergedFileUrl).then((r) => r.blob()),
      model: "gpt-4o-mini-transcribe",
    });

    const summary = transcription.text.slice(0, 200); // limit summary length

    // Update meeting record
    await supabase
      .from("meetings")
      .update({
        audio_url: mergedFileUrl,
        summary,
      })
      .eq("id", meeting_id);

    // Mark job as done
    await supabase.from("meeting_jobs").update({ status: "done" }).eq("id", id);

    console.log(`✅ Job ${id} done`);
  } catch (err) {
    console.error(`❌ Job ${id} failed:`, err);
    await supabase.from("meeting_jobs").update({ status: "failed" }).eq("id", id);
  }
}

// --- Edge Function entry point ---
Deno.serve(async (req: Request) => {
  try {
    const job = await fetchPendingJob();
    if (job) {
      await processJob(job);
      return new Response(JSON.stringify({ status: "processed", jobId: job.id }), { status: 200 });
    } else {
      console.log("No pending jobs");
      return new Response(JSON.stringify({ status: "no-pending-jobs" }), { status: 200 });
    }
  } catch (err) {
    console.error("Function error:", err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
