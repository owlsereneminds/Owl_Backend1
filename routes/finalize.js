// routes/finalize.js
import express from "express";
import supabase from "../supabaseClient.js";

const router = express.Router();

router.post("/", async (req, res) => {
  try {
    let meetingData = req.body;

    // Handle FormData case from content-script
    if (req.is("multipart/form-data")) {
      const rawMeeting = req.body.meeting || null;
      if (rawMeeting) {
        try {
          meetingData = JSON.parse(rawMeeting);
        } catch (e) {
          console.warn("⚠️ Failed to parse meeting JSON", e);
        }
      }
    }

    console.log("📥 Finalize payload:", meetingData);

    // Extract meeting code with fallbacks
    let meetingCode;
    
    if (meetingData?.meetingInfo?.meetingCode) {
      meetingCode = meetingData.meetingInfo.meetingCode;
    } else if (meetingData?.meetingInfo?.meetUrl) {
      // Extract from URL as fallback
      meetingCode = meetingData.meetingInfo.meetUrl.split('/').pop();
    } else if (meetingData?.meetUrl) {
      meetingCode = meetingData.meetUrl.split('/').pop();
    } else {
      return res.status(400).json({ error: "Missing meeting identification data" });
    }

    const {
      participants = [],
      startTime,
      endTime,
      durationMs
    } = meetingData;

    // Update the meeting
    const { data, error } = await supabase
      .from("meetings")
      .update({
        end_time: endTime,
        duration_ms: durationMs,
        participants: participants,
        finalized_at: new Date().toISOString()
      })
      .eq("meeting_code", meetingCode)
      .select()
      .single();

    if (error) {
      console.error("Supabase error:", error);
      throw error;
    }

    res.json({ success: true, finalized: true, meeting: data });
  } catch (err) {
    console.error("❌ Finalize error:", err);
    res.status(500).json({ error: err.message });
  }
});
export default router;
