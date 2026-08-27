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

        // 1. فحص الـ Idempotency بناءً على الـ Schema الصحيحة
        const { data: existingLog } = await supabase
            .from('idempotency_logs')
            .select('event_id')
            .eq('event_id', webhookId)
            .single();

        if (existingLog) {
            return res.status(200).json({ status: 'duplicate_ignored' });
        }

        // 2. جلب أو إنشاء العميل أولاً لضمان وجود customer_id للربط
        let { data: customer } = await supabase
            .from('customers')
            .select('id')
            .eq('phone', userPhone)
            .single();

        if (!customer) {
            const { data: newCustomer, err: custError } = await supabase
                .from('customers')
                .insert([{ phone: userPhone, name: customerName }])
                .select('id')
                .single();
            
            if (newCustomer) customer = newCustomer;
        }

        const customerId = customer ? customer.id : null;

        // 3. سحب آخر رسايل للمحادثة (History) لكي يفهم جيميناي السياق
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
        
        contents.push({
            role: 'user',
            parts: [{ text: String(userMessage) }]
        });

        // 4. استدعاء جيميناي (تأكدنا من استخدام موديل متوفر وفعال مثل gemini-2.5-flash)
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
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

        // 5. إرسال الرد فوراً للعميل لمنع أي Timeout على Vercel
        res.status(200).json({ 
            status: 'success', 
            webhook_id: webhookId, 
            total_time_ms: totalTime,
            reply: replyText 
        });

        // 6. العمليات في الخلفية (Background Tasks) لتخزين السجلات
        (async () => {
            try {
                // تسجيل الـ Idempotency مع الـ expires_at (ساعة من الآن)
                const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
                await supabase.from('idempotency_logs').insert([{ 
                    event_id: webhookId, 
                    expires_at: expiresAt 
                }]);

                if (customerId) {
                    // التحقق من الجلسة أو إنشائها
                    const { data: session } = await supabase
                        .from('conversations_sessions')
                        .select('id')
                        .eq('customer_id', customerId)
                        .single();

                    if (!session) {
                        await supabase.from('conversations_sessions').insert([{ 
                            customer_id: customerId, 
                            status: 'ai', 
                            department: 'sales' 
                        }]);
                    }

                    // حفظ الرسائل في جدول الـ messages (تأكد من إنشاء جدول messages لو مش موجود في السكيما)
                    await supabase.from('messages').insert([
                        { phone: userPhone, role: 'user', content: userMessage },
                        { phone: userPhone, role: 'model', content: replyText }
                    ]);

                    if (isHumanMode) {
                        await supabase
                            .from('conversations_sessions')
                            .update({ status: 'human', department: 'human' })
                            .eq('customer_id', customerId);
                    }
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