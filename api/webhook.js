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

        const userPhone = payload.phone;
        const userMessage = payload.message;

        if (!userMessage) {
            return res.status(200).json({ status: 'skipped_empty_message' });
        }

        // 1. فحص الـ Idempotency بسرعة (ضروري يكون سريع)
        const { data: existingLog } = await supabase
            .from('idempotency_logs')
            .select('webhook_id')
            .eq('webhook_id', webhookId)
            .single();

        if (existingLog) {
            return res.status(200).json({ status: 'duplicate_ignored' });
        }

        // 2. استدعاء جيميناي فوراً (بالموديل السريع والحديث)
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [{ role: 'user', parts: [{ text: String(userMessage) }] }],
            config: {
                systemInstruction: `أنت موظف مبيعات وخدمة عملاء احترافي لمتجر إلكتروني. 
                - تحدث بلغة عربية (عامية مصرية بسيطة وودودة ومحترفة).
                - مساعدة العميل في اختيار المنتجات وشرح المميزات والأسعار.
                - إذا طلب العميل التحدث مع موظف بشري أو اشتكى بشدة، أجب بـ [HUMAN_HANDOFF] في أول ردك.
                - كن دقيقاً، صبوراً، وساعد العميل حتى إتمام الشراء.`,
            }
        });

        let replyText = response.text || "أهلاً بك، كيف يمكنني مساعدتك اليوم؟.";
        
        let isHumanMode = false;
        if (replyText.includes('[HUMAN_HANDOFF]')) {
            replyText = "ولا تقلق يا فندم، أنا هحولك حالاً لأحد زميلي من خدمة العملاء يتابع معاك التفاصيل بدقة. ثواني ويكون معاك!";
            isHumanMode = true;
        }

        const totalTime = Date.now() - t0;

        // 3. نرجع الرد فوراً للعميل (أسرع استجابة ممكنة)
        res.status(200).json({ 
            status: 'success', 
            webhook_id: webhookId, 
            total_time_ms: totalTime,
            reply: replyText 
        });

        // 4. كل عمليات Supabase وسجلاتی الحفظ تحصل في الخلفية بهدوء بعد ما العميل استلم رده!
        (async () => {
            try {
                // تسجيل الـ Idempotency
                await supabase.from('idempotency_logs').insert([{ webhook_id: webhookId }]);

                // حفظ العميل أو الجلسة أو الرسائل
                await supabase.from('messages').insert([
                    { phone: userPhone, role: 'user', content: userMessage },
                    { phone: userPhone, role: 'model', content: replyText }
                ]);

                if (isHumanMode) {
                    await supabase
                        .from('conversations_sessions')
                        .update({ mode: 'human' })
                        .eq('phone', userPhone);
                }
            } catch (bgError) {
                console.error("Background DB Error:", bgError);
            }
        })();

    } catch (error) {
        console.error("Error processing Vercel webhook:", error);
        return res.status(500).json({ error: error.message || error });
    }
}