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
        const customerName = payload.name || 'عميل جديد';

        if (!userMessage || !userPhone) {
            return res.status(200).json({ status: 'skipped_missing_data' });
        }

        // 1. فحص الـ Idempotency بسرعة فائقة
        const { data: existingLog } = await supabase
            .from('idempotency_logs')
            .select('webhook_id')
            .eq('webhook_id', webhookId)
            .single();

        if (existingLog) {
            return res.status(200).json({ status: 'duplicate_ignored' });
        }

        // 2. سحب آخر رسايل للمحادثة (History) عشان جيميناي يكون فاهم السياق
        const { data: historyData } = await supabase
            .from('messages')
            .select('role, content')
            .eq('phone', userPhone)
            .order('created_at', { ascending: true })
            .limit(6);

        let contents = [];
        if (historyData && historyData.length > 0) {
            contents = historyData.map(msg => ({
                role: msg.role === 'model' ? 'model' : 'user',
                parts: [{ text: String(msg.content || '') }]
            }));
        }
        
        // إضافة الرسالة الحالية للـ Contents
        contents.push({
            role: 'user',
            parts: [{ text: String(userMessage) }]
        });

        // 3. استدعاء جيميناي بالموديل المطلوب وبسياق المحادثة الكامل
        const response = await ai.models.generateContent({
            model: 'gemini-3.6-flash',
            contents: contents,
            config: {
                systemInstruction: `أنت موظف مبيعات وخدمة عملاء احترافي لمتجر إلكتروني. 
                - تحدث بلغة عربية (عامية مصرية بسيطة وودودة ومحترفة).
                - مساعدة العميل في اختيار المنتجات وشرح المميزات والأسعار.
                - إذا طلب العميل التحدث مع موظف بشري أو اشتكى بشدة، أجب بـ [HUMAN_HANDOFF] في أول ردك.
                - كن دقيقاً، صبوراً، وساعد العميل حتى إتمام الشراء.`,
            }
        });

        let replyText = response.text || "أهلاً بك، كيف يمكنني مساعدتك اليوم؟";
        
        let isHumanMode = false;
        if (replyText.includes('[HUMAN_HANDOFF]')) {
            replyText = "ولا تقلق يا فندم، أنا هحولك حالاً لأحد زميلي من خدمة العملاء يتابع معاك التفاصيل بدقة. ثواني ويكون معاك!";
            isHumanMode = true;
        }

        const totalTime = Date.now() - t0;

        // 4. إرسال الرد فوراً للعميل
        res.status(200).json({ 
            status: 'success', 
            webhook_id: webhookId, 
            total_time_ms: totalTime,
            reply: replyText 
        });

        // 5. العمليات وقاعدة البيانات في الخلفية (Background Tasks) لضمان عدم حدوث أي تأخير
        (async () => {
            try {
                // تسجيل الـ Idempotency
                await supabase.from('idempotency_logs').insert([{ webhook_id: webhookId }]);

                // التأكد من وجود العميل وجلسته أو إنشائهم
                await supabase.from('customers').upsert([{ phone: userPhone, name: customerName }], { onConflict: 'phone' });
                
                const { data: session } = await supabase
                    .from('conversations_sessions')
                    .select('phone')
                    .eq('phone', userPhone)
                    .single();

                if (!session) {
                    await supabase.from('conversations_sessions').insert([{ phone: userPhone, mode: 'ai', department: 'sales' }]);
                }

                // حفظ الرسايل في جدول الـ messages
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