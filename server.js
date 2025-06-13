// -----------------------------------------------------------------------------
// SERVIDOR BACKEND UNIVERSAL - v6.1 (COMPLETO CON PAGOS DE STRIPE)
// -----------------------------------------------------------------------------
// Esta es la versión completa y unificada del servidor, incluyendo:
// - Webhook de WhatsApp con IA (Gemini) y alertas a humanos.
// - Webhooks universales para carritos y pedidos.
// - Tarea programada (Cron Job) para recordatorios.
// - Endpoints para crear y confirmar pagos con Stripe.
// -----------------------------------------------------------------------------

// --- 1. IMPORTACIONES Y CONFIGURACIÓN INICIAL ---
require('dotenv').config();
const express = require('express');
const admin = require('firebase-admin');
const twilio = require('twilio');
const cron = require('node-cron');
const fetch = require('node-fetch');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();

// --- ¡IMPORTANTE! El webhook de Stripe necesita el body "raw".
// Este middleware debe ir ANTES de que express.json() procese el cuerpo.
app.post('/stripe-webhook', express.raw({type: 'application/json'}));

// Middlewares para el resto de las rutas
app.use(express.json());
app.use(express.urlencoded({ extended: false }));


// --- 2. INICIALIZACIÓN DE SERVICIOS ---
const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();
console.log('Firebase conectado correctamente.');

const twilioAccountSid = process.env.TWILIO_ACCOUNT_SID;
const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;
const twilioClient = new twilio(twilioAccountSid, twilioAuthToken);
const geminiApiKey = process.env.GEMINI_API_KEY;
const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
console.log('Servicios externos configurados.');


// --- 3. LÓGICA DE NOTIFICACIÓN, IA, ETC. ---

async function saveMessageToConversation(conversationId, author, text, tiendaId) {
    const conversationRef = db.collection('conversaciones').doc(conversationId);
    await conversationRef.set({
        tiendaId: tiendaId,
        lastUpdate: admin.firestore.FieldValue.serverTimestamp(),
        customerPhone: conversationId
    }, { merge: true });
    const messageRef = conversationRef.collection('mensajes').doc();
    await messageRef.set({ author, text, timestamp: admin.firestore.FieldValue.serverTimestamp() });
}

async function notifyHuman(shopData, conversationId) {
    if (!shopData.telefonoAlertas) {
        console.log(`ALERTA HUMANA: La tienda ${shopData.nombre} no tiene un teléfono de alertas configurado.`);
        return;
    }
    let fullFrontendUrl = frontendUrl;
    if (!fullFrontendUrl.startsWith('http')) {
        fullFrontendUrl = `https://${fullFrontendUrl}`;
    }
    const conversationLink = `${fullFrontendUrl}/conversations/${encodeURIComponent(conversationId)}`;
    const alertMessage = `¡Atención! Un cliente (${conversationId.replace('whatsapp:','')}) necesita ayuda. La IA no ha podido responder.\n\nPuedes leer la conversación aquí:\n${conversationLink}`;
    try {
        const ownerPhone = `whatsapp:+${shopData.telefonoAlertas.replace(/\D/g, '')}`;
        await twilioClient.messages.create({
            from: shopData.whatsapp,
            to: ownerPhone,
            body: alertMessage
        });
        console.log(`Alerta de intervención humana enviada a la tienda ${shopData.nombre}`);
    } catch (error) {
        console.error(`Error al enviar la alerta de WhatsApp a la tienda ${shopData.nombre}:`, error.message);
    }
}

async function generateResponseWithGemini(query, faqsContext) {
    const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiApiKey}`;
    const full_prompt = `Eres un asistente de IA para un e-commerce español. Tu objetivo es responder preguntas de clientes basándote ÚNICAMENTE en la información de las Preguntas Frecuentes (FAQs). REGLAS IMPORTANTES: 1. Si puedes responder, hazlo breve y directo. 2. Si no, tu ÚNICA respuesta debe ser la palabra exacta: [HUMAN_TAKEOVER] 3. No saludes ni te despidas si la respuesta es [HUMAN_TAKEOVER]. Pregunta del cliente: "${query}" FAQs del e-commerce:\n---\n${faqsContext}\n---`;
    const payload = { contents: [{ parts: [{ text: full_prompt }] }], generationConfig: { temperature: 0.1 } };
    try {
        const response = await fetch(GEMINI_API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        if (!response.ok) return "[HUMAN_TAKEOVER]";
        const result = await response.json();
        return result.candidates?.[0]?.content?.parts?.[0]?.text.trim() || "[HUMAN_TAKEOVER]";
    } catch (error) {
        console.error("Error fatal llamando a Gemini:", error);
        return "[HUMAN_TAKEOVER]";
    }
}


// --- 4. ENDPOINTS ---

// Middleware de Autenticación por API Key
const authenticateApiKey = async (req, res, next) => {
    const apiKey = req.get('X-API-Key');
    if (!apiKey) return res.status(401).send('Error: Falta la cabecera X-API-Key.');
    try {
        const snapshot = await db.collection('clientes').where('apiKey', '==', apiKey).limit(1).get();
        if (snapshot.empty) return res.status(403).send('Error: API Key no válida.');
        req.tiendaId = snapshot.docs[0].id;
        next();
    } catch (error) { return res.status(500).send('Error interno del servidor.'); }
};

// Webhook para mensajes de WhatsApp
app.post('/whatsapp-webhook', async (req, res) => {
    res.status(200).send('EVENT_RECEIVED');
    const { From: from, Body: body, To: shopWhatsappNumber } = req.body;
    try {
        const snapshot = await db.collection('clientes').where('whatsapp', '==', shopWhatsappNumber).limit(1).get();
        if (snapshot.empty) return;
        const shopDoc = snapshot.docs[0];
        const shopData = shopDoc.data();
        await saveMessageToConversation(from, 'user', body, shopDoc.id);
        let responseMessage;
        if (shopData.faqs && shopData.faqs.trim() !== '') {
            const aiResponse = await generateResponseWithGemini(body, shopData.faqs);
            if (aiResponse === '[HUMAN_TAKEOVER]') {
                responseMessage = "Entiendo. Un agente se pondrá en contacto contigo para ayudarte. Gracias.";
                await notifyHuman(shopData, from);
            } else {
                responseMessage = aiResponse;
            }
        } else {
            responseMessage = 'Hola, gracias por contactar. Un agente revisará tu mensaje pronto.';
            await notifyHuman(shopData, from); 
        }
        await saveMessageToConversation(from, 'bot', responseMessage, shopDoc.id);
        await twilioClient.messages.create({ from: shopWhatsappNumber, to: from, body: responseMessage });
        console.log(`Respuesta enviada a ${from}`);
    } catch (error) {
        console.error('Error procesando el webhook de WhatsApp:', error);
    }
});

// Webhooks para E-commerce
app.post('/api/webhooks/carrito-abandonado', authenticateApiKey, async (req, res) => {
    res.status(200).send('Recibido');
    const { clienteTelefono, urlRecuperacion, productos } = req.body;
    if (!clienteTelefono || !urlRecuperacion || !productos) return;
    try {
        const newAbandonedCart = { tiendaId: req.tiendaId, cliente: `whatsapp:+${clienteTelefono.replace(/\D/g, '')}`, productos, urlRecuperacion, timestamp: admin.firestore.FieldValue.serverTimestamp(), recuperado: false, estadoMensaje: 'pendiente' };
        await db.collection('carritosAbandonados').add(newAbandonedCart);
    } catch (error) { console.error('Error al guardar carrito:', error); }
});

app.post('/api/webhooks/pedido-creado', authenticateApiKey, async (req, res) => {
    res.status(200).send('Recibido');
    const { clienteTelefono } = req.body;
    if (!clienteTelefono) return;
    const formattedPhone = `whatsapp:+${clienteTelefono.replace(/\D/g, '')}`;
    try {
        const snapshot = await db.collection('carritosAbandonados').where('tiendaId', '==', req.tiendaId).where('cliente', '==', formattedPhone).where('recuperado', '==', false).limit(1).get();
        if (snapshot.empty) return;
        await snapshot.docs[0].ref.update({ recuperado: true });
    } catch(error) { console.error('Error al verificar recuperación:', error); }
});

// Endpoints para Stripe
app.post('/create-checkout-session', async (req, res) => {
    const { priceId, userId } = req.body;
    if (!priceId || !userId) return res.status(400).send({ error: 'Falta el ID del precio o el ID del usuario.'});
    try {
        const session = await stripe.checkout.sessions.create({
            mode: 'subscription',
            line_items: [{ price: priceId, quantity: 1 }],
            client_reference_id: userId,
            success_url: `${frontendUrl}?payment_success=true`,
            cancel_url: `${frontendUrl}`,
        });
        res.send({ sessionId: session.id });
    } catch (e) {
        res.status(400).send({ error: { message: e.message } });
    }
});

app.post('/stripe-webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userId = session.client_reference_id;
      if (!userId) return res.status(400).send('Client reference ID is missing.');
      
      const lineItems = await stripe.checkout.sessions.listLineItems(session.id, { limit: 1 });
      const priceId = lineItems.data[0].price.id;

      // Lógica para determinar el plan basado en el priceId
      let planName = 'esencial';
      if (priceId === process.env.STRIPE_PRICE_ID_PROFESIONAL) planName = 'profesional';
      if (priceId === process.env.STRIPE_PRICE_ID_PREMIUM) planName = 'premium';

      const userRef = db.collection('clientes').doc(userId);
      await userRef.update({
        plan: planName,
        stripeCustomerId: session.customer,
        status: 'active'
      });
      console.log(`Plan '${planName}' activado para el usuario: ${userId}`);
  }
  res.status(200).send();
});


// --- 5. TAREAS PROGRAMADAS (CRON) ---
cron.schedule('*/5 * * * *', async () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    try {
        const snapshot = await db.collection('carritosAbandonados').where('estadoMensaje', '==', 'pendiente').where('timestamp', '<=', oneHourAgo).get();
        if (snapshot.empty) return;
        for (const doc of snapshot.docs) {
            const cart = doc.data();
            const shopDoc = await db.collection('clientes').doc(cart.tiendaId).get();
            if (!shopDoc.exists) continue;
            const message = `¡Hola! Vimos que dejaste "${cart.productos[0].nombre}" en tu carrito. Puedes completar tu compra aquí: ${cart.urlRecuperacion}`;
            await twilioClient.messages.create({ from: shopDoc.data().whatsapp, to: cart.cliente, body: message });
            await doc.ref.update({ estadoMensaje: 'recordatorio_enviado' });
        }
    } catch (error) { console.error('CRON Error:', error); }
});


// --- 6. INICIO DEL SERVIDOR ---
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en el puerto ${PORT}`);
});
