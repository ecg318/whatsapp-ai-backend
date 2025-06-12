// -----------------------------------------------------------------------------
// SERVIDOR BACKEND UNIVERSAL - v4 (con Alerta Humana)
// -----------------------------------------------------------------------------
// Se mejora el prompt de la IA para que pueda solicitar la intervención
// de un humano cuando no conoce la respuesta.
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

// --- ¡NUEVA FUNCIÓN! ---
/**
 * Notifica al dueño de la tienda que se requiere su intervención.
 * @param {object} shopData - Los datos del documento de la tienda desde Firebase.
 * @param {string} customerQuery - La pregunta original del cliente.
 * @param {string} customerPhone - El número de teléfono del cliente.
 */
async function notifyHuman(shopData, customerQuery, customerPhone) {
    console.log(`---! ALERTA HUMANA PARA LA TIENDA: ${shopData.nombre} !---`);
    console.log(`El cliente ${customerPhone} ha preguntado: "${customerQuery}"`);
    console.log(`La IA no ha podido responder. Notificando al dueño...`);
    
    // --- LÓGICA DE NOTIFICACIÓN REAL IRÍA AQUÍ ---
    // Por ejemplo, para enviar un email con SendGrid:
    // const emailText = `Un cliente (${customerPhone}) necesita ayuda con la siguiente pregunta: "${customerQuery}"`;
    // await sendEmail(shopData.ownerEmail, "Asistencia Requerida", emailText);
    
    // O para enviar un WhatsApp al dueño de la tienda (si tenemos su número):
    // if (shopData.ownerPhone) {
    //   await twilioClient.messages.create({
    //     from: shopData.whatsapp, // Desde el número del bot
    //     to: `whatsapp:${shopData.ownerPhone}`, // Al número del dueño
    //     body: `¡Atención! Cliente (${customerPhone}) necesita ayuda: "${customerQuery}"`
    //   });
    // }
    console.log('----------------------------------------------------');
}


// --- 3. LÓGICA DE IA (GEMINI) - ¡PROMPT MEJORADO! ---
async function generateResponseWithGemini(query, faqsContext) {
    const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiApiKey}`;
    
    // Se añaden instrucciones para escalar a un humano
    const full_prompt = `Eres un asistente de IA para un e-commerce español. Tu objetivo es responder preguntas de clientes basándote ÚNICAMENTE en la información de las Preguntas Frecuentes (FAQs).
    
    REGLAS IMPORTANTES:
    1. Si puedes responder la pregunta con las FAQs, hazlo de forma breve y directa.
    2. Si la pregunta es demasiado compleja, ambigua o no se puede responder con las FAQs, tu ÚNICA respuesta debe ser la palabra exacta: [HUMAN_TAKEOVER]
    3. No saludes ni te despidas si la respuesta es [HUMAN_TAKEOVER]. Solo devuelve esa palabra.

    Pregunta del cliente: "${query}"

    FAQs del e-commerce:
    ---
    ${faqsContext}
    ---
    `;
    const payload = { contents: [{ parts: [{ text: full_prompt }] }], generationConfig: { temperature: 0.1, topP: 0.9, topK: 40 } };
    try {
        const response = await fetch(GEMINI_API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        if (!response.ok) {
            console.error(`Error en la API de Gemini: ${response.status}`, await response.text());
            return "Lo siento, estoy teniendo problemas técnicos. Un agente lo revisará.";
        }
        const result = await response.json();
        return result.candidates?.[0]?.content?.parts?.[0]?.text.trim() || "[HUMAN_TAKEOVER]"; // Si no hay respuesta, escalar por seguridad.
    } catch (error) {
        console.error("Error fatal llamando a Gemini:", error);
        return "Ocurrió un error al procesar tu solicitud.";
    }
}


// --- 4. MIDDLEWARE Y ENDPOINTS ---
const authenticateApiKey = async (req, res, next) => {
    // (Sin cambios)
    const apiKey = req.get('X-API-Key');
    if (!apiKey) return res.status(401).send('Error: Falta la cabecera X-API-Key.');
    try {
        const snapshot = await db.collection('clientes').where('apiKey', '==', apiKey).limit(1).get();
        if (snapshot.empty) return res.status(403).send('Error: API Key no válida.');
        req.tiendaId = snapshot.docs[0].id;
        next();
    } catch (error) {
        return res.status(500).send('Error interno del servidor.');
    }
};

app.post('/whatsapp-webhook', async (req, res) => {
    res.status(200).send('EVENT_RECEIVED');
    const { From: from, Body: body, To: shopWhatsappNumber } = req.body;
    
    try {
        const snapshot = await db.collection('clientes').where('whatsapp', '==', shopWhatsappNumber).limit(1).get();
        if (snapshot.empty) return;
        
        const shopDoc = snapshot.docs[0];
        const shopData = shopDoc.data();
        
        let responseMessage = 'Hola, gracias por contactar. Un agente revisará tu mensaje pronto.';
        
        if (shopData.faqs && shopData.faqs.trim() !== '') {
            const aiResponse = await generateResponseWithGemini(body, shopData.faqs);
            
            // --- ¡NUEVA LÓGICA DE DECISIÓN! ---
            if (aiResponse === '[HUMAN_TAKEOVER]') {
                responseMessage = "Entiendo. Es una pregunta específica. Un agente de nuestro equipo se pondrá en contacto contigo por este mismo chat para ayudarte personalmente. Gracias por tu paciencia.";
                // Llamamos a la función para notificar al dueño de la tienda
                await notifyHuman(shopData, body, from);
            } else {
                responseMessage = aiResponse; // Usamos la respuesta directa de la IA
            }
        }
        
        await twilioClient.messages.create({ from: shopWhatsappNumber, to: from, body: responseMessage });
        console.log(`Respuesta enviada a ${from}`);
    } catch (error) {
        console.error('Error procesando el webhook de WhatsApp:', error);
    }
});


// --- (El resto de endpoints y el cron job no tienen cambios) ---
app.post('/api/webhooks/carrito-abandonado', authenticateApiKey, async (req, res) => {
    res.status(200).send('Webhook de carrito abandonado recibido');
    const { clienteTelefono, urlRecuperacion, productos } = req.body;
    if (!clienteTelefono || !urlRecuperacion || !productos) {
        return res.status(400).send('Faltan datos en el cuerpo de la petición.');
    }
    try {
        const newAbandonedCart = {
            tiendaId: req.tiendaId,
            cliente: `whatsapp:+${clienteTelefono.replace(/ /g, '')}`,
            productos,
            urlRecuperacion,
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
    const formattedPhone = `whatsapp:+${clienteTelefono.replace(/ /g, '')}`;
    try {
        const cartsRef = db.collection('carritosAbandonados');
        const snapshot = await cartsRef.where('tiendaId', '==', req.tiendaId).where('cliente', '==', formattedPhone).where('recuperado', '==', false).limit(1).get();
        if (snapshot.empty) return;
        const cartDoc = snapshot.docs[0];
        await cartDoc.ref.update({ recuperado: true });
        console.log(`¡ÉXITO! Carrito ${cartDoc.id} marcado como recuperado.`);
    } catch(error) {
        console.error('Error al verificar la recuperación del carrito:', error);
    }
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
    } catch (error) {
        console.error('CRON: Error general al buscar carritos abandonados:', error);
    }
});
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en el puerto ${PORT}`);
  console.log('El sistema unificado de Asistente de IA y Recuperación de Carritos está activo.');
});
