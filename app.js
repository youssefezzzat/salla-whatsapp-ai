import express from 'express';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

const app = express();
app.use(express.json());

// الاتصال بـ Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// تهيئة Gemini
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const PORT = process.env.PORT || 3000;

// Root Endpoint للتاكد من عمل السيرفر
app.get('/', (req, res) => {
    return res.send('🚀 Enterprise AI Sales & Support Server is running!');
});

// 1. WhatsApp Webhook Verification (مهم جداً عشان ميتا تقبل الرابط)
app.get('/webhook', (req, res) => {
    const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'my_secure_verify_token';
    
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            console.log('✅ WEBHOOK_VERIFIED_SUCCESSFULLY');
            return res.status(200).send(challenge); // ميتا تشترط إرجاع الـ challenge كـ Text خالص
        } else {
            return res.sendStatus(403);
        }
    }
    return res.sendStatus(400);
});

// 2. استقبال رسائل الواتساب وتوليد الرد بالذكاء الاصطناعي
app.post('/webhook', async (req, res) => {
    const t0 = Date.now();

    try {
        console.log("📥 Received webhook body:", JSON.stringify(req.body, null, 2));

        const payload = req.body;

        // تجاهل الرسائل الصادرة من البوت نفسه لمنع الـ Loops
        if (payload.from_me) {
            return res.status(200).json({ status: 'skipped_from_me' });
        }

        const userPhone = payload.phone;
        const userMessage = payload.message;
        const customerName = payload.name || 'عميل جديد';
        const webhookId = req.headers['webhook-id'] || req.headers['x-webhook-id'] || `wh_${Date.now()}_${Math.random()}`;

        if (!userMessage || !userPhone) {
            return res.status(200).json({ status: 'skipped_missing_data' });
        }

        // فحص الـ Idempotency لمنع تكرار معالجة نفس الطلب
        const { data: existingLog } = await supabase
            .from('idempotency_logs')
            .select('webhook_id')
            .eq('webhook_id', webhookId)
            .single();

        if (existingLog) {
            return res.status(200).json({ status: 'duplicate_ignored' });
        }

        // سحب تاريخ المحادثة من Supabase لضمان فهم السياق بواسطة Gemini
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
        
        // إضافة رسالة المستخدم الحالية
        contents.push({
            role: 'user',
            parts: [{ text: String(userMessage) }]
        });

        // استدعاء Gemini الذكي بالعامية المصرية
        const response = await ai.models.generateContent({
            model: 'gemini-3.6-flash',
            contents: contents,
            config: {
                systemInstruction: `أنت موظف مبيعات وخدمة عملاء احترافي لمتجر إلكتروني. 
                - تحدث بلغة عربية (عامية مصرية بسيطة وودودة ومحترفة).
                - ساعد العميل في اختيار المنتجات وشرح المميزات والأسعار.
                - إذا طلب العميل التحدث مع موظف بشري أو اشتكى بشدة، أجب بـ [HUMAN_HANDOFF] في أول ردك.
                - كن دقيقاً، صبوراً، وساعد العميل حتى إتمام الشراء.`,
            }
        });

        let replyText = response.text || "أهلاً بك، كيف يمكنني مساعدتك اليوم؟";
        let isHumanMode = false;

        // التحقق من طلب التحويل البشري
        if (replyText.includes('[HUMAN_HANDOFF]')) {
            replyText = "ولا تقلق يا فندم، أنا هحولك حالاً لأحد زميلي من خدمة العملاء يتابع معاك التفاصيل بدقة. ثواني ويكون معاك!";
            isHumanMode = true;
        }

        const totalTime = Date.now() - t0;

        // إرسال الرد فوراً وبدون تأخير للعميل
        res.status(200).json({ 
            status: 'success', 
            webhook_id: webhookId, 
            total_time_ms: totalTime,
            reply: replyText 
        });

        // حفظ العمليات وتحديث قاعدة البيانات في الخلفية (Background Tasks)
        (async () => {
            try {
                await supabase.from('idempotency_logs').insert([{ webhook_id: webhookId }]);
                await supabase.from('customers').upsert([{ phone: userPhone, name: customerName }], { onConflict: 'phone' });
                
                const { data: session } = await supabase
                    .from('conversations_sessions')
                    .select('phone')
                    .eq('phone', userPhone)
                    .single();

                if (!session) {
                    await supabase.from('conversations_sessions').insert([{ phone: userPhone, mode: 'ai', department: 'sales' }]);
                }

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
        console.error("Error processing Webhook:", error);
        return res.status(500).json({ error: error.message || error });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Enterprise Server running on port ${PORT}`);
});