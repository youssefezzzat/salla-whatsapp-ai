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

        // تحديد نوع الويب هوك (هل هو حدث من سلة زي order.created ولا رسالة دردشة؟)
        let userPhone, userMessage, customerName;
        const eventType = payload.event || 'chat_message';

        if (eventType === 'order.created' && payload.data) {
            // التعامل مع إشعار طلب سلة
            userPhone = payload.data.customer?.mobile || 'unknown';
            customerName = `${payload.data.customer?.first_name || ''} ${payload.data.customer?.last_name || ''}`.trim();
            const orderId = payload.data.id;
            const totalAmount = payload.data.amounts?.total?.amount || 0;
            const currency = payload.data.amounts?.total?.currency || 'SAR';

            userMessage = `مرحباً، لقد قمت للتو بإنشاء طلب جديد برقم #${orderId} بقيمة ${totalAmount} ${currency}.`;
        } else {
            // التعامل مع رسائل الدردشة العادية
            userPhone = payload.phone || 'unknown';
            customerName = payload.name || 'عميل جديد';
            userMessage = payload.message || '';
        }

        if (!userMessage) {
            return res.status(200).json({ status: 'skipped_empty_message' });
        }

        console.log(`💬 Processing [${eventType}] for (${userPhone}): "${userMessage}"`);

        // 2. Customer Check
        let { data: customer } = await supabase
            .from('customers')
            .select('*')
            .eq('phone', userPhone)
            .single();

        if (!customer) {
            await supabase.from('customers').insert([{ phone: userPhone, name: customerName }]);
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

        // 5. Fetch History
        const { data: historyData } = await supabase
            .from('messages')
            .select('role, content')
            .eq('phone', userPhone)
            .order('created_at', { ascending: true })
            .limit(10);

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

        const lastMsg = contents[contents.length - 1];
        if (!lastMsg || lastMsg.role !== 'user' || lastMsg.parts[0].text !== userMessage) {
            contents.push({
                role: 'user',
                parts: [{ text: String(userMessage) }]
            });
        }

        // 6. Call Gemini API
        const response = await ai.models.generateContent({
            model: 'gemini-3.6-flash',
            contents: contents,
            config: {
                systemInstruction: `أنت موظف مبيعات وخدمة عملاء احترافي لمتجر إلكتروني (يعمل على سلة). مهمتك:
                - التحدث بلغة عربية (عامية مصرية بسيطة وودودة ومحترفة).
                - مساعدة العميل في اختيار المنتجات وشرح المميزات والأسعار، وإذا أرسل إشعار بطلب جديد، رحب به وشكره على ثقته في المتجر وأكد له أن طلبه قيد المراجعة.
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
            event_handled: eventType,
            reply: replyText 
        });

    } catch (error) {
        console.error("Error processing Vercel webhook:", error);
        return res.status(500).json({ error: error.message || error });
    }
}