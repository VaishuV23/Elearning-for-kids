// server.js
import express from "express";
import cors from "cors";
import multer from "multer";
import OpenAI from "openai";
import { toFile } from "openai/uploads";
import admin from "firebase-admin";
// import "dotenv/config";

// ---------- Firebase Admin (optional) ----------
let adminApp;
try {
  const adminJson = process.env.FIREBASE_ADMIN_JSON
    ? JSON.parse(process.env.FIREBASE_ADMIN_JSON)
    : null;
  if (adminJson) {
    adminApp = admin.initializeApp({
      credential: admin.credential.cert(adminJson),
    });
  }
} catch (e) {
  console.error("Failed to initialise Firebase Admin:", e);
}

// ---------- App & Config ----------
const app = express();
const STT_MODEL = process.env.STT_MODEL || "whisper-1";
const CLEAN_TRANSCRIPT =
  String(process.env.CLEAN_TRANSCRIPT || "false").toLowerCase() === "true";

// ---- CORS (must be before any routes/middleware) ----
const allowedOrigins = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "https://elearning-for-kids.onrender.com", // add if you use this GH Pages domain
  "https://krishnan-govindan.github.io",
  
];

const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true);            // allow curl/Postman (no CORS)
    const ok = allowedOrigins.includes(origin);
    return cb(ok ? null : new Error("CORS blocked"), ok);
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: false,
};

// apply SAME options for normal & preflight
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// helpful for caches/CDNs
app.use((req, res, next) => {
  res.setHeader("Vary", "Origin");
  next();
});

const upload = multer({ storage: multer.memoryStorage() });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(express.static("."));
app.use(express.json());

// ---------- Optional Firebase token verify ----------
async function verifyFirebaseToken(req, res, next) {
  const authHdr = req.headers.authorization || "";
  const tokenMatch = authHdr.match(/^Bearer\s+(.*)$/i);
  if (tokenMatch && adminApp) {
    try {
      const decoded = await admin.auth().verifyIdToken(tokenMatch[1]);
      req.firebaseUser = decoded;
    } catch (e) {
      console.warn("Invalid Firebase token:", e?.message || e);
      req.firebaseUser = null;
    }
  } else {
    req.firebaseUser = null;
  }
  next();
}
app.use(verifyFirebaseToken);

// ---------- Language ISO map ----------
const ISO = {
  English: "en",
  Hindi: "hi",
  Tamil: "ta",
  Telugu: "te",
  Kannada: "kn",
  Malayalam: "ml",
  Marathi: "mr",
  Gujarati: "gu",
  Bengali: "bn",
  Punjabi: "pa",
  Panjabi: "pa",
};

// ---------- Main route (SSE streaming) ----------
app.post("/api/ask", upload.single("audio"), async (req, res) => {
  try {
    const body = req.body || {};
    const answerLanguage = (body.answerLanguage || "").trim();
    const speakLanguage = (body.speakLanguage || "").trim();
    const conversationId = (body.conversationId || "").trim();
    const uid = (body.uid || "").trim();

    let clientHistory = [];
    if (body.history) {
      try {
        clientHistory =
          typeof body.history === "string"
            ? JSON.parse(body.history)
            : body.history;
        if (!Array.isArray(clientHistory)) clientHistory = [];
      } catch {
        clientHistory = [];
      }
    }

    if (!conversationId) {
      return res
        .status(400)
        .json({ error: "missing_conversation", message: "No conversationId." });
    }
    if (!answerLanguage || !speakLanguage) {
      return res.status(400).json({
        error: "missing_language",
        message: "Please select both Speaking and Answer languages.",
      });
    }
    if (
      uid &&
      req.firebaseUser &&
      req.firebaseUser.uid &&
      uid !== req.firebaseUser.uid
    ) {
      return res
        .status(401)
        .json({ error: "unauthenticated", message: "UID does not match." });
    }

    // ---- Input (audio or text) ----
    let userText = "";
    if (req.file && req.file.buffer && req.file.size >= 5000) {
      const stt = await openai.audio.transcriptions.create({
        file: await toFile(req.file.buffer, "speech.webm", {
          type: "audio/webm",
        }),
        model: STT_MODEL,
        language: ISO[speakLanguage] || undefined,
        prompt: `This is a child speaking ${speakLanguage} about school topics. Keep output in ${speakLanguage}.`,
      });
      userText = (stt.text || "").trim();
    } else if (body.text && typeof body.text === "string" && body.text.trim()) {
      userText = body.text.trim();
    } else {
      return res
        .status(400)
        .json({ error: "no_input", message: "No valid audio or text provided." });
    }

    // ---- Optional transcript cleanup ----
    if (CLEAN_TRANSCRIPT && userText) {
      const cleaned = await openai.responses.create({
        model: "gpt-4o",
        input: [
          {
            role: "system",
            content: `Fix obvious transcription errors in ${speakLanguage} child speech.`,
          },
          { role: "user", content: userText },
        ],
      });
      userText = (cleaned.output_text || userText).trim();
    }

    const MAX_TURNS = 6;
    const safeHistory = clientHistory.slice(-MAX_TURNS * 2);

    const systemPrompt =
      `You are a ${answerLanguage} kids e-learning helper for Indian kids. ` +
      `Use very simple words, short sentences, warm tone. ` +
      `Use chat history for continuity and clarify doubts with tiny examples. ` +
      `Avoid adult/harmful content. Always answer in ${answerLanguage}.`;

    const messages = [
      { role: "system", content: systemPrompt },
      ...safeHistory,
      { role: "user", content: userText },
    ];

    // ---- SSE headers (plus echo CORS for safety) ----
    const origin = req.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    }
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    // ---- Stream assistant text ----
    let fullAssistantText = "";
    const stream = await openai.chat.completions.create({
      model: "gpt-4o",
      messages,
      stream: true,
    });

    for await (const chunk of stream) {
      const token = chunk.choices?.[0]?.delta?.content || "";
      fullAssistantText += token;
      res.write(`data: ${token}\n\n`);
    }

    res.write("data: [END]\n\n");
    res.end();

    // ---- Async TTS (non-blocking) ----
    process.nextTick(async () => {
      try {
        const speech = await openai.audio.speech.create({
          model: "gpt-4o-mini-tts",
          voice: "alloy",
          input: fullAssistantText,
          format: "mp3",
        });
        // Example: convert to base64 if you plan to store/forward
        const base64Audio = Buffer.from(await speech.arrayBuffer()).toString(
          "base64"
        );
        // TODO: save to Firestore/Storage or push over WS if needed
        void base64Audio;
      } catch (ttsErr) {
        console.warn("TTS failed:", ttsErr?.message || ttsErr);
      }
    });

    // ---- Async Firestore logging (non-blocking) ----
    if (adminApp && uid) {
      process.nextTick(async () => {
        try {
          const db = admin.firestore();
          const chatRef = db
            .collection("users")
            .doc(uid)
            .collection("chats")
            .doc(conversationId);

          await chatRef.set(
            { updatedAt: admin.firestore.FieldValue.serverTimestamp() },
            { merge: true }
          );

          await chatRef.collection("messages").add({
            role: "user",
            content: userText,
            speakLanguage,
            answerLanguage,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });

          await chatRef.collection("messages").add({
            role: "assistant",
            content: fullAssistantText,
            speakLanguage,
            answerLanguage,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        } catch (e) {
          console.error("Firestore write failed:", e);
        }
      });
    }
  } catch (err) {
    console.error("API error:", err);
    if (!res.headersSent) {
      res
        .status(500)
        .json({ error: "processing_failed", message: "Something went wrong." });
    }
  }
});

// ---------- Start ----------
const port = process.env.PORT || 3000;
app.listen(port, () =>
  console.log(`Server running on port ${port}. STT_MODEL=${STT_MODEL}`)
);
