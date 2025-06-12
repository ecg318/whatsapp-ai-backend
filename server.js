// -----------------------------------------------------------------------------
// SERVIDOR BACKEND UNIVERSAL - v3 (CORRECCIÓN FINAL)
// -----------------------------------------------------------------------------
// Se corrige el formato del número de teléfono en el webhook de carritos
// para que incluya el símbolo '+' requerido por Twilio.
// -----------------------------------------------------------------------------

// --- 1. IMPORTACIONES Y CONFIGURACIÓN INICIAL ---
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const twilio = require('twilio');
const cron = require('node-cron');
const fetch = require('node-fetch');
const crypto = require('crypto');

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
console.log('Servicios externos configurados.');


// --- 3. LÓGICA DE IA (GEMINI) ---
async function generateResponseWithGemini(query, faqsContext) {
    const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiApiKey}`;
    const full_prompt = `Eres un asistente de IA para un e-commerce español. Tu objetivo es responder preguntas de clientes basándote ÚNICAMENTE en la información de las Preguntas Frecuentes (FAQs). Si la pregunta no se puede responder con las FAQs, pide amablemente más información o di que un agente humano se pondrá en contacto. Sé breve y directo.\n\nPregunta del cliente: "${query}"\n\nFAQs del e-commerce:\n---\n${faqsContext}\n---\n\nBasado en las FAQs, genera una respuesta concisa para el cliente. Si no hay información, indícalo.`;
    const payload = { contents: [{ parts: [{ text: full_prompt }] }], generationConfig: { temperature: 0.2, topP: 0.9, topK: 40 } };
    try {
        const response = await fetch(GEMINI_API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        if (!response.ok) {
            console.error(`Error en la API de Gemini: ${response.status}`, await response.text());
            return "Lo siento, estoy teniendo problemas para conectar con mi cerebro de IA.";
        }
        const result = await response.json();
        return result.candidates?.[0]?.content?.parts?.[0]?.text.trim() || "No he podido generar una respuesta. Un agente revisará tu mensaje.";
    } catch (error) {
        console.error("Error fatal llamando a Gemini:", error);
        return "Ocurrió un error al procesar tu solicitud.";
    }
}


// --- 4. MIDDLEWARE DE AUTENTICACIÓN POR API KEY ---
const authenticateApiKey = async (req, res, next) => {
    const apiKey = req.get('X-API-Key');
    if (!apiKey) {
        return res.status(401).send('Error: Falta la cabecera X-API-Key.');
    }
    try {
        const snapshot = await db.collection('clientes').where('apiKey', '==', apiKey).limit(1).get();
        if (snapshot.empty) {
            return res.status(403).send('Error: API Key no válida.');
        }
        req.tiendaId = snapshot.docs[0].id;
        next();
    } catch (error) {
        console.error("Error en la autenticación por API Key:", error);
        return res.status(500).send('Error interno del servidor.');
    }
};


// --- 5. ENDPOINTS (WEBHOOKS) ---
app.post('/whatsapp-webhook', async (req, res) => {
    res.status(200).send('EVENT_RECEIVED');
    const { From: from, Body: body, To: shopWhatsappNumber } = req.body;
    try {
        const snapshot = await db.collection('clientes').where('whatsapp', '==', shopWhatsappNumber).limit(1).get();
        if (snapshot.empty) return;
        const shopData = snapshot.docs[0].data();
        const responseMessage = (shopData.faqs && shopData.faqs.trim() !== '') 
            ? await generateResponseWithGemini(body, shopData.faqs)
            : 'Hola, gracias por contactar. Un agente revisará tu mensaje pronto.';
        await twilioClient.messages.create({ from: shopWhatsappNumber, to: from, body: responseMessage });
        console.log(`Respuesta de IA enviada a ${from}`);
    } catch (error) {
        console.error('Error procesando el webhook de WhatsApp:', error);
    }
});

app.post('/api/webhooks/carrito-abandonado', authenticateApiKey, async (req, res) => {
    res.status(200).send('Webhook de carrito abandonado recibido');
    const { clienteTelefono, urlRecuperacion, productos } = req.body;
    if (!clienteTelefono || !urlRecuperacion || !productos) {
        return res.status(400).send('Faltan datos en el cuerpo de la petición.');
    }
    try {
        const newAbandonedCart = {
            tiendaId: req.tiendaId,
            // ¡CORRECCIÓN! Se añade el '+' para el formato E.164 de Twilio.
            cliente: `whatsapp:+${clienteTelefono.replace(/ /g, '')}`,
            productos: productos,
            urlRecuperacion: urlRecuperacion,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            recuperado: false,
            estadoMensaje: 'pendiente'
        };
        const docRef = await db.collection('carritosAbandonados').add(newAbandonedCart);
        console.log(`Carrito abandonado ${docRef.id} guardado para la tienda ${req.tiendaId}.`);
    } catch (error) {
        console.error('Error al guardar el carrito abandonado:', error);
    }
});

app.post('/api/webhooks/pedido-creado', authenticateApiKey, async (req, res) => {
    res.status(200).send('Webhook de pedido recibido');
    const { clienteTelefono } = req.body;
    if (!clienteTelefono) {
        return res.status(400).send('Falta el teléfono del cliente.');
    }
    // ¡CORRECCIÓN! Se añade el '+' para que la búsqueda coincida.
    const formattedPhone = `whatsapp:+${clienteTelefono.replace(/ /g, '')}`;
    try {
        const cartsRef = db.collection('carritosAbandonados');
        const snapshot = await cartsRef
            .where('tiendaId', '==', req.tiendaId)
            .where('cliente', '==', formattedPhone)
            .where('recuperado', '==', false)
            .limit(1)
            .get();
        if (snapshot.empty) {
            console.log(`No se encontraron carritos pendientes para el cliente ${formattedPhone} en la tienda ${req.tiendaId}.`);
            return;
        }
        const cartDoc = snapshot.docs[0];
        await cartDoc.ref.update({ recuperado: true });
        console.log(`¡ÉXITO! Carrito ${cartDoc.id} marcado como recuperado.`);
    } catch(error) {
        console.error('Error al verificar la recuperación del carrito:', error);
    }
});


// --- 6. TAREAS PROGRAMADAS (CRON) ---
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
    } catch (error) {
        console.error('CRON: Error general al buscar carritos abandonados:', error);
    }
});


// --- 7. INICIO DEL SERVIDOR ---
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en el puerto ${PORT}`);
  console.log('El sistema unificado de Asistente de IA y Recuperación de Carritos está activo.');
});
