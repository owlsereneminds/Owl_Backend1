// routes/start.js
import express from 'express';
import supabase from '../supabaseClient.js';

const router = express.Router();

router.post('/', async (req, res) => {
  try {
    const meetingData = req.body;
    console.log("📥 Incoming meetingData:", meetingData);

    const {
      meetingInfo,
      participants,
      engagement,
      startTime,
      googleUser
    } = meetingData;

    // ✅ FIX: use googleUser.sub instead of googleUser.id
    const googleId = googleUser?.sub || googleUser?.id;
    if (!googleId) {
      console.error("❌ Missing Google user ID:", googleUser);
      return res.status(400).json({ error: "Missing Google user ID" });
    }

    // 1️⃣ Ensure User Exists (don't overwrite existing user data)
    const { data: existingUser, error: userError } = await supabase
      .from('users')
      .select('*')
      .eq('google_id', googleUser.sub)
      .single();

    if (userError && userError.code !== 'PGRST116') {
      console.error("❌ Supabase user lookup error:", userError);
      throw userError;
    }

    let userId;
    if (existingUser) {
      console.log("👤 Existing user:", existingUser.email);
      userId = existingUser.id;
    } else {
      console.log("➕ Creating new user:", googleUser.email);
      const { data: newUser, error: insertError } = await supabase
        .from('users')
        .insert([{
          google_id: googleId,   // ✅ use sub
          name: googleUser.name,
          email: googleUser.email,
          picture: googleUser.picture
        }])
        .select()
        .single();

      if (insertError) {
        console.error("❌ Supabase insert user error:", insertError);
        throw insertError;
      }

      console.log("✅ User created:", newUser.email);
      userId = newUser.id;
    }

    // 2️⃣ Insert or Update Meeting
    const { data: meeting, error: meetingError } = await supabase
      .from('meetings')
      .upsert(
        [{
          meeting_code: meetingInfo.meetingCode,
          title: meetingInfo.meetingTitle,
          start_time: startTime,
          participants: participants || [],
          host_id: userId,
          location: meetingData.location || {}
        }],
        { onConflict: 'meeting_code' }
      )
      .select()
      .single();

    if (meetingError) {
      console.error("❌ Supabase meeting upsert error:", meetingError);
      throw meetingError;
    }

    console.log("📊 Meeting saved:", meeting.meeting_code);

    res.json({
      success: true,
      meeting,
      meeting_id: meeting.id,  // ✅ unique meeting id
      user_id: userId
    });

  } catch (err) {
    console.error("❌ Start route error:", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
