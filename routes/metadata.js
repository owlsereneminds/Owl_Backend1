// routes/metadata.js
import express from 'express';
import supabase from '../supabaseClient.js';

const router = express.Router();

router.post('/', async (req, res) => {
  try {
    const metadata = req.body;
    const { meetingInfo, participants, durationMs, endTime } = metadata;

    const { error } = await supabase
      .from('meetings')
      .update({
        end_time: endTime,
        duration_ms: durationMs,
        participants: participants,
      })
      .eq('meeting_code', meetingInfo.meetingCode);

    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
