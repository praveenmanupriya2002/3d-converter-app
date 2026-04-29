import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import FormData from "form-data";
import fs from "fs";
import path from "path";
import "dotenv/config";
// sharp තවදුරටත් enhancement සඳහා අවශ්‍ය නැත, නමුත් ඉවත් නොකළත් වරදක් නැත
import sharp from "sharp";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));

// ================= KEYS =================
const TRIPO_API_KEY = process.env.TRIPO_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!TRIPO_API_KEY) {
  console.error("❌ Missing TRIPO_API_KEY in .env file");
  process.exit(1);
}
if (!GEMINI_API_KEY) {
  console.error("❌ Missing GEMINI_API_KEY in .env file");
  process.exit(1);
}

const BASE_URL = "https://api.tripo3d.ai/v2/openapi";
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// ================= STORAGE =================
const outputDir = path.join(process.cwd(), "models");
const metaFile = path.join(outputDir, "meta.json");

if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);
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
      contents: [
        {
          role: "user",
          parts: [
            {
              inlineData: {
                data: base64Image,
                mimeType: "image/jpeg",
              },
            },
            {
              text: `
Analyze this image for 3D reconstruction.

CRITICAL REQUIREMENT:
- Replicate the object EXACTLY as shown in the image.
- Do NOT add, remove, or modify any details.
- Preserve the exact proportions, colors, materials, and textures.
- Output must be a faithful 3D replica, not an artistic interpretation.

Provide detailed description including:
- exact shape & structure
- material (metal, plastic, wood, glass, fabric, etc.)
- color accuracy (match image precisely)
- surface texture (smooth, rough, glossy, matte)
- lighting condition (to infer reflectivity)
- real world usage

AVOID any stylization, exaggeration, or generalization.
              `,
            },
          ],
        },
      ],
    });

    const response = await result.response;
    let prompt = response.text().trim();
    // අමතරව අවධාරණය කිරීම
    prompt += "\n\nIMPORTANT: Generate the model exactly as seen. No changes, no enhancement, no simplification. Exact replica.";
    return prompt;
  } catch (err) {
    console.log("⚠ Gemini fallback used");
    return "Generate an exact 3D replica of the object in the image. No modifications, no stylization. Preserve all original details.";
  }
};

const activeTasks = new Map();

// Helper: Ultra prompt builder - emphasis on "exact"
const buildUltraPrompt = (geminiText) => {
  return `
EXACT 3D REPLICA MODE - NO CHANGES WHATSOEVER

DIRECTIVES:
- Recreate the object precisely as it appears in the input image.
- Do not alter shape, proportions, color, material, or texture.
- Do not add any decorative or missing elements.
- Do not simplify or optimize geometry beyond necessary clean topology.

GEOMETRY: Exact as seen in image.
MATERIALS: Match image's visual properties exactly.
TEXTURE: Use colors and patterns directly from image.

INPUT ANALYSIS:
${geminiText}

OUTPUT: Pixel-perfect 3D replica.
`;
};

// ================= GENERATE 3D MODEL ENDPOINT =================
app.post("/api/generate-3d", async (req, res) => {
  try {
    const { imageBase64 } = req.body;
    if (!imageBase64) {
      return res.status(400).json({ error: "NO_IMAGE" });
    }

    // Decode base64
    const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");
    const originalBuffer = Buffer.from(base64Data, "base64");

    // CHECK IMAGE SIZE (max 8MB)
    if (originalBuffer.length > 8 * 1024 * 1024) {
      return res.status(400).json({ error: "IMAGE_TOO_LARGE", message: "Image exceeds 8MB limit" });
    }

    // !! NO IMAGE ENHANCEMENT – use original buffer directly !!
    const imageBufferForUpload = originalBuffer;

    // Generate prompt using Gemini (based on original image)
    const geminiPrompt = await generatePromptFromImage(originalBuffer.toString("base64"));
    console.log("Gemini Prompt (exact replica mode):", geminiPrompt.substring(0, 500));

    // ================= UPLOAD TO TRIPO =================
    const formData = new FormData();
    formData.append("file", imageBufferForUpload, {
      filename: "image.jpg",
      contentType: "image/jpeg",
    });

    const uploadRes = await fetch(`${BASE_URL}/upload`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TRIPO_API_KEY}`,
      },
      body: formData,
    });

    const uploadData = await uploadRes.json();

    if (!uploadRes.ok || !uploadData?.data?.image_token) {
      console.error("Upload failed:", uploadData);
      return res.status(500).json({
        error: "UPLOAD_FAILED",
        details: uploadData
      });
    }

    const imageToken = uploadData.data.image_token;

    // ================= CREATE TASK =================
    const mode = req.body.mode || "hd"; // HD mode for best fidelity

    const taskBody = {
      type: "image_to_model",
      quality: mode === "hd" ? "high" : "medium",
      texture: true,
      pbr: true,
      topology: "quad",
      object: "single",
      simplify: mode !== "hd",   // No simplification for HD
      prompt: buildUltraPrompt(geminiPrompt),
      file: {
        type: "jpg",
        file_token: imageToken,
      },
    };

    console.log("Task request (exact replica mode):", JSON.stringify(taskBody, null, 2));

    const taskRes = await fetch(`${BASE_URL}/task`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TRIPO_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(taskBody),
    });

    if (!taskRes.ok) {
      const errorData = await taskRes.json().catch(() => ({}));
      console.error("Task creation failed:", taskRes.status, errorData);
      if (taskRes.status === 402) {
        return res.status(402).json({ error: "NO_CREDITS", message: "Not enough Tripo3D credits" });
      }
      return res.status(taskRes.status).json({
        error: "TASK_CREATE_FAILED",
        status: taskRes.status,
        details: errorData
      });
    }

    const taskData = await taskRes.json();

    if (!taskData?.data?.task_id) {
      console.error("Task response missing task_id:", taskData);
      return res.status(500).json({
        error: "TASK_RESPONSE_INVALID",
        debug: taskData
      });
    }

    activeTasks.set(taskData.data.task_id, Date.now());

    res.json({ taskId: taskData.data.task_id, mode: mode });

  } catch (err) {
    console.error("SERVER ERROR:", err);
    res.status(500).json({ error: "SERVER_ERROR", message: err.message });
  }
});

// ================= TASK STATUS ENDPOINT (unchanged) =================
app.get("/api/task-status/:id", async (req, res) => {
  try {
    const taskId = req.params.id;

    const response = await fetch(`${BASE_URL}/task/${taskId}`, {
      headers: { Authorization: `Bearer ${TRIPO_API_KEY}` },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Status fetch failed for ${taskId}:`, response.status, errorText);
      return res.status(response.status).json({ error: "STATUS_FETCH_FAILED", details: errorText });
    }

    const data = await response.json();

    const status = data?.data?.status;
    const progress = data?.data?.progress || 0;

    const extractUrl = (obj) => {
      if (!obj) return null;
      for (const k in obj) {
        const v = obj[k];
        if (typeof v === "string" && v.startsWith("http")) return v;
        if (typeof v === "object") {
          const found = extractUrl(v);
          if (found) return found;
        }
      }
      return null;
    };

    if (status === "success") {
      const modelUrl =
        data?.data?.output?.model ||
        data?.data?.output?.url ||
        data?.data?.output?.file ||
        extractUrl(data?.data?.output);

      if (modelUrl) {
        const fileName = `${taskId}.glb`;
        const filePath = path.join(outputDir, fileName);

        if (!fs.existsSync(filePath)) {
          const fileRes = await fetch(modelUrl);
          if (fileRes.ok) {
            const buffer = Buffer.from(await fileRes.arrayBuffer());
            fs.writeFileSync(filePath, buffer);
            console.log(`✅ Model saved: ${filePath}`);
          } else {
            console.error(`Failed to download model for ${taskId}: ${fileRes.status}`);
          }
        }

        saveMeta({
          taskId,
          modelUrl,
          file: filePath,
          createdAt: new Date().toISOString(),
        });
      }

      activeTasks.delete(taskId);
      return res.json({
        status,
        progress,
        modelUrl,
        localPath: modelUrl ? path.join(outputDir, `${taskId}.glb`) : null,
      });
    }

    if (status === "failed") {
      activeTasks.delete(taskId);
    }

    res.json({ status, progress });

  } catch (err) {
    console.error("STATUS ERROR:", err);
    res.status(500).json({ error: "SERVER_ERROR", message: err.message });
  }
});

// ================= CLEANUP =================
setInterval(() => {
  const now = Date.now();
  for (const [id, time] of activeTasks.entries()) {
    if (now - time > 30 * 60 * 1000) {
      activeTasks.delete(id);
    }
  }
}, 60000);

// ================= START SERVER =================
const PORT = process.env.PORT || 5001;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`✅ API keys: Tripo3D ✓, Gemini ✓`);
  console.log(`🔒 Mode: EXACT REPLICA (no image enhancement, no modifications)`);
});