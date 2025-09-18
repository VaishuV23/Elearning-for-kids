import express from 'express';
import cors from 'cors';
import multer from 'multer';
import OpenAI from 'openai';
import { toFile } from 'openai/uploads';
import admin from 'firebase-admin';

/*
 * This server implements the back‑end API used by the Kid Speak & Learn
 * application.  It supports both voice and text inputs, verifies Firebase ID
 * tokens passed from the client, and stores chat history in Firestore using
 * the Firebase Admin SDK when credentials are provided.  The API accepts
 * multipart/form-data for audio recordings or JSON for typed requests.  It
 * performs speech‑to‑text using the Whisper model, generates an assistant
 * response via OpenAI, performs text‑to‑speech to return an audio reply,
 * then returns a JSON payload containing the assistant’s text and
 * base64‑encoded audio.  On success the conversation turn is also persisted
 * to Firestore under the authenticated user’s document.
 */

// Initialise Firebase Admin only if service account JSON is provided via
// FIREBASE_ADMIN_JSON environment variable.  Without credentials the
// Firestore write operations will be silently skipped.
let adminApp;
try {
  const adminJson = process.env.FIREBASE_ADMIN_JSON ? JSON.parse(process.env.FIREBASE_ADMIN_JSON) : null;
  if (adminJson) {
    adminApp = admin.initializeApp({ credential: admin.credential.cert(adminJson) });
  }
} catch (e) {
  console.error('Failed to initialise Firebase Admin:', e);
}

const app = express();

const STT_MODEL = process.env.STT_MODEL || 'whisper-1';
const CLEAN_TRANSCRIPT = String(process.env.CLEAN_TRANSCRIPT || 'false').toLowerCase() === 'true';

// Allow cross‑origin requests from the hosted front‑ends
app.use(cors({
  origin: [
    'https://india-therapist-chatbot.onrender.com',
    'https://krishnan-govindan.github.io'
  ],
  methods: ['GET', 'POST']
}));

const upload = multer({ storage: multer.memoryStorage() });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Serve static files for the front‑end (e.g. index.html)
app.use(express.static('.'));
// Allow JSON bodies on POST requests
app.use(express.json());

// Verify Firebase ID tokens if sent by the client.  The decoded UID is
// available on req.firebaseUser for downstream handlers.  If the token is
// missing or invalid, req.firebaseUser will be null and unauthenticated
// requests will still be processed, but the server will not write
// conversation history to Firestore.
async function verifyFirebaseToken(req, res, next) {
  const authHdr = req.headers.authorization || '';
  const tokenMatch = authHdr.match(/^Bearer\s+(.*)$/i);
  if (tokenMatch && adminApp) {
    const idToken = tokenMatch[1];
    try {
      const decoded = await admin.auth().verifyIdToken(idToken);
      req.firebaseUser = decoded;
    } catch (e) {
      console.warn('Invalid Firebase token:', e?.message || e);
      req.firebaseUser = null;
    }
  } else {
    req.firebaseUser = null;
  }
  next();
}
app.use(verifyFirebaseToken);

// Map of language names to ISO codes for Whisper.  Values correspond to
// supported language codes in the Whisper speech‑to‑text API.
const ISO = {
  English:'en', Hindi:'hi', Tamil:'ta', Telugu:'te', Kannada:'kn',
  Malayalam:'ml', Marathi:'mr', Gujarati:'gu', Bengali:'bn',
  Punjabi:'pa', Panjabi:'pa'
};

/**
 * POST /api/ask
 *
 * Accepts either an audio recording or a typed question along with the
 * selected languages and conversation context.  Performs speech‑to‑text
 * when audio is provided, generates a response using GPT, converts the
 * response to speech and returns both the text and audio to the client.  A
 * valid Firebase UID and ID token must be provided for history to be
 * persisted.
 */
app.post('/api/ask', upload.single('audio'), async (req, res) => {
  try {
    // Extract fields from multipart/form-data or JSON body
    const body = req.body || {};
    const answerLanguage = (body.answerLanguage || '').trim();
    const speakLanguage  = (body.speakLanguage  || '').trim();
    const conversationId = (body.conversationId || '').trim();
    const uid            = (body.uid || '').trim();
    // Parse conversation history if provided
    let clientHistory = [];
    if (body.history) {
      try {
        clientHistory = typeof body.history === 'string' ? JSON.parse(body.history) : body.history;
        if (!Array.isArray(clientHistory)) clientHistory = [];
      } catch {
        clientHistory = [];
      }
    }
    // Validate required fields
    if (!conversationId) {
      return res.status(400).json({ error: 'missing_conversation', message: 'No conversationId provided.' });
    }
    if (!answerLanguage || !speakLanguage) {
      return res.status(400).json({ error: 'missing_language', message: 'Please select both Speaking and Answer languages.' });
    }
    // If an ID token was verified, ensure the provided UID matches
    if (uid && req.firebaseUser && req.firebaseUser.uid && uid !== req.firebaseUser.uid) {
      return res.status(401).json({ error: 'unauthenticated', message: 'UID does not match authenticated user.' });
    }
    // Determine the user’s input: either from audio or from the text field
    let userText = '';
    if (req.file && req.file.buffer && req.file.size >= 5000) {
      // Speech‑to‑text via Whisper
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
      return res.status(400).json({ error: 'no_input', message: 'No valid audio or text provided.' });
    }
    // Optional cleanup using GPT to correct obvious transcription errors
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
    // Prepare safe history: last six turns (≈12 messages)
    const MAX_TURNS = 6;
    const safeHistory = clientHistory.slice(-MAX_TURNS * 2);
    // Compose system prompt and messages for the assistant
    const systemPrompt =
      `You are a ${answerLanguage} kids e-learning helper for Indian kids. ` +
      `This API key is for child-friendly education. Use very simple words, short sentences, warm tone. ` +
      `Use the chat history to keep continuity and clarify doubts with tiny examples. ` +
      `Avoid adult/harmful content. Always answer in ${answerLanguage}.`;
    const messages = [
      { role: 'system', content: systemPrompt },
      ...safeHistory,
      { role: 'user', content: userText }
    ];
    // Generate assistant text via GPT
    const resp = await openai.responses.create({ model: 'gpt-5', input: messages });
    const assistantText = (resp.output_text || '').trim();
    // Text‑to‑speech using OpenAI.  If unsupported, skip audio.
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
    // Persist history to Firestore if admin credentials and UID are present
    if (adminApp && uid) {
      try {
        const db = admin.firestore();
        const chatRef = db.collection('users').doc(uid).collection('chats').doc(conversationId);
        // ensure chat document exists; update updatedAt and maybe title
        await chatRef.set({ updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        // Save user message
        await chatRef.collection('messages').add({
          role: 'user',
          content: userText,
          speakLanguage,
          answerLanguage,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        // Save assistant message
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
    // Respond to client
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
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}. STT_MODEL=${STT_MODEL} CLEAN_TRANSCRIPT=${CLEAN_TRANSCRIPT}`));
