// -----------------------------------------------------------------------------
// SERVIDOR BACKEND UNIVERSAL - v5 (con Historial y Alertas Reales)
// -----------------------------------------------------------------------------
// - Guarda cada mensaje en una nueva colección 'conversaciones' en Firestore.
// - La función notifyHuman ahora envía un WhatsApp real al dueño de la tienda.
// -----------------------------------------------------------------------------

// --- 1. IMPORTACIONES Y CONFIGURACIÓN INICIAL ---
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const twilio = require('twilio');
const cron = require('node-cron');
const fetch = require('node-fetch');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

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
const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000'; // URL de tu app en Vercel
console.log('Servicios externos configurados.');

// --- 3. LÓGICA DE NOTIFICACIÓN Y CONVERSACIÓN ---

/**
 * Guarda un mensaje en el historial de una conversación.
 * @param {string} conversationId - El ID de la conversación (usaremos el número del cliente).
 * @param {string} author - Quién envía el mensaje ('user' o 'bot').
 * @param {string} text - El contenido del mensaje.
 * @param {string} tiendaId - El ID de la tienda a la que pertenece la conversación.
 */
async function saveMessageToConversation(conversationId, author, text, tiendaId) {
    const conversationRef = db.collection('conversaciones').doc(conversationId);
    await conversationRef.set({
        tiendaId: tiendaId,
        lastUpdate: admin.firestore.FieldValue.serverTimestamp(),
        customerPhone: conversationId // Guardamos el número del cliente
    }, { merge: true });

    const messageRef = conversationRef.collection('mensajes').doc();
    await messageRef.set({
        author,
        text,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
}


/**
 * Notifica al dueño de la tienda que se requiere su intervención.
 * @param {object} shopData - Los datos del documento de la tienda desde Firebase.
 * @param {string} conversationId - El ID de la conversación (número del cliente).
 */
async function notifyHuman(shopData, conversationId) {
    if (!shopData.telefonoAlertas) {
        console.log(`ALERTA HUMANA: La tienda ${shopData.nombre} no tiene un teléfono de alertas configurado.`);
        return;
    }
    
    const conversationLink = `${frontendUrl}/conversations/${conversationId}`;
    const alertMessage = `¡Atención! Un cliente (${conversationId.replace('whatsapp:','')}) necesita ayuda. La IA no ha podido responder.\n\nPuedes leer la conversación aquí:\n${conversationLink}`;

    try {
        await twilioClient.messages.create({
            from: shopData.whatsapp, // Desde el número del bot de la tienda
            to: `whatsapp:${shopData.telefonoAlertas}`, // Al número del dueño de la tienda
            body: alertMessage
        });
        console.log(`Alerta de intervención humana enviada a la tienda ${shopData.nombre}`);
    } catch (error) {
        console.error(`Error al enviar la alerta de WhatsApp a la tienda ${shopData.nombre}:`, error);
    }
}


// --- 4. LÓGICA DE IA (GEMINI) ---
async function generateResponseWithGemini(query, faqsContext) {
    const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiApiKey}`;
    const full_prompt = `Eres un asistente de IA para un e-commerce español. Tu objetivo es responder preguntas de clientes basándote ÚNICAMENTE en la información de las Preguntas Frecuentes (FAQs). REGLAS IMPORTANTES: 1. Si puedes responder la pregunta con las FAQs, hazlo de forma breve y directa. 2. Si la pregunta es demasiado compleja, ambigua o no se puede responder con las FAQs, tu ÚNICA respuesta debe ser la palabra exacta: [HUMAN_TAKEOVER] 3. No saludes ni te despidas si la respuesta es [HUMAN_TAKEOVER]. Solo devuelve esa palabra. Pregunta del cliente: "${query}" FAQs del e-commerce:\n---\n${faqsContext}\n---`;
    const payload = { contents: [{ parts: [{ text: full_prompt }] }], generationConfig: { temperature: 0.1 } };
    try {
        const response = await fetch(GEMINI_API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        if (!response.ok) {
            console.error(`Error en la API de Gemini: ${response.status}`, await response.text());
            return "[HUMAN_TAKEOVER]";
        }
        const result = await response.json();
        return result.candidates?.[0]?.content?.parts?.[0]?.text.trim() || "[HUMAN_TAKEOVER]";
    } catch (error) {
        console.error("Error fatal llamando a Gemini:", error);
        return "[HUMAN_TAKEOVER]";
    }
}


// --- 5. ENDPOINTS Y MIDDLEWARE ---
app.post('/whatsapp-webhook', async (req, res) => {
    res.status(200).send('EVENT_RECEIVED');
    const { From: from, Body: body, To: shopWhatsappNumber } = req.body;
    
    try {
        const snapshot = await db.collection('clientes').where('whatsapp', '==', shopWhatsappNumber).limit(1).get();
        if (snapshot.empty) return;
        
        const shopDoc = snapshot.docs[0];
        const shopData = shopDoc.data();
        const tiendaId = shopDoc.id;

        // Guardar el mensaje del usuario en el historial
        await saveMessageToConversation(from, 'user', body, tiendaId);
        
        let responseMessage;
        
        if (shopData.faqs && shopData.faqs.trim() !== '') {
            const aiResponse = await generateResponseWithGemini(body, shopData.faqs);
            
            if (aiResponse === '[HUMAN_TAKEOVER]') {
                responseMessage = "Entiendo. Un agente de nuestro equipo se pondrá en contacto contigo por este mismo chat para ayudarte personalmente. Gracias por tu paciencia.";
                await notifyHuman(shopData, from);
            } else {
                responseMessage = aiResponse;
            }
        } else {
            responseMessage = 'Hola, gracias por contactar. Un agente revisará tu mensaje pronto.';
            await notifyHuman(shopData, from); // Si no hay FAQs, siempre notificar
        }
        
        // Guardar la respuesta del bot en el historial
        await saveMessageToConversation(from, 'bot', responseMessage, tiendaId);

        await twilioClient.messages.create({ from: shopWhatsappNumber, to: from, body: responseMessage });
        console.log(`Respuesta enviada a ${from}`);
    } catch (error) {
        console.error('Error procesando el webhook de WhatsApp:', error);
    }
});

// --- (El resto de endpoints y el cron job no tienen cambios) ---
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
app.post('/api/webhooks/carrito-abandonado', authenticateApiKey, async (req, res) => {
    res.status(200).send('Webhook de carrito abandonado recibido');
    const { clienteTelefono, urlRecuperacion, productos } = req.body;
    if (!clienteTelefono || !urlRecuperacion || !productos) { return res.status(400).send('Faltan datos.'); }
    try {
        const newAbandonedCart = { tiendaId: req.tiendaId, cliente: `whatsapp:+${clienteTelefono.replace(/ /g, '')}`, productos, urlRecuperacion, timestamp: admin.firestore.FieldValue.serverTimestamp(), recuperado: false, estadoMensaje: 'pendiente' };
        await db.collection('carritosAbandonados').add(newAbandonedCart);
        console.log(`Carrito abandonado guardado para la tienda ${req.tiendaId}.`);
    } catch (error) { console.error('Error al guardar el carrito abandonado:', error); }
});
app.post('/api/webhooks/pedido-creado', authenticateApiKey, async (req, res) => {
    res.status(200).send('Webhook de pedido recibido');
    const { clienteTelefono } = req.body;
    if (!clienteTelefono) { return res.status(400).send('Falta el teléfono del cliente.'); }
    const formattedPhone = `whatsapp:+${clienteTelefono.replace(/ /g, '')}`;
    try {
        const snapshot = await db.collection('carritosAbandonados').where('tiendaId', '==', req.tiendaId).where('cliente', '==', formattedPhone).where('recuperado', '==', false).limit(1).get();
        if (snapshot.empty) return;
        await snapshot.docs[0].ref.update({ recuperado: true });
        console.log(`¡ÉXITO! Carrito ${snapshot.docs[0].id} marcado como recuperado.`);
    } catch(error) { console.error('Error al verificar la recuperación del carrito:', error); }
});
cron.schedule('*/5 * * * *', async () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    try {
        const snapshot = await db.collection('carritosAbandonados').where('estadoMensaje', '==', 'pendiente').where('timestamp', '<=', oneHourAgo).get();
        if (snapshot.empty) return;
        for (const doc of snapshot.docs) {
            const cart = doc.data();
            const shopDoc = await db.collection('clientes').doc(cart.tiendaId).get();
            if (!shopDoc.exists) continue;
            const shopWhatsappNumber = shopDoc.data().whatsapp;
            const message = `¡Hola! Vimos que dejaste "${cart.productos[0].nombre}" en tu carrito. ¿Tuviste algún problema? Puedes completar tu compra aquí: ${cart.urlRecuperacion}`;
            await twilioClient.messages.create({ from: shopWhatsappNumber, to: cart.cliente, body: message });
            await doc.ref.update({ estadoMensaje: 'recordatorio_enviado' });
            console.log(`CRON: Recordatorio enviado para el carrito ${doc.id}.`);
        }
    } catch (error) { console.error('CRON: Error general al buscar carritos abandonados:', error); }
});
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en el puerto ${PORT}`);
});
