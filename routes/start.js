// routes/start.js
import express from 'express';
import supabase from '../supabaseClient.js';

const router = express.Router();

router.post('/', async (req, res) => {
  try {
    const { meetingInfo, participants, startTime } = req.body;

    // Insert or update meeting row on conflict by meeting_code
    const { data, error } = await supabase
      .from('meetings')
      .upsert(
        [{ meeting_code: meetingInfo.meetingCode, title: meetingInfo.meetingTitle, start_time: startTime }],
        { onConflict: 'meeting_code' }
      )
      .select();

    if (error) throw error;

    res.json({ success: true, meeting: data[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
