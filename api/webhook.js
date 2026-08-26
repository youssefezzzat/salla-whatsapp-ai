export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const t0 = Date.now();

    try {
        const webhookId = req.headers['webhook-id'] || req.headers['x-webhook-id'] || `wh_${Date.now()}`;
        const payload = req.body;
        const userMessage = payload.message || 'عايز أسعار المنتجات';

        // استدعاء جيميناي لوحده للتجربة
        const geminiApiKey = process.env.GEMINI_API_KEY;
        const modelName = 'gemini-1.5-flash';
        const aiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${geminiApiKey}`;

        const aiResponse = await fetch(aiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                system_instruction: { parts: [{ text: "أنت مساعد ذكي ومحترف." }] },
                contents: [{ role: 'user', parts: [{ text: String(userMessage) }] }]
            })
        });

        const aiData = await aiResponse.json();
        let replyText = "أهلاً بك، كيف يمكنني مساعدتك اليوم؟";
        if (aiData && aiData.candidates && aiData.candidates[0]?.content?.parts?.[0]?.text) {
            replyText = aiData.candidates[0].content.parts[0].text;
        }

        const totalTime = Date.now() - t0;

        return res.status(200).json({ 
            status: 'success', 
            webhook_id: webhookId, 
            total_time_ms: totalTime,
            reply: replyText 
        });

    } catch (error) {
        console.error("Error processing webhook:", error);
        return res.status(500).json({ error: error.message || error });
    }
}