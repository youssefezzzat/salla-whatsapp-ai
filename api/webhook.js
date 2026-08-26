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

        let userPhone, userMessage, customerName;
        const eventType = payload.event || 'chat_message';

        if (eventType === 'order.created' && payload.data) {
            userPhone = payload.data.customer?.mobile || 'unknown';
            customerName = `${payload.data.customer?.first_name || ''} ${payload.data.customer?.last_name || ''}`.trim();
            const orderId = payload.data.id;
            const totalAmount = payload.data.amounts?.total?.amount || 0;
            const currency = payload.data.amounts?.total?.currency || 'SAR';
            userMessage = `مرحباً، لقد قمت للتو بإنشاء طلب جديد برقم #${orderId} بقيمة ${totalAmount} ${currency}.`;
        } else {
            userPhone = payload.phone || 'unknown';
            customerName = payload.name || 'عميل جديد';
            userMessage = payload.message || '';
        }

        if (!userMessage) {
            return res.status(200).json({ status: 'skipped_empty_message' });
        }

        // تنظيف الـ URL لضمان عدم وجود سلاش زايدة تسبب fetch failed
        const rawSupabaseUrl = process.env.SUPABASE_URL || '';
        const supabaseUrl = rawSupabaseUrl.endsWith('/') ? rawSupabaseUrl.slice(0, -1) : rawSupabaseUrl;
        const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

        const headers = {
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`,
            'Content-Type': 'application/json'
        };

        // فحص الـ Idempotency بسرعة عبر REST
        const checkRes = await fetch(`${supabaseUrl}/rest/v1/idempotency_logs?webhook_id=eq.${webhookId}&select=webhook_id`, {
            method: 'GET',
            headers: headers
        });
        const existingLogs = await checkRes.json();

        if (existingLogs && Array.isArray(existingLogs) && existingLogs.length > 0) {
            return res.status(200).json({ status: 'duplicate_ignored' });
        }

        // استدعاء جيميناي عبر الـ REST API السريع
        const geminiApiKey = process.env.GEMINI_API_KEY;
        const modelName = 'gemini-1.5-flash';
        const aiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${geminiApiKey}`;

        const systemInstructionText = `أنت موظف مبيعات وخدمة عملاء احترافي لمتجر إلكتروني. تحدث بعامية مصرية بسيطة وودودة ومحترفة لمساعدة العميل.`;

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

        // تسجيل الـ Idempotency في الخلفية
        fetch(`${supabaseUrl}/rest/v1/idempotency_logs`, {
            method: 'POST',
            headers: { ...headers, 'Prefer': 'return=minimal' },
            body: JSON.stringify({ webhook_id: webhookId })
        }).catch(err => console.error("Background log error:", err));

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