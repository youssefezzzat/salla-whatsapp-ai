import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI } from '@google/genai';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const webhookId = req.headers['webhook-id'] || req.headers['x-webhook-id'] || `wh_${Date.now()}`;
        const payload = req.body;

        if (payload.from_me) {
            return res.status(200).json({ status: 'skipped_from_me' });
        }

        // 1. Idempotency Check
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

        // 2. Customer Check
        let { data: customer } = await supabase
            .from('customers')
            .select('*')
            .eq('phone', userPhone)
            .single();

        if (!customer) {
            await supabase.from('customers').insert([{ phone: userPhone, name: payload.name || 'عميل جديد' }]);
        }

        // 3. Session Check
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

        // 4. Save User Message
        await supabase.from('messages').insert([
            { phone: userPhone, role: 'user', content: userMessage }
        ]);

        // 5. Fetch History and Format cleanly for SDK
        const { data: historyData } = await supabase
            .from('messages')
            .select('role, content')
            .eq('phone', userPhone)
            .order('created_at', { ascending: true })
            .limit(10);

        // تحويل الأدوار بالشكل الصحيح المقبول في Gemini SDK (user / model)
        let contents = [];
        if (historyData && historyData.length > 0) {
            contents = historyData.map(msg => ({
                role: msg.role === 'model' ? 'model' : 'user',
                parts: [{ text: String(msg.content || '') }]
            }));
        } else {
            contents = [
                {
                    role: 'user',
                    parts: [{ text: String(userMessage) }]
                }
            ];
        }

        // التأكد إن آخر رسالة هي رسالة المستخدم الحالية
        const lastMsg = contents[contents.length - 1];
        if (!lastMsg || lastMsg.role !== 'user' || lastMsg.parts[0].text !== userMessage) {
            contents.push({
                role: 'user',
                parts: [{ text: String(userMessage) }]
            });
        }

        // 6. Call Gemini API securely
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: contents,
            config: {
                systemInstruction: `أنت موظف مبيعات وخدمة عملاء احترافي لمتجر إلكتروني (يعمل على سلة). مهمتك:
                - التحدث بلغة عربية (عامية مصرية بسيطة وودودة ومحترفة).
                - مساعدة العميل في اختيار المنتجات وشرح المميزات والأسعار.
                - إذا طلب العميل التحدث مع موظف بشري أو اشتكى بشدة، أجب بـ [HUMAN_HANDOFF] في أول ردك.
                - كن دقيقاً، صبوراً، وساعد العميل حتى إتمام الشراء.`,
            }
        });

        let replyText = response.text || "أهلاً بك، كيف يمكنني مساعدتك اليوم؟";
        
        if (replyText.includes('[HUMAN_HANDOFF]')) {
            replyText = "ولا تقلق يا فندم، أنا هحولك حالاً لأحد زميلي من خدمة العملاء يتابع معاك التفاصيل بدقة. ثواني ويكون معاك!";
            await supabase
                .from('conversations_sessions')
                .update({ mode: 'human' })
                .eq('phone', userPhone);
        }

        // 7. Save AI Response
        await supabase.from('messages').insert([
            { phone: userPhone, role: 'model', content: replyText }
        ]);

        return res.status(200).json({ 
            status: 'success', 
            webhook_id: webhookId, 
            reply: replyText 
        });

    } catch (error) {
        console.error("Error processing Vercel webhook:", error);
        return res.status(500).json({ error: error.message || error });
    }
}