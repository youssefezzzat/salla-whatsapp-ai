import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';

dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

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

// 2. دالة معالجة الرد عبر Gemini بالصيغة الصحيحة
export async function processMessageWithAI(phone, userInput) {
    const context = await buildAiContext(phone);

    const systemPrompt = `أنت مساعد خدمة عملاء ومبيعات خبير لمنصة سلا التجارية. تتحدث باللغة العربية الفصحى المبسطة بنبرة ودودة.
    قواعد التشغيل:
    1. التزم بالسياق المرفق ولا تخمن أبدًا.
    2. إذا طلب العميل موظف بشري أو أبدى غضباً، صنف القسم إلى 'human_handoff'.
    3. الردود قصيرة وواضحة تناسب واتساب.
    
    يجب أن يكون الرد بصيغة JSON حصراً يحتوي على الخصائص التالية:
    - department: "sales" أو "support" أو "human_handoff"
    - reply_arabic: نص الرد للعميل
    - action: "none" أو "request_template" أو "update_memory"`;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-3.6-flash',
            contents: [
                {
                    role: 'user',
                    parts: [
                        { text: `${systemPrompt}\n\nالسياق:\n${JSON.stringify(context)}\n\nرسالة العميل: ${userInput}` }
                    ]
                }
            ],
            config: {
                responseMimeType: "application/json"
            }
        });

        return JSON.parse(response.text);
    } catch (error) {
        console.error("Gemini Error:", error);
        return {
            department: "support",
            reply_arabic: "أهلاً بك، عذراً حدث خطأ تقني بسيط وسيتم تحويلك لموظف خدمة العملاء.",
            action: "human_handoff"
        };
    }
}