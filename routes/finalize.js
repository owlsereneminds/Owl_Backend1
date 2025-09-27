// routes/finalize.js
import express from 'express';
import supabase from '../supabaseClient.js';

const router = express.Router();

router.post('/', async (req, res) => {
  try {
    const { meetingCode, endedAt } = req.body;

    const { error } = await supabase
      .from('meetings')
      .update({ finalized_at: endedAt })
      .eq('meeting_code', meetingCode);

    if (error) throw error;

    res.json({ success: true, finalized: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
