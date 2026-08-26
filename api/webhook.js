export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const t0 = Date.now();

    try {
        const webhookId = req.headers['webhook-id'] || req.headers['x-webhook-id'] || `wh_${Date.now()}`;
        const payload = req.body;

        if (payload.from_me) {
            return res.status(200).json({ status: 'skipped_from_me' });
        }

        let userMessage, customerName;
        const eventType = payload.event || 'chat_message';

        if (eventType === 'order.created' && payload.data) {
            customerName = `${payload.data.customer?.first_name || ''} ${payload.data.customer?.last_name || ''}`.trim();
            const orderId = payload.data.id;
            const totalAmount = payload.data.amounts?.total?.amount || 0;
            const currency = payload.data.amounts?.total?.currency || 'SAR';
            userMessage = `مرحباً، لقد قمت للتو بإنشاء طلب جديد برقم #${orderId} بقيمة ${totalAmount} ${currency}.`;
        } else {
            customerName = payload.name || 'عميل جديد';
            userMessage = payload.message || '';
        }

        if (!userMessage) {
            return res.status(200).json({ status: 'skipped_empty_message' });
        }

        // استدعاء Gemini API مباشرة وبأقصى سرعة
        const geminiApiKey = process.env.GEMINI_API_KEY;
        const modelName = 'gemini-1.5-flash';
        const aiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${geminiApiKey}`;

        const systemInstructionText = `أنت موظف مبيعات وخدمة عملاء احترافي لمتجر إلكتروني. 
- تحدث بلغة عربية (عامية مصرية بسيطة وودودة ومحترفة).
- مساعدة العميل في اختيار المنتجات وشرح المميزات والأسعار، وإذا أرسل إشعار بطلب جديد، رحب به وشكره على ثقته في المتجر.
- كن دقيقاً، صبوراً، وساعد العميل حتى إتمام الشراء.`;

        const aiResponse = await fetch(aiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                system_instruction: { parts: [{ text: systemInstructionText }] },
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