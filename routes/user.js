// backend/routes/users.js
import express from "express";
import supabase from "../supabaseClient.js";

const router = express.Router();

// Register or fetch user
router.post("/auth/google", async (req, res) => {
  const { google_id, name, email, picture } = req.body;

  if (!google_id || !email) {
    return res.status(400).json({ error: "Missing google_id or email" });
  }

  try {
    // 1. Check if user exists
    const { data: existingUser, error: findError } = await supabase
      .from("users")
      .select("*")
      .or(`google_id.eq.${google_id},email.eq.${email}`)
      .single();

    if (findError && findError.code !== "PGRST116") {
      // PGRST116 = no rows found
      throw findError;
    }

    if (existingUser) {
      return res.json({ user: existingUser, message: "User already exists" });
    }

    // 2. Insert new user
    const { data: newUser, error: insertError } = await supabase
      .from("users")
      .insert([{ google_id, name, email, picture }])
      .select()
      .single();

    if (insertError) throw insertError;

    return res.json({ user: newUser, message: "User created successfully" });
  } catch (err) {
    console.error("Error in user auth:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
