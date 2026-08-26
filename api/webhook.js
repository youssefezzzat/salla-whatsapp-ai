import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI } from '@google/genai';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

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

        const t1 = Date.now();
        console.log(`⏱️ Setup time: ${t1 - t0}ms`);

        // فحص الـ Idempotency
        const { data: existingLog } = await supabase
            .from('idempotency_logs')
            .select('webhook_id')
            .eq('webhook_id', webhookId)
            .single();

        if (existingLog) {
            return res.status(200).json({ status: 'duplicate_ignored' });
        }

        const t2 = Date.now();
        console.log(`⏱️ Idempotency check time: ${t2 - t1}ms`);

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

        const t3 = Date.now();
        console.log(`⏱️ Supabase queries time: ${t3 - t2}ms`);

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

        // استدعاء Gemini API
        const aiStart = Date.now();
        const response = await ai.models.generateContent({
            model: 'gemini-3.6-flash',
            contents: contents,
            config: {
                systemInstruction: `أنت موظف مبيعات وخدمة عملاء احترافي لمتجر إلكتروني. تحدث بعامية مصرية بسيطة وودودة ومحترفة لمساعدة العميل.`,
            }
        });
        const aiEnd = Date.now();
        console.log(`⏱️ Gemini API time: ${aiEnd - aiStart}ms`);

        let replyText = response.text || "أهلاً بك، كيف يمكنني مساعدتك اليوم؟";

        // حفظ الرسائل في الخلفية بدون ما نعطل الرد
        Promise.all([
            supabase.from('customers').insert([{ phone: userPhone, name: customerName }]),
            supabase.from('messages').insert([{ phone: userPhone, role: 'user', content: userMessage }]),
            supabase.from('messages').insert([{ phone: userPhone, role: 'model', content: replyText }]),
            supabase.from('idempotency_logs').insert([{ webhook_id: webhookId }])
        ]).catch(err => console.error("Background sync error:", err));

        const totalTime = Date.now() - t0;
        console.log(`⏱️ TOTAL Execution time: ${totalTime}ms`);

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