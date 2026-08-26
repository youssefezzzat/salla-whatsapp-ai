import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

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

        // فحص الـ Idempotency
        const { data: existingLog } = await supabase
            .from('idempotency_logs')
            .select('webhook_id')
            .eq('webhook_id', webhookId)
            .single();

        if (existingLog) {
            return res.status(200).json({ status: 'duplicate_ignored' });
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

        // سحب البيانات من Supabase
        const [customerResult, sessionResult, historyResult] = await Promise.all([
            supabase.from('customers').select('*').eq('phone', userPhone).single(),
            supabase.from('conversations_sessions').select('*').eq('phone', userPhone).single(),
            supabase.from('messages').select('role, content').eq('phone', userPhone).order('created_at', { ascending: true }).limit(2)
        ]);

        let session = sessionResult.data;
        if (!session) {
            const { data: newSession } = await supabase
                .from('conversations_sessions')
                .insert([{ phone: userPhone, mode: 'ai', department: 'sales' }])
                .select()
                .single();
            session = newSession;
        }

        if (session && session.mode === 'human') {
            return res.status(200).json({ status: 'human_mode_active', reply: null });
        }

        // تجهيز الـ Contents لـ Gemini API
        let contents = [];
        const historyData = historyResult.data;
        if (historyData && historyData.length > 0) {
            contents = historyData.map(msg => ({
                role: msg.role === 'model' ? 'model' : 'user',
                parts: [{ text: String(msg.content || '') }]
            }));
        }

        contents.push({
            role: 'user',
            parts: [{ text: String(userMessage) }]
        });

        // استدعاء Gemini مباشرة عبر REST API (أسرع بكتير وبدون مكتبات ثقيلة)
        const geminiApiKey = process.env.GEMINI_API_KEY;
        const modelName = 'gemini-1.5-flash'; // استخدام موديل مستقر وسريع جداً على الـ API
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${geminiApiKey}`;

        const systemInstructionText = `أنت موظف مبيعات وخدمة عملاء احترافي لمتجر إلكتروني (يعمل على سلة). مهمتك:
        - التحدث بلغة عربية (عامية مصرية بسيطة وودودة ومحترفة).
        - مساعدة العميل في اختيار المنتجات وشرح المميزات والأسعار، وإذا أرسل إشعار بطلب جديد، رحب به وشكره على ثقته في المتجر وأكد له أن طلبه قيد المراجعة.
        - إذا طلب العميل التحدث مع موظف بشري أو اشتكى بشدة، أجب بـ [HUMAN_HANDOFF] في أول ردك.
        - كن دقيقاً، صبوراً، وساعد العميل حتى إتمام الشراء.`;

        const geminiResponse = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                system_instruction: {
                    parts: [{ text: systemInstructionText }]
                },
                contents: contents
            })
        });

        const geminiData = await geminiResponse.json();

        let replyText = "أهلاً بك، كيف يمكنني مساعدتك اليوم؟";
        if (geminiData && geminiData.candidates && geminiData.candidates[0]?.content?.parts?.[0]?.text) {
            replyText = geminiData.candidates[0].content.parts[0].text;
        }

        if (replyText.includes('[HUMAN_HANDOFF]')) {
            replyText = "ولا تقلق يا فندم، أنا هحولك حالاً لأحد زميلي من خدمة العملاء يتابع معاك التفاصيل بدقة. ثواني ويكون معاك!";
            supabase.from('conversations_sessions').update({ mode: 'human' }).eq('phone', userPhone).then();
        }

        // حفظ البيانات في الخلفية
        Promise.all([
            supabase.from('customers').insert([{ phone: userPhone, name: customerName }]),
            supabase.from('messages').insert([{ phone: userPhone, role: 'user', content: userMessage }]),
            supabase.from('messages').insert([{ phone: userPhone, role: 'model', content: replyText }]),
            supabase.from('idempotency_logs').insert([{ webhook_id: webhookId }])
        ]).catch(err => console.error("Background sync error:", err));

        const totalTime = Date.now() - t0;

        return res.status(200).json({ 
            status: 'success', 
            webhook_id: webhookId, 
            total_time_ms: totalTime,
            reply: replyText 
        });

    } catch (error) {
        console.error("Error processing Vercel webhook:", error);
        return res.status(500).json({ error: error.message || error });
    }
}