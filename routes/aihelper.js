import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function transcribeAudio(filePath) {
  const resp = await openai.audio.transcriptions.create({
    file: fs.createReadStream(filePath),
    model: "whisper-1"
  });
  return resp.text;
}

async function runPrompt(prompt, transcript) {
  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt + transcript }]
  });
  return resp.choices?.[0]?.message?.content ?? '';
}

export async function analyzeTranscript(transcriptText) {
    const prompts = { 
        summary: `You are an expert clinical assistant. 
    Summarize the following session transcript in clear, concise language. 
    Highlight main themes, client concerns, and any significant progress or challenges. 
    Keep it factual and professional.
    
    Transcript: `,
    
        soap: `You are a mental health professional writing SOAP notes. 
    Generate structured SOAP notes from the transcript below:
    
    S (Subjective): Client’s self-reported concerns, feelings, and symptoms.
    O (Objective): Observable behaviors, mood, and clinician’s observations.
    A (Assessment): Clinical impressions, patterns, and progress.
    P (Plan): Next steps, interventions, or recommendations.
    
    Transcript: `,
    
        tips: `You are a therapist providing guidance. 
    Based on the transcript below, generate treatment tips and practical recommendations tailored to the client. 
    Keep them empathetic, actionable, and evidence-based.
    
    Transcript: `
    };
    
  return {
    transcript: transcriptText,
    summary: await runPrompt(prompts.summary, transcriptText),
    soap: await runPrompt(prompts.soap, transcriptText),
    tips: await runPrompt(prompts.tips, transcriptText)
  };
}
