import express from "express";
import serverless from "serverless-http";
import fetch from "node-fetch";
import FormData from "form-data";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();
app.use(express.json({ limit: "25mb" }));

// ================= KEYS =================
const TRIPO_API_KEY = process.env.TRIPO_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!TRIPO_API_KEY || !GEMINI_API_KEY) {
  console.error("❌ Missing API keys in environment");
}

const BASE_URL = "https://api.tripo3d.ai/v2/openapi";
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// ================= STORAGE (Netlify environment හි temporary disk එකේ) =================
const outputDir = "/tmp/models";
const metaFile = "/tmp/models/meta.json";

if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
if (!fs.existsSync(metaFile)) fs.writeFileSync(metaFile, JSON.stringify([]));

const saveMeta = (data) => {
  const existing = JSON.parse(fs.readFileSync(metaFile));
  existing.unshift(data);
  fs.writeFileSync(metaFile, JSON.stringify(existing, null, 2));
};

// ================= GEMINI PROMPT (exact replication) =================
const generatePromptFromImage = async (base64Image) => {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const result = await model.generateContent({
      contents: [{
        role: "user",
        parts: [
          { inlineData: { data: base64Image, mimeType: "image/jpeg" } },
          { text: `Analyze this image for 3D reconstruction... (your full prompt)` }
        ]
      }]
    });
    return result.response.text().trim();
  } catch (err) {
    return "Generate an exact 3D replica...";
  }
};

const buildUltraPrompt = (geminiText) => {
  return `EXACT 3D REPLICA MODE... ${geminiText}`;
};

// ================= GENERATE ENDPOINT =================
app.post("/api/generate-3d", async (req, res) => {
  try {
    const { imageBase64 } = req.body;
    if (!imageBase64) return res.status(400).json({ error: "NO_IMAGE" });

    const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");
    const originalBuffer = Buffer.from(base64Data, "base64");
    if (originalBuffer.length > 8 * 1024 * 1024)
      return res.status(400).json({ error: "IMAGE_TOO_LARGE" });

    const imageBufferForUpload = originalBuffer;

    const geminiPrompt = await generatePromptFromImage(originalBuffer.toString("base64"));
    console.log("Gemini Prompt:", geminiPrompt.substring(0, 200));

    // Upload to Tripo
    const formData = new FormData();
    formData.append("file", imageBufferForUpload, { filename: "image.jpg", contentType: "image/jpeg" });
    const uploadRes = await fetch(`${BASE_URL}/upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TRIPO_API_KEY}` },
      body: formData
    });
    const uploadData = await uploadRes.json();
    if (!uploadRes.ok || !uploadData?.data?.image_token)
      return res.status(500).json({ error: "UPLOAD_FAILED" });

    const imageToken = uploadData.data.image_token;
    const mode = req.body.mode || "hd";

    const taskBody = {
      type: "image_to_model",
      quality: mode === "hd" ? "high" : "medium",
      texture: true,
      pbr: true,
      topology: "quad",
      object: "single",
      simplify: mode !== "hd",
      prompt: buildUltraPrompt(geminiPrompt),
      file: { type: "jpg", file_token: imageToken }
    };

    const taskRes = await fetch(`${BASE_URL}/task`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TRIPO_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(taskBody)
    });
    const taskData = await taskRes.json();
    if (!taskRes.ok && taskRes.status === 402)
      return res.status(402).json({ error: "NO_CREDITS" });
    if (!taskData?.data?.task_id)
      return res.status(500).json({ error: "TASK_RESPONSE_INVALID" });

    res.json({ taskId: taskData.data.task_id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ================= TASK STATUS ENDPOINT =================
app.get("/api/task-status/:id", async (req, res) => {
  try {
    const taskId = req.params.id;
    const response = await fetch(`${BASE_URL}/task/${taskId}`, {
      headers: { Authorization: `Bearer ${TRIPO_API_KEY}` }
    });
    const data = await response.json();
    const status = data?.data?.status;
    const progress = data?.data?.progress || 0;
    const modelUrl = data?.data?.output?.model || data?.data?.output?.url || null;
    res.json({ status, progress, modelUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================= EXPORT SERVERLESS FUNCTION =================
export const handler = serverless(app);