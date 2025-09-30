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
        summary: `You are an expert clinical assistant. Summarize the following session transcript in clear, concise language. 
        Since the transcript only includes the psychologist’s dialogue, infer the client’s concerns, emotions, and responses from the psychologist’s statements and questions. 
        Highlight the main themes of the session, the likely client concerns, and any significant progress or challenges discussed. Keep the summary factual, professional, and entirely in English. 
        Do not include opinions or assumptions beyond what can be reasonably inferred.

       Transcript: `,
    
        soap: `You are a mental health professional writing SOAP notes. 
        The transcript below only contains the psychologist’s dialogue. 
        Carefully infer the client’s reported concerns and context based on the psychologist’s statements, reflections, and interventions.
    
    S (Subjective): Summarize the client’s self-reported concerns, feelings, and symptoms as inferred.
    O (Objective): Note observable or implied behaviors, mood, and clinician’s observations.
    A (Assessment): Provide clinical impressions, themes, and progress inferred from the session.
    P (Plan): Outline next steps, interventions, or recommendations.

    Ensure clarity, professionalism, and avoid adding details not reasonably supported by the transcript.
    
    Transcript: `,
    
        tips: `You are a therapist providing guidance. The transcript below only contains the psychologist’s dialogue. 
        Infer the client’s challenges and needs from the psychologist’s statements and generate tailored treatment tips and practical recommendations. 
        Make them empathetic, actionable, and evidence-based. Focus on coping strategies, skill-building, and next steps that align with the inferred context of the session.
    
    Transcript: `
    };
    
  return {
    transcript: transcriptText,
    summary: await runPrompt(prompts.summary, transcriptText),
    soap: await runPrompt(prompts.soap, transcriptText),
    tips: await runPrompt(prompts.tips, transcriptText)
  };
}
