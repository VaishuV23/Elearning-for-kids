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

// ---- at the top, after your requires ----

const allowedOrigins = [
  'https://elearning-for-kids.onrender.com',
  // 'https://india-therapist-chatbot.onrender.com',
  'http://localhost:3000',
  'http://localhost:5173'
];

app.use(cors({
  origin: allowedOrigins,
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','Accept','X-Requested-With'],
  credentials: true,
}));

app.options('*', cors({
  origin: allowedOrigins,
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','Accept','X-Requested-With'],
  credentials: true,
}));



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
app.post('/api/ask', upload.single('audio'), async (req, res) => {
  // Decide mode: stream when query ?stream=1 OR Accept: text/event-stream
  const wantsStream =
    String(req.query.stream || '').trim() === '1' ||
    /text\/event-stream/i.test(req.headers.accept || '');

  // Small helper for CORS echo (useful for SSE over some hosts)
  const origin = req.headers.origin;
if (origin && allowedOrigins.includes(origin)) {
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization'
  );
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET,POST,OPTIONS'
  );
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}


  try {
    // -------- Parse inputs (multipart/form-data or JSON) --------
    const body = req.body || {};
    const answerLanguage = (body.answerLanguage || '').trim();
    const speakLanguage  = (body.speakLanguage  || '').trim();
    const conversationId = (body.conversationId || '').trim();
    const uid            = (body.uid || '').trim();

    // History
    let clientHistory = [];
    if (body.history) {
      try {
        clientHistory = typeof body.history === 'string' ? JSON.parse(body.history) : body.history;
        if (!Array.isArray(clientHistory)) clientHistory = [];
      } catch {
        clientHistory = [];
      }
    }

    // Basic validation
    if (!conversationId) {
      return wantsStream
        ? sseError(res, 400, 'missing_conversation', 'No conversationId.')
        : res.status(400).json({ error: 'missing_conversation', message: 'No conversationId.' });
    }
    if (!answerLanguage || !speakLanguage) {
      return wantsStream
        ? sseError(res, 400, 'missing_language', 'Please select both Speaking and Answer languages.')
        : res.status(400).json({ error: 'missing_language', message: 'Please select both Speaking and Answer languages.' });
    }
    if (uid && req.firebaseUser && req.firebaseUser.uid && uid !== req.firebaseUser.uid) {
      return wantsStream
        ? sseError(res, 401, 'unauthenticated', 'UID does not match.')
        : res.status(401).json({ error: 'unauthenticated', message: 'UID does not match.' });
    }

    // -------- Determine input text (STT if audio present) --------
    let userText = '';
    if (req.file && req.file.buffer && req.file.size >= 5000) {
      const stt = await openai.audio.transcriptions.create({
        file: await toFile(req.file.buffer, 'speech.webm', { type: 'audio/webm' }),
        model: STT_MODEL,
        language: ISO[speakLanguage] || undefined,
        prompt: `This is a child speaking ${speakLanguage} about school topics. Keep output in ${speakLanguage}.`
      });
      userText = (stt.text || '').trim();
    } else if (body.text && typeof body.text === 'string' && body.text.trim()) {
      userText = body.text.trim();
    } else {
      return wantsStream
        ? sseError(res, 400, 'no_input', 'No valid audio or text provided.')
        : res.status(400).json({ error: 'no_input', message: 'No valid audio or text provided.' });
    }

    // Optional transcript cleanup
    if (CLEAN_TRANSCRIPT && userText) {
      const cleaned = await openai.responses.create({
        model: 'gpt-5',
        input: [
          { role: 'system', content: `Fix obvious transcription errors in ${speakLanguage} child speech. Return only the corrected text.` },
          { role: 'user', content: userText }
        ]
      });
      userText = (cleaned.output_text || userText).trim();
    }

    // -------- Compose messages --------
    const MAX_TURNS = 6;
    const safeHistory = clientHistory.slice(-MAX_TURNS * 2);
    const systemPrompt =
      `You are a ${answerLanguage} kids e-learning helper for Indian kids. ` +
      `Use very simple words, short sentences, warm tone. ` +
      `Use chat history for continuity and clarify doubts with tiny examples. ` +
      `Avoid adult/harmful content. Always answer in ${answerLanguage}.`;

    const messages = [
      { role: 'system', content: systemPrompt },
      ...safeHistory,
      { role: 'user', content: userText }
    ];

    // =====================================================================
    // STREAMING MODE (SSE)
    // =====================================================================
    if (wantsStream) {
      // SSE headers
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();

      // SSE helpers
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      const endWith = (obj) => { try { send(obj); } finally { res.end(); } };

      let fullAssistantText = '';

      try {
        // Stream assistant text token-by-token
        const stream = await openai.chat.completions.create({
          model: 'gpt-5',
          messages,
          // temperature: 0.3,
          
          stream: true
        });

        for await (const chunk of stream) {
          const token = chunk?.choices?.[0]?.delta?.content || '';
          if (token) {
            fullAssistantText += token;
            send({ type: 'delta', delta: token });
          }
        }
        send({ type: 'message_end' });

        // Optional TTS (emit when ready)
        let base64Audio = '';
        try {
          const speech = await openai.audio.speech.create({
            model: 'gpt-4o-mini-tts',
            voice: 'alloy',
            input: fullAssistantText,
            format: 'mp3'
          });
          base64Audio = Buffer.from(await speech.arrayBuffer()).toString('base64');
          if (base64Audio) send({ type: 'tts', audioBase64: base64Audio });
        } catch (ttsErr) {
          send({ type: 'tts_error', message: String(ttsErr?.message || ttsErr) });
        }

        // Firestore logging (best-effort)
        if (adminApp && uid) {
          try {
            const db = admin.firestore();
            const chatRef = db.collection('users').doc(uid).collection('chats').doc(conversationId);
            await chatRef.set({ updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
            await chatRef.collection('messages').add({
              role: 'user',
              content: userText,
              speakLanguage,
              answerLanguage,
              createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
            await chatRef.collection('messages').add({
              role: 'assistant',
              content: fullAssistantText,
              speakLanguage,
              answerLanguage,
              createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
          } catch (e) {
            send({ type: 'warn', message: 'history_write_failed' });
          }
        }

        // Final “done” summary for clients that want a single close-out object
        endWith({ type: 'done', transcript: userText, text: fullAssistantText });
      } catch (err) {
        endWith({ type: 'error', message: err?.message || 'processing_failed' });
      }
      return; // SSE path ends here
    }

    // =====================================================================
    // NON-STREAMING (JSON) — original behavior preserved
    // =====================================================================
    const resp = await openai.responses.create({ model: 'gpt-5', input: messages });
    const assistantText = (resp.output_text || '').trim();

    let base64Audio = '';
    try {
      const speech = await openai.audio.speech.create({
        model: 'gpt-4o-mini-tts',
        voice: 'alloy',
        input: assistantText,
        format: 'mp3'
      });
      base64Audio = Buffer.from(await speech.arrayBuffer()).toString('base64');
    } catch (ttsErr) {
      console.warn('TTS failed; returning text only', ttsErr?.message || ttsErr);
      base64Audio = '';
    }

    if (adminApp && uid) {
      try {
        const db = admin.firestore();
        const chatRef = db.collection('users').doc(uid).collection('chats').doc(conversationId);
        await chatRef.set({ updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        await chatRef.collection('messages').add({
          role: 'user',
          content: userText,
          speakLanguage,
          answerLanguage,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        await chatRef.collection('messages').add({
          role: 'assistant',
          content: assistantText,
          speakLanguage,
          answerLanguage,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      } catch (e) {
        console.error('Failed to write history to Firestore:', e);
      }
    }

    res.json({
      conversationId,
      transcript: userText,
      text: assistantText,
      audioBase64: base64Audio
    });
  } catch (err) {
    const msg = (err?.error?.message || err?.message || '').toLowerCase();
    if (msg.includes('shorter than') || msg.includes('too short')) {
      return res.status(400).json({ error: 'audio_too_short', message: 'Audio too short. Please record at least 1 second.' });
    }
    if (msg.includes('invalid') && msg.includes('language')) {
      return res.status(400).json({ error: 'invalid_language', message: 'Unsupported language code.' });
    }
    console.error('API error:', err);
    return res.status(500).json({ error: 'processing_failed', message: 'Something went wrong while processing input.' });
  }

  // ---- helpers (local to this route) ----
  function sseError(res, code, error, message) {
    res.statusCode = code;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    res.write(`data: ${JSON.stringify({ type: 'error', error, message })}\n\n`);
    return res.end();
  }
});

// ---------- Start ----------
const port = process.env.PORT || 3000;
app.listen(port, () =>
  console.log(`Server running on port ${port}. STT_MODEL=${STT_MODEL}`)
);
