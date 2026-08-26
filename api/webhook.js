import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI } from '@google/genai';

// الاتصال بـ Supabase باستخدام متغيرات البيئة في Vercel
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// تهيئة Gemini
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export default async function handler(req, res) {
    // التأكد إن الطلب نوعه POST
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        console.log("📥 Received Vercel webhook body:", req.body);

        const webhookId = req.headers['webhook-id'] || req.headers['x-webhook-id'] || `wh_${Date.now()}`;
        const payload = req.body;

        if (payload.from_me) {
            return res.status(200).json({ status: 'skipped_from_me' });
        }

        // 1. فحص الـ Idempotency لمنع التكرار
        const { data: existingLog } = await supabase
            .from('idempotency_logs')
            .select('webhook_id')
            .eq('webhook_id', webhookId)
            .single();

        if (existingLog) {
            return res.status(200).json({ status: 'duplicate_ignored' });
        }

        await supabase.from('idempotency_logs').insert([{ webhook_id: webhookId }]);

        const userPhone = payload.phone;
        const userMessage = payload.message;

        // 2. التحقق من العميل في جدول customers
        let { data: customer } = await supabase
            .from('customers')
            .select('*')
            .eq('phone', userPhone)
            .single();

        if (!customer) {
            await supabase.from('customers').insert([{ phone: userPhone, name: payload.name || 'عميل جديد' }]);
        }

        // 3. التحقق من حالة المحادثة (Human Handoff Check)
        let { data: session } = await supabase
            .from('conversations_sessions')
            .select('*')
            .eq('phone', userPhone)
            .single();

        if (!session) {
            const { data: newSession } = await supabase
                .from('conversations_sessions')
                .insert([{ phone: userPhone, mode: 'ai', department: 'sales' }])
                .select()
                .single();
            session = newSession;
        }

        if (session && session.mode === 'human') {
            await supabase.from('messages').insert([{ phone: userPhone, role: 'user', content: userMessage }]);
            return res.status(200).json({ status: 'human_mode_active', reply: null });
        }

        // 4. حفظ رسالة المستخدم
        await supabase.from('messages').insert([
            { phone: userPhone, role: 'user', content: userMessage }
        ]);

        // 5. سحب التاريخ للذاكرة
        const { data: historyData } = await supabase
            .from('messages')
            .select('role, content')
            .eq('phone', userPhone)
            .order('created_at', { ascending: true })
            .limit(10);

        let formattedHistory = historyData && historyData.length > 0 
            ? historyData.map(msg => ({
                role: msg.role,
                parts: [{ text: msg.content }]
              }))
            : [];

        if (formattedHistory.length === 0 || formattedHistory[formattedHistory.length - 1].parts[0].text !== userMessage) {
            formattedHistory.push({
                role: 'user',
                parts: [{ text: userMessage }]
            });
        }

        // 6. تشغيل الـ AI
        const response = await ai.models.generateContent({
            model: 'gemini-3.6-flash',
            contents: formattedHistory,
            config: {
                systemInstruction: `أنت موظف مبيعات وخدمة عملاء احترافي لمتجر إلكتروني (يعمل على سلة). مهمتك:
                - التحدث بلغة عربية (عامية مصرية بسيطة وودودة ومحترفة).
                - مساعدة العميل في اختيار المنتجات وشرح المميزات والأسعار.
                - إذا طلب العميل التحدث مع موظف بشري أو اشتكى بشدة، أجب بـ [HUMAN_HANDOFF] في أول ردك.
                - كن دقيقاً، صبوراً، وساعد العميل حتى إتمام الشراء.`,
            }
        });

        let replyText = response.text;
        
        if (replyText.includes('[HUMAN_HANDOFF]')) {
            replyText = "ولا تقلق يا فندم، أنا هحولك حالاً لأحد زميلي من خدمة العملاء يتابع معاك التفاصيل بدقة. ثواني ويكون معاك!";
            await supabase
                .from('conversations_sessions')
                .update({ mode: 'human' })
                .eq('phone', userPhone);
        }

        // 7. حفظ رد الـ AI
        await supabase.from('messages').insert([
            { phone: userPhone, role: 'model', content: replyText }
        ]);

        return res.status(200).json({ 
            status: 'success', 
            webhook_id: webhookId, 
            reply: replyText 
        });

    } catch (error) {
        console.error("Error processing Vercel webhook:", error.message);
        return res.status(500).json({ error: error.message });
    }
}