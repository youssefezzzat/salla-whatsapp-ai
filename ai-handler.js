import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 1. دالة بناء السياق (Context Injection)
export async function buildAiContext(phone) {
    const cleanPhone = phone.replace(/[^0-9+]/g, '');

    const [{ data: session }, { data: memory }] = await Promise.all([
        supabase.from('conversations_sessions').select('*').eq('phone', cleanPhone).order('last_active', { ascending: false }).limit(1).single(),
        supabase.from('customer_memory').select('summary, last_updated').eq('phone', cleanPhone).single()
    ]);

    const isWithin24h = session?.last_active ? (Date.now() - new Date(session.last_active).getTime()) < 86400000 : false;

    return {
        customer_phone: cleanPhone,
        session_mode: session?.mode || 'ai',
        department_assigned: session?.department || null,
        short_term_memory: memory?.summary || 'لا توجد ذاكرة نشطة.',
        is_within_24h_window: isWithin24h
    };
}

// 2. دالة معالجة الرد عبر GPT-4o
export async function processMessageWithAI(phone, userInput) {
    const context = await buildAiContext(phone);

    const systemPrompt = `أنت مساعد خدمة عملاء ومبيعات خبير لمنصة سلا التجارية. تتحدث باللغة العربية الفصحى المبسطة بنبرة ودودة.
    قواعد التشغيل:
    1. التزم بالسياق المرفق ولا تخمن أبدًا.
    2. إذا طلب العميل موظف بشري أو أبدى غضباً، صنف القسم إلى 'human_handoff'.
    3. الردود قصيرة وواضحة تناسب واتساب.`;

    const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: `الرسالة: ${userInput}\nالسياق: ${JSON.stringify(context)}` }
        ],
        response_format: {
            type: "json_schema",
            json_schema: {
                name: "classification_response",
                schema: {
                    type: "object",
                    properties: {
                        department: { type: "string", enum: ["sales", "support", "human_handoff"] },
                        reply_arabic: { type: "string" },
                        action: { type: "string", enum: ["none", "request_template", "update_memory"] }
                    },
                    required: ["department", "reply_arabic", "action"]
                }
            }
        },
        max_tokens: 512
    });

    return JSON.parse(response.choices[0].message.content);
}