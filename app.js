import express from 'express';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

const app = express();
app.use(express.json());

// الاتصال بـ Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// تهيئة Gemini (يمكنك استبداله بـ OpenAI لاحقاً لو طلب العميل)
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    return res.send('🚀 Enterprise AI Sales & Support Server is running!');
});

app.post('/webhook', async (req, res) => {
    try {
        console.log("📥 Received webhook body:", req.body);

        const webhookId = req.headers['webhook-id'] || req.headers['x-webhook-id'] || `wh_${Date.now()}`;
        const payload = req.body;

        if (payload.from_me) {
            console.log("Skipping message sent by bot.");
            return res.status(200).json({ status: 'skipped_from_me' });
        }

        // 1. فحص الـ Idempotency لمنع تكرار الويب هوك تماماً
        const { data: existingLog } = await supabase
            .from('idempotency_logs')
            .select('webhook_id')
            .eq('webhook_id', webhookId)
            .single();

        if (existingLog) {
            console.log(`Duplicate webhook ignored: ${webhookId}`);
            return res.status(200).json({ status: 'duplicate_ignored' });
        }

        await supabase.from('idempotency_logs').insert([{ webhook_id: webhookId }]);

        const userPhone = payload.phone;
        const userMessage = payload.message;
        console.log(`💬 User (${userPhone}) message: "${userMessage}"`);

        // 2. التحقق من وجود العميل في جدول customers، وإضافته لو جديد
        let { data: customer } = await supabase
            .from('customers')
            .select('*')
            .eq('phone', userPhone)
            .single();

        if (!customer) {
            await supabase.from('customers').insert([{ phone: userPhone, name: payload.name || 'عميل جديد' }]);
        }

        // 3. التحقق من حالة المحادثة (هل البوت شغال ولا تحولت لموظف بشري Human Handoff؟)
        let { data: session } = await supabase
            .from('conversations_sessions')
            .select('*')
            .eq('phone', userPhone)
            .single();

        if (!session) {
            // إنشاء جلسة افتراضية بوضع الـ AI
            const { data: newSession } = await supabase
                .from('conversations_sessions')
                .insert([{ phone: userPhone, mode: 'ai', department: 'sales' }])
                .select()
                .single();
            session = newSession;
        }

        // لو الحالة human، البوت مش هيرد عشان نسيب الموظف البشري يكمل
        if (session && session.mode === 'human') {
            console.log(`User ${userPhone} is handled by human agent. AI skipped.`);
            // حفظ الرسالة فقط في الـ messages
            await supabase.from('messages').insert([{ phone: userPhone, role: 'user', content: userMessage }]);
            return res.status(200).json({ status: 'human_mode_active', reply: null });
        }

        // 4. حفظ رسالة المستخدم في جدول الـ messages (الذاكرة)
        await supabase.from('messages').insert([
            { phone: userPhone, role: 'user', content: userMessage }
        ]);

        // 5. سحب آخر الرسائل للذاكرة
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

        // التأكد من إضافة الرسالة الحالية للـ contents لو مش مضافة
        if (formattedHistory.length === 0 || formattedHistory[formattedHistory.length - 1].parts[0].text !== userMessage) {
            formattedHistory.push({
                role: 'user',
                parts: [{ text: userMessage }]
            });
        }

        // 6. تشغيل الـ AI مع الـ System Instructions الاحترافية لخدمة العملاء والمبيعات
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
        
        // التحقق من طلب التدخل البشري (Human Handoff)
        if (replyText.includes('[HUMAN_HANDOFF]')) {
            replyText = "ولا تقلق يا فندم، أنا هحولك حالاً لأحد زميلي من خدمة العملاء يتابع معاك التفاصيل بدقة. ثواني ويكون معاك!";
            // تحديث حالة الجلسة إلى human
            await supabase
                .from('conversations_sessions')
                .update({ mode: 'human' })
                .eq('phone', userPhone);
        }

        console.log(`🤖 AI Reply: "${replyText}"`);

        // 7. حفظ رد الـ AI في الداتا بيز
        await supabase.from('messages').insert([
            { phone: userPhone, role: 'model', content: replyText }
        ]);

        return res.status(200).json({ 
            status: 'success', 
            webhook_id: webhookId, 
            reply: replyText 
        });

    } catch (error) {
        console.error("Error processing Enterprise webhook:", error.message);
        return res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Enterprise Server running on port ${PORT}`);
});