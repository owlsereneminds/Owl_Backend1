// in finalize.js (for example)
import express from "express";
import { processMeeting } from "./workers/ProcessMeetings.js";

const router = express.Router();

router.post("/", async (req, res) => {
  try {
    const result = await processMeeting(req.body); 
    res.json(result);
  } catch (err) {
    console.error("❌ finalize error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
