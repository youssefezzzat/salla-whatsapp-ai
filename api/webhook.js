export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const t0 = Date.now();

    try {
        const webhookId = req.headers['webhook-id'] || req.headers['x-webhook-id'] || `wh_${Date.now()}`;
        
        const totalTime = Date.now() - t0;

        return res.status(200).json({ 
            status: 'success', 
            webhook_id: webhookId, 
            total_time_ms: totalTime,
            reply: "أهلاً بك يا فندم، السرعة هنا هتبقا طلقة!" 
        });

    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}